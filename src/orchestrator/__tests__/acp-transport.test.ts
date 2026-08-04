import { describe, expect, test, vi } from "vitest";
import {
  acpSpawnEnv,
  foldSessionUpdate,
  createAcpTurnAccumulator,
  resolvePermission,
  acpTokenAccounting,
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
