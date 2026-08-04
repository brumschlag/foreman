import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createAcpSubprocessClient, DEFAULT_ACP_COMMAND } from "../acp-client.js";
import { createAcpTurnAccumulator, foldSessionUpdate } from "../acp-transport.js";
import { createAcpPhaseRunner } from "../acp-phase-runner.js";
import type { PhaseRunnerOptions } from "../phase-runner.js";

/**
 * These drive the real SDK against a spawned process. The adapter itself is not
 * installed here, so the cases cover the failure paths a phase must survive —
 * the happy path needs a live adapter and an API key, which belongs in a manual
 * smoke run rather than the unit suite.
 */

function options(worktree: string, overrides: Partial<PhaseRunnerOptions> = {}): PhaseRunnerOptions {
  return {
    prompt: "list the modules",
    systemPrompt: "you are the explorer",
    cwd: worktree,
    model: "anthropic/claude-haiku-4-5",
    context: {
      phaseName: "explorer",
      taskId: "task-1",
      taskTitle: "Survey repo",
      worktreePath: worktree,
    },
    ...overrides,
  };
}

describe("acp subprocess client", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "acp-client-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  test("advertises tool-policy enforcement only when a policy is wired", () => {
    expect(createAcpSubprocessClient().enforcesToolPolicy).toBe(false);
    expect(
      createAcpSubprocessClient({ toolPolicy: { check: async () => ({ allowed: true, action: "allow", reason: "ok" }) } })
        .enforcesToolPolicy,
    ).toBe(true);
  });

  // Foreman's 22 workflow tools are Pi ToolDefinitions with no ACP equivalent, so
  // this must stay false until they are exposed through mcpServers — the runner
  // relies on it to refuse a phase that needs them.
  test("does not claim to provide Foreman custom tools", () => {
    expect(createAcpSubprocessClient().providesCustomTools).toBe(false);
  });

  // A missing adapter arrives as an async 'error' event, not a throw. Unraced it
  // becomes an unhandled rejection while the phase waits forever.
  test("reports a missing adapter binary as a phase failure instead of hanging", async () => {
    const runner = createAcpPhaseRunner(
      createAcpSubprocessClient({ command: "foreman-acp-agent-that-does-not-exist" }),
    );

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^agent-error:/);
    expect(result.errorMessage).toMatch(/failed to spawn ACP agent/);
  }, 20_000);

  // An agent that never speaks ACP would otherwise stall the phase indefinitely.
  test("times out an agent that never completes the turn", async () => {
    const runner = createAcpPhaseRunner(
      createAcpSubprocessClient({ command: "sleep", args: ["30"], timeoutMs: 200 }),
    );

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^agent-error:/);
    expect(result.errorMessage).toMatch(/exceeded 200ms/);
  }, 20_000);

  // An adapter that exits immediately (bad flags, missing API key) must fail the
  // phase rather than leave the runner awaiting a stream that will never produce.
  test("fails the phase when the agent exits without speaking ACP", async () => {
    const runner = createAcpPhaseRunner(
      createAcpSubprocessClient({ command: "true", timeoutMs: 5_000 }),
    );

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^agent-error:/);
  }, 20_000);

  // A turn is one assistant/tool exchange, NOT one streamed text chunk. Counting
  // chunks reported 28 turns for a 3-turn phase in a live run, which corrupts the
  // maxTurns gate and budget accounting.
  test("counts turns as message boundaries, not text chunks", () => {
    const acc = createAcpTurnAccumulator();
    for (const text of ["a", "b", "c"]) {
      foldSessionUpdate(acc, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    }
    foldSessionUpdate(acc, { sessionUpdate: "tool_call", toolCallId: "1", title: "Read", rawInput: {} });
    for (const text of ["d", "e"]) {
      foldSessionUpdate(acc, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    }

    // Two assistant messages separated by a tool call — not five.
    expect(acc.turns).toBe(2);
    expect(acc.outputText).toBe("abcde");
  });

  test("defaults to the Claude ACP adapter bin name", () => {
    expect(DEFAULT_ACP_COMMAND).toBe("claude-agent-acp");
  });
});

