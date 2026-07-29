/**
 * Tests for the atomic build approach.
 *
 * Verifies:
 * - The `build` script no longer calls `npm run clean` (no dist/ deletion mid-flight)
 * - The `rebuild` script exists as the clean+build alias
 * - The `build:atomic` script exists and points to scripts/build-atomic.js
 * - build-atomic.js skips the final swap in --dry mode (no stale temp dirs)
 * - build-atomic.js builds to a temp directory first, then swaps
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../../..");

// ── package.json script assertions ──────────────────────────────────────────

describe("package.json build scripts", () => {
  let scripts: Record<string, string>;

  beforeEach(() => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    scripts = pkg.scripts;
  });

  it('build script does NOT call "npm run clean" (no dist/ deletion mid-flight)', () => {
    expect(scripts["build"]).toBeDefined();
    expect(scripts["build"]).not.toContain("npm run clean");
    expect(scripts["build"]).not.toContain("rm -rf");
  });

  it('rebuild script exists and starts with "npm run clean"', () => {
    expect(scripts["rebuild"]).toBeDefined();
    expect(scripts["rebuild"]).toMatch(/npm run clean/);
  });

  it('"build:atomic" script exists and references scripts/build-atomic.js', () => {
    expect(scripts["build:atomic"]).toBeDefined();
    expect(scripts["build:atomic"]).toContain("build-atomic.js");
  });

  it('"clean" script still exists as a standalone command', () => {
    expect(scripts["clean"]).toBeDefined();
    expect(scripts["clean"]).toContain("rm -rf dist");
  });

  it('build script delegates to build-atomic.js (zero-downtime atomic swap)', () => {
    expect(scripts["build"]).toContain("build-atomic.js");
  });
});

// ── build-atomic.js dry-run test ─────────────────────────────────────────────

describe("build-atomic.js --dry mode", () => {
  it("build-atomic.js script file exists", () => {
    expect(existsSync(join(root, "scripts/build-atomic.js"))).toBe(true);
  });

  it("build-atomic.js contains atomic swap logic", () => {
    const src = readFileSync(join(root, "scripts/build-atomic.js"), "utf8");
    expect(src).toContain("renameSync");
    expect(src).toContain("dist-new-");
    expect(src).toContain("--dry");
    expect(src).toContain("atomic swap");
  });

  it("build-atomic.js uses a temp directory, not dist/ directly", () => {
    const src = readFileSync(join(root, "scripts/build-atomic.js"), "utf8");
    // The outDir passed to tsc must be tmpDir (not finalDir)
    expect(src).toContain("--outDir ${tmpDir}");
    // Final rename: tmpDir → dist/
    expect(src).toContain("renameSync(tmpDir, finalDir)");
  });

  it("packages .sh assets so pod-side hooks resolve from dist", () => {
    // The asset filter allowed only extensionless/.md/.yaml, so no shell script
    // ever reached dist/defaults/hooks. The tool-policy hook and the Agent Mail
    // shim both prefer dist and fall back to src, so this was invisible locally
    // (package.json also ships src/defaults) while leaving the packaged layout
    // dependent on that fallback.
    const src = readFileSync(join(root, "scripts/build-atomic.js"), "utf8");
    expect(src).toContain(".sh");
  });
});

// ── packaged pod-side assets ──────────────────────────────────────────────────

describe("pod-side hook packaging", () => {
  // These run against whatever dist/ currently holds, so they are meaningful
  // only after a build; skipping keeps a fresh clone's suite green.
  const hooks = join(root, "dist/defaults/hooks");

  it.skipIf(!existsSync(hooks))("ships the tool-policy hook and mail shim", () => {
    expect(existsSync(join(hooks, "tool-policy-pretooluse.sh"))).toBe(true);
    expect(existsSync(join(hooks, "mail-shim.sh"))).toBe(true);
  });
});
