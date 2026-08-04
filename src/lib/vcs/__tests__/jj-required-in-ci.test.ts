import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The three JujutsuBackend suites gate on `jj` being installed via
 * `describe.skipIf(!JJ_AVAILABLE)`. That is right for a contributor's machine, but
 * in CI it is a silent hole: vitest exits 0 reporting "17 passed | 55 skipped", so
 * a green check certifies 55 tests that never ran. A git-town config bug shipped in
 * jujutsu-backend.ts exactly that way, while its identical sibling in
 * git-backend.ts was caught — only the git suite actually executed.
 *
 * So make the absence loud where it matters. Locally this is a no-op; in CI it
 * fails if the toolchain step is dropped or its download breaks.
 */
describe("jj availability", () => {
  const isCi = process.env.CI === "true" || process.env.CI === "1";

  it.skipIf(!isCi)("is installed in CI so the JujutsuBackend suites cannot silently skip", () => {
    const version = execFileSync("jj", ["--version"], { encoding: "utf-8" }).trim();

    expect(version).toMatch(/^jj \d+\.\d+\.\d+/);
  });
});
