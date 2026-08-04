import { isAbsolute, relative } from "node:path";
import type { ToolPolicyDecision } from "./pi-sdk-runner.js";

/**
 * Pure transport helpers for the ACP backend: environment construction, folding
 * the `session/update` notification stream into phase accounting, and answering
 * `session/request_permission` from Foreman's tool policy.
 *
 * Kept free of subprocess and connection concerns so the mapping is testable
 * without spawning an agent.
 */

export interface AcpSpawnEnvOptions {
  model: string;
}

/**
 * Environment for the agent subprocess.
 *
 * ACP carries no model parameter — `NewSessionRequest` is only cwd,
 * additionalDirectories, mcpServers and _meta, `session/prompt` has no override,
 * and the dedicated `session/select_model` proposal was closed unmerged. Per-phase
 * model routing therefore rides the process boundary, which is portable to any
 * adapter honouring the vendor env vars.
 */
export function acpSpawnEnv(
  opts: AcpSpawnEnvOptions,
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };

  // The adapter shells out to the same Claude binary the Pi path uses, which
  // refuses to start when it believes it is nested inside another session.
  delete env.CLAUDECODE;

  // Last, so an inherited value cannot outrank the phase's routing decision.
  env.ANTHROPIC_MODEL = opts.model;
  return env;
}

// ── session/update folding ───────────────────────────────────────────────

/** Minimal shape of the `session/update` notifications this backend consumes. */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  rawInput?: Record<string, unknown>;
  status?: string;
  /** ACP `ToolKind`: read, edit, delete, move, search, execute, think, fetch, ... */
  kind?: string;
  /** Files the call touched. Absolute paths, per the schema. */
  locations?: Array<{ path?: string; line?: number | null }>;
  /** Tokens currently in context — NOT per-turn input/output. */
  used?: number;
  /** Total context window size in tokens. */
  size?: number;
  /** Cumulative session cost, not a per-turn delta. */
  cost?: { amount?: number; currency?: string };
  /**
   * ACP adds update kinds over time (plan, available_commands_update, ...) and
   * this backend folds only the ones carrying accounting. Accepting the rest keeps
   * a newly-added kind from being a type error at the call site.
   */
  [key: string]: unknown;
}

export interface AcpTurnAccumulator {
  outputText: string;
  /**
   * Assistant message boundaries, not streamed chunks. ACP emits one
   * `agent_message_chunk` per text delta, so counting chunks reported 28 turns for
   * a 3-turn phase — and turns gate `maxTurns` and budget.
   */
  turns: number;
  /** Whether the current run of chunks has already been counted as a turn. */
  inAssistantMessage: boolean;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Context-window occupancy from the latest usage_update, for observability. */
  contextUsed: number;
  contextSize: number;
  seenToolCallIds: Set<string>;
  /**
   * Kind per tool call id. A `tool_call_update` carries no `kind`, so without this
   * a read's late-arriving location would be recorded as a change.
   */
  toolCallKinds: Map<string, string>;
  /**
   * Worktree-relative paths of files MUTATED this phase.
   *
   * Relative because finalize's scope and changed-domain checks match repo-relative
   * prefixes (`packages/foreman_server/`); absolute paths would make them silently
   * never fire.
   */
  filesChanged: string[];
  /**
   * Reported locations that fall outside the worktree. Not changed repo files — a
   * guardrail signal, kept separate so it cannot pollute the scope check.
   */
  locationsOutsideWorktree: string[];
  /** Worktree root, for relativizing reported locations. */
  cwd?: string;
  onText?: (text: string) => void;
}

export function createAcpTurnAccumulator(
  opts: { onText?: (text: string) => void; cwd?: string } = {},
): AcpTurnAccumulator {
  return {
    outputText: "",
    turns: 0,
    inAssistantMessage: false,
    filesChanged: [],
    locationsOutsideWorktree: [],
    cwd: opts.cwd,
    toolCalls: 0,
    toolBreakdown: {},
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    contextUsed: 0,
    contextSize: 0,
    seenToolCallIds: new Set(),
    toolCallKinds: new Map(),
    onText: opts.onText,
  };
}

/** ACP `ToolKind` values that mutate the filesystem. */
const MUTATING_TOOL_KINDS = new Set(["edit", "delete", "move"]);

/**
 * Records the files a mutating tool call touched.
 *
 * Locations arrive on `tool_call` OR on a later `tool_call_update` (the path is
 * often unknown until the write completes), so both paths call this.
 */
function recordLocations(acc: AcpTurnAccumulator, update: AcpSessionUpdate): void {
  const id = update.toolCallId;
  if (update.kind !== undefined && id !== undefined) acc.toolCallKinds.set(id, update.kind);

  // An update carries no kind of its own, so fall back to the one its tool_call
  // reported. Reads report locations too, but only mutations change files —
  // counting reads would inflate finalize's scope-expansion check.
  const kind = update.kind ?? (id !== undefined ? acc.toolCallKinds.get(id) : undefined);
  if (kind !== undefined && !MUTATING_TOOL_KINDS.has(kind)) return;

  for (const location of update.locations ?? []) {
    const path = location?.path;
    if (!path) continue;

    if (!acc.cwd) {
      if (!acc.filesChanged.includes(path)) acc.filesChanged.push(path);
      continue;
    }

    const rel = relative(acc.cwd, path);
    // Outside the worktree: `..`-prefixed or absolute after relativizing. A
    // guardrail signal rather than a changed repo file.
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      if (!acc.locationsOutsideWorktree.includes(path)) acc.locationsOutsideWorktree.push(path);
      continue;
    }
    if (!acc.filesChanged.includes(rel)) acc.filesChanged.push(rel);
  }
}