describe("acp subprocess client custom tools", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "acp-tools-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  // Once tools are served over MCP the runner must stop refusing write phases,
  // otherwise the whole port is inert.
  test("advertises custom tool support when tools are supplied", () => {
    const client = createAcpSubprocessClient({ customTools: [] });

    expect(client.providesCustomTools).toBe(true);
  });

  test("does not advertise custom tool support when no tools are supplied", () => {
    expect(createAcpSubprocessClient().providesCustomTools).toBe(false);
  });

  // The MCP server binds a port per phase. If a failed phase does not close it the
  // listener leaks for the life of the worker, and a long run leaks one per phase.
  test("closes the tool MCP server even when the phase fails", async () => {
    const listeners: number[] = [];
    const client = createAcpSubprocessClient({
      command: "foreman-acp-agent-that-does-not-exist",
      customTools: [],
      onToolServerListening: (port) => listeners.push(port),
    });

    const result = await createAcpPhaseRunner(client)(options(worktree));

    expect(result.success).toBe(false);
    expect(listeners).toHaveLength(1);
    // The port must be free again: rebinding it proves the listener was released.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(listeners[0], "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }, 20_000);
});

describe("acp subprocess client worktree safety", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "acp-teardown-"));
    mkdirSync(join(worktree, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  // A write phase commits and pushes mid-run (checkpointPr), so killing the agent
  // can interrupt git and strand .git/index.lock. Every later git command in that
  // worktree then fails with "Another git process seems to be running" — including
  // the retry — so the task is wedged, not retried.
  test("clears a stale git lock after the phase so the worktree stays usable", async () => {
    const lock = join(worktree, ".git", "index.lock");
    writeFileSync(lock, "");
    const cleared: string[] = [];

    const runner = createAcpPhaseRunner(
      createAcpSubprocessClient({
        command: "foreman-acp-agent-that-does-not-exist",
        onWorktreeLocksCleared: (paths) => cleared.push(...paths),
      }),
    );

    await runner(options(worktree));

    expect(existsSync(lock)).toBe(false);
    expect(cleared).toEqual([lock]);
  }, 20_000);

  test("reports nothing when the phase left no lock behind", async () => {
    const cleared: string[] = [];

    const runner = createAcpPhaseRunner(
      createAcpSubprocessClient({
        command: "foreman-acp-agent-that-does-not-exist",
        onWorktreeLocksCleared: (paths) => cleared.push(...paths),
      }),
    );

    await runner(options(worktree));

    expect(cleared).toEqual([]);
  }, 20_000);
});

describe("acp teardown ordering", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "acp-order-"));
    mkdirSync(join(worktree, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  // Clearing locks is only safe BECAUSE the agent is already gone. If teardown ran
  // the clear while the child still lived it could delete a LIVE lock and corrupt a
  // commit in progress — the ordering is the safety property, not the removal. This
  // uses a real long-lived process that ignores EOF, so it must be reaped by signal.
  test("waits for the agent to exit before clearing locks", async () => {
    writeFileSync(join(worktree, ".git", "index.lock"), "");
    let aliveAtClear: boolean | undefined;
    let pid: number | undefined;

    const client = createAcpSubprocessClient({
      command: "sleep",
      args: ["30"],
      timeoutMs: 300,
      onAgentSpawned: (spawnedPid) => { pid = spawnedPid; },
      onWorktreeLocksCleared: () => {
        // process.kill(pid, 0) throws ESRCH once the process is gone.
        try {
          if (pid !== undefined) process.kill(pid, 0);
          aliveAtClear = true;
        } catch {
          aliveAtClear = false;
        }
      },
    });

    // Capture the pid the client spawned via the listening hook's sibling path:
    // stderr fires from the live child, so first data proves it started.
    const result = await createAcpPhaseRunner(client)(
      options(worktree, { onText: () => {} }),
    );

    expect(result.success).toBe(false);
    expect(aliveAtClear).toBe(false);
  }, 20_000);
});
