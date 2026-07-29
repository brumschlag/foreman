/**
 * Tests for resolving the finalize test command per project.
 *
 * Finalize hardcoded `npm test`, so ANY non-Node project could never pass
 * validation — a real in-cluster run on a repo with no package.json failed with
 * ENOENT. The surrounding code is already language-aware (it appends `mix test`
 * / `go test ./...` for changed Elixir/Go files), so the Node assumption was an
 * inconsistency rather than a deliberate constraint.
 *
 * A project with no recognisable test setup must SKIP validation, not fail it —
 * mirroring installDependencies(), which already no-ops without a package.json.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectTestCommand } from "../finalize-guards.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function worktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-testcmd-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

describe("resolveProjectTestCommand", () => {
  it("skips validation when the project has no recognisable test setup", () => {
    // The live failure: a packer/ansible repo with only Jenkinsfile + packer.json.
    const dir = worktree({ "packer.json": "{}", Jenkinsfile: "pipeline {}" });

    expect(resolveProjectTestCommand(dir)).toBeUndefined();
  });

  it("uses npm test for a Node project", () => {
    const dir = worktree({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });

    expect(resolveProjectTestCommand(dir)).toBe("npm test -- --reporter=dot");
  });

  it("skips a Node project that declares no test script", () => {
    // `npm test` on a package.json without a test script exits non-zero, which
    // would fail finalize for a reason the task cannot fix.
    const dir = worktree({ "package.json": JSON.stringify({ name: "x" }) });

    expect(resolveProjectTestCommand(dir)).toBeUndefined();
  });

  it("uses mix test for an Elixir project", () => {
    const dir = worktree({ "mix.exs": "defmodule X.MixProject do end" });

    expect(resolveProjectTestCommand(dir)).toBe("mix test");
  });

  it("uses go test for a Go project", () => {
    const dir = worktree({ "go.mod": "module x" });

    expect(resolveProjectTestCommand(dir)).toBe("go test ./...");
  });

  it("uses cargo test for a Rust project", () => {
    const dir = worktree({ "Cargo.toml": "[package]" });

    expect(resolveProjectTestCommand(dir)).toBe("cargo test");
  });

  it("prefers an explicit configured command over detection", () => {
    const dir = worktree({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });

    expect(resolveProjectTestCommand(dir, "make check")).toBe("make check");
  });

  it("treats an explicit empty string as an intentional opt-out", () => {
    const dir = worktree({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });

    expect(resolveProjectTestCommand(dir, "")).toBeUndefined();
  });
});
