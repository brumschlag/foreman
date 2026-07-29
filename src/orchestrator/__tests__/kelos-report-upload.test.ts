/**
 * Phase reports on the kelos path.
 *
 * A kelos phase runs in its own pod and returns work as a git patch of the
 * REPOSITORY. Reports live outside the repo (Foreman's ~/.foreman/reports), so
 * they never appeared in the diff — the documentation phase's artifact gate failed
 * a run whose agents had all succeeded, and the agent had earlier hit
 * "mkdir: cannot create directory '/home/foreman': Permission denied" trying.
 *
 * Reports upload through /worker/v1/reports and the server writes them where the
 * existing filesystem gate looks.
 */

import { describe, expect, test } from "vitest";
import {
  POD_REPORT_SHIM_PATH,
  reportShimEnv,
  reportShimInstallCommands,
  reportShimPromptGuidance,
} from "../kelos-report-shim.js";

describe("kelos report shim", () => {
  test("installs a shim the agent can call", () => {
    const script = reportShimInstallCommands().map((c) => c.join(" ")).join("\n");

    expect(script).toContain(POD_REPORT_SHIM_PATH);
    // Embedded, not referenced: the orchestrator's src/defaults tree does not
    // exist in the pod.
    expect(script).not.toContain("src/defaults/hooks");
  });

  test("passes the endpoint and the ids the server requires", () => {
    const env = new Map(
      reportShimEnv({
        serverUrl: "http://foreman-server:4766",
        authToken: "tok",
        projectId: "proj",
        taskId: "task-1",
        runId: "run-1",
        phaseId: "documentation",
      }).map((e) => [e.name, e.value] as const),
    );

    expect(env.get("FOREMAN_SERVER_URL")).toBe("http://foreman-server:4766");
    expect(env.get("FOREMAN_PROJECT_ID")).toBe("proj");
    expect(env.get("FOREMAN_TASK_ID")).toBe("task-1");
    expect(env.get("FOREMAN_RUN_ID")).toBe("run-1");
  });

  test("omits the token rather than sending an empty one", () => {
    const names = reportShimEnv({
      serverUrl: "http://foreman-server:4766",
      projectId: "proj",
      taskId: "task-1",
      runId: "run-1",
      phaseId: "qa",
    }).map((e) => e.name);

    expect(names).not.toContain("FOREMAN_SERVER_AUTH_TOKEN");
  });

  test("tells the agent the shim exists", () => {
    // An installed-but-unmentioned capability is never used: the mail shim
    // learned this, so guidance rides in the prompt.
    const guidance = reportShimPromptGuidance();

    expect(guidance).toContain(POD_REPORT_SHIM_PATH);
    expect(guidance.toLowerCase()).toContain("report");
  });
});

