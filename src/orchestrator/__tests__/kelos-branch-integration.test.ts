/**
 * Integration test for the kelos phase runner's branch transport.
 *
 * The unit tests in kelos-phase-runner.test.ts stub the VCS seam, so they prove
 * the runner *calls* fetch/merge but not that a branch pushed by an external
 * agent actually lands in Foreman's worktree. This exercises the real
 * GitBackend against real git repositories:
 *
 *   1. Bare remote (simulated origin)
 *   2. Foreman's worktree cloned from it
 *   3. A separate clone stands in for the kelos agent Pod: it commits and
 *      pushes a branch, exactly as a kelos agent does
 *   4. The runner fetches and merges that branch into Foreman's worktree
 *   5. The agent's file must exist in Foreman's worktree
 *
 * @module src/orchestrator/__tests__/kelos-branch-integration.test
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitBackend } from "../../lib/vcs/git-backend.js";
import { createKelosPhaseRunner, type KelosClient } from "../kelos-phase-runner.js";
import type { PhaseRunnerOptions } from "../phase-runner.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

function configure(repo: string): void {
  git(["config", "user.email", "foreman-test@example.com"], repo);
  git(["config", "user.name", "Foreman Test"], repo);
}

/** Bare remote plus a seeded `dev` branch, standing in for origin. */
function makeRemote(): string {
  const remote = tmp("kelos-remote-");
  git(["init", "--bare", "-b", "dev"], remote);

  const seed = tmp("kelos-seed-");
  git(["clone", remote, "."], seed);
  configure(seed);
  writeFileSync(join(seed, "README.md"), "# base\n", "utf-8");
  git(["add", "README.md"], seed);
  git(["commit", "-m", "base"], seed);
  git(["push", "origin", "dev"], seed);
  return remote;
}

/** Simulates the kelos agent Pod: commit work on a branch and push it. */
function agentPushesBranch(remote: string, branch: string, file: string, body: string): void {
  const pod = tmp("kelos-pod-");
  git(["clone", remote, "."], pod);
  configure(pod);
  git(["checkout", "-b", branch], pod);
  mkdirSync(dirname(join(pod, file)), { recursive: true });
  writeFileSync(join(pod, file), body, "utf-8");
  git(["add", file], pod);
  git(["commit", "-m", `agent: add ${file}`], pod);
  git(["push", "origin", branch], pod);
}

function options(worktree: string): PhaseRunnerOptions {
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
      targetBranch: "dev",
    },
  };
}

function clientReturning(branch: string): KelosClient {
  return {
    runTask: async () => ({
      succeeded: true,
      costUsd: 0.25,
      inputTokens: 900,
      outputTokens: 150,
      files: [],
      branch,
      commit: "unused",
    }),
  };
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("kelos branch transport (real git)", () => {
  it("lands a branch pushed by the agent into Foreman's worktree", async () => {
    const remote = makeRemote();
    const branch = "kelos/task-1-developer";
    agentPushesBranch(remote, branch, "src/greeting.ts", "export const hi = 1;\n");

    const worktree = tmp("kelos-worktree-");
    git(["clone", remote, "."], worktree);
    configure(worktree);

    const vcs = new GitBackend(worktree);
    const runner = createKelosPhaseRunner(clientReturning(branch), { vcs });

    const result = await runner(options(worktree));

    expect(result.success).toBe(true);
    expect(readFileSync(join(worktree, "src/greeting.ts"), "utf-8")).toBe("export const hi = 1;\n");
    expect(result.filesChanged).toContain("src/greeting.ts");
    expect(result.costUsd).toBe(0.25);
  });

  it("fails the phase when the agent's branch conflicts with the worktree", async () => {
    const remote = makeRemote();
    const branch = "kelos/task-1-conflict";
    agentPushesBranch(remote, branch, "shared.ts", "export const value = 'agent';\n");

    const worktree = tmp("kelos-worktree-");
    git(["clone", remote, "."], worktree);
    configure(worktree);
    // Foreman's side commits a different version of the same file.
    writeFileSync(join(worktree, "shared.ts"), "export const value = 'foreman';\n", "utf-8");
    git(["add", "shared.ts"], worktree);
    git(["commit", "-m", "foreman: conflicting change"], worktree);

    const vcs = new GitBackend(worktree);
    const runner = createKelosPhaseRunner(clientReturning(branch), { vcs });

    const result = await runner(options(worktree));

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^merge_conflict:/);
    expect(result.errorMessage).toContain("shared.ts");
  });
});
