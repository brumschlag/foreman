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
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import {
  POD_REPORT_SHIM_PATH,
  POD_REPORT_WRITE_HOOK_PATH,
  reportShimEnv,
  reportShimInstallCommands,
  reportShimPromptGuidance,
  reportWriteHookPath,
  reportWriteHookSettingsEntry,
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
    expect(pre).not.toContain(POD_REPORT_WRITE_HOOK_PATH);
  });

  test("installs the Write-interception hook and registers it alongside the policy gate", async () => {
    // The shim alone cannot serve a Bash-denied phase, so the hook has to be
    // installed AND registered — and the policy gate must survive the merge.
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
      toolPolicy: {
        serverUrl: "http://foreman-server:4766",
        runId: "run-1",
        taskId: "task-1",
        phaseId: "explorer",
      },
      reports: {
        serverUrl: "http://foreman-server:4766",
        projectId: "proj-1",
        taskId: "task-1",
        runId: "run-1",
        phaseId: "explorer",
      },
    });

    await client.runTask({
      prompt: "p",
      systemPrompt: "s",
      model: "MiniMax",
      phaseName: "explorer",
      taskId: "task-1",
    });

    const pre = (created?.spec?.preCommands ?? []).map((c) => c.join(" ")).join("\n");
    expect(pre).toContain(POD_REPORT_WRITE_HOOK_PATH);
    // The settings write is what makes Claude Code actually load the hook;
    // installing the script without registering it is a silent no-op.
    expect(pre).toContain("report-write-pretooluse.sh");
    expect(pre).toContain("tool-policy-pretooluse.sh");
  });
});

/**
 * The report shim is invoked as a SHELL command, so a phase denied the Bash tool
 * cannot call it at any prompt strength. foreman_server's overwatch denies the
 * explorer bash/find/ls (overwatch.ex: "explorer must use Grep/Glob/Read
 * discovery"), which is why run f36967cb produced every report EXCEPT
 * EXPLORER_REPORT.md — the explorer wrote it with the Write tool and hit EACCES.
 *
 * These tests EXECUTE the hook against a real HTTP server. A write-side
 * assertion would not have caught the earlier settings-path bug either: the
 * install was verified, and the hook still never ran.
 */
