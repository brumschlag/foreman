import type { PiRunResult } from "./pi-sdk-runner.js";
import type { ConfiguredPhaseRunner, PhaseRunnerOptions } from "./phase-runner.js";

/**
 * Why a turn ended. Mirrors ACP's stable v1 `StopReason`.
 *
 * `end_turn` is the only success: the model finished without asking for more
 * tool calls. Every other value is a phase failure with a distinct cause, which
 * is what lets a turn-limit abort stay distinguishable from a crash.
 */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface AcpPromptRequest {
  prompt: string;
  systemPrompt: string;
  /**
   * Passed to the agent subprocess as `ANTHROPIC_MODEL` at spawn time. ACP has no
   * in-protocol model parameter — `session/new` carries only cwd, directories and
   * MCP servers — so per-phase model routing lives at the process boundary.
   */
  model: string;
  /** Session root. ACP requires an absolute path and treats it as a boundary. */
  cwd: string;
  maxTurns?: number;
}

export interface AcpPromptResult {
  stopReason: AcpStopReason;
  /** From ACP's `UsageUpdate.cost`, which is modeled in stable v1. */
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  /** Concatenated assistant text from `session/update` notifications. */
  outputText?: string;
  /**
   * Worktree-relative paths mutated this phase, from `ToolCall.locations`.
   *
   * Finalize's scope-expansion and changed-domain checks read this, so an empty
   * list on a write phase produces a false pass rather than a visible gap.
   */
  filesChanged?: string[];
  errorMessage?: string;
}

export interface AcpClient {
  prompt(request: AcpPromptRequest): Promise<AcpPromptResult>;
  /**
   * True when this client answers `session/request_permission` from Foreman's
   * policy gate. Checked BEFORE dispatch: discovering it afterwards would mean
   * the agent already ran unguarded.
   *
   * SCOPE — verified live against claude-agent-acp 0.64.2: the agent raises a
   * permission request for MUTATIONS (a denied `Write` never reached disk) but not
   * for reads or read-only terminal commands, and no permission mode changes that.
   * So this means "mutations are gated", NOT "every tool call is gated". A phase
   * needing reads gated cannot get that from this backend, and treating the flag as
   * total coverage would be gate theatre.
   */
  enforcesToolPolicy?: boolean;
  /**
   * True when this client exposes Foreman's workflow tools to the agent (via
   * ACP's `mcpServers` passthrough). Foreman's 22 custom tools have no ACP
   * equivalent, so a phase requiring them cannot run against a client without.
   */
  providesCustomTools?: boolean;
}

function refuse(errorMessage: string): PiRunResult {
  return {
    success: false,
    costUsd: 0,
    turns: 0,
    toolCalls: 0,
    toolBreakdown: {},
    tokensIn: 0,
    tokensOut: 0,
    errorMessage,
    filesChanged: [],
  };
}

function failureFor(result: AcpPromptResult, maxTurns?: number): string | undefined {
  switch (result.stopReason) {
    case "end_turn":
      return undefined;
    case "max_turn_requests":
      return `Phase exceeded maxTurns (${maxTurns ?? result.turns})`;
    case "max_tokens":
      return "Phase hit the model's output token limit before finishing";
    case "refusal":
      return "The model refused to continue the phase";
    case "cancelled":
      return "agent-error: the ACP session was cancelled before the turn completed";
  }
}

export function createAcpPhaseRunner(client: AcpClient): ConfiguredPhaseRunner {
  return async (opts: PhaseRunnerOptions): Promise<PiRunResult> => {
    // In-process the policy wraps Pi SDK tool objects, which cannot reach an agent
    // running as a separate subprocess. Over ACP the equivalent gate is the
    // client's `session/request_permission` handler; a client without one leaves
    // every tool call unchecked, so refuse rather than run the phase looking
    // protected while it is not.
    if (opts.toolPolicy && !client.enforcesToolPolicy) {
      return refuse(
        "agent-error: tool policy cannot be enforced on the ACP backend; " +
          "the policy gate wraps in-process Pi SDK tools and an ACP agent runs as a separate subprocess",
      );
    }

    // Foreman's workflow verbs (artifact_write, phase_handoff, needs_retry, ...)
    // are Pi ToolDefinitions with no ACP equivalent. Running without them yields a
    // phase that cannot write its artifact or signal a retry — a half-executed
    // phase whose failure surfaces later at whichever phase needs the missing work.
    const requestedTools = opts.customTools ?? [];
    if (requestedTools.length > 0 && !client.providesCustomTools) {
      const names = requestedTools.map((tool) => tool.name).join(", ");
      return refuse(
        `agent-error: phase requires Foreman custom tools the ACP client cannot provide (${names}); ` +
          "port them to an MCP server and pass it through session/new mcpServers",
      );
    }

    let result: AcpPromptResult;
    try {
      result = await client.prompt({
        prompt: opts.prompt,
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        cwd: opts.cwd,
        maxTurns: opts.maxTurns,
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return refuse(`agent-error: ACP session failed: ${reason}`);
    }

    if (result.outputText) {
      opts.onText?.(result.outputText);
    }

    let errorMessage = result.errorMessage ?? failureFor(result, opts.maxTurns);

    // Backstop for a silently unproductive phase: a real model call always
    // consumes tokens, so turns with zero tokens in AND out means every request
    // failed (e.g. an auth rejection on each turn) even when the agent reported a
    // clean stop. Without this such a phase reports success having done nothing.
    if (!errorMessage && result.turns > 0 && result.tokensIn === 0 && result.tokensOut === 0) {
      errorMessage = `Phase made ${result.turns} turn(s) but consumed no tokens; the provider rejected every request`;
    }

    return {
      success: errorMessage === undefined,
      costUsd: result.costUsd,
      turns: result.turns,
      toolCalls: result.toolCalls,
      toolBreakdown: result.toolBreakdown,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      errorMessage,
      outputText: result.outputText,
      filesChanged: result.filesChanged ?? [],
    };
  };
}
