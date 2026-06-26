/**
 * dispatcher-milestone.test.ts — Tests for TRD-2026-016 / TRD-001: milestone
 * bead detection and pipeline routing in the dispatcher.
 *
 * Verifies:
 *  1. A milestone-typed seed is routed to `spawnMilestonePipeline()` instead
 *     of `spawnAgent()`.
 *  2. Non-milestone seeds (task, epic, feature, bug, chore) continue to use
 *     the standard `spawnAgent()` path with no regression.
 *  3. A mixed batch (one milestone + one task) dispatches the task normally
 *     and routes the milestone to the milestone pipeline stub.
 *  4. When `spawnMilestonePipeline()` throws, the seed is reported in the
 *     `skipped` list with the failure reason (dispatch continues for other
 *     seeds).
 *  5. The default `spawnMilestonePipeline()` stub resolves and is callable
 *     with the standard spawn signature (returning a synthetic session key).
 *
 * Mock pattern is identical to dispatcher-epic.test.ts: the same vi.mock()
 * blocks are used so the construction, VCS, workflow, templates, and store
 * behaviors match the existing dispatch test suite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../dispatcher.js";
import type { ITaskClient, Issue } from "../../lib/task-client.js";
import type { ForemanStore } from "../../lib/store.js";
import { VcsBackendFactory } from "../../lib/vcs/index.js";
import type { EpicTask } from "../pipeline-executor.js";

// ── Module Mocks (mirror dispatcher-epic.test.ts) ────────────────────────────

vi.mock("../../lib/vcs/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/vcs/index.js")>();
  return {
    ...original,
    VcsBackendFactory: {
      create: vi.fn().mockResolvedValue({
        name: "git",
        createWorkspace: vi.fn().mockResolvedValue({
          workspacePath: "/tmp/worktrees/test",
          branchName: "foreman/test",
        }),
      }),
      resolveBackend: vi.fn((config: { backend: "git" | "jujutsu" | "auto" }) =>
        config.backend === "auto" ? "git" : config.backend),
    },
  };
});

vi.mock("../../lib/vcs/git-backend.js", () => ({
  GitBackend: class {
    async getCurrentBranch(): Promise<string> { return "main"; }
    async detectDefaultBranch(): Promise<string> { return "main"; }
    async branchExists(): Promise<boolean> { return false; }
    async createWorkspace(_repoPath: string, seedId: string): Promise<{ workspacePath: string; branchName: string }> {
      return { workspacePath: `/tmp/worktrees/${seedId}`, branchName: `foreman/${seedId}` };
    }
  },
}));

vi.mock("../../lib/worktree-manager.js", () => ({
  WorktreeManager: class {
    async createWorktree(opts: { projectId: string; beadId: string; repoPath: string; baseBranch?: string }) {
      return {
        projectId: opts.projectId,
        beadId: opts.beadId,
        branchName: `foreman/${opts.beadId}`,
        path: `/tmp/worktrees/${opts.projectId}/${opts.beadId}`,
        exists: false,
      };
    }
  },
}));

vi.mock("../../lib/setup.js", () => ({
  installDependencies: vi.fn().mockResolvedValue(undefined),
  runSetupWithCache: vi.fn().mockResolvedValue(undefined),
  runWorkspaceHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/workflow-loader.js", () => ({
  loadWorkflowConfig: vi.fn().mockReturnValue({
    name: "default",
    phases: [],
  }),
  resolveWorkflowName: vi.fn((type: string) => {
    if (type === "milestone") return "milestone";
    if (type === "epic") return "epic";
    return "default";
  }),
}));

vi.mock("../../lib/workflow-config-loader.js", () => ({
  resolveWorkflowType: vi.fn((type: string) => type),
}));

vi.mock("../../lib/project-config.js", () => ({
  loadProjectConfig: vi.fn().mockReturnValue(null),
  resolveVcsConfig: vi.fn().mockReturnValue({ backend: "git" }),
}));

vi.mock("../templates.js", () => ({
  workerAgentMd: vi.fn().mockReturnValue("# TASK.md content"),
}));

vi.mock("../pi-rpc-spawn-strategy.js", () => ({
  isPiAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../lib/beads-rust.js", () => ({
  BeadsRustClient: class {
    async show(_id: string): Promise<never> { throw new Error("not found"); }
  },
}));

// Mock task-ordering — returns 3 ordered tasks by default
vi.mock("../task-ordering.js", () => ({
  getTaskOrder: vi.fn().mockResolvedValue([
    { seedId: "child-1", seedTitle: "Child Task 1" },
    { seedId: "child-2", seedTitle: "Child Task 2" },
    { seedId: "child-3", seedTitle: "Child Task 3" },
  ] as EpicTask[]),
}));

// Mock fs/promises to prevent actual file system writes
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue({ fd: 1, close: vi.fn().mockResolvedValue(undefined) }),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeIssue(id: string, type: string, priority = "P2"): Issue {
  return {
    id,
    title: `${type} ${id}`,
    status: "open",
    priority,
    type,
    assignee: null,
    parent: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

let currentReadyIssues: Issue[] = [];

function nativeTaskFromIssue(issue: Issue) {
  return {
    id: issue.id, title: issue.title, description: issue.description ?? null, type: issue.type,
    priority: Number(String(issue.priority ?? "2").replace(/^P/, "")) || 2, status: "ready",
    run_id: null, branch: null, external_id: null, labels: issue.labels ?? [], parent: issue.parent ?? null,
    created_at: issue.created_at, updated_at: issue.updated_at, approved_at: new Date().toISOString(), closed_at: null,
  };
}

function makeStore(): ForemanStore {
  return {
    getActiveRuns: vi.fn().mockReturnValue([]),
    getRunsByStatus: vi.fn().mockReturnValue([]),
    getRunsByStatuses: vi.fn().mockReturnValue([]),
    getRunsByStatusesSince: vi.fn().mockReturnValue([]),
    getRunsForSeed: vi.fn().mockReturnValue([]),
    getProjectByPath: vi.fn().mockReturnValue({ id: "proj-1" }),
    hasNativeTasks: vi.fn().mockReturnValue(true),
    getReadyTasks: vi.fn(() => currentReadyIssues.map(nativeTaskFromIssue)),
    getTaskByExternalId: vi.fn().mockReturnValue(null),
    getTaskById: vi.fn((id: string) => currentReadyIssues.map(nativeTaskFromIssue).find((task) => task.id === id) ?? null),
    claimTask: vi.fn().mockReturnValue(true),
    hasActiveOrPendingRun: vi.fn().mockReturnValue(false),
    createRun: vi.fn().mockReturnValue({ id: "run-1" }),
    updateRun: vi.fn(),
    logEvent: vi.fn(),
    sendMessage: vi.fn(),
    getPendingBeadWrites: vi.fn().mockReturnValue([]),
  } as unknown as ForemanStore;
}

function makeSeedsClient(overrides: Partial<ITaskClient> = {}): ITaskClient {
  const ready = overrides.ready as unknown as { getMockImplementation?: () => (() => Promise<Issue[]>) | undefined } | undefined;
  const impl = ready?.getMockImplementation?.();
  if (impl) {
    void impl().then((issues) => { currentReadyIssues = issues; });
  }
  return {
    ready: vi.fn().mockResolvedValue([]),
    show: vi.fn().mockResolvedValue({ status: "open" }),
    update: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Dispatcher — Milestone Bead Detection (TRD-2026-016 / TRD-001)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("milestone seed is routed to spawnMilestonePipeline() instead of spawnAgent()", async () => {
    const milestoneIssue = makeIssue("milestone-1", "milestone");
    const seedsClient = makeSeedsClient({
      ready: vi.fn().mockResolvedValue([milestoneIssue]),
      show: vi.fn().mockResolvedValue({ ...milestoneIssue, description: "milestone spec" }),
    });
    const store = makeStore();
    const dispatcher = new Dispatcher(seedsClient, store, "/tmp/project");

    const spawnAgentSpy = vi.spyOn(dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> }, "spawnAgent")
      .mockResolvedValue({ sessionKey: "agent-key" });
    const spawnMilestoneSpy = vi.spyOn(dispatcher as never as { spawnMilestonePipeline: (...args: unknown[]) => Promise<{ sessionKey: string }> }, "spawnMilestonePipeline")
      .mockResolvedValue({ sessionKey: "milestone-stub-key" });

    const result = await dispatcher.dispatch({ pipeline: true });

    // The milestone must be in dispatched (the run was created and the stub
    // resolved) and the milestone pipeline must have been called.
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0].seedId).toBe("milestone-1");
    expect(result.skipped).toHaveLength(0);

    expect(spawnMilestoneSpy).toHaveBeenCalledOnce();
    expect(spawnAgentSpy).not.toHaveBeenCalled();
  });

  // Note: `epic` is intentionally excluded here — once epic decomposition was
  // wired (da7ae4d0), epic seeds route through the epic pipeline (prepareEpicTasks)
  // rather than a plain spawnAgent() dispatch. That behavior is covered by
  // dispatcher-epic.test.ts. This test only verifies non-milestone leaf types.
  it("non-milestone seeds (task/feature/bug/chore) still go through spawnAgent()", async () => {
    const issues: Issue[] = [
      makeIssue("task-1", "task"),
      makeIssue("feat-1", "feature"),
      makeIssue("bug-1", "bug"),
      makeIssue("chore-1", "chore"),
    ];
    const seedsClient = makeSeedsClient({
      ready: vi.fn().mockResolvedValue(issues),
      show: vi.fn().mockImplementation(async (id: string) => {
        const found = issues.find((i) => i.id === id);
        return { ...(found ?? issues[0]!), description: `desc for ${id}` };
      }),
    });
    const store = makeStore();
    const dispatcher = new Dispatcher(seedsClient, store, "/tmp/project");

    const spawnAgentSpy = vi.spyOn(dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> }, "spawnAgent")
      .mockResolvedValue({ sessionKey: "agent-key" });
    const spawnMilestoneSpy = vi.spyOn(dispatcher as never as { spawnMilestonePipeline: (...args: unknown[]) => Promise<{ sessionKey: string }> }, "spawnMilestonePipeline")
      .mockResolvedValue({ sessionKey: "milestone-stub-key" });

    const result = await dispatcher.dispatch({ pipeline: true, maxAgents: 10 });

    expect(result.dispatched).toHaveLength(4);
    expect(result.skipped).toHaveLength(0);
    expect(spawnAgentSpy).toHaveBeenCalledTimes(4);
    expect(spawnMilestoneSpy).not.toHaveBeenCalled();
  });

  it("mixed batch dispatches non-milestones and routes the milestone separately", async () => {
    const taskIssue = makeIssue("task-1", "task");
    const milestoneIssue = makeIssue("milestone-1", "milestone");
    const seedsClient = makeSeedsClient({
      ready: vi.fn().mockResolvedValue([taskIssue, milestoneIssue]),
      show: vi.fn().mockImplementation(async (id: string) => {
        if (id === "milestone-1") return { ...milestoneIssue, description: "milestone spec" };
        return { ...taskIssue, description: "do the task" };
      }),
    });
    const store = makeStore();
    const dispatcher = new Dispatcher(seedsClient, store, "/tmp/project");

    const spawnAgentSpy = vi.spyOn(dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> }, "spawnAgent")
      .mockResolvedValue({ sessionKey: "agent-key" });
    const spawnMilestoneSpy = vi.spyOn(dispatcher as never as { spawnMilestonePipeline: (...args: unknown[]) => Promise<{ sessionKey: string }> }, "spawnMilestonePipeline")
      .mockResolvedValue({ sessionKey: "milestone-stub-key" });

    const result = await dispatcher.dispatch({ pipeline: true });

    // Both dispatched; one through spawnAgent, one through spawnMilestonePipeline.
    expect(result.dispatched.map((d) => d.seedId).sort()).toEqual(["milestone-1", "task-1"]);
    expect(result.skipped).toHaveLength(0);
    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    expect(spawnMilestoneSpy).toHaveBeenCalledOnce();

    // Verify the call routed to spawnAgent was the task and to
    // spawnMilestonePipeline was the milestone.
    const agentCall = spawnAgentSpy.mock.calls[0];
    const agentSeed = agentCall[2] as { id: string };
    expect(agentSeed.id).toBe("task-1");

    const milestoneCall = spawnMilestoneSpy.mock.calls[0];
    const milestoneSeed = milestoneCall[2] as { id: string };
    expect(milestoneSeed.id).toBe("milestone-1");
  });

  it("milestone pipeline failure is captured as a skipped entry (dispatch continues)", async () => {
    const milestoneIssue = makeIssue("milestone-1", "milestone");
    const taskIssue = makeIssue("task-1", "task");
    const seedsClient = makeSeedsClient({
      ready: vi.fn().mockResolvedValue([milestoneIssue, taskIssue]),
      show: vi.fn().mockImplementation(async (id: string) => {
        if (id === "milestone-1") return { ...milestoneIssue, description: "milestone spec" };
        return { ...taskIssue, description: "do the task" };
      }),
    });
    const store = makeStore();
    const dispatcher = new Dispatcher(seedsClient, store, "/tmp/project");

    // First call (milestone) throws, second call (task) succeeds.
    const spawnAgentSpy = vi.spyOn(dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> }, "spawnAgent")
      .mockResolvedValue({ sessionKey: "agent-key" });
    const spawnMilestoneSpy = vi.spyOn(dispatcher as never as { spawnMilestonePipeline: (...args: unknown[]) => Promise<{ sessionKey: string }> }, "spawnMilestonePipeline")
      .mockRejectedValueOnce(new Error("milestone pipeline boom"));

    const result = await dispatcher.dispatch({ pipeline: true });

    // The task still dispatches even though the milestone pipeline threw.
    const dispatchedIds = result.dispatched.map((d) => d.seedId);
    expect(dispatchedIds).toContain("task-1");

    // The milestone is in the skipped list with the failure reason.
    const skippedMilestone = result.skipped.find((s) => s.seedId === "milestone-1");
    expect(skippedMilestone).toBeDefined();
    expect(skippedMilestone!.reason).toMatch(/milestone pipeline boom/i);

    expect(spawnMilestoneSpy).toHaveBeenCalledOnce();
    expect(spawnAgentSpy).toHaveBeenCalledOnce();
  });

  it("default spawnMilestonePipeline() stub is callable and resolves with a synthetic session key", async () => {
    const milestoneIssue = makeIssue("milestone-stub", "milestone");
    const seedsClient = makeSeedsClient({
      ready: vi.fn().mockResolvedValue([milestoneIssue]),
      show: vi.fn().mockResolvedValue({ ...milestoneIssue, description: "stub" }),
    });
    const store = makeStore();
    const dispatcher = new Dispatcher(seedsClient, store, "/tmp/project");

    // Do NOT spy/stub spawnMilestonePipeline — exercise the real (stub) body.
    const spawnAgentSpy = vi.spyOn(dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> }, "spawnAgent")
      .mockResolvedValue({ sessionKey: "agent-key" });

    const result = await dispatcher.dispatch({ pipeline: true });

    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0].seedId).toBe("milestone-stub");
    expect(result.skipped).toHaveLength(0);
    expect(spawnAgentSpy).not.toHaveBeenCalled();

    // The run was recorded with the synthetic session key returned by the stub.
    const updateRunCalls = (store.updateRun as ReturnType<typeof vi.fn>).mock.calls;
    const sessionKeyUpdate = updateRunCalls.find(
      (call) => call[1] && typeof call[1] === "object" && "session_key" in call[1],
    );
    expect(sessionKeyUpdate).toBeDefined();
    const updatePayload = sessionKeyUpdate![1] as { session_key: string; status: string };
    expect(updatePayload.session_key).toMatch(/milestone-stub/);
    expect(updatePayload.status).toBe("running");
  });
});
