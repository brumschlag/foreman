/**
 * The smoke workflow's QA report must satisfy the QA artifact gate.
 *
 * Two independently reasonable components disagreed on a contract. The QA phase
 * gate (`pipeline-executor.ts`, `phaseName === "qa" && !qaReportHasTestEvidence`)
 * overrides a PASS verdict when the report shows no test evidence — deliberately,
 * so an agent cannot wave work through with "looks fine". Meanwhile the smoke
 * prompt mandates a fixed noop report and explicitly forbids running tests.
 *
 * The result was an unsatisfiable phase: the QA agent wrote exactly what it was
 * told, returned PASS, and the gate rewrote it to fail on every attempt:
 *
 *   [QA] FAIL — report missing test command evidence
 *   [QA] FAIL — looping back to developer (retry 1/2)
 *   [QA] FAIL — max retries (2) exhausted, continuing
 *
 * `qaReportHasTestEvidence` already anticipates this and honours an explicit
 * `Test suite: SKIPPED`, which is a deliberate statement rather than a bare
 * claim. The prompt just never used it.
 *
 * This asserts against the SHIPPED prompt file rather than a copy of its text,
 * so editing the prompt back into an unsatisfiable state fails here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseVerdict, qaReportHasTestEvidence } from "../roles.js";

const PROMPT = join(__dirname, "..", "..", "defaults", "prompts", "smoke", "qa.md");

/**
 * Pull the fenced report body the prompt tells the agent to write verbatim. The
 * gate runs against that content, so it is what has to be checked.
 */
function mandatedReport(promptText: string): string {
  const fence = promptText.match(/```\n([\s\S]*?)```/);
  if (!fence) throw new Error("smoke qa prompt has no fenced report block");
  return fence[1];
}

describe("smoke workflow QA prompt", () => {
  const prompt = readFileSync(PROMPT, "utf8");
  const report = mandatedReport(prompt);

  test("the mandated report is still a PASS verdict", () => {
    expect(parseVerdict(report)).toBe("pass");
  });

  test("the mandated report satisfies the QA test-evidence gate", () => {
    // Without this the gate rewrites the agent's PASS to fail and the pipeline
    // burns every retry on work that was correct the first time.
    expect(qaReportHasTestEvidence(report)).toBe(true);
  });

  test("the prompt states the skip explicitly rather than omitting evidence", () => {
    // The gate accepts SKIPPED / N/A / NONE. Assert the report declares one, so
    // a future edit cannot satisfy the gate by accident (e.g. by mentioning
    // "npm test" in prose while running nothing).
    expect(report).toMatch(/Test suite:\s*(?:\*\*)?(?:SKIPPED|N\/A|NONE)\b/i);
  });
});
