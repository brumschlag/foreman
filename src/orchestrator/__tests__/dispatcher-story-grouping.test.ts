/**
 * dispatcher-story-grouping.test.ts — Story-level worktree grouping dispatch tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../dispatcher.js";
import type { ITaskClient } from "../../lib/task-client.js";
import type { ForemanStore } from "../../lib/store.js";
import type { EpicTask } from "../pipeline-executor.js";

vi.mock("../../lib/vcs/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/vcs/index.js")>();
  return {
    ...original,
    VcsBackendFactory: {
      create: vi.fn().mockResolvedValue({ name: "git" }),
      resolveBackend: vi.fn(() => "git"),
    },
  };
});

const createWorktreeMock = vi.hoisted(() =>
  vi.fn().mockImplementation(async (opts: { beadId: string }) => ({
    projectId: "proj-1",
    beadId: opts.beadId,
    branchName: `foreman/${opts.beadId}`,
    path: `/tmp/worktrees/proj-1/${opts.beadId}`,
    exists: false,
    created: true,
  })),
);

vi.mock("../../lib/worktree-manager.js", () => ({
  WorktreeManager: class {
    createWorktree = createWorktreeMock;
  },
}));

vi.mock("../../lib/setup.js", () => ({
  installDependencies: vi.fn().mockResolvedValue(undefined),
  runSetupWithCache: vi.fn().mockResolvedValue(undefined),
  runWorkspaceHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/workflow-loader.js", () => ({
  loadWorkflowConfig: vi.fn().mockReturnValue({ name: "default", phases: [] }),
  resolveWorkflowName: vi.fn((type: string) => (type === "story" ? "epic" : "default")),
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

function storyTask(id: string, parentId: string) {
  return {
    id,
    title: `task ${id}`,
    description: null,
    type: "task",
    priority: 2,
    status: "ready",
    run_id: null,
    branch: null,
    external_id: null,
    labels: [],
    parent: parentId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    closed_at: null,
  };
}

function makeStore(readyTasks: ReturnType<typeof storyTask>[]): ForemanStore {
  const storyParent = {
    id: "story-1",
    title: "Story One",
    description: null,
    type: "story",
    priority: 2,
    status: "open",
    run_id: null,
    branch: null,
    external_id: null,
    labels: [],
    parent: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    approved_at: null,
    closed_at: null,
  };

  return {
    getActiveRuns: vi.fn().mockReturnValue([]),
    getRunsByStatus: vi.fn().mockReturnValue([]),
    getRunsByStatuses: vi.fn().mockReturnValue([]),
    getRunsByStatusesSince: vi.fn().mockReturnValue([]),
    getRunsForSeed: vi.fn().mockReturnValue([]),
    getProjectByPath: vi.fn().mockReturnValue({ id: "proj-1" }),
    hasNativeTasks: vi.fn().mockReturnValue(true),
    getReadyTasks: vi.fn().mockReturnValue(readyTasks),
    getTaskByExternalId: vi.fn().mockReturnValue(null),
    getTaskById: vi.fn((id: string) => {
      if (id === "story-1") return storyParent;
      return readyTasks.find((task) => task.id === id) ?? null;
    }),
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
    show: vi.fn().mockImplementation(async (id: string) => {
      if (id === "story-1") {
        return { id: "story-1", title: "Story One", type: "story", status: "open", labels: [] };
      }
      throw new Error(`not found: ${id}`);
    }),
    update: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
}

describe("Dispatcher — story worktree grouping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createWorktreeMock.mockClear();
  });

  it("collapses ready story children into one epic runner dispatch with shared worktree", async () => {
    const readyTasks = [
      storyTask("task-a", "story-1"),
      storyTask("task-b", "story-1"),
    ];
    const store = makeStore(readyTasks);
    const dispatcher = new Dispatcher(makeSeedsClient(), store, "/tmp/project");

    const spawnSpy = vi.spyOn(
      dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> },
      "spawnAgent",
    ).mockResolvedValue({ sessionKey: "test-key" });

    const result = await dispatcher.dispatch({ pipeline: true });

    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0].seedId).toBe("story-1");
    expect(result.skipped).toHaveLength(0);
    expect(spawnSpy).toHaveBeenCalledOnce();

    const callArgs = spawnSpy.mock.calls[0];
    const epicTasks = callArgs[10] as EpicTask[] | undefined;
    const epicId = callArgs[11] as string | undefined;

    expect(epicId).toBe("story-1");
    expect(epicTasks?.map((task) => task.seedId)).toEqual(["task-a", "task-b"]);
    expect(createWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({ beadId: "story-1" }),
    );
  });

  it("skips duplicate story children already scheduled in the same dispatch cycle", async () => {
    const readyTasks = [
      storyTask("task-a", "story-1"),
      storyTask("task-b", "story-1"),
      storyTask("task-c", "story-2"),
      storyTask("task-d", "story-2"),
    ];
    const store = {
      ...makeStore(readyTasks),
      getTaskById: vi.fn((id: string) => {
        if (id === "story-1") {
          return {
            id: "story-1", title: "Story One", type: "story", priority: 2, status: "open",
            run_id: null, branch: null, external_id: null, labels: [], parent: null,
            description: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            approved_at: null, closed_at: null,
          };
        }
        if (id === "story-2") {
          return {
            id: "story-2", title: "Story Two", type: "story", priority: 2, status: "open",
            run_id: null, branch: null, external_id: null, labels: [], parent: null,
            description: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            approved_at: null, closed_at: null,
          };
        }
        return readyTasks.find((task) => task.id === id) ?? null;
      }),
    } as unknown as ForemanStore;

    const seedsClient = {
      ...makeSeedsClient(),
      show: vi.fn().mockImplementation(async (id: string) => {
        if (id === "story-1") return { id: "story-1", title: "Story One", type: "story", status: "open", labels: [] };
        if (id === "story-2") return { id: "story-2", title: "Story Two", type: "story", status: "open", labels: [] };
        throw new Error(`not found: ${id}`);
      }),
    };

    const dispatcher = new Dispatcher(seedsClient, store, "/tmp/project");
    vi.spyOn(
      dispatcher as never as { spawnAgent: (...args: unknown[]) => Promise<{ sessionKey: string }> },
      "spawnAgent",
    ).mockResolvedValue({ sessionKey: "test-key" });

    const result = await dispatcher.dispatch({ pipeline: true, maxAgents: 2 });

    expect(result.dispatched).toHaveLength(2);
    expect(result.dispatched.map((entry) => entry.seedId).sort()).toEqual(["story-1", "story-2"]);
  });
});
