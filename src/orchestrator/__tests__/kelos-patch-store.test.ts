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
