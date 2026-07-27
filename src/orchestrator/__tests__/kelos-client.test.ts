import { describe, expect, test } from "vitest";
import {
  createKelosCrdClient,
  type KelosApi,
  type KelosCrdClientOptions,
  type KelosTaskObject,
} from "../kelos-client.js";

function api(overrides: Partial<KelosApi> = {}): KelosApi {
  return {
    createTask: async () => "task-generated",
    getTask: async () => ({ status: { phase: "Succeeded" } }) as KelosTaskObject,
    ...overrides,
  };
}

const request = {
  prompt: "implement the thing",
  systemPrompt: "you are the developer",
  model: "anthropic/claude-sonnet-4-6",
  phaseName: "developer",
  taskId: "task-1",
};

const CREDENTIALS = { type: "oauth", secretRef: { name: "claude-oauth-token" } };

function clientOptions(overrides: Partial<KelosCrdClientOptions> = {}): KelosCrdClientOptions {
  return {
    api: api(),
    workspace: "my-workspace",
    agentType: "claude-code",
    credentials: CREDENTIALS,
    pollIntervalMs: 0,
    ...overrides,
  };
}

describe("kelos CRD client", () => {
  test("creates a Task carrying the phase prompt, model, and workspace", async () => {
    let created: Record<string, unknown> | undefined;
    const client = createKelosCrdClient(
      clientOptions({
        api: api({
          createTask: async (task) => {
            created = task as unknown as Record<string, unknown>;
            return "kelos-task-1";
          },
        }),
      }),
    );

    await client.runTask(request);

    expect(created).toMatchObject({
      apiVersion: "kelos.dev/v1alpha2",
      kind: "Task",
      spec: {
        type: "claude-code",
        model: "anthropic/claude-sonnet-4-6",
        workspaceRef: { name: "my-workspace" },
      },
    });
    const spec = (created as { spec: { prompt: string } }).spec;
    expect(spec.prompt).toContain("implement the thing");
    expect(spec.prompt).toContain("you are the developer");
  });

  // The kelos Task CRD enforces "type with credentials is required" (verified by
  // server dry-run against tasks.kelos.dev v1alpha2); a Task without credentials
  // is rejected by the API server.
  test("includes credentials so the Task passes kelos CRD validation", async () => {
    let created: { spec?: Record<string, unknown> } | undefined;
    const client = createKelosCrdClient(
      clientOptions({
        api: api({
          createTask: async (task) => {
            created = task as { spec?: Record<string, unknown> };
            return "kelos-task-1";
          },
        }),
      }),
    );

    await client.runTask(request);

    expect(created?.spec).toMatchObject({
      credentials: { type: "oauth", secretRef: { name: "claude-oauth-token" } },
    });
  });

  test("polls until the Task reaches a terminal phase, then maps its results", async () => {
    const phases = ["Pending", "Running", "Succeeded"];
    let calls = 0;
    const client = createKelosCrdClient(clientOptions({
      api: api({
        getTask: async () => {
          const phase = phases[Math.min(calls++, phases.length - 1)];
          return {
            status: {
              phase,
              results:
                phase === "Succeeded"
                  ? {
                      branch: "kelos/task-1",
                      commit: "abc123",
                      "cost-usd": "0.25",
                      "input-tokens": "900",
                      "output-tokens": "150",
                    }
                  : undefined,
            },
          } as KelosTaskObject;
        },
      }),
    }));

    const result = await client.runTask(request);

    expect(calls).toBe(3);
    expect(result.succeeded).toBe(true);
    expect(result.branch).toBe("kelos/task-1");
    expect(result.commit).toBe("abc123");
    expect(result.costUsd).toBe(0.25);
    expect(result.inputTokens).toBe(900);
    expect(result.outputTokens).toBe(150);
  });

  test("reports a failed Task as unsuccessful with the status message", async () => {
    const client = createKelosCrdClient(
      clientOptions({
        api: api({
          getTask: async () =>
            ({ status: { phase: "Failed", message: "pod evicted" } }) as KelosTaskObject,
        }),
      }),
    );

    const result = await client.runTask(request);

    expect(result.succeeded).toBe(false);
    expect(result.errorMessage).toBe("pod evicted");
  });

  test("gives up after the configured timeout instead of polling forever", async () => {
    const client = createKelosCrdClient(
      clientOptions({
        api: api({ getTask: async () => ({ status: { phase: "Running" } }) as KelosTaskObject }),
        maxPolls: 3,
      }),
    );

    const result = await client.runTask(request);

    expect(result.succeeded).toBe(false);
    expect(result.errorMessage).toMatch(/did not reach a terminal phase/i);
  });
});
