/**
 * Tests that a tool policy requested by a phase actually reaches the kelos agent
 * pod.
 *
 * A kelos agent is a separate program in a separate pod, so the in-process Pi SDK
 * tool wrapper cannot gate it. The gate travels instead as a PreToolUse hook,
 * installed by preCommands and configured by envOverrides. Until that wiring
 * existed the runner refused any phase requesting a policy; these tests pin the
 * wiring so the refusal can be lifted without leaving phases unguarded.
 */

import { describe, expect, test } from "vitest";
import {
  createKelosCrdClient,
  type KelosApi,
  type KelosCrdClientOptions,
  type KelosTaskObject,
} from "../kelos-client.js";
import { createKelosPhaseRunner } from "../kelos-phase-runner.js";
import { POD_HOOK_PATH, POD_HOOK_SETTINGS_PATH } from "../kelos-tool-policy-hook.js";

type CreatedTask = {
  spec?: {
    preCommands?: string[][];
    envOverrides?: { name: string; value: string }[];
  };
};

function clientOptions(overrides: Partial<KelosCrdClientOptions> = {}): KelosCrdClientOptions {
  const api: KelosApi = {
    createTask: async () => "task-generated",
    getTask: async () => ({ status: { phase: "Succeeded" } }) as KelosTaskObject,
  };
  return {
    api,
    workspace: "my-workspace",
    agentType: "claude-code",
    credentials: { type: "none" },
    pollIntervalMs: 0,
    ...overrides,
  };
}

const request = {
  prompt: "do the thing",
  systemPrompt: "you are the explorer",
  model: "anthropic/claude-sonnet-4-6",
  phaseName: "explorer",
  taskId: "task-1",
};

const TOOL_POLICY = {
  serverUrl: "http://foreman-server.kelos-pilot.svc.cluster.local:4766",
  authToken: "policy-token",
  runId: "run-1",
  taskId: "task-1",
  phaseId: "explorer",
};

describe("kelos client tool-policy wiring", () => {
  test("installs the hook via preCommands when a tool policy is requested", async () => {
    let created: CreatedTask | undefined;
    const client = createKelosCrdClient(
      clientOptions({
        toolPolicy: TOOL_POLICY,
        api: {
          createTask: async (task) => {
            created = task as CreatedTask;
            return "task-1";
          },
          getTask: async () => ({ status: { phase: "Succeeded" } }) as KelosTaskObject,
        },
      }),
    );

    await client.runTask(request);

    const preCommands = created?.spec?.preCommands ?? [];
    const joined = preCommands.map((c) => c.join(" ")).join("\n");
    expect(joined).toContain(POD_HOOK_PATH);
    expect(joined).toContain("settings.json");
  });

  test("passes the policy endpoint and correlation ids as envOverrides", async () => {
    let created: CreatedTask | undefined;
    const client = createKelosCrdClient(
      clientOptions({
        toolPolicy: TOOL_POLICY,
        api: {
          createTask: async (task) => {
            created = task as CreatedTask;
            return "task-1";
          },
          getTask: async () => ({ status: { phase: "Succeeded" } }) as KelosTaskObject,
        },
      }),
    );

    await client.runTask(request);

    const env = new Map((created?.spec?.envOverrides ?? []).map((e) => [e.name, e.value] as const));
    expect(env.get("FOREMAN_SERVER_URL")).toBe(TOOL_POLICY.serverUrl);
    expect(env.get("FOREMAN_SERVER_AUTH_TOKEN")).toBe("policy-token");
    expect(env.get("FOREMAN_PHASE_ID")).toBe("explorer");
  });

  test("adds no hook wiring when no tool policy is requested", async () => {
    let created: CreatedTask | undefined;
    const client = createKelosCrdClient(
      clientOptions({
        api: {
          createTask: async (task) => {
            created = task as CreatedTask;
            return "task-1";
          },
          getTask: async () => ({ status: { phase: "Succeeded" } }) as KelosTaskObject,
        },
      }),
    );

    await client.runTask(request);

    const joined = (created?.spec?.preCommands ?? []).map((c) => c.join(" ")).join("\n");
    expect(joined).not.toContain(POD_HOOK_PATH);
  });
});

describe("kelos phase runner tool-policy refusal", () => {
  test("runs a policy-gated phase when the client can enforce the policy", async () => {
    const runner = createKelosPhaseRunner({
      enforcesToolPolicy: true,
      runTask: async () => ({
        succeeded: true,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        turns: 1,
        toolCalls: 0,
        toolBreakdown: {},
        files: [],
      }),
    });

    const result = await runner({
      prompt: "p",
      systemPrompt: "s",
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-4-6",
      context: { phaseName: "explorer", taskId: "task-1" },
      toolPolicy: {
        context: { runId: "run-1", phaseId: "explorer" },
        check: async () => ({ allowed: true, action: "approve", reason: "ok" }),
      },
    } as never);

    expect(result.success).toBe(true);
    expect(result.errorMessage).toBeUndefined();
  });

  test("still refuses a policy-gated phase when the client cannot enforce it", async () => {
    const runner = createKelosPhaseRunner({
      runTask: async () => ({
        succeeded: true,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        turns: 1,
        toolCalls: 0,
        toolBreakdown: {},
        files: [],
      }),
    });

    const result = await runner({
      prompt: "p",
      systemPrompt: "s",
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-4-6",
      context: { phaseName: "explorer", taskId: "task-1" },
      toolPolicy: {
        context: { runId: "run-1", phaseId: "explorer" },
        check: async () => ({ allowed: true, action: "approve", reason: "ok" }),
      },
    } as never);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("tool policy cannot be enforced");
  });

  test("refuses before dispatch, so an unguarded agent never runs", async () => {
    let dispatched = false;
    const runner = createKelosPhaseRunner({
      runTask: async () => {
        dispatched = true;
        return {
          succeeded: true,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          turns: 1,
          toolCalls: 0,
          toolBreakdown: {},
          files: [],
        };
      },
    });

    await runner({
      prompt: "p",
      systemPrompt: "s",
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-4-6",
      context: { phaseName: "explorer", taskId: "task-1" },
      toolPolicy: {
        context: { runId: "run-1", phaseId: "explorer" },
        check: async () => ({ allowed: true, action: "approve", reason: "ok" }),
      },
    } as never);

    expect(dispatched).toBe(false);
  });
});