export function foldSessionUpdate(acc: AcpTurnAccumulator, update: AcpSessionUpdate): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      // First chunk of a message opens a turn; the rest of the run belongs to it.
      if (!acc.inAssistantMessage) {
        acc.inAssistantMessage = true;
        acc.turns += 1;
      }
      // Thought chunks deliberately excluded: reasoning is not phase output, and
      // folding it in would corrupt a report the next phase has to read.
      const text = update.content?.text;
      if (text) {
        acc.outputText += text;
        acc.onText?.(text);
      }
      return;
    }

    case "tool_call": {
      // A tool call ends the assistant message, so text after it opens a new turn.
      acc.inAssistantMessage = false;
      recordLocations(acc, update);
      const id = update.toolCallId;
      if (id !== undefined) {
        if (acc.seenToolCallIds.has(id)) return;
        acc.seenToolCallIds.add(id);
      }
      acc.toolCalls += 1;
      const name = update.title ?? "unknown";
      acc.toolBreakdown[name] = (acc.toolBreakdown[name] ?? 0) + 1;
      return;
    }

    case "tool_call_update": {
      // Locations recorded even for an already-counted call: the path is often
      // unknown at tool_call time and only reported once the write completes.
      recordLocations(acc, update);
      // Progress on an already-counted call. Only an id never seen as a tool_call
      // counts, so out-of-order delivery cannot lose a call or double it.
      const id = update.toolCallId;
      if (id === undefined || acc.seenToolCallIds.has(id)) return;
      acc.seenToolCallIds.add(id);
      acc.toolCalls += 1;
      const name = update.title ?? "unknown";
      acc.toolBreakdown[name] = (acc.toolBreakdown[name] ?? 0) + 1;
      return;
    }

    case "usage_update": {
      // `cost.amount` is CUMULATIVE for the session, so the latest value is the
      // total — summing notifications would multiply the real cost.
      if (typeof update.cost?.amount === "number") {
        acc.costUsd = update.cost.amount;
      }
      // `used`/`size` describe the context window, not tokens billed this turn.
      // Per-turn input/output tokens come from PromptResponse.usage instead.
      if (typeof update.used === "number") acc.contextUsed = update.used;
      if (typeof update.size === "number") acc.contextSize = update.size;
      return;
    }

    default:
      // plan, available_commands_update, current_mode_update and friends carry no
      // accounting Foreman needs; ignoring them keeps this forward-compatible with
      // update kinds added after this was written.
      return;
  }
}

// ── token accounting ─────────────────────────────────────────────────────

/** ACP's `Usage`, from `PromptResponse.usage`. Marked UNSTABLE in the v1 schema. */
export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  thoughtTokens?: number | null;
  totalTokens?: number;
}

/**
 * Folds ACP's usage report into Foreman's tokensIn/tokensOut.
 *
 * `inputTokens` counts only the UNCACHED prompt, so cache reads and writes have to
 * be added or input is under-reported by orders of magnitude — a live phase
 * reported 16 uncached against 39k cached-read and 91k cached-write. Cache-write
 * costs roughly 12.5x cache-read, so dropping these hides the dominant cost driver.
 */
export function acpTokenAccounting(usage: AcpUsage | undefined): {
  tokensIn: number;
  tokensOut: number;
} {
  if (!usage) return { tokensIn: 0, tokensOut: 0 };
  return {
    tokensIn:
      (usage.inputTokens ?? 0) +
      (usage.cachedReadTokens ?? 0) +
      (usage.cachedWriteTokens ?? 0),
    tokensOut: usage.outputTokens ?? 0,
  };
}

// ── session/request_permission ───────────────────────────────────────────

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpPermissionOutcome {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}

export interface ResolvePermissionOptions {
  options: AcpPermissionOption[];
  check: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<ToolPolicyDecision>;
  /** ACP's own id for the call, so a decision is auditable against the turn. */
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

/** Default ceiling for a policy round-trip before the call is denied. */
export const PERMISSION_TIMEOUT_MS = 30_000;

function pick(options: AcpPermissionOption[], kinds: string[]): string | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match.optionId;
  }
  return undefined;
}

/**
 * Answers one `session/request_permission` from Foreman's policy gate.
 *
 * Fails closed on every uncertain path. An unanswered permission request HANGS
 * the turn rather than failing it — retry-forever semantics make a stalled policy
 * backend look like a slow phase — so a timeout or a throw denies rather than
 * waits or allows.
 */
export async function resolvePermission(
  opts: ResolvePermissionOptions,
): Promise<AcpPermissionOutcome> {
  const timeoutMs = opts.timeoutMs ?? PERMISSION_TIMEOUT_MS;

  const deny = (): AcpPermissionOutcome => {
    const rejectId = pick(opts.options, ["reject_once", "reject_always"]);
    // With no reject option offered, cancelling is the only way to stop the call.
    // Selecting an allow option would silently execute a denied tool.
    return rejectId
      ? { outcome: { outcome: "selected", optionId: rejectId } }
      : { outcome: { outcome: "cancelled" } };
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    const decision = await Promise.race([
      opts.check(opts.toolCallId, opts.toolName, opts.args),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`tool policy check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);

    if (!decision.allowed) return deny();

    const allowId = pick(opts.options, ["allow_once", "allow_always"]);
    // An allowed call with no allow option offered cannot be permitted; denying is
    // the honest outcome rather than guessing at an option id.
    return allowId ? { outcome: { outcome: "selected", optionId: allowId } } : deny();
  } catch {
    return deny();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
