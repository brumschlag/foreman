import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ControlOutcome, ToolResultWithControl } from "./pi-sdk-tools.js";

/**
 * Exposes Foreman's workflow tools over MCP so an out-of-process agent can call
 * them.
 *
 * Foreman's tools are Pi `ToolDefinition`s registered in-process, which an ACP
 * agent running as a separate subprocess cannot see. ACP passes MCP servers
 * through on `session/new`, so re-exposing the SAME ToolDefinition objects over
 * MCP keeps one implementation rather than a second copy that drifts.
 *
 * Hand-rolled JSON-RPC, matching `src/mcp/foreman-mcp-server.ts` — the project
 * ships no MCP SDK dependency.
 */

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ForemanToolMcpServerOptions {
  tools: ToolDefinition[];
  /** Aborts in-flight tool work when the phase is cancelled. */
  signal?: AbortSignal;
}

export interface ListeningForemanToolMcpServer {
  /** OS-assigned port. Never guess one: each concurrent phase runs its own server. */
  port: number;
  /** Pass this to ACP as the `McpServerHttp.url` on session/new. */
  url: string;
  close(): Promise<void>;
}

export interface ForemanToolMcpServer {
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  /**
   * Bind an HTTP listener.
   *
   * HTTP rather than stdio because the Claude ACP adapter advertises
   * `mcpCapabilities: {http: true, sse: true}` and no stdio support, and because
   * the tools close over this phase's ForemanToolContext — serving them in-process
   * keeps runId/taskId/reportDir out of subprocess env entirely.
   *
   * Pass port 0 so the OS assigns one: a port picked in advance can be taken by
   * the time we bind, and parallel phases each need their own.
   */
  listen(host?: string, port?: number): Promise<ListeningForemanToolMcpServer>;
  /**
   * Control signal raised by `abort_phase` / `needs_retry` during this phase.
   *
   * Over MCP a tool's return value is just text to the agent, so a control tool
   * cannot stop the turn by itself — the runner reads this after the turn to
   * decide abort vs retry, and without it the phase would continue past an abort.
   */
  controlOutcome(): ControlOutcome | undefined;
}

/** Same version the operator-facing Foreman MCP server reports. */
const PROTOCOL_VERSION = "2024-11-05";

export function createForemanToolMcpServer(
  opts: ForemanToolMcpServerOptions,
): ForemanToolMcpServer {
  const byName = new Map(opts.tools.map((tool) => [tool.name, tool]));
  let controlOutcome: ControlOutcome | undefined;

  const result = (id: number | string | null, value: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    result: value,
  });

  const error = (
    id: number | string | null,
    code: number,
    message: string,
  ): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

  const callTool = async (params: Record<string, unknown>): Promise<unknown> => {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name || "<missing>"}`);

    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId : name;

    // A tool that throws is a tool-level failure, reported as isError on the
    // RESULT. A JSON-RPC error reads as "the MCP server is broken" and can abort
    // the session, where the agent should instead see the message and adjust.
    let raw: unknown;
    try {
      // Signature is execute(toolCallId, params, signal?, onUpdate?, ctx). Foreman's
      // own tools ignore the trailing three, but the type requires them; the signal
      // is threaded so a cancelled phase can stop a tool mid-flight.
      raw = await tool.execute(
        toolCallId,
        args as never,
        opts.signal,
        undefined as never,
        undefined as never,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: message }], isError: true };
    }

    const toolResult = raw as ToolResultWithControl;
    // First signal wins: a later call must not downgrade an abort to a retry.
    if (toolResult?.controlOutcome && !controlOutcome) {
      controlOutcome = toolResult.controlOutcome;
    }

    return {
      content: toolResult?.content ?? [{ type: "text", text: "" }],
      ...(toolResult?.details ? { structuredContent: toolResult.details } : {}),
    };
  };

  const server: ForemanToolMcpServer = {
    controlOutcome: () => controlOutcome,

    async listen(host = "127.0.0.1", port = 0): Promise<ListeningForemanToolMcpServer> {
      const http = await import("node:http");
      const httpServer = http.createServer((req, res) => {
        if (req.method !== "POST") return void res.writeHead(405).end("method not allowed");

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          void (async () => {
            res.setHeader("content-type", "application/json");
            let request: JsonRpcRequest;
            try {
              request = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as JsonRpcRequest;
            } catch {
              return void res.end(JSON.stringify(error(null, -32700, "Parse error")));
            }
            const response = await server.handle(request);
            // A notification gets no body: replying to one is a protocol violation.
            if (!response) return void res.writeHead(204).end();
            res.end(JSON.stringify(response));
          })();
        });
      });

      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => resolve());
      });

      const address = httpServer.address();
      const boundPort = typeof address === "object" && address ? address.port : port;

      return {
        port: boundPort,
        url: `http://${host}:${boundPort}/mcp`,
        close: () =>
          new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
          }),
      };
    },

    async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      // Notifications carry no id and expect no reply.
      if (request.id === undefined && request.method?.startsWith("notifications/")) {
        return null;
      }
      const id = request.id ?? null;

      try {
        switch (request.method) {
          case "initialize":
            return result(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "foreman-tools", version: "0.1.0" },
            });

          case "tools/list":
            return result(id, {
              tools: opts.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.parameters,
              })),
            });

          case "tools/call":
            return result(id, await callTool(request.params ?? {}));

          case "ping":
            return result(id, {});

          default:
            return error(id, -32601, `Method not found: ${request.method ?? "<missing>"}`);
        }
      } catch (err: unknown) {
        return error(id, -32000, err instanceof Error ? err.message : String(err));
      }
    },
  };

  return server;
}
