/**
 * End-to-end guard: a non-Node project must survive finalize's toolchain steps.
 *
 * Four separate places assumed every project is Node with a test suite —
 * `npm test` in finalize validation, `npm install` in workflow setup, a QA
 * evidence check demanding runner output, and `npm ci` + `npx tsc --noEmit` in
 * the finalize builtin. Each was found and fixed one at a time, by a live run,
 * because NOTHING in CI ever exercised a project without a package.json. That is
 * the gap this file closes: it asserts the *composed* behaviour over a realistic
 * non-Node worktree rather than one resolver at a time, so a fifth site fails
 * here instead of in-cluster.
 *
 * The fixture mirrors the real repo that surfaced these (packer-pipeline-test):
 * a packer/ansible tree with a Jenkinsfile and no Node manifest anywhere.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  finalizeValidationCommands,
  resolveProjectInstallCommand,
  resolveProjectTestCommand,
  resolveProjectTypecheckCommand,
} from "../finalize-guards.js";
import { setupStepApplies } from "../../lib/setup.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real git worktree, because finalize runs git commands against one. */
function nonNodeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-nonnode-"));
  tmpDirs.push(dir);

  const files: Record<string, string> = {
    "packer.json": JSON.stringify({ builders: [{ type: "amazon-ebs" }] }, null, 2),
    Jenkinsfile: "pipeline { agent any\n  stages { stage('build') { steps { sh 'packer build packer.json' } } }\n}",
    "ansible/site.yml": "- hosts: all\n  tasks:\n    - name: noop\n      ping:\n",
    "README.md": "# packer pipeline\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "foreman-test@example.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Foreman Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("a non-Node project through finalize", () => {
  it("selects no Node toolchain command anywhere", () => {
    const dir = nonNodeWorktree();

    // Every one of these returned a Node command before its own fix. Asserting
    // them together is the point: this fails if any single site regresses.
    expect(resolveProjectInstallCommand(dir)).toBeUndefined();
    expect(resolveProjectTypecheckCommand(dir)).toBeUndefined();
    expect(resolveProjectTestCommand(dir)).toBeUndefined();
  });

  it("skips a bundled npm setup step instead of aborting the run", () => {
    const dir = nonNodeWorktree();

    // The bundled workflows declare this with failFatal: true, which killed a
    // non-Node run before its first phase.
    expect(setupStepApplies({ command: "npm install --prefer-offline --no-audit" }, dir)).toBe(false);
    expect(setupStepApplies({ command: "npm ci" }, dir)).toBe(false);
  });

  it("still runs a project-supplied step it cannot classify", () => {
    const dir = nonNodeWorktree();

    // Skipping is only safe for toolchains we recognise as absent. An unknown
    // command is the author's call, so over-skipping would silently drop real
    // setup work.
    expect(setupStepApplies({ command: "packer init ." }, dir)).toBe(true);
    expect(setupStepApplies({ command: "./scripts/bootstrap.sh" }, dir)).toBe(true);
  });

  it("adds no Node validation for changed non-Node files", () => {
    const changed = ["packer.json", "ansible/site.yml", "Jenkinsfile"];

    const commands = finalizeValidationCommands(changed);

    expect(commands.join(" ")).not.toMatch(/npm|tsc|vitest/);
  });

  it("leaves the worktree intact — no node_modules or lockfile is created", () => {
    const dir = nonNodeWorktree();

    // If a step ran despite being inapplicable, it would leave evidence here.
    expect(resolveProjectInstallCommand(dir)).toBeUndefined();
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(existsSync(join(dir, "package-lock.json"))).toBe(false);

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf-8" });
    expect(status.trim()).toBe("");
  });
});

describe("a Node project is unaffected", () => {
  // The other direction. A skip-everything implementation would pass every
  // assertion above, so this pins that real Node work is still selected.
  function nodeWorktree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "foreman-node-"));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    return dir;
  }

  it("still installs, typechecks and tests a TypeScript project", () => {
    const dir = nodeWorktree({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "package-lock.json": "{}",
      "tsconfig.json": "{}",
    });

    expect(resolveProjectInstallCommand(dir)).toBe("npm ci");
    expect(resolveProjectTypecheckCommand(dir)).toBe("npx tsc --noEmit");
    expect(resolveProjectTestCommand(dir)).toBe("npm test -- --reporter=dot");
    expect(setupStepApplies({ command: "npm install" }, dir)).toBe(true);
  });
});
