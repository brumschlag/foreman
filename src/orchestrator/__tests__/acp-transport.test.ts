import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  acpSpawnEnv,
  foldSessionUpdate,
  createAcpTurnAccumulator,
  resolvePermission,
  acpTokenAccounting,
  findStaleGitLocks,
  clearStaleGitLocks,
  type AcpPermissionOption,
} from "../acp-transport.js";

describe("acpSpawnEnv", () => {
  // ACP has no in-protocol model parameter, so per-phase model routing has to ride
  // the process boundary. The adapter reads ANTHROPIC_MODEL at spawn.
  test("carries the phase model as ANTHROPIC_MODEL", () => {
    const env = acpSpawnEnv({ model: "anthropic/claude-haiku-4-5" }, {});

    expect(env.ANTHROPIC_MODEL).toBe("anthropic/claude-haiku-4-5");
  });

  test("preserves provider routing already present in the parent env", () => {
    const env = acpSpawnEnv(
      { model: "anthropic/claude-haiku-4-5" },
      { ANTHROPIC_BASE_URL: "https://gateway.internal", AWS_REGION: "us-east-1" },
    );

    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.internal");
    expect(env.AWS_REGION).toBe("us-east-1");
  });

  // A nested Claude session errors out; the Pi path already strips this and the
  // ACP adapter shells out to the same Claude binary, so it needs the same removal.
  test("strips CLAUDECODE so the adapter does not see a nested session", () => {
    const env = acpSpawnEnv({ model: "m" }, { CLAUDECODE: "1" });

    expect(env.CLAUDECODE).toBeUndefined();
  });

  test("overrides an inherited ANTHROPIC_MODEL so the phase model always wins", () => {
    const env = acpSpawnEnv({ model: "anthropic/claude-haiku-4-5" }, { ANTHROPIC_MODEL: "opus" });

    expect(env.ANTHROPIC_MODEL).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("foldSessionUpdate", () => {
  test("accumulates assistant text from agent_message_chunk", () => {
    const acc = createAcpTurnAccumulator();

    foldSessionUpdate(acc, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } });
    foldSessionUpdate(acc, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } });

    expect(acc.outputText).toBe("hello world");
  });

  // Thought chunks are reasoning, not phase output. Folding them into the artifact
  // text would corrupt a report the next phase has to read.
  test("ignores agent_thought_chunk", () => {
    const acc = createAcpTurnAccumulator();

    foldSessionUpdate(acc, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });

    expect(acc.outputText).toBe("");
  });

  test("counts tool calls per tool name", () => {
    const acc = createAcpTurnAccumulator();

    foldSessionUpdate(acc, { sessionUpdate: "tool_call", toolCallId: "1", title: "Read", rawInput: {} });
    foldSessionUpdate(acc, { sessionUpdate: "tool_call", toolCallId: "2", title: "Read", rawInput: {} });
    foldSessionUpdate(acc, { sessionUpdate: "tool_call", toolCallId: "3", title: "Grep", rawInput: {} });

    expect(acc.toolCalls).toBe(3);
    expect(acc.toolBreakdown).toEqual({ Read: 2, Grep: 1 });
  });

  // tool_call_update reports progress on an ALREADY-counted call. Counting it again
  // would inflate tool counts, which feed budget/turn accounting.
  test("does not double-count a tool_call_update for a known call", () => {
    const acc = createAcpTurnAccumulator();

    foldSessionUpdate(acc, { sessionUpdate: "tool_call", toolCallId: "1", title: "Read", rawInput: {} });
    foldSessionUpdate(acc, { sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed" });

    expect(acc.toolCalls).toBe(1);
  });

  // UsageUpdate.cost is CUMULATIVE for the session, so the last value is the total
  // — summing the notifications would multiply the real cost.
  test("takes the latest cumulative cost rather than summing", () => {
    const acc = createAcpTurnAccumulator();

    foldSessionUpdate(acc, { sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount: 0.01, currency: "USD" } });
    foldSessionUpdate(acc, { sessionUpdate: "usage_update", used: 400, size: 200_000, cost: { amount: 0.05, currency: "USD" } });

    expect(acc.costUsd).toBe(0.05);
  });

  // UsageUpdate carries `used`/`size` — CONTEXT window tokens, not per-turn in/out.
  // Reading them as input/output tokens would report the context size as spend.
  test("does not mistake context-window tokens for input/output tokens", () => {
    const acc = createAcpTurnAccumulator();

    foldSessionUpdate(acc, { sessionUpdate: "usage_update", used: 50_000, size: 200_000 });

    expect(acc.tokensIn).toBe(0);
    expect(acc.tokensOut).toBe(0);
    expect(acc.contextUsed).toBe(50_000);
  });

  test("forwards text chunks to the onText callback as they stream", () => {
    const onText = vi.fn();
    const acc = createAcpTurnAccumulator({ onText });

    foldSessionUpdate(acc, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "chunk" } });

    expect(onText).toHaveBeenCalledWith("chunk");
  });

  test("ignores update kinds it does not model", () => {
    const acc = createAcpTurnAccumulator();

    expect(() =>
      foldSessionUpdate(acc, { sessionUpdate: "available_commands_update", availableCommands: [] }),
    ).not.toThrow();
  });
});

