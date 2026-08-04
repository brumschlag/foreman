import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ToolPolicyDecision } from "./pi-sdk-runner.js";
import type { AcpClient, AcpPromptRequest, AcpPromptResult, AcpStopReason } from "./acp-phase-runner.js";
import {
  acpSpawnEnv,
  acpTokenAccounting,
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

export function createAcpSubprocessClient(opts: AcpSubprocessClientOptions = {}): AcpClient {
  return {
    // Foreman answers session/request_permission itself, so the gate is enforced
    // on the client side of the connection rather than inside the agent.
    enforcesToolPolicy: opts.toolPolicy !== undefined,
    // Foreman's workflow tools have no ACP equivalent yet; until they are exposed
    // through mcpServers a phase requiring them is refused by the runner.
    providesCustomTools: false,

    async prompt(request: AcpPromptRequest): Promise<AcpPromptResult> {
      const child = spawn(opts.command ?? DEFAULT_ACP_COMMAND, opts.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: request.cwd,
        env: acpSpawnEnv({ model: request.model }, opts.env ?? process.env),
      });

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

          return ctx.buildSession(request.cwd).withSession(async (active) => {
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
        // The adapter keeps writing after the turn resolves, so killing it outright
        // tears down the pipe under an in-flight write and it dies on an unhandled
        // EPIPE. Ending stdin lets it observe EOF and exit on its own; the kill is
        // only a backstop for one that ignores EOF, since an orphaned child gets
        // the whole process group SIGTERMed at command end.
        child.stdout?.destroy();
        child.stdin?.end();
        if (child.exitCode === null && child.signalCode === null) {
          const reap = setTimeout(() => child.kill("SIGTERM"), 250);
          reap.unref();
          child.once("exit", () => clearTimeout(reap));
        }
      }
    },
  };
}
