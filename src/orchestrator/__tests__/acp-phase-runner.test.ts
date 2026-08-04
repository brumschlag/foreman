import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createAcpPhaseRunner,
  type AcpClient,
  type AcpPromptRequest,
  type AcpPromptResult,
} from "../acp-phase-runner.js";
import type { PhaseRunnerOptions } from "../phase-runner.js";

function options(worktree: string, overrides: Partial<PhaseRunnerOptions> = {}): PhaseRunnerOptions {
  return {
    prompt: "explore the repo",
    systemPrompt: "you are the explorer",
    cwd: worktree,
    model: "anthropic/claude-haiku-4-5",
    context: {
      phaseName: "explorer",
      taskId: "task-1",
      taskTitle: "Add greeting",
      worktreePath: worktree,
    },
    ...overrides,
  };
}

function stubClient(
  result: Partial<AcpPromptResult> = {},
  capabilities: Partial<Pick<AcpClient, "enforcesToolPolicy" | "providesCustomTools">> = {},
): AcpClient & { requests: AcpPromptRequest[] } {
  const requests: AcpPromptRequest[] = [];
  return {
    requests,
    ...capabilities,
    prompt: async (request) => {
      requests.push(request);
      return {
        stopReason: "end_turn",
        costUsd: 0,
        tokensIn: 1,
        tokensOut: 1,
        turns: 1,
        toolCalls: 0,
        toolBreakdown: {},
        ...result,
      };
    },
  };
}

describe("acp phase runner", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "acp-runner-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  test("passes prompt, system prompt, model and cwd through to the ACP session", async () => {
    const client = stubClient();
    const runner = createAcpPhaseRunner(client);

    await runner(options(worktree, { maxTurns: 12 }));

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      prompt: "explore the repo",
      systemPrompt: "you are the explorer",
      model: "anthropic/claude-haiku-4-5",
      cwd: worktree,
      maxTurns: 12,
    });
  });

  test("reports usage accounting from the ACP UsageUpdate", async () => {
    const runner = createAcpPhaseRunner(
      stubClient({ costUsd: 0.42, tokensIn: 1200, tokensOut: 340, turns: 4, toolCalls: 7 }),
    );

    const result = await runner(options(worktree));

    expect(result).toMatchObject({
      success: true,
      costUsd: 0.42,
      tokensIn: 1200,
      tokensOut: 340,
      turns: 4,
      toolCalls: 7,
    });
  });

  // A phase whose policy gate cannot be honored must be refused BEFORE dispatch.
  // Discovering it afterwards would mean the agent already ran unguarded.
  test("refuses a policy-gated phase when the client cannot enforce the tool policy", async () => {
    const client = stubClient();
    const runner = createAcpPhaseRunner(client);

    const result = await runner(
      options(worktree, {
        toolPolicy: {
          context: { runId: "run-1", phaseId: "explorer" },
          check: async () => ({ allowed: true, action: "allow", reason: "ok" }),
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^agent-error:/);
    expect(result.errorMessage).toMatch(/tool policy/i);
    expect(client.requests).toHaveLength(0);
  });

  test("runs a policy-gated phase when the client enforces the tool policy", async () => {
    const client = stubClient({}, { enforcesToolPolicy: true });
    const runner = createAcpPhaseRunner(client);

    const result = await runner(
      options(worktree, {
        toolPolicy: {
          context: { runId: "run-1", phaseId: "explorer" },
          check: async () => ({ allowed: true, action: "allow", reason: "ok" }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(client.requests).toHaveLength(1);
  });

  // Foreman's custom tools (artifact_write, phase_handoff, needs_retry, ...) have
  // no ACP equivalent yet. A phase that needs them would run silently missing its
  // workflow verbs, so refuse rather than produce a half-executed phase.
  test("refuses a phase that requests custom tools the client cannot provide", async () => {
    const client = stubClient();
    const runner = createAcpPhaseRunner(client);

    const result = await runner(
      options(worktree, {
        customTools: [{ name: "artifact_write" }, { name: "needs_retry" }] as never,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^agent-error:/);
    expect(result.errorMessage).toMatch(/custom tools/i);
    expect(result.errorMessage).toMatch(/artifact_write/);
    expect(client.requests).toHaveLength(0);
  });

  // Pi enforces maxTurns by ABORTING the session mid-run. Reading only the terminal
  // stopReason would let a runaway phase burn its whole budget (developer allows
  // 500 turns) before stopping on its own, so the runner must surface the limit and
  // the client must be able to cancel.
  test("reports files changed during the phase", async () => {
    const runner = createAcpPhaseRunner(
      stubClient({ filesChanged: ["src/math.js", "src/greet.js"] }),
    );

    const result = await runner(options(worktree));

    expect(result.filesChanged).toEqual(["src/math.js", "src/greet.js"]);
  });

  // pipeline-executor reads result.controlOutcome to route ABORTED/NEEDS_RETRY.
  // Without it an abort_phase call over MCP is just text to the agent and the
  // phase continues as though nothing happened.
  test("surfaces a control outcome raised by a tool", async () => {
    const runner = createAcpPhaseRunner(
      stubClient({
        controlOutcome: { type: "ABORTED", reason: "approach is unworkable", suggestion: null },
      }),
    );

    const result = await runner(options(worktree));

    expect(result.controlOutcome).toEqual({
      type: "ABORTED",
      reason: "approach is unworkable",
      suggestion: null,
    });
  });

  test("treats max_turn_requests as a turn-limit failure, not a crash", async () => {
    const runner = createAcpPhaseRunner(stubClient({ stopReason: "max_turn_requests", turns: 12 }));

    const result = await runner(options(worktree, { maxTurns: 12 }));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/maxTurns \(12\)/);
  });

  test("treats a refusal as a phase failure", async () => {
    const runner = createAcpPhaseRunner(stubClient({ stopReason: "refusal" }));

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/refus/i);
  });

  test("surfaces a transport error as agent-error", async () => {
    const runner = createAcpPhaseRunner({
      prompt: async () => {
        throw new Error("agent exited before responding to initialize");
      },
    });

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^agent-error:/);
    expect(result.errorMessage).toMatch(/initialize/);
  });

  // A real model call always consumes tokens, so a turn that consumed none means
  // every request failed (e.g. auth rejection). Same backstop as the Pi runner:
  // without it the phase reports success having done nothing.
  test("fails a phase that made turns but consumed no tokens", async () => {
    const runner = createAcpPhaseRunner(stubClient({ turns: 3, tokensIn: 0, tokensOut: 0 }));

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/consumed no tokens/i);
  });

  test("forwards assistant text to onText and returns it as outputText", async () => {
    const chunks: string[] = [];
    const runner = createAcpPhaseRunner(stubClient({ outputText: "found 3 modules" }));

    const result = await runner(options(worktree, { onText: (t) => chunks.push(t) }));

    expect(result.outputText).toBe("found 3 modules");
    expect(chunks.join("")).toBe("found 3 modules");
  });
});
