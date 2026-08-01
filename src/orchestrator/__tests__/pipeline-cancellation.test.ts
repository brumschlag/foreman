/**
 * Mid-run cancellation.
 *
 * `task.close` sets the task projection to closed and returns 202, but the node
 * pipeline never read that projection, so every remaining phase still ran. Two
 * runs were "stopped" and finished all five phases anyway — 5r4-discovery-verify-1
 * cost $37.72 when closing after the explorer was meant to cap it near $7. This
 * was the only mid-run cost brake available, and it did not brake.
 *
 * The between-phase boundary is where a stop can be honoured: a phase already in
 * flight owns a live agent, but the NEXT one has not been dispatched yet.
 */

import { describe, expect, test } from "vitest";
import { cancellationReason, TERMINAL_TASK_STATUSES } from "../pipeline-executor.js";

describe("cancellationReason()", () => {
  test("stops on a task closed mid-run", () => {
    // The exact case observed: closed while the developer phase was running.
    expect(cancellationReason("closed")).toMatch(/closed/i);
  });

  test("stops on every terminal status, not just closed", () => {
    // Whatever the server considers terminal must stop the pipeline, or the next
    // status someone adds silently resumes the old runaway behaviour.
    for (const status of TERMINAL_TASK_STATUSES) {
      expect(cancellationReason(status), `expected ${status} to stop the pipeline`).toBeTruthy();
    }
  });

  test("keeps running while the task is still live", () => {
    for (const status of ["open", "ready", "in_progress", "in-progress", "blocked"]) {
      expect(cancellationReason(status), `expected ${status} to continue`).toBeUndefined();
    }
  });

  test("keeps running when the status is unknown", () => {
    // Fail OPEN, unlike the tool-policy gate. An unreachable server or a status
    // this build has never seen must not silently abort a paid, working run —
    // the cost of over-running is money, the cost of a false stop is a wasted
    // pipeline and a confusing failure.
    for (const status of [undefined, null, "", "   ", "some-future-status"]) {
      expect(cancellationReason(status as never), `expected ${String(status)} to continue`).toBeUndefined();
    }
  });

  test("is case- and separator-insensitive", () => {
    // The projection has used both in-progress and in_progress for the same
    // state, so a terminal status could plausibly arrive either way.
    expect(cancellationReason("CLOSED")).toBeTruthy();
    expect(cancellationReason("Cancelled")).toBeTruthy();
  });

  test("names the status so the log says why the run stopped", () => {
    // "pipeline stopped" with no cause is indistinguishable from a crash.
    const reason = cancellationReason("closed") ?? "";
    expect(reason).toContain("closed");
  });
});

describe("pipeline context wiring", () => {
  test("the pipeline accepts a cancellation check on its context", async () => {
    // A pure predicate nothing calls is the failure mode this repo has shipped
    // twice (a hook written where nothing read it, a tool-policy gate that never
    // fired), so assert the CONTEXT exposes the seam rather than only that the
    // helper is correct. The check is a callback, not a server client, so the
    // pipeline keeps no dependency on the Elixir API.
    const mod = await import("../pipeline-executor.js");
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../pipeline-executor.ts", import.meta.url).pathname,
        "utf8",
      ),
    );

    // Declared on the context type.
    expect(source).toMatch(/checkCancelled\?:/);
    expect(mod.cancellationReason).toBeTypeOf("function");

    // And actually CONSULTED — `ctx.checkCancelled(` only appears where the
    // pipeline invokes the callback, so this cannot be satisfied by the helper's
    // own definition the way a bare /cancellationReason\(/ was.
    expect(source).toMatch(/ctx\.checkCancelled\(/);

    // In the phase loop, before the phase is dispatched. The budget stop already
    // guards this boundary, so the cancellation check must sit on the same side
    // of it — after the loop opens, before the agent name is built.
    const loopStart = source.indexOf("while (i < phases.length) {");
    const dispatchPoint = source.indexOf("const agentName = `${phaseName}-${taskId}`;");
    const consultPoint = source.indexOf("ctx.checkCancelled(");
    expect(loopStart).toBeGreaterThan(-1);
    expect(dispatchPoint).toBeGreaterThan(loopStart);
    expect(consultPoint, "cancellation must be checked inside the phase loop").toBeGreaterThan(loopStart);
    expect(consultPoint, "cancellation must be checked BEFORE the phase is dispatched").toBeLessThan(dispatchPoint);
  });
});
