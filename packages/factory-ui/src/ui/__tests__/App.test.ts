import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");

/**
 * Tests for the App.tsx footer attribution change.
 * PR: Updated footer name from "Raven" to "Ivy" (foreman-eb53b).
 *
 * Scope: only the footer attribution span content introduced by this PR.
 */
describe("App footer attribution", () => {
  it('renders "Ivy" as the foreman attribution name', () => {
    expect(appSource).toContain("Ivy / brumschlag/foreman");
  });

  it('does not render the old attribution name "Raven"', () => {
    // Regression: previous value was "Raven / brumschlag/foreman"
    expect(appSource).not.toContain("Raven / brumschlag/foreman");
  });

  it("footer attribution includes the year 2026", () => {
    // The footer span format is: "2026 — Ivy / brumschlag/foreman"
    expect(appSource).toMatch(/2026\s*—\s*Ivy/);
  });

  it('footer attribution includes the repository path "brumschlag/foreman"', () => {
    expect(appSource).toContain("brumschlag/foreman");
  });

  it("footer attribution string matches the full expected format", () => {
    // Full attribution: "2026 — Ivy / brumschlag/foreman"
    expect(appSource).toContain("2026 — Ivy / brumschlag/foreman");
  });

  it("footer left-side branding span remains unchanged", () => {
    // The left span was not part of the PR change and should still read "Foreman Dark Factory"
    expect(appSource).toContain("⬡ Foreman Dark Factory");
  });
});