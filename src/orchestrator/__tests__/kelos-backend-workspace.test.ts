/**
 * The kelos backend must actually USE the per-project workspace resolution.
 *
 * A correct helper the backend never calls is the exact failure this repo already
 * shipped once: the tool-policy install machinery was right, `kelos-backend` never
 * populated the client's `toolPolicy`, and the first live dispatch failed one layer
 * below where the wiring stopped. So these assert `Task.spec.workspaceRef` on the
 * object the REAL backend creates, not on a re-implementation of its logic.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const createTask = vi.fn(async (_task: unknown) => "task-name");

vi.mock("../kelos-kubectl-api.js", () => ({
  createKubectlKelosApi: () => ({
    createTask,
    getTask: async () => ({ status: { phase: "Succeeded" } }),
  }),
}));

const saved = { ...process.env };

beforeEach(() => {
  createTask.mockClear();
  process.env.KELOS_NAMESPACE = "kelos-pilot";
});

afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

/** The workspaceRef on the Task the backend created for one phase. */
async function dispatchAndReadWorkspaceRef(config: {
  workspace: string;
  projectConfigFor?: (id: string) => Promise<Record<string, unknown> | undefined>;
  workerPool?: string;
  projectId?: string;
}): Promise<{ name: string } | undefined> {
  const { createKelosBackend } = await import("../kelos-backend.js");

  const runner = createKelosBackend({
    namespace: "kelos-pilot",
    workspace: config.workspace,
    agentType: "claude-code",
    pollIntervalMs: 0,
    workerPool: config.workerPool,
    projectConfigFor: config.projectConfigFor,
    envOverridesFor: () => [],
    gatewayModel: (model: string) => model,
  });

  await runner({
    model: "claude-haiku",
    prompt: "p",
    systemPrompt: "s",
    cwd: "/tmp",
    context: {
      phaseName: "explorer",
      taskId: "t-1",
      taskTitle: "t",
      worktreePath: "/tmp",
      projectId: config.projectId ?? "inpulse",
    },
    // A refusal is an expected outcome for the fail-closed case, and the
    // assertion is on whether a Task was created.
  } as never).catch(() => undefined);

  const task = createTask.mock.calls[0]?.[0] as
    | { spec?: { workspaceRef?: { name: string } } }
    | undefined;
  return task?.spec?.workspaceRef;
}

describe("kelos backend per-project workspace", () => {
  test("uses the workspace the owning project declares", async () => {
    const ref = await dispatchAndReadWorkspaceRef({
      workspace: "packer-pipeline-test",
      projectConfigFor: async () => ({ name: "inpulse", kelosWorkspace: "inpulse" }),
    });

    expect(ref).toEqual({ name: "inpulse" });
  });

  test("falls back to KELOS_WORKSPACE for a project that declares none", async () => {
    // The regression guard: an existing deployment that only sets the env var
    // must behave exactly as it did before this change.
    const ref = await dispatchAndReadWorkspaceRef({
      workspace: "packer-pipeline-test",
      projectConfigFor: async () => ({ name: "foreman-bench" }),
    });

    expect(ref).toEqual({ name: "packer-pipeline-test" });
  });

  test("falls back when no lookup is configured at all", async () => {
    const ref = await dispatchAndReadWorkspaceRef({ workspace: "packer-pipeline-test" });

    expect(ref).toEqual({ name: "packer-pipeline-test" });
  });

  test("refuses to dispatch when the project's config could not be read", async () => {
    // Falling back here would run the agent against a DIFFERENT repository than
    // the task targets, so no Task may be created at all.
    await dispatchAndReadWorkspaceRef({
      workspace: "packer-pipeline-test",
      projectConfigFor: async () => {
        throw new Error("server unreachable");
      },
    });

    expect(createTask).not.toHaveBeenCalled();
  });
});
