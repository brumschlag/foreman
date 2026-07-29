import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createKelosPhaseRunner,
  type KelosClient,
  type KelosTaskResult,
} from "../kelos-phase-runner.js";
import type { PhaseRunnerOptions } from "../phase-runner.js";

function options(worktree: string, overrides: Partial<PhaseRunnerOptions> = {}): PhaseRunnerOptions {
  return {
    prompt: "implement the thing",
    systemPrompt: "you are the developer",
    cwd: worktree,
    model: "anthropic/claude-sonnet-4-6",
    context: {
      phaseName: "developer",
      taskId: "task-1",
      taskTitle: "Add greeting",
      worktreePath: worktree,
    },
    ...overrides,
  };
}

function stubClient(result: Partial<KelosTaskResult> = {}): KelosClient {
  return {
    runTask: async () => ({
      succeeded: true,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      files: [],
      ...result,
    }),
  };
}

describe("kelos phase runner", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "kelos-runner-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  test("writes files produced by the kelos task into the local worktree", async () => {
    const runner = createKelosPhaseRunner(
      stubClient({ files: [{ path: "src/greeting.ts", content: "export const hi = 1;\n" }] }),
    );

    await runner(options(worktree));

    expect(readFileSync(join(worktree, "src/greeting.ts"), "utf-8")).toBe("export const hi = 1;\n");
  });

  test("maps kelos usage accounting onto the phase result", async () => {
    const runner = createKelosPhaseRunner(
      stubClient({ costUsd: 0.42, inputTokens: 1200, outputTokens: 350 }),
    );

    const result = await runner(options(worktree));

    expect(result.success).toBe(true);
    expect(result.costUsd).toBe(0.42);
    expect(result.tokensIn).toBe(1200);
    expect(result.tokensOut).toBe(350);
  });

  test("reports the files it synced so downstream phases can see them", async () => {
    const runner = createKelosPhaseRunner(
      stubClient({
        files: [
          { path: "a.ts", content: "a" },
          { path: "nested/b.ts", content: "b" },
        ],
      }),
    );

    const result = await runner(options(worktree));

    expect(result.filesChanged).toEqual(["a.ts", "nested/b.ts"]);
  });

  test("surfaces a failed kelos task as a failed phase with its error message", async () => {
    const runner = createKelosPhaseRunner(
      stubClient({ succeeded: false, errorMessage: "pod evicted" }),
    );

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("pod evicted");
  });

  test("refuses paths that escape the worktree instead of writing outside it", async () => {
    const runner = createKelosPhaseRunner(
      stubClient({ files: [{ path: "../escaped.ts", content: "pwned" }] }),
    );

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/escape/i);
    expect(existsSync(join(worktree, "..", "escaped.ts"))).toBe(false);
  });

  test("refuses absolute paths outside the worktree", async () => {
    const outside = join(tmpdir(), "kelos-absolute-escape.ts");
    rmSync(outside, { force: true });
    const runner = createKelosPhaseRunner(
      stubClient({ files: [{ path: outside, content: "pwned" }] }),
    );

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });

  describe("git branch transport", () => {
    test("fetches and merges the branch the kelos task pushed", async () => {
      const calls: string[] = [];
      const runner = createKelosPhaseRunner(
        stubClient({ branch: "kelos/task-1-developer", commit: "abc123" }),
        {
          vcs: {
            fetch: async (repoPath) => {
              calls.push(`fetch:${repoPath}`);
            },
            merge: async (repoPath, sourceBranch) => {
              calls.push(`merge:${sourceBranch}`);
              return { success: true, conflicts: [] };
            },
            getChangedFiles: async () => ["src/greeting.ts"],
          },
        },
      );

      const result = await runner(options(worktree));

      expect(result.success).toBe(true);
      // Merges the remote-tracking ref, not the bare branch name: the kelos agent
      // pushed to the remote, so the local repo has no such branch.
      expect(calls).toEqual([`fetch:${worktree}`, "merge:origin/kelos/task-1-developer"]);
      expect(result.filesChanged).toEqual(["src/greeting.ts"]);
    });

    test("fails the phase when the merge conflicts instead of reporting success", async () => {
      const runner = createKelosPhaseRunner(
        stubClient({ branch: "kelos/task-1-developer" }),
        {
          vcs: {
            fetch: async () => {},
            merge: async () => ({ success: false, conflicts: ["src/a.ts"] }),
            getChangedFiles: async () => [],
          },
        },
      );

      const result = await runner(options(worktree));

      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/conflict/i);
      expect(result.errorMessage).toContain("src/a.ts");
    });
  });

  // Foreman's tool policy is enforced by wrapping Pi SDK tool objects in-process
  // (pi-sdk-runner wrapToolWithPolicy). A kelos agent is a separate program in a
  // separate pod, so there is nothing to wrap and the gate cannot run. Silently
  // dropping it would leave a phase looking guarded while every tool call went
  // unchecked, so the phase is refused instead.
  test("refuses to run a phase whose tool policy cannot be enforced", async () => {
    let dispatched = false;
    const runner = createKelosPhaseRunner({
      runTask: async () => {
        dispatched = true;
        return { succeeded: true, costUsd: 0, inputTokens: 0, outputTokens: 0, files: [] };
      },
    });

    const result = await runner(
      options(worktree, {
        toolPolicy: {
          context: { runId: "r", phaseId: "developer" },
          check: async () => ({ allowed: true, action: "allow", reason: "ok" }),
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/tool policy/i);
    // Fail closed: the agent must not run at all.
    expect(dispatched).toBe(false);
  });

  test("runs normally when no tool policy is configured", async () => {
    const runner = createKelosPhaseRunner(stubClient());

    const result = await runner(options(worktree));

    expect(result.success).toBe(true);
  });

  describe("patch transport", () => {
    // The agent uploads a git patch; Foreman applies it to its own worktree. The
    // pod's filesystem is never read, so the pod can be reclaimed immediately.
    test("applies the patch the agent uploaded and reports its files", async () => {
      const applied: string[] = [];
      const runner = createKelosPhaseRunner(
        stubClient({ transport: "patch", patchKey: "foreman/run-1/developer.patch" }),
        {
          patchStore: {
            presignPut: async () => "https://example.invalid/put",
            get: async (key) => (key === "foreman/run-1/developer.patch" ? "PATCH BODY" : null),
          },
          vcs: {
            fetch: async () => {},
            merge: async () => ({ success: true }),
            getChangedFiles: async () => [],
            getModifiedFiles: async () => ["src/greeting.ts"],
            applyPatchToIndex: async (_repo, file) => {
              applied.push(readFileSync(file, "utf-8"));
            },
          },
        },
      );

      const result = await runner(options(worktree));

      expect(result.success).toBe(true);
      expect(applied).toEqual(["PATCH BODY"]);
      expect(result.filesChanged).toEqual(["src/greeting.ts"]);
    });

    // A read-only phase legitimately produces no patch; that must not fail it.
    test("succeeds with no files when the phase uploaded no patch", async () => {
      const runner = createKelosPhaseRunner(
        stubClient({ transport: "patch", patchKey: "foreman/run-1/qa.patch" }),
        {
          patchStore: {
            presignPut: async () => "https://example.invalid/put",
            get: async () => null,
          },
          vcs: {
            fetch: async () => {},
            merge: async () => ({ success: true }),
            getChangedFiles: async () => [],
            getModifiedFiles: async () => [],
            applyPatchToIndex: async () => {
              throw new Error("must not apply when there is no patch");
            },
          },
        },
      );

      const result = await runner(options(worktree));

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual([]);
    });

    // Every kelos phase runs in a fresh pod, so each agent writes its own
    // SESSION_LOG.md at the worktree root. The explorer's patch adds it to the
    // index; the developer's patch then adds the same path and `git apply --index`
    // refuses with "already exists in index".
    //
    // That is a worker-artifact collision, not a conflict in the task's own work,
    // and it stopped a run whose agent phases had all succeeded. Retry without the
    // colliding paths rather than failing the phase.
    test("recovers when a worker artifact already exists in the index", async () => {
      const attempts: string[] = [];
      const runner = createKelosPhaseRunner(
        stubClient({ transport: "patch", patchKey: "k" }),
        {
          patchStore: {
            presignPut: async () => "https://example.invalid/put",
            get: async () => "PATCH",
          },
          vcs: {
            fetch: async () => {},
            merge: async () => ({ success: true }),
            getChangedFiles: async () => [],
            getModifiedFiles: async () => ["KELOS_SMOKE.md"],
            removeFromIndex: async (_repo: string, file: string) => {
              attempts.push(`rm:${file}`);
            },
            applyPatchToIndex: async () => {
              attempts.push("apply");
              if (attempts.filter((a) => a === "apply").length === 1) {
                // git uses TWO wordings depending on whether the path is in the
                // index or only on disk. The first fix matched "in index" only,
                // and the very next live run failed on "in working directory".
                throw new Error("error: SESSION_LOG.md: already exists in working directory");
              }
            },
          },
        },
      );

      const result = await runner(options(worktree));

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(["KELOS_SMOKE.md"]);
      // The colliding path was cleared from the index, then the patch retried.
      expect(attempts).toEqual(["apply", "rm:SESSION_LOG.md", "apply"]);
    });

    // Both wordings must recover: git says "in index" for a tracked path and
    // "in working directory" for one only on disk. Live runs produced each.
    test.each([
      "error: SESSION_LOG.md: already exists in index",
      "error: SESSION_LOG.md: already exists in working directory",
    ])("recovers from %s", async (gitError: string) => {
      const attempts: string[] = [];
      const runner = createKelosPhaseRunner(
        stubClient({ transport: "patch", patchKey: "k" }),
        {
          patchStore: {
            presignPut: async () => "https://example.invalid/put",
            get: async () => "PATCH",
          },
          vcs: {
            fetch: async () => {},
            merge: async () => ({ success: true }),
            getChangedFiles: async () => [],
            getModifiedFiles: async () => ["KELOS_SMOKE.md"],
            removeFromIndex: async (_repo: string, file: string) => {
              attempts.push(`rm:${file}`);
            },
            applyPatchToIndex: async () => {
              attempts.push("apply");
              if (attempts.filter((a) => a === "apply").length === 1) throw new Error(gitError);
            },
          },
        },
      );

      const result = await runner(options(worktree));

      expect(result.success).toBe(true);
      expect(attempts).toEqual(["apply", "rm:SESSION_LOG.md", "apply"]);
    });

    // A genuine conflict must still fail even when removeFromIndex is available,
    // and must not be retried: re-applying a patch git already rejected cannot
    // succeed, and the retry is what an over-broad recovery guard would cause.
    test("does not clear the index or retry for a conflict git did not name", async () => {
      const cleared: string[] = [];
      let applyAttempts = 0;
      const runner = createKelosPhaseRunner(
        stubClient({ transport: "patch", patchKey: "k" }),
        {
          patchStore: {
            presignPut: async () => "https://example.invalid/put",
            get: async () => "PATCH",
          },
          vcs: {
            fetch: async () => {},
            merge: async () => ({ success: true }),
            getChangedFiles: async () => [],
            getModifiedFiles: async () => [],
            removeFromIndex: async (_repo: string, file: string) => {
              cleared.push(file);
            },
            applyPatchToIndex: async () => {
              applyAttempts += 1;
              throw new Error("error: patch failed: src/real.ts:12\nerror: src/real.ts: patch does not apply");
            },
          },
        },
      );

      const result = await runner(options(worktree));

      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/^merge_conflict:/);
      expect(cleared).toEqual([]);
      expect(applyAttempts).toBe(1);
    });

    // A genuine conflict in the task's own files must still fail, so
    // retryWithByReason can route it to the merge-resolver phase.
    // A patch that will not apply is a conflict, and must surface in the form
    // Foreman's retryWithByReason routes to the merge-resolver phase.
    test("fails the phase when the patch does not apply", async () => {
      const runner = createKelosPhaseRunner(
        stubClient({ transport: "patch", patchKey: "k" }),
        {
          patchStore: {
            presignPut: async () => "https://example.invalid/put",
            get: async () => "BAD PATCH",
          },
          vcs: {
            fetch: async () => {},
            merge: async () => ({ success: true }),
            getChangedFiles: async () => [],
            getModifiedFiles: async () => [],
            applyPatchToIndex: async () => {
              throw new Error("patch does not apply");
            },
          },
        },
      );

      const result = await runner(options(worktree));

      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/^merge_conflict:/);
    });
  });

  describe("shared volume transport", () => {
    // opts.cwd is the path the AGENT sees inside the pod; Foreman runs git on its
    // own machine, where that path does not exist. Reading changes from opts.cwd
    // fails with ENOENT, so the local worktree path has to be supplied separately.
    test("reads changes from Foreman's local worktree, not the pod path", async () => {
      const inspected: string[] = [];
      const runner = createKelosPhaseRunner(stubClient({ transport: "volume" }), {
        localWorktreePath: "/home/me/worktrees/task-1",
        vcs: {
          fetch: async () => {},
          merge: async () => ({ success: true }),
          getChangedFiles: async () => [],
          getModifiedFiles: async (p) => {
            inspected.push(p);
            return ["DEVELOPER_REPORT.md"];
          },
        },
      });

      const result = await runner(options(worktree, { cwd: "/workspace" }));

      expect(inspected).toEqual(["/home/me/worktrees/task-1"]);
      expect(result.filesChanged).toEqual(["DEVELOPER_REPORT.md"]);
    });

    test("falls back to cwd when no separate local path is configured", async () => {
      const inspected: string[] = [];
      const runner = createKelosPhaseRunner(stubClient({ transport: "volume" }), {
        vcs: {
          fetch: async () => {},
          merge: async () => ({ success: true }),
          getChangedFiles: async () => [],
          getModifiedFiles: async (p) => {
            inspected.push(p);
            return [];
          },
        },
      });

      await runner(options(worktree));

      expect(inspected).toEqual([worktree]);
    });

    test("reports files the agent wrote into the shared worktree, without touching the remote", async () => {
      const touched: string[] = [];
      const runner = createKelosPhaseRunner(stubClient({ transport: "volume" }), {
        vcs: {
          fetch: async () => {
            touched.push("fetch");
          },
          merge: async () => {
            touched.push("merge");
            return { success: true };
          },
          getChangedFiles: async () => {
            touched.push("getChangedFiles");
            return [];
          },
          getModifiedFiles: async () => ["src/greeting.ts", "docs/notes.md"],
        },
      });

      const result = await runner(options(worktree));

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(["src/greeting.ts", "docs/notes.md"]);
      // Nothing is pushed or fetched: Foreman keeps sole ownership of git.
      expect(touched).toEqual([]);
    });

    test("still fails the phase when a volume-transport task fails", async () => {
      const runner = createKelosPhaseRunner(
        stubClient({ transport: "volume", succeeded: false, errorMessage: "agent crashed" }),
        {
          vcs: {
            fetch: async () => {},
            merge: async () => ({ success: true }),
            getChangedFiles: async () => [],
            getModifiedFiles: async () => [],
          },
        },
      );

      const result = await runner(options(worktree));

      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("agent crashed");
    });
  });
});
