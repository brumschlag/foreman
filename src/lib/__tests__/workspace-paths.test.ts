import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTrackedStateRestoreCommand,
  getTasksIssuesPathForWorkspace,
  getWorkspacePath,
  getWorkspaceRoot,
  inferProjectPathFromWorkspacePath,
} from "../workspace-paths.js";

describe("workspace path helpers", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("builds external workspace paths", () => {
    expect(getWorkspaceRoot("/tmp/repo")).toBe("/tmp/.foreman-worktrees/repo");
    expect(getWorkspacePath("/tmp/repo", "foreman-123")).toBe("/tmp/.foreman-worktrees/repo/foreman-123");
    expect(inferProjectPathFromWorkspacePath("/tmp/.foreman-worktrees/repo/foreman-123")).toBe("/tmp/repo");
  });

  it("uses local tasks state for external workspaces", () => {
    expect(getTasksIssuesPathForWorkspace("/tmp/.foreman-worktrees/repo/foreman-123", "/tmp/repo")).toBe(".tasks/issues.jsonl");
  });

  it("uses main repo tasks state for nested legacy workspaces", () => {
    expect(getTasksIssuesPathForWorkspace("/tmp/repo/.foreman-worktrees/foreman-123", "/tmp/repo")).toBe("../../.tasks/issues.jsonl");
  });

  // Asserted against REAL git rather than by substring: the pathspecs are globs,
  // so "does the command mention TASK.md" cannot tell whether git actually
  // unstages it, nor whether a repo's own docs/SESSION_LOG.md is spared.
  //
  // The first end-to-end in-cluster run opened a PR containing the task's file
  // plus TASK.md and REVIEW_SESSION_LOG.md, because the old list enumerated exact
  // names and missed both.
  it("unstages worker artifacts but keeps real content", () => {
    const repo = mkdtempSync(join(tmpdir(), "foreman-unstage-"));
    tmpDirs.push(repo);
    const git = (args: string): void => {
      execSync(`git ${args}`, { cwd: repo, stdio: "pipe" });
    };
    git("init -q .");
    git("config user.email t@t");
    git("config user.name t");
    mkdirSync(join(repo, "docs"), { recursive: true });

    const artifacts = [
      "TASK.md",
      "BLOCKED.md",
      "SESSION_LOG.md",
      "RUN_LOG.md",
      "SESSION_LOG_DOCS.md",
      "REVIEW_SESSION_LOG.md",
      "QA_SESSION_LOG.md",
      "QA_DETAILED_SESSION_LOG.md",
      "QA_VERIFICATION_SESSION.md",
      "EXPLORER_HANDOFF.json",
      "QA_REPORT.md",
      "DEVELOPER_REPORT.md",
      "REVIEW.md",
      "FINALIZE_VALIDATION.md",
    ];
    const keep = [
      "CLUSTER_SMOKE.md",
      "src_real.ts",
      "README.md",
      "CHANGELOG.md",
      join("docs", "SESSION_LOG.md"),
    ];
    for (const f of [...artifacts, ...keep]) writeFileSync(join(repo, f), "x", "utf8");
    git("add -A");

    execSync(buildTrackedStateRestoreCommand(repo, repo), { cwd: repo, stdio: "pipe", shell: "/bin/bash" });

    const staged = execSync("git diff --cached --name-only", { cwd: repo, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);

    for (const artifact of artifacts) {
      expect(staged, `${artifact} must not reach the PR`).not.toContain(artifact);
    }
    for (const file of keep) {
      expect(staged, `${file} must be kept`).toContain(file.replace(/\\/g, "/"));
    }
  });
});