describe("report write interception hook", () => {
  const hook = reportWriteHookPath();
  const REPORT_PATH = "/home/foreman/.foreman/reports/proj/task/run/EXPLORER_REPORT.md";

  type HookRun = {
    stdout: string;
    decision?: { permissionDecision?: string; permissionDecisionReason?: string };
  };

  function parseRun(stdout: string): HookRun {
    if (!stdout.trim()) return { stdout };
    return { stdout, decision: JSON.parse(stdout).hookSpecificOutput };
  }

  /**
   * Async on purpose. execFileSync blocks the event loop, so the in-process
   * report server below can never answer the hook's curl — every upload times
   * out and the hook looks broken when only the harness is.
   */
  async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<HookRun> {
    const child = execFile("sh", [hook], { encoding: "utf8", env: { ...process.env, ...env } });
    const done = new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout?.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });
    // The hook reads its payload from stdin, so the stream must be closed or it
    // blocks on `cat`.
    child.stdin?.end(JSON.stringify(payload));
    return parseRun(await done);
  }

  /** No server needed: these paths never reach curl. */
  function runHookSync(payload: unknown, env: Record<string, string> = {}): HookRun {
    return parseRun(
      execFileSync("sh", [hook], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: { ...process.env, ...env },
      }),
    );
  }

  /** A one-shot server standing in for /worker/v1/reports. */
  async function withReportServer<T>(
    fn: (url: string, received: Array<Record<string, unknown>>) => Promise<T> | T,
    status = 200,
  ): Promise<T> {
    const received: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ url: req.url, body: body ? JSON.parse(body) : {} });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status < 400 ? '{"ok":true}' : '{"ok":false}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      return await fn(`http://127.0.0.1:${port}`, received);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const reportWrite = {
    tool_name: "Write",
    tool_input: { file_path: REPORT_PATH, content: "# Explorer Report\n\nHas \"quotes\" and `backticks`.\n" },
  };

  test("uploads the report the agent tried to write, then denies the write", async () => {
    await withReportServer(async (url, received) => {
      const { decision } = await runHook(reportWrite, {
        FOREMAN_SERVER_URL: url,
        FOREMAN_PROJECT_ID: "proj",
        FOREMAN_TASK_ID: "task",
        FOREMAN_RUN_ID: "run",
        FOREMAN_PHASE_ID: "explorer",
      });

      // Denied because the file genuinely never lands in the pod: an "allow"
      // would leave the agent believing a local copy exists.
      expect(decision?.permissionDecision).toBe("deny");
      expect(received).toHaveLength(1);
      expect(received[0]?.url).toBe("/worker/v1/reports");

      const body = received[0]?.body as Record<string, unknown>;
      expect(body["file_name"]).toBe("EXPLORER_REPORT.md");
      expect(body["project_id"]).toBe("proj");
      expect(body["run_id"]).toBe("run");
      // The body must survive JSON encoding intact — reports contain quotes and
      // backticks, which is why the shim encodes with python3 rather than shell.
      expect(body["content"]).toBe(reportWrite.tool_input.content);
    });
  });

  test("tells the agent the report is saved so it does not retry or report blocked", async () => {
    await withReportServer(async (url) => {
      const { decision } = await runHook(reportWrite, { FOREMAN_SERVER_URL: url });
      const reason = decision?.permissionDecisionReason ?? "";

      // The deny is the agent's ONLY signal, so it has to convey success.
      expect(reason).toContain("EXPLORER_REPORT.md");
      expect(reason.toLowerCase()).toContain("saved");
      expect(reason.toLowerCase()).toMatch(/do not retry|not a failure/);
    });
  });

  test("does not claim the report is saved when the upload fails", async () => {
    // The dangerous failure is a false success: the phase would report complete
    // with no report anywhere.
    await withReportServer(async (url) => {
      const { decision } = await runHook(reportWrite, { FOREMAN_SERVER_URL: url, FOREMAN_REPORT_TIMEOUT: "2" });
      const reason = decision?.permissionDecisionReason ?? "";

      expect(decision?.permissionDecision).toBe("deny");
      expect(reason.toLowerCase()).toContain("failed");
      expect(reason.toLowerCase()).not.toContain("is saved");
    }, 500);
  });

  test("leaves writes outside the reports directory alone", () => {
    // The agent's real work is its worktree; intercepting that would corrupt the
    // patch the phase returns. Silence (exit 0, no JSON) is "no decision", which
    // leaves the tool-policy gate to rule on the call.
    const cases = [
      { tool_name: "Write", tool_input: { file_path: "/workspace/repo/src/index.ts", content: "x" } },
      // Same FILE NAME as a report, but in the repo — must not be intercepted.
      { tool_name: "Write", tool_input: { file_path: "/workspace/repo/EXPLORER_REPORT.md", content: "x" } },
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { tool_name: "Read", tool_input: { file_path: REPORT_PATH } },
    ];

    for (const payload of cases) {
      expect(runHookSync(payload).stdout.trim(), JSON.stringify(payload.tool_input)).toBe("");
    }
  });

  test("covers report artifacts that are not named *_REPORT.md", async () => {
    // Matching on the reports LOCATION rather than the file name: a workflow can
    // declare any artifact (REVIEW.md, PR_METADATA.json), and a name pattern
    // would miss those silently.
    await withReportServer(async (url, received) => {
      await runHook(
        { tool_name: "Write", tool_input: { file_path: "/home/foreman/.foreman/reports/p/t/r/REVIEW.md", content: "ok" } },
        { FOREMAN_SERVER_URL: url },
      );
      expect((received[0]?.body as Record<string, unknown>)["file_name"]).toBe("REVIEW.md");
    });
  });

  test("passes through rather than denying when it cannot read a report body", () => {
    // Denying with nothing uploaded would strand the phase with no route at all;
    // letting the write proceed leaves the artifact gate to decide honestly.
    const noBody = { tool_name: "Write", tool_input: { file_path: REPORT_PATH, content: "" } };
    expect(runHookSync(noBody, { FOREMAN_SERVER_URL: "http://127.0.0.1:1" }).stdout.trim()).toBe("");
  });

  test("registers itself in the ONE settings.json the policy install writes", async () => {
    // Claude Code reads a single settings.json and the policy install writes it
    // with `cat >`. A second writer would clobber the safety gate, so the report
    // hook must ride along in that same write.
    const { toolPolicyHookSettings, POD_HOOK_PATH } = await import("../kelos-tool-policy-hook.js");
    const settings = toolPolicyHookSettings(POD_HOOK_PATH, 10, [reportWriteHookSettingsEntry()]) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const entries = settings.hooks.PreToolUse;

    expect(entries.some((e) => e.matcher === "*" && e.hooks[0]?.command.includes("tool-policy"))).toBe(true);
    expect(entries.some((e) => e.hooks[0]?.command.includes(POD_REPORT_WRITE_HOOK_PATH))).toBe(true);
    // Without reports there is nowhere to upload, so nothing extra is registered.
    const bare = toolPolicyHookSettings(POD_HOOK_PATH, 10) as typeof settings;
    expect(bare.hooks.PreToolUse).toHaveLength(1);
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
