/**
 * A setup step must not fail a project that does not use its toolchain.
 *
 * The bundled workflows declare `npm install ... failFatal: true`, so running any
 * non-Node repo aborted before the first phase with an ENOENT on package.json.
 * installDependencies() already no-ops when package.json is absent; the raw
 * setup command did not, so the same assumption failed in two places.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupStepApplies } from "../setup.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dirWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-setup-skip-"));
  tmpDirs.push(dir);
  for (const f of files) writeFileSync(join(dir, f), "{}", "utf8");
  return dir;
}

describe("setupStepApplies", () => {
  it("skips an npm step when the project has no package.json", () => {
    const dir = dirWith(["packer.json", "Jenkinsfile"]);

    expect(setupStepApplies({ command: "npm install --prefer-offline" }, dir)).toBe(false);
  });

  it("runs an npm step when package.json is present", () => {
    const dir = dirWith(["package.json"]);

    expect(setupStepApplies({ command: "npm install --prefer-offline" }, dir)).toBe(true);
  });

  it("skips mix/go/cargo steps without their manifests", () => {
    const dir = dirWith(["README.md"]);

    expect(setupStepApplies({ command: "mix deps.get" }, dir)).toBe(false);
    expect(setupStepApplies({ command: "go mod download" }, dir)).toBe(false);
    expect(setupStepApplies({ command: "cargo fetch" }, dir)).toBe(false);
  });

  it("runs a command with no known toolchain manifest unconditionally", () => {
    // An arbitrary project-supplied step is the author's business, not ours to
    // second-guess.
    const dir = dirWith(["README.md"]);

    expect(setupStepApplies({ command: "make bootstrap" }, dir)).toBe(true);
  });
});
