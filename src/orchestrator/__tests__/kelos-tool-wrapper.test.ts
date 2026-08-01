/**
 * Restoring Grep/Glob to a kelos agent.
 *
 * Claude Code 2.1.220 excludes Grep and Glob from its DEFAULT tool set, so an
 * explorer phase had no discovery tool at all: it called Grep, got "No such tool
 * available: Grep", and a real run produced zero exploration. The tools DO exist
 * in the binary — `--allowed-tools "Grep,Glob"` yields 27 tools — but the kelos
 * agent image's entrypoint forwards no CLI flags, and nothing else reaches them
 * (settings.json via --settings and via CLAUDE_CONFIG_DIR, a
 * CLAUDE_CODE_ALLOWED_TOOLS env var, and the AgentConfig CRD were all probed
 * in-pod and all left the default 25-tool set unchanged).
 *
 * What IS reachable: the pod's PATH puts /home/claude/.local/bin ahead of
 * /usr/bin, where the real claude lives, and that directory is empty and
 * writable. So a preCommand can install a wrapper that re-execs the real binary
 * with the flag.
 */

import { describe, expect, test } from "vitest";
import {
  POD_TOOL_WRAPPER_PATH,
  RESTORED_TOOLS,
  toolWrapperInstallCommands,
} from "../kelos-tool-wrapper.js";

describe("kelos tool wrapper", () => {
  test("installs a claude wrapper that PATH-shadows the real binary", () => {
    const script = toolWrapperInstallCommands().map((c) => c.join(" ")).join("\n");

    // The wrapper must land in the directory that precedes /usr/bin in the pod's
    // PATH, or the real binary wins and the install is a silent no-op.
    expect(POD_TOOL_WRAPPER_PATH).toBe("/home/claude/.local/bin/claude");
    expect(script).toContain(POD_TOOL_WRAPPER_PATH);
    expect(script).toContain("chmod +x");
  });

  test("re-execs the real binary by absolute path", () => {
    const script = toolWrapperInstallCommands().map((c) => c.join(" ")).join("\n");

    // Calling bare `claude` would re-enter the wrapper — infinite recursion.
    expect(script).toContain("/usr/bin/claude");
    expect(script).toMatch(/exec\s+\/usr\/bin\/claude/);
  });

  test("adds the missing tools instead of replacing the tool set", () => {
    const script = toolWrapperInstallCommands().map((c) => c.join(" ")).join("\n");

    // --allowed-tools ADDS to the default set; --tools REPLACES it, and
    // `--tools "Grep,Glob"` would leave the agent with two tools and no Write,
    // Edit or Bash. Verified in-pod: --tools "Bash,Read,Grep,Glob" -> exactly 4.
    expect(script).toContain("--allowed-tools");
    expect(script).not.toContain("--tools ");
    for (const tool of RESTORED_TOOLS) {
      expect(script).toContain(tool);
    }
  });

  test("forwards the arguments kelos passes to the agent", () => {
    const script = toolWrapperInstallCommands().map((c) => c.join(" ")).join("\n");

    // The entrypoint supplies --dangerously-skip-permissions, --output-format,
    // --verbose, -p PROMPT and optionally --model/--effort/--plugin-dir. Dropping
    // them would break the run entirely.
    expect(script).toContain('"$@"');
  });

  test("the client installs the wrapper BEFORE the agent starts", async () => {
    // An install that is never dispatched is the failure mode this repo has
    // already shipped once (a tool-policy hook written to a path nothing read),
    // so assert the wiring, not just the command builder.
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
      model: "MiniMax",
      phaseName: "explorer",
      taskId: "task-1",
    });

    const pre = created?.spec?.preCommands ?? [];
    const joined = pre.map((c) => c.join(" "));
    const wrapperIdx = joined.findIndex((c) => c.includes(POD_TOOL_WRAPPER_PATH));

    expect(wrapperIdx, "wrapper install must be dispatched").toBeGreaterThanOrEqual(0);
    // preCommands run in order and the agent starts after them all, so position
    // only matters relative to other installs — but a later reorder that pushed
    // this after an agent start would be silent, so pin it first.
    expect(wrapperIdx).toBe(0);
  });

  test("overwrites any wrapper left by an earlier task on the same pod", () => {
    const script = toolWrapperInstallCommands().map((c) => c.join(" ")).join("\n");

    // A pooled worker's filesystem persists across every Task it serves, so a
    // conditional install would let a stale wrapper from an earlier Task keep
    // serving different flags.
    expect(script).not.toMatch(/if\s+\[\s*!?\s*-[efx]/);
    expect(script).toMatch(/cat\s*>\s*\/home\/claude\/\.local\/bin\/claude/);
  });
});
