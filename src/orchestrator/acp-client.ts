import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolPolicyDecision } from "./pi-sdk-runner.js";
import { createForemanToolMcpServer } from "./foreman-tool-mcp-server.js";
import type { AcpClient, AcpPromptRequest, AcpPromptResult, AcpStopReason } from "./acp-phase-runner.js";
import {
  acpSpawnEnv,
  acpTokenAccounting,
  clearStaleGitLocks,
  createAcpTurnAccumulator,
  foldSessionUpdate,
  resolvePermission,
  type AcpPermissionOption,
  type AcpSessionUpdate,
  type AcpUsage,
} from "./acp-transport.js";

/**
 * ACP client over a spawned agent subprocess.
 *
 * Foreman is the CLIENT: it launches the agent (`claude-agent-acp` by default)
 * and drives one session per phase over stdio. One subprocess per phase is what
 * makes per-phase model routing work, since the model is only settable through
 * the spawn environment.
 */

export interface AcpSubprocessClientOptions {
  /** Adapter executable. Defaults to the Claude ACP adapter's bin name. */
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Foreman's policy gate, wired to `session/request_permission`. */
  toolPolicy?: {
    check: (
      toolCallId: string,
      toolName: string,
      args: Record<string, unknown>,
    ) => Promise<ToolPolicyDecision>;
  };
  onText?: (text: string) => void;
  /** Ceiling on one phase. A hung agent must fail the phase, not stall the run. */
  timeoutMs?: number;
  /** Receives the agent's stderr, which ACP reserves for logging. */
  onStderr?: (chunk: string) => void;
  /**
   * Foreman's workflow tools, served to the agent over MCP.
   *
   * The same Pi ToolDefinition objects the in-process runner uses — they close over
   * this phase's context, so nothing about the run has to reach the subprocess.
   */
  customTools?: ToolDefinition[];
  /** Fires with the tool server's bound port. For tests and diagnostics. */
  onToolServerListening?: (port: number) => void;
  /** Fires with the git lock files teardown removed, if any. */
  onWorktreeLocksCleared?: (paths: string[]) => void;
  /** Fires with the agent's pid once spawned. For tests and diagnostics. */
  onAgentSpawned?: (pid: number) => void;
}

export const DEFAULT_ACP_COMMAND = "claude-agent-acp";
export const DEFAULT_PHASE_TIMEOUT_MS = 30 * 60_000;

function stopReasonOf(response: { stopReason?: string }): AcpStopReason {
  const reason = response.stopReason;
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return reason;
    default:
      // An unrecognised stop reason must not read as success — a future protocol
      // value would otherwise silently pass a phase that did not finish.
      return "cancelled";
  }
}

/** How long teardown waits for the agent to exit on EOF before SIGTERM, then KILL. */
const REAP_GRACE_MS = 250;
const REAP_KILL_MS = 2_000;

/**
 * Wait for the agent process to actually exit.
 *
 * Teardown has to know the child is GONE before touching git locks: clearing a
 * lock while the process might still be running would delete a live one. Escalates
 * EOF → SIGTERM → SIGKILL and resolves regardless, since a hung teardown would
 * stall the phase it is cleaning up after.
 */
async function reapChild(child: { exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (signal?: NodeJS.Signals) => boolean; once: (event: "exit", listener: () => void) => unknown }): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(term);
      clearTimeout(kill);
      resolve();
    };
    const term = setTimeout(() => child.kill("SIGTERM"), REAP_GRACE_MS);
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, REAP_KILL_MS);
    term.unref();
    kill.unref();
    child.once("exit", finish);
  });
}

