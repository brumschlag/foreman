import type { NativeTaskStatus } from "./types.js";

/**
 * Making an `ask_operator` wait resumable.
 *
 * A phase that calls `ask_operator` parks the run at `waiting_for_operator` and
 * returns, which is correct — it must not be re-dispatched as a failure. But
 * nothing brings it back: the Elixir scheduler dispatches on TASK status, only
 * `ready`/`approved` are dispatchable, and the task is left at `in-progress`
 * because nativeTaskStatusForPhase returns that for every phase. The run's own
 * `waiting_for_operator` reads as resumable and is in fact terminal, so the agent
 * asks a question and the work strands.
 *
 * These are the pure pieces of the fix: where to park the task so a resume is
 * possible, how to recognise the parked state, and how an operator's answer is
 * shaped for the phase that re-runs.
 */

/**
 * Task status to park at while waiting for an operator.
 *
 * `blocked` because it is the existing status meaning "parked, needs a human",
 * accepted by both NativeTaskStatus and the Elixir projection's task_statuses set.
 * Anything in `in-progress` is invisible to the scheduler forever, which is the
 * bug; `ready` would be worse, since it would re-dispatch immediately and the
 * phase would ask the same question again.
 */
export function taskStatusForOperatorWait(): NativeTaskStatus {
  return "blocked";
}

/** True when this run is parked waiting for operator input. */
export function isAwaitingOperator(run: { status?: string } | undefined): boolean {
  return run?.status === "waiting_for_operator";
}

export interface OperatorReplyInput {
  /** The question the phase asked, when it was recorded. */
  question?: string;
  /** The operator's answer. */
  reply: string;
  /** Phase that asked, for the feedback heading. */
  phase: string;
}

/**
 * Format an operator's answer as phase feedback.
 *
 * Rides the same `feedbackContext` channel a QA retry uses, so the prompt-injection
 * path is already proven rather than new. Carries the original question because the
 * phase re-runs from scratch with no memory of what it asked, and labels the answer
 * as the operator's so the agent does not read it as its own earlier reasoning.
 */
export function operatorReplyFeedback(input: OperatorReplyInput): string {
  const reply = input.reply?.trim();
  // An empty reply is an operator slip, not an instruction: resuming on it re-runs
  // the phase with no new information, so it asks the same question and loops.
  if (!reply) {
    throw new Error("operator reply must not be empty");
  }

  const lines = [`## Operator response (${input.phase})`, ""];
  if (input.question?.trim()) {
    lines.push(`You asked: ${input.question.trim()}`, "");
  }
  lines.push(`The operator answered: ${reply}`, "", "Continue with this guidance.");
  return lines.join("\n");
}
