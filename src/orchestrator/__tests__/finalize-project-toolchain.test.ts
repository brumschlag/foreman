/**
 * Tests for resolving finalize's install and typecheck commands per project.
 *
 * The fourth site of the same Node assumption. `resolveProjectTestCommand` and
 * `setupStepApplies` were both fixed, but `runFinalizeBuiltinPhase` still ran
 * `npm ci` and `npx tsc --noEmit` unconditionally. On the run that produced
 * packer-pipeline-test#3 — a repo with no package.json — FINALIZE_REPORT.md
 * recorded:
 *
 *   ## Dependency Install
 *   - Status: FAILED
 *   - Details: npm error code EUSAGE ... can only install with an existing
 *              package-lock.json
 *
 *   ## Type Check
 *   - Status: FAILED
 *   - Details: This is not the tsc command you are looking for
 *
 * Neither blocked the run, which is exactly why it survived: every non-Node
 * finalize report carries two false failures, and a reader cannot tell those
 * from real ones. A step that cannot apply must be SKIPPED, not run and failed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectInstallCommand, resolveProjectTypecheckCommand } from "../finalize-guards.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function worktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-toolchain-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

describe("resolveProjectInstallCommand", () => {
  it("skips install for a repo with no package.json", () => {
    // The live case: packer-pipeline-test, which produced the EUSAGE failure.
    const dir = worktree({ "packer.json": "{}", Jenkinsfile: "pipeline {}" });

    expect(resolveProjectInstallCommand(dir)).toBeUndefined();
  });

  it("uses npm ci only when a lockfile exists", () => {
    // `npm ci` REQUIRES a lockfile — that is the EUSAGE error. A package.json
    // alone must not select it.
    const withLock = worktree({ "package.json": "{}", "package-lock.json": "{}" });
    expect(resolveProjectInstallCommand(withLock)).toBe("npm ci");

    const noLock = worktree({ "package.json": "{}" });
    expect(resolveProjectInstallCommand(noLock)).toBe("npm install");
  });

  it("honours an explicit override and an explicit opt-out", () => {
    const dir = worktree({ "package.json": "{}", "package-lock.json": "{}" });

    expect(resolveProjectInstallCommand(dir, "pnpm install --frozen-lockfile"))
      .toBe("pnpm install --frozen-lockfile");
    expect(resolveProjectInstallCommand(dir, "")).toBeUndefined();
  });
});

describe("resolveProjectTypecheckCommand", () => {
  it("skips typecheck for a repo with no package.json", () => {
    const dir = worktree({ "packer.json": "{}" });

    expect(resolveProjectTypecheckCommand(dir)).toBeUndefined();
  });

  it("skips typecheck for a Node project with no TypeScript config", () => {
    // A plain JS project has no tsc to run; `npx tsc` would try to FETCH it,
    // which is what produced "This is not the tsc command you are looking for".
    const dir = worktree({ "package.json": "{}" });

    expect(resolveProjectTypecheckCommand(dir)).toBeUndefined();
  });

  it("typechecks a TypeScript project", () => {
    const dir = worktree({ "package.json": "{}", "tsconfig.json": "{}" });

    expect(resolveProjectTypecheckCommand(dir)).toBe("npx tsc --noEmit");
  });

  it("honours an explicit override and an explicit opt-out", () => {
    const dir = worktree({ "package.json": "{}", "tsconfig.json": "{}" });

    expect(resolveProjectTypecheckCommand(dir, "npm run check")).toBe("npm run check");
    expect(resolveProjectTypecheckCommand(dir, "")).toBeUndefined();
  });
});
