/**
 * Patch-collision recovery, exercised against REAL git.
 *
 * Every kelos phase runs in a fresh pod, so each agent writes its own
 * SESSION_LOG.md at the worktree root. A later phase's patch re-adds that path and
 * `git apply --index` refuses, failing a run whose agent phases all succeeded.
 *
 * Driven through git rather than a stub because a stub hid the actual requirement:
 * the first fix cleared only the index, git then refused with "already exists in
 * working directory", and the mock-based test still passed.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GitBackend } from "../../lib/vcs/git-backend.js";
import { createKelosPhaseRunner } from "../kelos-phase-runner.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

/** A repo where phase 1's patch is already applied, plus phase 2's patch. */
function repoWithPriorPhase(): { repo: string; patch: string } {
  const repo = mkdtempSync(join(tmpdir(), "kelos-collide-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "."]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);

  // Phase 2's patch: its own SESSION_LOG.md plus the task's real work.
  writeFileSync(join(repo, "SESSION_LOG.md"), "phase2\n", "utf8");
  writeFileSync(join(repo, "KELOS_SMOKE.md"), "work\n", "utf8");
  git(repo, ["add", "-A"]);
  const patch = git(repo, ["diff", "--cached", "--binary", "HEAD"]);
  git(repo, ["reset", "-q", "--hard", "HEAD"]);
  rmSync(join(repo, "SESSION_LOG.md"), { force: true });
  rmSync(join(repo, "KELOS_SMOKE.md"), { force: true });

  // Phase 1 already contributed its session log, staged and on disk.
  writeFileSync(join(repo, "SESSION_LOG.md"), "phase1\n", "utf8");
  git(repo, ["add", "SESSION_LOG.md"]);

  return { repo, patch };
}

describe("kelos patch collision recovery (real git)", () => {
  test("applies a later phase's patch over an earlier phase's session log", async () => {
    const { repo, patch } = repoWithPriorPhase();

    const runner = createKelosPhaseRunner(
      {
        runTask: async () => ({
          succeeded: true,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          files: [],
          transport: "patch" as const,
          patchKey: "k",
        }),
      },
      {
        vcs: new GitBackend(repo),
        localWorktreePath: repo,
        patchStore: { presignPut: async () => "https://example.invalid", get: async () => patch },
      },
    );

    const result = await runner({
      prompt: "p",
      systemPrompt: "s",
      cwd: repo,
      model: "claude-haiku",
      context: { phaseName: "developer", taskId: "t1" },
    } as never);

    expect(result.errorMessage).toBeUndefined();
    expect(result.success).toBe(true);

    // The task's actual work landed, which is the point of the phase.
    const staged = git(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    expect(staged).toContain("KELOS_SMOKE.md");
  });

  test("a real conflict in the task's own files still fails", async () => {
    const { repo } = repoWithPriorPhase();

    const runner = createKelosPhaseRunner(
      {
        runTask: async () => ({
          succeeded: true,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          files: [],
          transport: "patch" as const,
          patchKey: "k",
        }),
      },
      {
        vcs: new GitBackend(repo),
        localWorktreePath: repo,
        // A patch against content that is not there cannot apply.
        patchStore: {
          presignPut: async () => "https://example.invalid",
          get: async () =>
            [
              "diff --git a/README.md b/README.md",
              "index 1111111..2222222 100644",
              "--- a/README.md",
              "+++ b/README.md",
              "@@ -1 +1 @@",
              "-something that is not in the file",
              "+replacement",
              "",
            ].join("\n"),
        },
      },
    );

    const result = await runner({
      prompt: "p",
      systemPrompt: "s",
      cwd: repo,
      model: "claude-haiku",
      context: { phaseName: "developer", taskId: "t1" },
    } as never);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^merge_conflict:/);
  });
});
