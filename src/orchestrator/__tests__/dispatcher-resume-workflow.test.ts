import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Regression test: resuming a stuck/failed run must preserve the workflow the
 * run was dispatched with. Previously `resumeAgent` spawned the worker with a
 * stub seed and no `workflowName`, so the resumed worker re-resolved the
 * workflow by (missing) task type and ran the wrong pipeline.
 */

// Mock child_process.spawn so no real worker process is created (and so the
// written worker-config file is NOT read+deleted by a real worker).
const mockSpawn = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: mockSpawn };
});

// Mock fs.open to avoid real log file descriptors; keep writeFile/mkdir real so
// the worker config is actually written to disk for inspection.
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockOpen = vi.fn().mockResolvedValue({ fd: 3, close: mockClose });
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: (...args: unknown[]) => mockOpen(...args) };
});

const { mockLoadProjectConfig } = vi.hoisted(() => ({ mockLoadProjectConfig: vi.fn() }));
vi.mock("../../lib/project-config.js", () => ({
  loadProjectConfig: (...args: unknown[]) => mockLoadProjectConfig(...args),
}));

const { Dispatcher } = await import("../dispatcher.js");
import type { ITaskClient } from "../../lib/task-client.js";
import type { ForemanStore } from "../../lib/store.js";

function makeStuckRun() {
  return {
    id: "run-old",
    project_id: "proj-1",
    seed_id: "seed-1",
    agent_type: "anthropic/claude-haiku-4-5",
    // session_key MUST contain a `session-<id>` segment to be resumable
    session_key: "foreman:sdk:claude-haiku-4-5:run-old:session-abc123",
    worktree_path: "/tmp/worktree/seed-1",
    status: "stuck",
    started_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    progress: null,
  };
}

describe("resumeRuns — preserves workflow override on the resumed worker", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "foreman-resume-wf-"));
    vi.stubEnv("HOME", tmpHome);
    mockSpawn.mockClear();
    mockLoadProjectConfig.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("writes the resolved workflowName into the resumed worker config", async () => {
    const seedsClient: ITaskClient = {
      ready: vi.fn().mockResolvedValue([]),
      show: vi.fn().mockResolvedValue({ status: "in-progress", type: "task", labels: [], priority: 2 }),
      update: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };
    const store = {} as unknown as ForemanStore;

    const overrides = {
      externalProjectId: "proj-1",
      getActiveRuns: vi.fn().mockResolvedValue([]),
      getRunsByStatus: vi.fn().mockResolvedValue([makeStuckRun()]),
      getRun: vi.fn().mockResolvedValue(makeStuckRun()),
      runOps: {
        createRun: vi.fn().mockResolvedValue({ ...makeStuckRun(), id: "run-new", status: "pending" }),
        updateRun: vi.fn().mockResolvedValue(undefined),
        logEvent: vi.fn().mockResolvedValue(undefined),
      },
    };

    const dispatcher = new Dispatcher(seedsClient, store, "/tmp/project", null, overrides);

    const result = await dispatcher.resumeRuns({ maxAgents: 1, statuses: ["stuck"], workflow: "smoke" });

    expect(result.resumed).toHaveLength(1);

    const configPath = join(tmpHome, ".foreman", "tmp", "worker-run-new.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.workflowName).toBe("smoke");
  });
});
