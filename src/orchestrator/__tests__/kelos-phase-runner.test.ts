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

  describe("shared volume transport", () => {
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
