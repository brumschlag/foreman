import { defineVitestLaneConfig } from "./vitest.shared";

/** Vitest config scoped to PR #25 epic run quality tests for Stryker (tight mutate scope). */
export default defineVitestLaneConfig("stryker", {
  include: [
    "src/orchestrator/__tests__/dispatch-planning.test.ts",
    "src/orchestrator/__tests__/dispatcher-story-grouping.test.ts",
    "src/orchestrator/__tests__/pipeline-epic-loop.test.ts",
    "src/orchestrator/__tests__/task-ordering.test.ts",
  ],
});