describe("resolvePermission", () => {
  const options: AcpPermissionOption[] = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];

  test("selects an allow option when the policy allows the call", async () => {
    const outcome = await resolvePermission({
      options,
      toolCallId: "call-1",
      check: async () => ({ allowed: true, action: "allow", reason: "ok" }),
      toolName: "Read",
      args: {},
    });

    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  test("selects a reject option when the policy denies the call", async () => {
    const outcome = await resolvePermission({
      options,
      toolCallId: "call-1",
      check: async () => ({ allowed: false, action: "deny", reason: "blocked" }),
      toolName: "Bash",
      args: { command: "rm -rf /" },
    });

    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });

  // An unanswered permission request HANGS the turn rather than failing it, so a
  // policy backend that never responds must fail closed on a timeout.
  test("denies when the policy check exceeds its timeout", async () => {
    const outcome = await resolvePermission({
      options,
      toolCallId: "call-1",
      check: () => new Promise(() => {}),
      toolName: "Bash",
      args: {},
      timeoutMs: 10,
    });

    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });

  test("denies when the policy check throws", async () => {
    const outcome = await resolvePermission({
      options,
      toolCallId: "call-1",
      check: async () => {
        throw new Error("overwatch unreachable");
      },
      toolName: "Bash",
      args: {},
    });

    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });

  // With no reject option to select, cancelling is the only way to stop the call;
  // returning an allow would silently execute a denied tool.
  test("cancels when the agent offered no reject option for a denied call", async () => {
    const outcome = await resolvePermission({
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      toolCallId: "call-1",
      check: async () => ({ allowed: false, action: "deny", reason: "blocked" }),
      toolName: "Bash",
      args: {},
    });

    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("file change tracking", () => {
  // ACP reports absolute paths, but finalize's scope and domain checks match
  // repo-relative prefixes (e.g. "packages/foreman_server/"). Recording absolutes
  // makes those checks silently never fire.
  test("records written files relative to the worktree", () => {
    const acc = createAcpTurnAccumulator({ cwd: "/work/repo" });

    foldSessionUpdate(acc, {
      sessionUpdate: "tool_call",
      toolCallId: "1",
      title: "Write src/math.js",
      locations: [{ path: "/work/repo/src/math.js" }],
    });

    expect(acc.filesChanged).toEqual(["src/math.js"]);
  });

  test("deduplicates a file touched by several tool calls", () => {
    const acc = createAcpTurnAccumulator({ cwd: "/work/repo" });

    for (const id of ["1", "2"]) {
      foldSessionUpdate(acc, {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: "Edit src/math.js",
        locations: [{ path: "/work/repo/src/math.js" }],
      });
    }

    expect(acc.filesChanged).toEqual(["src/math.js"]);
  });

  test("captures every location a single tool call reports", () => {
    const acc = createAcpTurnAccumulator({ cwd: "/work/repo" });

    foldSessionUpdate(acc, {
      sessionUpdate: "tool_call",
      toolCallId: "1",
      title: "MultiEdit",
      locations: [{ path: "/work/repo/a.ts" }, { path: "/work/repo/b.ts" }],
    });

    expect(acc.filesChanged).toEqual(["a.ts", "b.ts"]);
  });

  // A tool_call arrives before the write completes, so the path often lands on the
  // tool_call_update instead. Missing it would under-report changed files.
  test("records locations that arrive on a tool_call_update", () => {
    const acc = createAcpTurnAccumulator({ cwd: "/work/repo" });

    foldSessionUpdate(acc, { sessionUpdate: "tool_call", toolCallId: "1", title: "Write" });
    foldSessionUpdate(acc, {
      sessionUpdate: "tool_call_update",
      toolCallId: "1",
      status: "completed",
      locations: [{ path: "/work/repo/src/late.js" }],
    });

    expect(acc.filesChanged).toEqual(["src/late.js"]);
  });

  // A tool_call_update carries no `kind`, so the kind must be remembered from the
  // originating tool_call — otherwise a read's late-arriving location is recorded
  // as a change and inflates the scope-expansion check.
  test("does not record a late location for a call known to be a read", () => {
    const acc = createAcpTurnAccumulator({ cwd: "/work/repo" });

    foldSessionUpdate(acc, {
      sessionUpdate: "tool_call",
      toolCallId: "1",
      title: "Read src/math.js",
      kind: "read",
    });
    foldSessionUpdate(acc, {
      sessionUpdate: "tool_call_update",
      toolCallId: "1",
      status: "completed",
      locations: [{ path: "/work/repo/src/math.js" }],
    });

    expect(acc.filesChanged).toEqual([]);
  });

  // A path outside the worktree is a guardrail signal, not a changed repo file;
  // relativizing it would produce a misleading "../../etc/passwd" entry.
  test("ignores a location outside the worktree", () => {
    const acc = createAcpTurnAccumulator({ cwd: "/work/repo" });

    foldSessionUpdate(acc, {
      sessionUpdate: "tool_call",
      toolCallId: "1",
      title: "Write",
      locations: [{ path: "/etc/passwd" }],
    });

    expect(acc.filesChanged).toEqual([]);
    expect(acc.locationsOutsideWorktree).toEqual(["/etc/passwd"]);
  });

  // Reads report locations too, but only mutations change files. Counting reads
  // would inflate the scope-expansion check with files nobody edited.
  test("does not record a location from a read-only tool call", () => {
    const acc = createAcpTurnAccumulator({ cwd: "/work/repo" });

    foldSessionUpdate(acc, {
      sessionUpdate: "tool_call",
      toolCallId: "1",
      title: "Read src/math.js",
      kind: "read",
      locations: [{ path: "/work/repo/src/math.js" }],
    });

    expect(acc.filesChanged).toEqual([]);
  });
});

describe("acpTokenAccounting", () => {
  // The adapter reports the prompt's uncached input only. A live Bedrock phase came
  // back inputTokens=16 with cachedReadTokens=39086 and cachedWriteTokens=90933, so
  // reading inputTokens alone under-reports input by ~99.99% and makes cache
  // behaviour — the dominant cost driver — invisible to budget accounting.
  test("counts cached read and write tokens as input", () => {
    const tokens = acpTokenAccounting({
      inputTokens: 16,
      outputTokens: 134,
      cachedReadTokens: 39_086,
      cachedWriteTokens: 90_933,
    });

    expect(tokens).toEqual({ tokensIn: 130_035, tokensOut: 134 });
  });

  test("handles a usage payload with no cache fields", () => {
    expect(acpTokenAccounting({ inputTokens: 10, outputTokens: 5 })).toEqual({
      tokensIn: 10,
      tokensOut: 5,
    });
  });

  // PromptResponse.usage is marked UNSTABLE in the v1 schema, so it can be absent.
  test("reports zero when the agent sent no usage at all", () => {
    expect(acpTokenAccounting(undefined)).toEqual({ tokensIn: 0, tokensOut: 0 });
  });
});

describe("resolvePermission audit identity", () => {
  // ACP puts its own toolCallId on the permission request, so a policy decision is
  // auditable against the exact call in the turn rather than a synthesized key.
  test("forwards ACP's tool call id to the policy gate", async () => {
    const seen: Array<[string, string]> = [];

    await resolvePermission({
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      toolCallId: "call_abc123",
      check: async (toolCallId, toolName) => {
        seen.push([toolCallId, toolName]);
        return { allowed: true, action: "allow", reason: "ok" };
      },
      toolName: "Grep",
      args: { pattern: "x" },
    });

    expect(seen).toEqual([["call_abc123", "Grep"]]);
  });
});

describe("worktree lock safety", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "acp-lock-"));
    mkdirSync(join(worktree, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  // A phase killed mid-commit leaves .git/index.lock behind, and every later git
  // operation in that worktree then fails with "Another git process seems to be
  // running" — including the retry, so the task is wedged rather than retried.
  test("reports a stale index lock left in the worktree", () => {
    writeFileSync(join(worktree, ".git", "index.lock"), "");

    expect(findStaleGitLocks(worktree)).toEqual([join(worktree, ".git", "index.lock")]);
  });

  test("reports nothing for a clean worktree", () => {
    expect(findStaleGitLocks(worktree)).toEqual([]);
  });

  // A worktree's .git is a FILE pointing at the real gitdir, not a directory, so
  // looking only for <worktree>/.git/index.lock misses every locked worktree —
  // which is exactly where Foreman's phases run.
  test("follows the gitdir pointer when .git is a file", () => {
    const realGitDir = join(worktree, "actual-gitdir");
    mkdirSync(realGitDir, { recursive: true });
    rmSync(join(worktree, ".git"), { recursive: true, force: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${realGitDir}\n`);
    writeFileSync(join(realGitDir, "index.lock"), "");

    expect(findStaleGitLocks(worktree)).toEqual([join(realGitDir, "index.lock")]);
  });

  test("finds the other lock files git leaves behind", () => {
    for (const name of ["index.lock", "HEAD.lock", "config.lock"]) {
      writeFileSync(join(worktree, ".git", name), "");
    }

    expect(findStaleGitLocks(worktree).map((p) => p.split("/").pop()).sort()).toEqual([
      "HEAD.lock",
      "config.lock",
      "index.lock",
    ]);
  });

  test("removes the locks it finds", () => {
    writeFileSync(join(worktree, ".git", "index.lock"), "");

    const removed = clearStaleGitLocks(worktree);

    expect(removed).toHaveLength(1);
    expect(findStaleGitLocks(worktree)).toEqual([]);
  });

  // Called on a path that is not a repo at all (a refused phase, a bad cwd), this
  // must not throw — teardown runs in a finally and an exception there would mask
  // the real phase error.
  test("does not throw for a path with no git directory", () => {
    expect(() => clearStaleGitLocks(join(worktree, "nope"))).not.toThrow();
    expect(findStaleGitLocks(join(worktree, "nope"))).toEqual([]);
  });
});
