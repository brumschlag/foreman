/**
 * Tests for installing the tool-policy PreToolUse hook into a kelos agent pod.
 *
 * The hook script and its Claude Code settings already exist, but nothing put
 * them inside the pod — so a kelos phase requesting a tool policy had to be
 * refused. A kelos agent is a separate program in a separate pod, so the only
 * seam that runs before the agent is `Task.spec.preCommands`.
 *
 * These tests pin the shape of that install: the commands must materialise both
 * the script and the settings file, and must not depend on anything from the
 * orchestrator's filesystem being visible to the pod.
 */

import { describe, expect, test } from "vitest";
import {
  toolPolicyInstallCommands,
  toolPolicyHookEnv,
  POD_HOOK_PATH,
  POD_HOOK_SETTINGS_PATH,
} from "../kelos-tool-policy-hook.js";

describe("toolPolicyInstallCommands", () => {
  test("writes the hook script into the pod", () => {
    const commands = toolPolicyInstallCommands();
    const script = commands.map((c: string[]) => c.join(" ")).join("\n");

    expect(script).toContain(POD_HOOK_PATH);
    // The gate's own fail-closed marker must survive the transfer.
    expect(script).toContain("exit 2");
  });

  test("registers the hook for every tool in Claude Code settings", () => {
    const commands = toolPolicyInstallCommands();
    const script = commands.map((c: string[]) => c.join(" ")).join("\n");

    expect(script).toContain("settings.json");
    expect(script).toContain("PreToolUse");
  });

  test("writes settings where Claude Code actually reads them", () => {
    // A live pod proved the point: settings under /tmp are never loaded, so the
    // hook silently did not fire and the agent ran unguarded. Claude Code reads
    // $CLAUDE_CONFIG_DIR/settings.json, defaulting to $HOME/.claude.
    expect(POD_HOOK_SETTINGS_PATH).toContain("settings.json");

    const script = toolPolicyInstallCommands()
      .map((c: string[]) => c.join(" "))
      .join("\n");
    expect(script).toContain("CLAUDE_CONFIG_DIR");
    expect(script).toContain("$HOME/.claude");
  });

  test("embeds the script inline rather than reading the orchestrator's disk", () => {
    const commands = toolPolicyInstallCommands();

    // A path reference would resolve inside the pod, where the orchestrator's
    // src/defaults tree does not exist.
    for (const command of commands) {
      expect(command.join(" ")).not.toContain("src/defaults/hooks");
    }
  });

  test("every command is directly executable without a shell on PATH assumption", () => {
    for (const command of toolPolicyInstallCommands()) {
      expect(command.length).toBeGreaterThan(0);
      expect(command[0]).toBe("sh");
    }
  });
});

describe("toolPolicyHookEnv", () => {
  test("passes the server URL, token, and correlation ids the hook reads", () => {
    const env = toolPolicyHookEnv({
      serverUrl: "http://foreman-server.kelos-pilot.svc.cluster.local:4766",
      authToken: "secret-token",
      runId: "run-1",
      taskId: "task-1",
      phaseId: "explorer",
    });
    const byName = new Map(env.map((e) => [e.name, e.value] as const));

    expect(byName.get("FOREMAN_SERVER_URL")).toBe(
      "http://foreman-server.kelos-pilot.svc.cluster.local:4766",
    );
    expect(byName.get("FOREMAN_SERVER_AUTH_TOKEN")).toBe("secret-token");
    expect(byName.get("FOREMAN_RUN_ID")).toBe("run-1");
    expect(byName.get("FOREMAN_TASK_ID")).toBe("task-1");
    expect(byName.get("FOREMAN_PHASE_ID")).toBe("explorer");
  });

  test("omits the token when none is configured rather than sending an empty one", () => {
    const env = toolPolicyHookEnv({
      serverUrl: "http://foreman-server:4766",
      runId: "run-1",
      taskId: "task-1",
      phaseId: "developer",
    });

    expect(env.map((e) => e.name)).not.toContain("FOREMAN_SERVER_AUTH_TOKEN");
  });
});
