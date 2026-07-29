/**
 * Tests for installing the Agent Mail shim into a kelos agent pod.
 *
 * Mail on the Pi path is three in-process tool closures over a live
 * AgentMailClient, which cannot reach an agent running as a separate program in
 * a separate pod. So a kelos phase had no mail channel: operator steering sent
 * with `foreman inbox send` was stored and never consumed, and an agent hitting a
 * blocker had no way to report it.
 *
 * These tests pin the shape of the install. The install mirrors the tool-policy
 * hook, so it inherits that hook's hard-won constraint: files must land where the
 * agent actually reads them, and nothing may depend on the orchestrator's
 * filesystem being visible inside the pod.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  mailShimInstallCommands,
  mailShimCommands,
  mailShimEnv,
  mailShimPath,
  mailShimPromptGuidance,
  POD_MAIL_SHIM_PATH,
  POD_MAIL_COMMANDS_DIR,
} from "../kelos-mail-shim.js";

describe("mailShimInstallCommands", () => {
  test("writes the shim script into the pod", () => {
    const script = mailShimInstallCommands()
      .map((c) => c.join(" "))
      .join("\n");

    expect(script).toContain(POD_MAIL_SHIM_PATH);
    // The shim's own verbs must survive the transfer.
    expect(script).toContain("mail-shim.sh");
    expect(script).toContain("chmod +x");
  });

  test("registers slash commands where Claude Code actually reads them", () => {
    // The tool-policy install proved this the expensive way: settings written
    // outside $CLAUDE_CONFIG_DIR were silently never loaded, so the hook did not
    // fire and the phase looked successful while running unguarded. Commands
    // live in $CLAUDE_CONFIG_DIR/commands, so the same trap applies here.
    expect(POD_MAIL_COMMANDS_DIR).toContain("commands");

    const script = mailShimInstallCommands()
      .map((c) => c.join(" "))
      .join("\n");
    expect(script).toContain("CLAUDE_CONFIG_DIR");
    expect(script).toContain("$HOME/.claude");
    expect(script).toContain("mail-read.md");
    expect(script).toContain("mail-send.md");
  });

  test("embeds the script inline rather than reading the orchestrator's disk", () => {
    // A path reference would resolve inside the pod, where the orchestrator's
    // src/defaults tree does not exist.
    for (const command of mailShimInstallCommands()) {
      expect(command.join(" ")).not.toContain("src/defaults/hooks");
    }
  });

  test("writes the script before the commands that invoke it", () => {
    const commands = mailShimInstallCommands();
    const scriptIndex = commands.findIndex((c) => c.join(" ").includes("chmod +x"));
    const commandIndex = commands.findIndex((c) => c.join(" ").includes("mail-read.md"));

    expect(scriptIndex).toBeGreaterThanOrEqual(0);
    expect(commandIndex).toBeGreaterThan(scriptIndex);
  });
});

describe("mailShimCommands", () => {
  test("exposes read and send to the agent", () => {
    const names = mailShimCommands().map((c) => c.name);
    expect(names).toContain("mail-read");
    expect(names).toContain("mail-send");
  });

  test("send forwards the agent's arguments to the shim", () => {
    const send = mailShimCommands().find((c) => c.name === "mail-send");
    // Without $ARGUMENTS the recipient/subject/body never reach the script and
    // every send is a usage error.
    expect(send?.body).toContain("$ARGUMENTS");
    expect(send?.body).toContain(`${POD_MAIL_SHIM_PATH} send`);
  });

  test("read invokes the shim's read verb", () => {
    const read = mailShimCommands().find((c) => c.name === "mail-read");
    expect(read?.body).toContain(`${POD_MAIL_SHIM_PATH} read`);
  });
});

describe("mailShimEnv", () => {
  const base = {
    serverUrl: "http://foreman:4766",
    runId: "run-1",
    taskId: "task-1",
    phaseId: "developer",
  };

  test("carries the correlation ids the shim needs", () => {
    const names = mailShimEnv(base).map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "FOREMAN_SERVER_URL",
        "FOREMAN_RUN_ID",
        "FOREMAN_TASK_ID",
        "FOREMAN_PHASE_ID",
        "FOREMAN_AGENT_NAME",
      ]),
    );
  });

  test("defaults the inbox owner to the phase id", () => {
    const agent = mailShimEnv(base).find((e) => e.name === "FOREMAN_AGENT_NAME");
    expect(agent?.value).toBe("developer");
  });

  test("honours an explicit agent name", () => {
    const agent = mailShimEnv({ ...base, agentName: "developer-task-1" }).find(
      (e) => e.name === "FOREMAN_AGENT_NAME",
    );
    expect(agent?.value).toBe("developer-task-1");
  });

  test("omits the token entirely when absent", () => {
    // An empty-but-present variable looks configured while 401ing every call.
    const names = mailShimEnv(base).map((e) => e.name);
    expect(names).not.toContain("FOREMAN_SERVER_AUTH_TOKEN");

    const withToken = mailShimEnv({ ...base, authToken: "tok" });
    expect(withToken.find((e) => e.name === "FOREMAN_SERVER_AUTH_TOKEN")?.value).toBe("tok");
  });
});

describe("mail shim script", () => {
  const script = () => readShim();

  test("fails open rather than closed", () => {
    // The policy hook must deny when it cannot reach the server. Mail must NOT:
    // blocking the phase because steering is unavailable is worse than losing
    // steering. `exit 2` is the policy hook's block signal and must not appear.
    expect(script()).not.toContain("exit 2");
  });

  test("acknowledges what it displays", () => {
    // An unacknowledged read re-delivers the same steering on every check and
    // the agent loops on stale instructions.
    expect(script()).toContain("delivery_status=delivered");
  });

  test("does not pipe ids into a loop that runs curl", () => {
    // A `while read` loop fed by redirection loses its remaining input to curl,
    // which inherits the loop's stdin — only the first message got acked.
    expect(script()).not.toMatch(/while\s+IFS=.*read.*\n(.|\n)*done\s*<\s*"\$IDFILE"/);
  });
});

describe("mailShimPromptGuidance", () => {
  test("tells the agent the channel exists", () => {
    // The commands install fine and are never invoked without this: the Pi
    // path's tool descriptions do not travel to a pod.
    const guidance = mailShimPromptGuidance();
    expect(guidance).toContain("/mail-read");
    expect(guidance).toContain("/mail-send");
  });

  test("tells the agent to keep working when mail is unavailable", () => {
    expect(mailShimPromptGuidance().toLowerCase()).toContain("carry on");
  });
});

function readShim(): string {
  return readFileSync(mailShimPath(), "utf8");
}
