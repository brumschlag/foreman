/**
 * Producing the seed patch handed to a kelos phase.
 *
 * Each phase runs in a fresh clone, so Foreman must hand it the accumulated work
 * of earlier phases or a verdict phase reports the task's own output missing.
 *
 * Driven through real git: the previous patch bug survived a stub because the stub
 * did not model git's actual behaviour.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GitBackend } from "../git-backend.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "seed-patch-"));
  dirs.push(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "."]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "base\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  return dir;
}

describe("createWorktreePatch", () => {
  test("captures uncommitted work including new files", async () => {
    const dir = repo();
    // A phase's output is typically a NEW file, which a plain `git diff` misses.
    writeFileSync(join(dir, "KELOS_SMOKE.md"), "made by foreman\n", "utf8");
    writeFileSync(join(dir, "README.md"), "base\nchanged\n", "utf8");

    const patch = await new GitBackend(dir).createWorktreePatch(dir);

    expect(patch).toContain("KELOS_SMOKE.md");
    expect(patch).toContain("made by foreman");
    expect(patch).toContain("changed");
  });

  // The seed is applied inside a fresh agent pod, so anything it carries looks to
  // that agent like part of the task. Shipping worker artifacts made QA return
  // BLOCKING_SCOPE_BREACH: "the developer committed three files instead of one",
  // objecting to TASK.md and SESSION_LOG.md it had itself been handed.
  test("excludes worker-generated artifacts from the seed", async () => {
    const dir = repo();
    writeFileSync(join(dir, "KELOS_SMOKE.md"), "real work\n", "utf8");
    writeFileSync(join(dir, "TASK.md"), "pipeline scratch\n", "utf8");
    writeFileSync(join(dir, "SESSION_LOG.md"), "pipeline scratch\n", "utf8");
    writeFileSync(join(dir, "QA_REPORT.md"), "pipeline scratch\n", "utf8");

    const patch = await new GitBackend(dir).createWorktreePatch(dir);

    expect(patch).toContain("KELOS_SMOKE.md");
    expect(patch).not.toContain("TASK.md");
    expect(patch).not.toContain("SESSION_LOG.md");
    expect(patch).not.toContain("QA_REPORT.md");
  });

  test("returns empty when there is nothing to inherit", async () => {
    // The first phase of a run has no prior work; an empty seed must not look like
    // a failure.
    const dir = repo();

    expect(await new GitBackend(dir).createWorktreePatch(dir)).toBe("");
  });

  test("the patch it produces actually applies to a clean clone", async () => {
    const source = repo();
    writeFileSync(join(source, "KELOS_SMOKE.md"), "made by foreman\n", "utf8");
    const patch = await new GitBackend(source).createWorktreePatch(source);

    // Simulate the pod: a fresh clone of the same base commit.
    const clone = repo();
    const patchFile = join(clone, "seed.patch");
    writeFileSync(patchFile, patch, "utf8");
    execFileSync("git", ["apply", "--index", "seed.patch"], { cwd: clone });

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: clone,
      encoding: "utf8",
    });
    expect(staged).toContain("KELOS_SMOKE.md");
  });
});
