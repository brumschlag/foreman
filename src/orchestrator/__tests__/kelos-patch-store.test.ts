import { describe, expect, test } from "vitest";
import { patchObjectKey } from "../kelos-patch-store.js";

describe("patch object key", () => {
  test("namespaces by run and phase so concurrent phases cannot collide", () => {
    const key = patchObjectKey({ prefix: "foreman", runId: "run-7", phaseName: "developer" });

    expect(key).toBe("foreman/run-7/developer.patch");
  });

  test("keeps keys inside the configured prefix even for hostile ids", () => {
    const key = patchObjectKey({
      prefix: "foreman",
      runId: "../../etc",
      phaseName: "dev/../..",
    });

    expect(key.startsWith("foreman/")).toBe(true);
    expect(key).not.toContain("..");
  });

  test("tolerates a prefix with a trailing slash", () => {
    expect(patchObjectKey({ prefix: "foreman/", runId: "r", phaseName: "qa" })).toBe(
      "foreman/r/qa.patch",
    );
  });
});

// Option A (seed the pod): a phase must start from the accumulated work of prior
// phases, not a clean clone. QA reported "KELOS_SMOKE.md was not created" while the
// file sat in Foreman's worktree, because each pod clones master fresh.
//
// Foreman uploads ONE cumulative patch of its own worktree and the pod applies it
// before the agent starts — no chaining of per-phase patches, so no ordering
// requirement and no re-collision at each boundary.
describe("seed patch keys", () => {
  test("are distinct per run and phase so a retry cannot read a stale seed", async () => {
    const { seedObjectKey } = await import("../kelos-patch-store.js");

    const a = seedObjectKey({ prefix: "foreman", runId: "run-1", phaseName: "qa" });
    const b = seedObjectKey({ prefix: "foreman", runId: "run-1", phaseName: "reviewer" });
    const c = seedObjectKey({ prefix: "foreman", runId: "run-2", phaseName: "qa" });

    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toContain("run-1");
    expect(a).toContain("qa");
  });

  test("cannot escape the prefix via ids from task metadata", async () => {
    const { seedObjectKey } = await import("../kelos-patch-store.js");

    const key = seedObjectKey({ prefix: "foreman", runId: "../../etc", phaseName: "../x" });

    expect(key.startsWith("foreman/")).toBe(true);
    expect(key).not.toContain("..");
  });

  test("does not collide with the phase's own output patch", async () => {
    const { seedObjectKey, patchObjectKey } = await import("../kelos-patch-store.js");
    const args = { prefix: "foreman", runId: "run-1", phaseName: "developer" };

    expect(seedObjectKey(args)).not.toBe(patchObjectKey(args));
  });
});
