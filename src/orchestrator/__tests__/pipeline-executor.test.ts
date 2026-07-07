import { describe, it, expect } from "vitest";
import { isIgnoredChangePath } from "../pipeline-executor.js";

describe("isIgnoredChangePath", () => {
  it("ignores the node_modules symlink foreman creates from its setup-cache", () => {
    // Foreman symlinks `node_modules` into the worktree from setup-cache. Because the
    // repo .gitignore rule is `node_modules/` (directory-only), the symlink is NOT
    // matched, so `git ls-files --others --exclude-standard` returns it and the
    // developer-completion gate mistakes it for real work. It must be excluded.
    expect(isIgnoredChangePath("node_modules")).toBe(true);
    expect(isIgnoredChangePath("node_modules/react/index.js")).toBe(true);
    expect(isIgnoredChangePath("src/frontend/inpulse-web/node_modules")).toBe(true);
    expect(isIgnoredChangePath("src/frontend/inpulse-web/node_modules/vite/bin/vite.js")).toBe(true);
  });

  it("does not ignore real source or config changes", () => {
    expect(isIgnoredChangePath("src/frontend/inpulse-web/src/App.tsx")).toBe(false);
    expect(isIgnoredChangePath("package.json")).toBe(false);
    expect(isIgnoredChangePath("src/orchestrator/pipeline-executor.ts")).toBe(false);
    // A path that merely contains the substring "node_modules" in a filename is not a match.
    expect(isIgnoredChangePath("src/docs/node_modules_notes.md")).toBe(false);
  });
});
