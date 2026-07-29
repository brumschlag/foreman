/**
 * Tests that an Agent Mail channel requested for a phase actually reaches the
 * kelos agent pod.
 *
 * A kelos agent is a separate program in a separate pod, so the Pi path's
 * in-process mail tools cannot serve it. The channel travels instead as a shell
 * shim plus slash commands installed by preCommands, configured by envOverrides,
 * and advertised in the prompt. All three are required: without the install there
 * is no shim, without the env it cannot reach the server, and without the prompt
 * guidance the agent never invokes it.
 */

import { describe, expect, test } from "vitest";
import {
  createKelosCrdClient,
  type KelosApi,
  type KelosCrdClientOptions,
  type KelosTaskObject,
} from "../kelos-client.js";
import { POD_MAIL_SHIM_PATH } from "../kelos-mail-shim.js";

type CreatedTask = {
  spec?: {
    prompt?: string;
    preCommands?: string[][];
    envOverrides?: { name: string; value: string }[];
  };
};

function captureTask(overrides: Partial<KelosCrdClientOptions> = {}) {
  const created: CreatedTask[] = [];
  const api: KelosApi = {
    createTask: async (task: unknown) => {
      created.push(task as CreatedTask);
      return "task-generated";
    },
    getTask: async () => ({ status: { phase: "Succeeded" } }) as KelosTaskObject,
  };
  const client = createKelosCrdClient({
    api,
    workspace: "my-workspace",
    agentType: "claude-code",
    credentials: { type: "none" },
    pollIntervalMs: 0,
    ...overrides,
  });
  return { client, created };
}

const request = {
  prompt: "do the thing",
  systemPrompt: "you are the developer",
  model: "anthropic/claude-sonnet-4-6",
  phaseName: "developer",
  taskId: "task-1",
};

const MAIL = {
  serverUrl: "http://foreman-server.kelos-pilot.svc.cluster.local:4766",
  authToken: "mail-token",
  runId: "run-1",
  taskId: "task-1",
  phaseId: "developer",
};

describe("kelos mail wiring", () => {
  test("installs the shim and its commands when mail is configured", async () => {
    const { client, created } = captureTask({ mail: MAIL });
    await client.runTask(request);

    const preCommands = created[0]?.spec?.preCommands ?? [];
    const flat = preCommands.map((c) => c.join(" ")).join("\n");

    expect(flat).toContain(POD_MAIL_SHIM_PATH);
    expect(flat).toContain("mail-read.md");
    expect(flat).toContain("mail-send.md");
  });

  test("passes the server URL and correlation ids as env", async () => {
    const { client, created } = captureTask({ mail: MAIL });
    await client.runTask(request);

    const env = created[0]?.spec?.envOverrides ?? [];
    const byName = Object.fromEntries(env.map((e) => [e.name, e.value]));

    expect(byName.FOREMAN_SERVER_URL).toBe(MAIL.serverUrl);
    expect(byName.FOREMAN_RUN_ID).toBe("run-1");
    expect(byName.FOREMAN_PHASE_ID).toBe("developer");
    expect(byName.FOREMAN_AGENT_NAME).toBe("developer");
    expect(byName.FOREMAN_SERVER_AUTH_TOKEN).toBe("mail-token");
  });

  test("tells the agent the channel exists", async () => {
    // Installed-but-unmentioned slash commands are never invoked: the Pi path's
    // tool descriptions do not travel to a pod.
    const { client, created } = captureTask({ mail: MAIL });
    await client.runTask(request);

    const prompt = created[0]?.spec?.prompt ?? "";
    expect(prompt).toContain("/mail-read");
    expect(prompt).toContain("/mail-send");
    // The phase's own prompt must survive alongside the guidance.
    expect(prompt).toContain("do the thing");
    expect(prompt).toContain("you are the developer");
  });

  test("does not duplicate env names shared with the tool policy", async () => {
    // kelos rejects a Task whose envOverrides repeat a name, and the policy and
    // mail configs both carry the server URL and correlation ids.
    const { client, created } = captureTask({
      mail: MAIL,
      toolPolicy: {
        serverUrl: MAIL.serverUrl,
        authToken: "policy-token",
        runId: "run-1",
        taskId: "task-1",
        phaseId: "developer",
      },
    });
    await client.runTask(request);

    const names = (created[0]?.spec?.envOverrides ?? []).map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("adds nothing when mail is not configured", async () => {
    // A phase that wants no mail channel must produce a byte-identical Task to
    // before this feature existed.
    const { client, created } = captureTask();
    await client.runTask(request);

    const flat = (created[0]?.spec?.preCommands ?? []).map((c) => c.join(" ")).join("\n");
    expect(flat).not.toContain(POD_MAIL_SHIM_PATH);

    const names = (created[0]?.spec?.envOverrides ?? []).map((e) => e.name);
    expect(names).not.toContain("FOREMAN_AGENT_NAME");

    expect(created[0]?.spec?.prompt).not.toContain("/mail-read");
  });

  test("does not claim to deliver mail on the path that ignores preCommands", async () => {
    // kelos runs preCommands only on the POOLED path. A non-pooled Job accepts
    // and stores them, then silently ignores them — so a configured mail channel
    // is never installed. Reporting it as working is the failure mode the
    // tool-policy work was bitten by: a phase that looks equipped and is not.
    const { client } = captureTask({ mail: MAIL });
    expect(client.deliversMail).toBe(false);
  });

  test("claims to deliver mail on the pooled path, where preCommands run", async () => {
    const { client } = captureTask({ mail: MAIL, workerPool: "envoverrides-pool" });
    expect(client.deliversMail).toBe(true);
  });

  test("does not claim to deliver mail when none was configured", async () => {
    const { client } = captureTask({ workerPool: "envoverrides-pool" });
    expect(client.deliversMail).toBe(false);
  });

  test("installs mail alongside a tool policy without displacing it", async () => {
    const { client, created } = captureTask({
      mail: MAIL,
      toolPolicy: {
        serverUrl: MAIL.serverUrl,
        runId: "run-1",
        taskId: "task-1",
        phaseId: "developer",
      },
    });
    await client.runTask(request);

    const flat = (created[0]?.spec?.preCommands ?? []).map((c) => c.join(" ")).join("\n");
    // The policy hook must still be installed, and before the agent starts.
    expect(flat).toContain("PreToolUse");
    expect(flat).toContain(POD_MAIL_SHIM_PATH);
  });
});
