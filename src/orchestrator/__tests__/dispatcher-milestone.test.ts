/**
 * dispatcher-milestone.test.ts — Tests for TRD-001 (TRD-2026-016):
 * milestone detection in the dispatcher.
 *
 * Verifies:
 *  1. Milestone-type tasks are excluded from `listDispatchableReadyTasks`
 *     (postgres-adapter level filter).
 *  2. When a milestone seed reaches the dispatch loop, it is routed to
 *     `spawnMilestonePipeline()` instead of `spawnAgent()`.
 *  3. Non-milestone tasks (epic/task/feature) continue to dispatch through
 *     the standard path without regression.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../dispatcher.js";
import type { ITaskClient, Issue } from "../../lib/task-client.js";
import type { ForemanStore } from "../../lib/store.js";

// ── Module Mocks (parallel to dispatcher-epic.test.ts) ───────────────────────

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
  loadWorkflowConfig: vi.fn().mockReturnValue({ name: "default", phases: [] }),
  resolveWorkflowName: vi.fn((type: string) => {
    if (type === "epic") return "epic";
    if (type === "milestone") return "milestone";
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

vi.mock("../task-ordering.js", () => ({
  getTaskOrder: vi.fn().mockResolvedValue([]),
}));

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

function nativeTaskFromIssue(issue: Issue) {
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description ?? null,
    type: issue.type,
    priority: Number(String(issue.priority ?? "2").replace(/^P/, "")) || 2,
    status: "ready",
    run_id: null,
    branch: null,
    external_id: null,
    labels: issue.labels ?? [],
    parent: issue.parent ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    approved_at: new Date().toISOString(),
    closed_at: null,
  };
}

function makeStore(readyIssues: Issue[]): ForemanStore {
  return {
    getActiveRuns: vi.fn().mockReturnValue([]),
    getRunsByStatus: vi.fn().mockReturnValue([]),
    getRunsByStatuses: vi.fn().mockReturnValue([]),
    getRunsByStatusesSince: vi.fn().mockReturnValue([]),
    getRunsForSeed: vi.fn().mockReturnValue([]),
    getProjectByPath: vi.fn().mockReturnValue({ id: "proj-1" }),
    hasNativeTasks: vi.fn().mockReturnValue(true),
    getReadyTasks: vi.fn(() => readyIssues.map(nativeTaskFromIssue)),
    getTaskByExternalId: vi.fn().mockReturnValue(null),
    getTaskById: vi.fn((id: string) =>
      readyIssues.map(nativeTaskFromIssue).find((task) => task.id === id) ?? null),
    claimTask: vi.fn().mockReturnValue(true),
    hasActiveOrPendingRun: vi.fn().mockReturnValue(false),
    createRun: vi.fn().mockReturnValue({ id: "run-1" }),
    updateRun: vi.fn(),
    logEvent: vi.fn(),
    sendMessage: vi.fn(),
    getPendingBeadWrites: vi.fn().mockReturnValue([]),
  } as unknown as ForemanStore;
}

function makeSeedsClient(): ITaskClient {
  return {
    ready: vi.fn().mockResolvedValue([]),
    show: vi.fn().mockResolvedValue({ status: "open" }),
    update: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  } as unknown as ITaskClient;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Dispatcher — Milestone Detection (TRD-2026-016 / TRD-001)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a milestone seed to spawnMilestonePipeline() instead of spawnAgent()", async () => {
    const milestoneIssue = makeIssue("ms-1", "milestone");
    const store = makeStore([milestoneIssue]);
    const dispatcher = new Dispatcher(makeSeedsClient(), store, "/tmp/project");

    const spawnAgentSpy = vi.spyOn(
      dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> },
      "spawnAgent",
    ).mockResolvedValue({ sessionKey: "should-not-be-called" });

    const milestoneSpy = vi.spyOn(dispatcher, "spawnMilestonePipeline").mockResolvedValue(undefined);

    const result = await dispatcher.dispatch({ pipeline: true });

    expect(milestoneSpy).toHaveBeenCalledOnce();
    expect(milestoneSpy.mock.calls[0][0].id).toBe("ms-1");
    expect(spawnAgentSpy).not.toHaveBeenCalled();

    // Milestone routing is a side-channel — the seed is not added to the
    // standard `dispatched` list because it does not go through spawnAgent.
    expect(result.dispatched).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("non-milestone seeds (task, epic, feature) are unaffected by milestone routing", async () => {
    const taskIssue = makeIssue("task-1", "task");
    const epicIssue = makeIssue("epic-1", "epic");
    const featureIssue = makeIssue("feat-1", "feature");
    const store = makeStore([taskIssue, epicIssue, featureIssue]);
    const dispatcher = new Dispatcher(makeSeedsClient(), store, "/tmp/project");

    const spawnAgentSpy = vi.spyOn(
      dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> },
      "spawnAgent",
    ).mockResolvedValue({ sessionKey: "test-key" });

    const milestoneSpy = vi.spyOn(dispatcher, "spawnMilestonePipeline").mockResolvedValue(undefined);

    const result = await dispatcher.dispatch({ pipeline: true, maxAgents: 5 });

    expect(milestoneSpy).not.toHaveBeenCalled();
    expect(spawnAgentSpy).toHaveBeenCalledTimes(3);
    expect(result.dispatched).toHaveLength(3);
    expect(result.dispatched.map((d) => d.seedId).sort()).toEqual(["epic-1", "feat-1", "task-1"]);
  });

  it("mixed batch dispatches non-milestones via spawnAgent and routes milestones separately", async () => {
    const taskIssue = makeIssue("task-2", "task");
    const milestoneIssue = makeIssue("ms-2", "milestone");
    const store = makeStore([milestoneIssue, taskIssue]);
    const dispatcher = new Dispatcher(makeSeedsClient(), store, "/tmp/project");

    const spawnAgentSpy = vi.spyOn(
      dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> },
      "spawnAgent",
    ).mockResolvedValue({ sessionKey: "test-key" });

    const milestoneSpy = vi.spyOn(dispatcher, "spawnMilestonePipeline").mockResolvedValue(undefined);

    const result = await dispatcher.dispatch({ pipeline: true, maxAgents: 5 });

    expect(milestoneSpy).toHaveBeenCalledOnce();
    expect(milestoneSpy.mock.calls[0][0].id).toBe("ms-2");

    expect(spawnAgentSpy).toHaveBeenCalledOnce();
    const spawnedSeed = spawnAgentSpy.mock.calls[0][2] as { id: string };
    expect(spawnedSeed.id).toBe("task-2");

    expect(result.dispatched.map((d) => d.seedId)).toEqual(["task-2"]);
  });

  it("milestone pipeline routing failure surfaces as a skipped entry (defense-in-depth)", async () => {
    const milestoneIssue = makeIssue("ms-fail", "milestone");
    const store = makeStore([milestoneIssue]);
    const dispatcher = new Dispatcher(makeSeedsClient(), store, "/tmp/project");

    vi.spyOn(
      dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> },
      "spawnAgent",
    ).mockResolvedValue({ sessionKey: "should-not-be-called" });

    vi.spyOn(dispatcher, "spawnMilestonePipeline").mockRejectedValue(new Error("pipeline boom"));

    const result = await dispatcher.dispatch({ pipeline: true });

    expect(result.dispatched).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].seedId).toBe("ms-fail");
    expect(result.skipped[0].reason).toContain("pipeline boom");
  });

  it("default spawnMilestonePipeline() stub is callable and resolves without spawning a worker", async () => {
    const dispatcher = new Dispatcher(makeSeedsClient(), makeStore([]), "/tmp/project");
    const milestoneIssue = makeIssue("ms-stub", "milestone");
    await expect(dispatcher.spawnMilestonePipeline(milestoneIssue)).resolves.toBeUndefined();
  });
});
