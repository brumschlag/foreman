/**
 * dispatcher-milestone.test.ts — Tests for TRD-2026-016: milestone layer.
 *
 * Verifies:
 *  1. Milestone tasks dispatch as single-agent planning checkpoints
 *  2. detectMilestoneCycle correctly identifies cycles
 *  3. detectMilestoneCycle returns empty array for valid graphs
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher, detectMilestoneCycle } from "../dispatcher.js";
import type { ITaskClient, Issue } from "../../lib/task-client.js";
import type { ForemanStore } from "../../lib/store.js";
import { VcsBackendFactory } from "../../lib/vcs/index.js";
import type { EpicTask } from "../pipeline-executor.js";

// ── Module Mocks ─────────────────────────────────────────────────────────────
// NOTE: These are copied verbatim from dispatcher-epic.test.ts as required.

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

// ── Dispatcher milestone tests ────────────────────────────────────────────────

describe("Dispatcher — Milestone Dispatch (TRD-2026-016)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("milestone task dispatches as a single-agent planning checkpoint", async () => {
    const milestoneIssue = makeIssue("milestone-1", "milestone");
    const seedsClient = makeSeedsClient({
      ready: vi.fn().mockResolvedValue([milestoneIssue]),
      show: vi.fn().mockResolvedValue({ ...milestoneIssue }),
    });
    const store = makeStore();
    const dispatcher = new Dispatcher(seedsClient, store, "/tmp/project");

    const spawnSpy = vi.spyOn(
      dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> },
      "spawnAgent",
    ).mockResolvedValue({ sessionKey: "test-key" });

    const result = await dispatcher.dispatch({ pipeline: true });

    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0].seedId).toBe("milestone-1");
    expect(result.skipped).toHaveLength(0);

    // Dispatched as single-agent — no epicTasks
    expect(spawnSpy).toHaveBeenCalledOnce();
    const callArgs = spawnSpy.mock.calls[0];
    const epicTasks = callArgs[10] as EpicTask[] | undefined;
    expect(epicTasks).toBeUndefined();
  });

  it("milestone and regular task both dispatch independently", async () => {
    const milestoneIssue = makeIssue("milestone-2", "milestone");
    const taskIssue = makeIssue("task-1", "task");

    const seedsClient = makeSeedsClient({
      ready: vi.fn().mockResolvedValue([milestoneIssue, taskIssue]),
      show: vi.fn().mockImplementation(async (id: string) => {
        if (id === "milestone-2") return { ...milestoneIssue };
        return { ...taskIssue, description: "do the thing" };
      }),
    });
    const store = makeStore();
    const dispatcher = new Dispatcher(seedsClient, store, "/tmp/project");

    const spawnSpy = vi.spyOn(
      dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> },
      "spawnAgent",
    ).mockResolvedValue({ sessionKey: "test-key" });

    const result = await dispatcher.dispatch({ pipeline: true, maxAgents: 2 });

    expect(result.dispatched).toHaveLength(2);
    expect(result.dispatched.map((d) => d.seedId)).toContain("milestone-2");
    expect(result.dispatched.map((d) => d.seedId)).toContain("task-1");
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });
});

// ── detectMilestoneCycle unit tests ───────────────────────────────────────────

describe("detectMilestoneCycle", () => {
  it("returns empty array when there are no nodes", () => {
    expect(detectMilestoneCycle([])).toEqual([]);
  });

  it("returns empty array for a valid linear chain", () => {
    const nodes = [
      { id: "m1", parentId: null },
      { id: "t1", parentId: "m1" },
      { id: "t2", parentId: "m1" },
    ];
    expect(detectMilestoneCycle(nodes)).toEqual([]);
  });

  it("returns empty array for independent nodes", () => {
    const nodes = [
      { id: "m1", parentId: null },
      { id: "m2", parentId: null },
      { id: "t1", parentId: "m1" },
    ];
    expect(detectMilestoneCycle(nodes)).toEqual([]);
  });

  it("detects a direct self-cycle", () => {
    const nodes = [{ id: "m1", parentId: "m1" }];
    const cycles = detectMilestoneCycle(nodes);
    expect(cycles).toContain("m1");
  });

  it("detects a two-node cycle (A → B → A)", () => {
    const nodes = [
      { id: "m1", parentId: "m2" },
      { id: "m2", parentId: "m1" },
    ];
    const cycles = detectMilestoneCycle(nodes);
    expect(cycles.length).toBeGreaterThan(0);
    // Both nodes are in the cycle
    expect(cycles).toContain("m1");
    expect(cycles).toContain("m2");
  });

  it("detects a three-node cycle (A → B → C → A)", () => {
    const nodes = [
      { id: "m1", parentId: "m3" },
      { id: "m2", parentId: "m1" },
      { id: "m3", parentId: "m2" },
    ];
    const cycles = detectMilestoneCycle(nodes);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("does not flag nodes outside the cycle", () => {
    const nodes = [
      { id: "m1", parentId: "m2" },
      { id: "m2", parentId: "m1" },
      { id: "safe", parentId: null }, // not in cycle
    ];
    const cycles = detectMilestoneCycle(nodes);
    expect(cycles).not.toContain("safe");
  });
});