export function createAcpSubprocessClient(opts: AcpSubprocessClientOptions = {}): AcpClient {
  return {
    // Foreman answers session/request_permission itself, so the gate is enforced
    // on the client side of the connection rather than inside the agent.
    enforcesToolPolicy: opts.toolPolicy !== undefined,
    // Served over MCP and passed through on session/new, so the runner no longer
    // has to refuse a phase that needs them.
    providesCustomTools: opts.customTools !== undefined,

    async prompt(request: AcpPromptRequest): Promise<AcpPromptResult> {
      // Bound before the spawn: session/new needs the URL, and binding after would
      // race the agent's first tool call.
      const toolServer = opts.customTools
        ? createForemanToolMcpServer({ tools: opts.customTools })
        : undefined;
      const toolListener = toolServer ? await toolServer.listen() : undefined;
      if (toolListener) opts.onToolServerListening?.(toolListener.port);

      const child = spawn(opts.command ?? DEFAULT_ACP_COMMAND, opts.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: request.cwd,
        env: acpSpawnEnv({ model: request.model }, opts.env ?? process.env),
      });

      if (child.pid !== undefined) opts.onAgentSpawned?.(child.pid);

      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => opts.onStderr?.(chunk));

      // A spawn failure (adapter not installed) arrives as an async 'error' event,
      // not a throw, so it has to be raced against the session or it surfaces as an
      // unhandled rejection while the phase waits forever.
      const spawnFailed = new Promise<never>((_resolve, reject) => {
        child.once("error", (err: Error) =>
          reject(new Error(`failed to spawn ACP agent '${opts.command ?? DEFAULT_ACP_COMMAND}': ${err.message}`)),
        );
      });

      // cwd so reported absolute locations can be relativized against the worktree.
      const acc = createAcpTurnAccumulator({ onText: opts.onText, cwd: request.cwd });

      const session = (async (): Promise<AcpPromptResult> => {
        const stream = acp.ndJsonStream(
          Writable.toWeb(child.stdin),
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        );

        const app = acp.client({ name: "foreman" }).onRequest(
          acp.methods.client.session.requestPermission,
          async (ctx: { params: unknown }) => {
            const params = ctx.params as {
              options?: AcpPermissionOption[];
              toolCall?: { toolCallId?: string; title?: string; rawInput?: Record<string, unknown> };
            };
            const check = opts.toolPolicy?.check;
            if (!check) {
              // No gate configured. The runner refuses a policy-gated phase before
              // dispatch, so reaching here means the phase is ungated by design.
              const allow = params.options?.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
              return allow
                ? { outcome: { outcome: "selected", optionId: allow.optionId } }
                : { outcome: { outcome: "cancelled" } };
            }
            return resolvePermission({
              options: params.options ?? [],
              check,
              toolCallId: params.toolCall?.toolCallId ?? "unknown",
              toolName: params.toolCall?.title ?? "unknown",
              args: params.toolCall?.rawInput ?? {},
            });
          },
        );

        return app.connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            // Terminal is declined: Bash runs inside the agent's own SDK rather
            // than over ACP terminals, and the adapter falls back to a code block.
            // fs is declined too so the agent uses its own reads under the cwd
            // boundary instead of round-tripping every file through Foreman.
            clientCapabilities: {},
          });

          // The full NewSessionRequest form, so Foreman's tools ride along as an
          // HTTP MCP server the agent connects back to.
          return ctx
            .buildSession({
              cwd: request.cwd,
              // `headers` is required by McpServerHttp even when empty.
              mcpServers: toolListener
                ? [{ type: "http" as const, name: "foreman", url: toolListener.url, headers: [] }]
                : [],
            })
            .withSession(async (active) => {
            const turn = active.prompt(
              `${request.systemPrompt}\n\n${request.prompt}`,
            );

            let cancelledForTurnLimit = false;

            for (;;) {
              const message = await active.nextUpdate();
              if (message.kind === "stop") {
                const response = (await turn) as { stopReason?: string; usage?: AcpUsage };
                // PromptResponse.usage is marked UNSTABLE in the v1 schema, so it
                // may be absent; the cumulative cost from usage_update still lands.
                const tokens = acpTokenAccounting(response.usage);
                return {
                  stopReason: stopReasonOf(response),
                  costUsd: acc.costUsd,
                  tokensIn: tokens.tokensIn,
                  tokensOut: tokens.tokensOut,
                  turns: Math.max(acc.turns, 1),
                  toolCalls: acc.toolCalls,
                  toolBreakdown: acc.toolBreakdown,
                  outputText: acc.outputText || undefined,
                  filesChanged: acc.filesChanged,
                  // Read from the tool server, not the turn: a control tool's return
                  // value reaches the agent as text only, so this is the only path
                  // by which an abort or retry request gets back to the pipeline.
                  ...(toolServer?.controlOutcome()
                    ? { controlOutcome: toolServer.controlOutcome() }
                    : {}),
                  // A cancel we initiated is a turn-limit abort, not the agent
                  // stopping on its own; the runner needs that distinction to
                  // report `maxTurns` rather than a bare cancellation.
                  ...(cancelledForTurnLimit ? { stopReason: "max_turn_requests" as const } : {}),
                } satisfies AcpPromptResult;
              }

              foldSessionUpdate(acc, message.notification.update as AcpSessionUpdate);

              // Enforce the ceiling actively. Reading only the terminal stopReason
              // would let a runaway phase burn its whole budget first — the
              // developer phase allows 500 turns.
              if (request.maxTurns && acc.turns > request.maxTurns && !cancelledForTurnLimit) {
                cancelledForTurnLimit = true;
                await ctx.notify(acp.methods.agent.session.cancel, {
                  sessionId: active.sessionId,
                });
              }
            }
          });
        });
      })();

      const timeoutMs = opts.timeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`ACP phase exceeded ${timeoutMs}ms without completing`)),
          timeoutMs,
        );
      });

      try {
        return await Promise.race([session, spawnFailed, timedOut]);
      } finally {
        if (timer) clearTimeout(timer);
        // Release the bound port on every exit path. A failed phase that leaves it
        // open leaks a listener for the life of the worker — one per phase.
        if (toolListener) await toolListener.close();
        // The adapter keeps writing after the turn resolves, so killing it outright
        // tears down the pipe under an in-flight write and it dies on an unhandled
        // EPIPE. Ending stdin lets it observe EOF and exit on its own; the kill is
        // only a backstop for one that ignores EOF, since an orphaned child gets
        // the whole process group SIGTERMed at command end.
        child.stdout?.destroy();
        child.stdin?.end();
        await reapChild(child);

        // Only AFTER the agent is gone. A write phase commits and pushes mid-run
        // (checkpointPr), so an interrupted git leaves .git/index.lock behind and
        // every later git command in the worktree — the retry included — fails with
        // "Another git process seems to be running". Clearing it while the child
        // might still be running could instead delete a LIVE lock, so the ordering
        // is the safety property, not the removal.
        const cleared = clearStaleGitLocks(request.cwd);
        if (cleared.length > 0) opts.onWorktreeLocksCleared?.(cleared);
      }
    },
  };
}
