import { describe, expect, test } from "vitest";
import {
  isAwaitingOperator,
  operatorReplyFeedback,
  taskStatusForOperatorWait,
} from "../operator-resume.js";

/**
 * A phase that calls `ask_operator` parks the run at `waiting_for_operator` and
 * returns. Nothing then brings it back: the Elixir scheduler dispatches on TASK
 * status, only `ready`/`approved` are dispatchable, and the task is left at
 * `in-progress` (nativeTaskStatusForPhase returns that for every phase). So the
 * agent asks a question and the run strands forever — `waiting_for_operator`
 * reads as resumable but is terminal.
 *
 * These cover the pieces needed to make the wait resumable.
 */

describe("taskStatusForOperatorWait", () => {
  // The task has to leave `in-progress`, or the scheduler will never look at it
  // again. `blocked` is the existing status meaning "parked, needs a human" and is
  // already in the projection's accepted set.
  test("parks the task in a status the scheduler can act on later", () => {
    expect(taskStatusForOperatorWait()).toBe("blocked");
  });

  test("does not leave the task in-progress, which is never dispatchable", () => {
    expect(taskStatusForOperatorWait()).not.toBe("in-progress");
    expect(taskStatusForOperatorWait()).not.toBe("in_progress");
  });
});

describe("isAwaitingOperator", () => {
  test("recognises a run parked for operator input", () => {
    expect(isAwaitingOperator({ status: "waiting_for_operator" })).toBe(true);
  });

  test("does not treat a running or failed run as awaiting input", () => {
    expect(isAwaitingOperator({ status: "running" })).toBe(false);
    expect(isAwaitingOperator({ status: "failed" })).toBe(false);
    expect(isAwaitingOperator({ status: "stuck" })).toBe(false);
  });

  test("tolerates a missing status rather than throwing", () => {
    expect(isAwaitingOperator({})).toBe(false);
    expect(isAwaitingOperator(undefined)).toBe(false);
  });
});

describe("operatorReplyFeedback", () => {
  // The reply rides the SAME feedbackContext channel a QA retry uses, so the
  // prompt-injection path is already proven. It has to carry the original question
  // too: the phase re-runs from scratch and has no memory of what it asked.
  test("pairs the operator's answer with the question that was asked", () => {
    const feedback = operatorReplyFeedback({
      question: "Should I bump the major version?",
      reply: "No — patch only.",
      phase: "developer",
    });

    expect(feedback).toContain("Should I bump the major version?");
    expect(feedback).toContain("No — patch only.");
  });

  test("labels the answer as coming from the operator, not the agent's own notes", () => {
    const feedback = operatorReplyFeedback({
      question: "q",
      reply: "r",
      phase: "developer",
    });

    expect(feedback).toMatch(/operator/i);
  });

  test("reads sensibly when the original question was not recorded", () => {
    const feedback = operatorReplyFeedback({ reply: "proceed", phase: "qa" });

    expect(feedback).toContain("proceed");
    expect(feedback).not.toContain("undefined");
  });

  // An empty reply is an operator mistake, not a resume instruction: resuming on
  // it would re-run the phase with no new information and it would very likely
  // ask the same question again, looping.
  test("refuses an empty reply", () => {
    expect(() => operatorReplyFeedback({ reply: "   ", phase: "developer" })).toThrow(
      /reply/i,
    );
  });
});

describe("worker parks the task when waiting for an operator", () => {
  // Reading the source because onPipelineComplete needs the full worker context
  // (store, task client, mail, notification server) to invoke, and the assertion is
  // about a single missing call — the task status update that makes a resume
  // possible at all.
  test("the waiting branch updates task status, not only run status", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/orchestrator/agent-worker.ts", "utf-8");
    const branch = source.slice(
      source.indexOf("if (waitingForOperator) {"),
      source.indexOf("const hasFinalizePhase"),
    );

    expect(branch).toContain("waiting_for_operator");
    // Without this the task stays in-progress, which dispatchable? never matches,
    // so the run waits forever.
    expect(branch).toMatch(/taskStatusForOperatorWait|status:\s*"blocked"/);
  });
});