// The client is the seam that builds the Task, so wiring is asserted here rather
// than through createKelosBackend, whose kubectl API is constructed internally.
describe("kelos client report wiring", () => {
  test("installs the shim, passes the ids, and tells the agent it exists", async () => {
    const { createKelosCrdClient } = await import("../kelos-client.js");
    let created: {
      spec?: {
        preCommands?: string[][];
        envOverrides?: { name: string; value: string }[];
        prompt?: string;
      };
    } | undefined;

    const client = createKelosCrdClient({
      api: {
        createTask: async (task) => {
          created = task as typeof created;
          return "t";
        },
        getTask: async () => ({ status: { phase: "Succeeded" } }) as never,
      },
      workspace: "repo",
      agentType: "claude-code",
      credentials: { type: "none" },
      pollIntervalMs: 0,
      reports: {
        serverUrl: "http://foreman-server:4766",
        authToken: "tok",
        projectId: "proj-1",
        taskId: "task-1",
        runId: "run-1",
        phaseId: "documentation",
      },
    });

    await client.runTask({
      prompt: "p",
      systemPrompt: "s",
      model: "claude-haiku",
      phaseName: "documentation",
      taskId: "task-1",
    });

    const pre = (created?.spec?.preCommands ?? []).map((c) => c.join(" ")).join("\n");
    expect(pre).toContain(POD_REPORT_SHIM_PATH);

    const env = new Map((created?.spec?.envOverrides ?? []).map((e) => [e.name, e.value] as const));
    expect(env.get("FOREMAN_PROJECT_ID")).toBe("proj-1");
    expect(env.get("FOREMAN_SERVER_AUTH_TOKEN")).toBe("tok");

    // Guidance must ride in the prompt or the agent never calls the shim.
    expect(created?.spec?.prompt).toContain(POD_REPORT_SHIM_PATH);
  });

  // Run 4e7fb82a went STUCK on a missing DOCUMENTATION_REPORT.md because the
  // phase prompt's `mkdir -p "{{reportDir}}"` came AFTER the shim guidance and
  // won: MiniMax followed it literally, hit "Permission denied", and never
  // called the shim. Haiku had resolved the same conflict correctly, so this
  // read as model flakiness rather than an ordering bug.
  test("puts the shim guidance after the phase prompt so it is the last word", async () => {
    const { createKelosCrdClient } = await import("../kelos-client.js");
    let created: { spec?: { prompt?: string } } | undefined;

    const client = createKelosCrdClient({
      api: {
        createTask: async (task) => {
          created = task as typeof created;
          return "t";
        },
        getTask: async () => ({ status: { phase: "Succeeded" } }) as never,
      },
      workspace: "repo",
      agentType: "claude-code",
      credentials: { type: "none" },
      pollIntervalMs: 0,
      reports: {
        serverUrl: "http://foreman-server:4766",
        projectId: "proj-1",
        taskId: "task-1",
        runId: "run-1",
        phaseId: "documentation",
      },
    });

    // Verbatim shape of the instruction the shim has to beat.
    const phasePrompt = 'Create the directory first with `mkdir -p "/home/foreman/.foreman/reports/p/t/r"`.';
    await client.runTask({
      prompt: phasePrompt,
      systemPrompt: "s",
      model: "MiniMax",
      phaseName: "documentation",
      taskId: "task-1",
    });

    const prompt = created?.spec?.prompt ?? "";
    expect(prompt.indexOf(POD_REPORT_SHIM_PATH)).toBeGreaterThan(prompt.indexOf(phasePrompt));
  });

  test("guidance overrides an earlier instruction to mkdir the reports directory", () => {
    // Being last is not enough on its own — the agent has to be told which of
    // two conflicting instructions wins, by name.
    const guidance = reportShimPromptGuidance().toLowerCase();

    expect(guidance).toContain("mkdir");
    expect(guidance).toMatch(/ignore|instead of|overrides|even if|supersede/);
  });

  test("adds no report wiring when reports are not configured", async () => {
    const { createKelosCrdClient } = await import("../kelos-client.js");
    let created: { spec?: { preCommands?: string[][] } } | undefined;

    const client = createKelosCrdClient({
      api: {
        createTask: async (task) => {
          created = task as typeof created;
          return "t";
        },
        getTask: async () => ({ status: { phase: "Succeeded" } }) as never,
      },
      workspace: "repo",
      agentType: "claude-code",
      credentials: { type: "none" },
      pollIntervalMs: 0,
    });

    await client.runTask({
      prompt: "p",
      systemPrompt: "s",
      model: "claude-haiku",
      phaseName: "qa",
      taskId: "task-1",
    });

    const pre = (created?.spec?.preCommands ?? []).map((c) => c.join(" ")).join("\n");
    expect(pre).not.toContain(POD_REPORT_SHIM_PATH);
  });
});

// Option A: seed each pod with Foreman's accumulated worktree state.
describe("kelos seed patch wiring", () => {
  test("applies the seed BEFORE capturing the baseline", async () => {
    // Ordering is the correctness property. The baseline is what the phase's own
    // diff is taken against, so a seed applied after it would be attributed to
    // this phase and re-uploaded as its work.
    const { createKelosCrdClient } = await import("../kelos-client.js");
    let created: { spec?: { preCommands?: string[][] } } | undefined;

    const client = createKelosCrdClient({
      api: {
        createTask: async (task) => {
          created = task as typeof created;
          return "t";
        },
        getTask: async () => ({ status: { phase: "Succeeded" } }) as never,
      },
      workspace: "repo",
      agentType: "claude-code",
      credentials: { type: "none" },
      pollIntervalMs: 0,
      patchUpload: { url: "https://example.invalid/put", envVar: "FOREMAN_PATCH_URL" },
      seed: { url: "https://example.invalid/seed", envVar: "FOREMAN_SEED_URL" },
    });

    await client.runTask({
      prompt: "p",
      systemPrompt: "s",
      model: "claude-haiku",
      phaseName: "qa",
      taskId: "task-1",
    });

    const pre = (created?.spec?.preCommands ?? []).map((c) => c.join(" "));
    const seedIndex = pre.findIndex((c) => c.includes("FOREMAN_SEED_URL"));
    const baselineIndex = pre.findIndex((c) => c.includes("git stash create"));

    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(baselineIndex).toBeGreaterThanOrEqual(0);
    expect(seedIndex).toBeLessThan(baselineIndex);
  });

  test("omits seed wiring when no seed is provided", async () => {
    const { createKelosCrdClient } = await import("../kelos-client.js");
    let created: { spec?: { preCommands?: string[][] } } | undefined;

    const client = createKelosCrdClient({
      api: {
        createTask: async (task) => {
          created = task as typeof created;
          return "t";
        },
        getTask: async () => ({ status: { phase: "Succeeded" } }) as never,
      },
      workspace: "repo",
      agentType: "claude-code",
      credentials: { type: "none" },
      pollIntervalMs: 0,
    });

    await client.runTask({
      prompt: "p",
      systemPrompt: "s",
      model: "claude-haiku",
      phaseName: "explorer",
      taskId: "task-1",
    });

    const pre = (created?.spec?.preCommands ?? []).map((c) => c.join(" ")).join("\n");
    expect(pre).not.toContain("FOREMAN_SEED_URL");
  });
});
