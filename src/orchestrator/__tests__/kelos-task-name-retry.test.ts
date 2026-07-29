/**
 * A retried phase must apply a DIFFERENT Task object.
 *
 * `Task.spec` carries the CRD validation `self == oldSelf`, so the API server
 * rejects an apply that reuses an existing name:
 *
 *   The Task "foreman-k8s-smoke-1-developer" is invalid:
 *   spec: Invalid value: Task spec is immutable after creation
 *
 * The name was derived from task + phase alone, so every retry re-applied the
 * completed object and the phase died before an agent started. Observed live: a
 * smoke run completed explorer, developer, documentation and qa, then qa asked
 * for a developer retry and the pipeline went STUCK on that error.
 *
 * Asserted through the real client against a stubbed kubectl api rather than by
 * unit-testing the name helper, because the bug spanned two seams — the phase
 * runner did not forward `runId`, so fixing only the name kept producing a
 * collision.
 */

import { describe, expect, test } from "vitest";
import { createKelosCrdClient } from "../kelos-client.js";
import { createKelosPhaseRunner, type KelosTaskRequest } from "../kelos-phase-runner.js";
import type { KelosTaskObject } from "../kelos-kubectl-api.js";

function stubApi(applied: string[]) {
  return {
    async createTask(task: KelosTaskObject): Promise<string> {
      const name = task.metadata?.name ?? "";
      // Mirror the CRD: a repeated name is a conflict, not an update.
      if (applied.includes(name)) {
        throw new Error(
          `The Task "${name}" is invalid: spec: Invalid value: Task spec is immutable after creation`,
        );
      }
      applied.push(name);
      return name;
    },
    async getTask(): Promise<KelosTaskObject> {
      return { metadata: { name: "stub" }, status: { phase: "Succeeded" } } as KelosTaskObject;
    },
  };
}

function request(runId?: string) {
  return {
    prompt: "p",
    systemPrompt: "s",
    model: "claude-haiku",
    phaseName: "developer",
    taskId: "k8s-smoke-1",
    ...(runId ? { runId } : {}),
  };
}

describe("kelos Task naming across attempts", () => {
  test("two runs of the same phase produce distinct Task names", async () => {
    const applied: string[] = [];
    const api = stubApi(applied);
    const client = createKelosCrdClient({
      api,
      workspace: "ws",
      agentType: "claude-code",
      credentials: { type: "none" },
      pollIntervalMs: 1,
    });

    await client.runTask(request("7b63360d-250e-442b-d893-6682b6e95d96"));
    // The retry: same task, same phase, new run. Must NOT collide.
    await expect(
      client.runTask(request("f0ae309d-b440-5394-0068-354aa6c7f665")),
    ).resolves.toBeDefined();

    expect(applied).toHaveLength(2);
    expect(new Set(applied).size).toBe(2);
    for (const name of applied) {
      expect(name).toMatch(/^foreman-k8s-smoke-1-developer-[a-z0-9]{8}$/);
      // Pod names derived from this cap at 63 characters.
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  test("a request without runId keeps the original name", async () => {
    const applied: string[] = [];
    const client = createKelosCrdClient({
      api: stubApi(applied),
      workspace: "ws",
      agentType: "claude-code",
      credentials: { type: "none" },
      pollIntervalMs: 1,
    });

    await client.runTask(request());

    // No trailing separator, and unchanged for callers that never send a runId.
    expect(applied).toEqual(["foreman-k8s-smoke-1-developer"]);
  });

  /**
   * The naming fix alone is not sufficient: the phase runner builds the request,
   * and it did not forward `runId`. Without this the client would receive
   * `runId: undefined` on every attempt and fall back to the colliding name — so
   * this covers the second seam the live failure spanned.
   */
  test("the phase runner forwards runId from the phase context", async () => {
    const seen: KelosTaskRequest[] = [];
    const runner = createKelosPhaseRunner(
      {
        runTask: async (request) => {
          seen.push(request);
          return {
            succeeded: true,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            files: [],
          };
        },
      },
      {},
    );

    await runner({
      prompt: "p",
      systemPrompt: "s",
      cwd: "/tmp",
      model: "claude-haiku",
      context: {
        phaseName: "developer",
        taskId: "k8s-smoke-1",
        taskTitle: "t",
        worktreePath: "/tmp",
        runId: "7b63360d-250e-442b",
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].runId).toBe("7b63360d-250e-442b");
  });

  test("a long taskId stays within the k8s object name limit", async () => {
    const applied: string[] = [];
    const client = createKelosCrdClient({
      api: stubApi(applied),
      workspace: "ws",
      agentType: "claude-code",
      credentials: { type: "none" },
      pollIntervalMs: 1,
    });

    await client.runTask({ ...request("abc12345"), taskId: "x".repeat(300) });

    expect(applied[0].length).toBeLessThanOrEqual(253);
    expect(applied[0].endsWith("-abc12345")).toBe(true);
  });
});
