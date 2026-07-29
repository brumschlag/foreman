/**
 * Installs the Agent Mail shim into a kelos agent pod.
 *
 * Mail on the Pi path is three in-process tool closures over a live
 * AgentMailClient (`agent-worker.ts`), which cannot reach a kelos agent running
 * as a separate program in a separate pod. So a kelos phase had no mail channel
 * at all: `foreman inbox send` was stored but never consumed, Overwatch steering
 * landed as `delivery_status: "unsupported"`, and an agent hitting a blocker had
 * no way to report it.
 *
 * The fix mirrors the tool-policy hook exactly: the authority stays server-side
 * (`/worker/v1/mail*`) and only the interception point moves into the pod. Here
 * that point is a shell shim plus Claude Code slash commands, because
 * `Task.spec.preCommands` is an agent's only pre-start seam.
 *
 * Unlike the policy hook this is not a safety gate, so it does not fail closed —
 * see the script's header. Losing steering is bad; wedging the phase because
 * steering is unavailable is worse.
 *
 * @module kelos-mail-shim
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM_FILE = "mail-shim.sh";

/** Where the shim script lands inside the agent pod. */
export const POD_MAIL_SHIM_PATH = "/tmp/foreman/mail-shim.sh";

/**
 * Claude Code loads slash commands from `$CLAUDE_CONFIG_DIR/commands/*.md`
 * (default `$HOME/.claude`). The tool-policy install learned this the hard way:
 * files written anywhere else are silently never read, so the feature looks
 * installed and simply does not exist at runtime.
 */
export const POD_MAIL_COMMANDS_DIR = '${CLAUDE_CONFIG_DIR:-$HOME/.claude}/commands';

/**
 * Absolute path to the shim script. Resolved from this module so it works from
 * both `src/` under tsx and `dist/` after a build, where `src/defaults/` is
 * packaged alongside.
 */
export function mailShimPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/orchestrator/... -> dist/defaults/hooks (packaged layout)
    join(here, "..", "defaults", "hooks", SHIM_FILE),
    // src/orchestrator/... -> src/defaults/hooks
    join(here, "..", "..", "src", "defaults", "hooks", SHIM_FILE),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`mail shim script not found; looked in ${candidates.join(", ")}`);
}

/**
 * The slash commands the agent sees. Bodies are Claude Code command markdown:
 * `!` prefixes a shell command whose output is returned to the model.
 *
 * `$ARGUMENTS` is Claude Code's substitution for whatever the agent typed after
 * the command name, so `/mail-send foreman agent-error blocked` reaches the shim
 * as three positional arguments.
 */
export function mailShimCommands(): { name: string; body: string }[] {
  return [
    {
      name: "mail-read",
      body: [
        "---",
        "description: Read new Foreman Agent Mail (operator steering, phase handoffs)",
        "---",
        "",
        `!sh ${POD_MAIL_SHIM_PATH} read`,
        "",
      ].join("\n"),
    },
    {
      name: "mail-send",
      body: [
        "---",
        "description: Send Foreman Agent Mail. Usage: /mail-send <to> <subject> <body>",
        "---",
        "",
        `!sh ${POD_MAIL_SHIM_PATH} send $ARGUMENTS`,
        "",
      ].join("\n"),
    },
  ];
}

/**
 * `Task.spec.preCommands` entries that materialise the shim inside the agent pod.
 *
 * The script's CONTENTS are embedded rather than referenced by path: preCommands
 * run in the agent pod, where the orchestrator's `src/defaults/` tree does not
 * exist. A heredoc with a quoted delimiter keeps the shell from expanding the
 * script's own `$VAR` references while it is being written.
 */
export function mailShimInstallCommands(): string[][] {
  const script = readFileSync(mailShimPath(), "utf8");

  const commands: string[][] = [
    [
      "sh",
      "-c",
      `set -e; mkdir -p ${dirname(POD_MAIL_SHIM_PATH)}; ` +
        `cat > ${POD_MAIL_SHIM_PATH} <<'FOREMAN_MAIL_EOF'\n${script}\nFOREMAN_MAIL_EOF\n` +
        `chmod +x ${POD_MAIL_SHIM_PATH}`,
    ],
  ];

  for (const command of mailShimCommands()) {
    commands.push([
      "sh",
      "-c",
      // The commands dir is a shell expansion, so it resolves in the pod rather
      // than by Node's path helpers.
      `set -e; DIR="${"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"}/commands"; mkdir -p "$DIR"; ` +
        `cat > "$DIR/${command.name}.md" <<'FOREMAN_MAIL_CMD_EOF'\n${command.body}\nFOREMAN_MAIL_CMD_EOF`,
    ]);
  }

  return commands;
}

/**
 * Environment the shim reads, as kelos `envOverrides` entries.
 *
 * The token is omitted when absent rather than sent empty: the shim treats an
 * empty token as "no auth header", and an empty-but-present variable would look
 * configured while failing every call with a 401.
 *
 * `FOREMAN_SERVER_URL`, `FOREMAN_RUN_ID`, `FOREMAN_TASK_ID` and
 * `FOREMAN_PHASE_ID` overlap with the tool policy's env. Callers merge both
 * lists, so this returns only what is not already guaranteed to be present when
 * a policy is configured — see `mailShimEnv`'s use in `kelos-client.ts`, which
 * de-duplicates by name.
 */
export function mailShimEnv(opts: {
  serverUrl: string;
  authToken?: string;
  runId: string;
  taskId: string;
  phaseId: string;
  /** Inbox owner. Defaults to the phase id, matching the Pi path's agent names. */
  agentName?: string;
}): { name: string; value: string }[] {
  const env = [
    { name: "FOREMAN_SERVER_URL", value: opts.serverUrl },
    { name: "FOREMAN_RUN_ID", value: opts.runId },
    { name: "FOREMAN_TASK_ID", value: opts.taskId },
    { name: "FOREMAN_PHASE_ID", value: opts.phaseId },
    { name: "FOREMAN_AGENT_NAME", value: opts.agentName ?? opts.phaseId },
  ];
  if (opts.authToken) {
    env.push({ name: "FOREMAN_SERVER_AUTH_TOKEN", value: opts.authToken });
  }
  return env;
}

/**
 * Guidance appended to the phase prompt so the agent knows the channel exists.
 *
 * Without this the commands are installed and never invoked: the reference agent
 * images do not advertise slash commands unprompted, and the Pi path's tool
 * descriptions (which is where this guidance lives in-process) do not travel to
 * a pod.
 */
export function mailShimPromptGuidance(): string {
  return [
    "## Agent Mail",
    "",
    "You have a mail channel to Foreman and its operator:",
    "",
    "- `/mail-read` — read new mail. Operator steering and phase handoffs arrive here.",
    "  Check it when you start, and again if you are about to change approach.",
    "- `/mail-send <to> <subject> <body>` — send mail. Use `foreman` as the recipient",
    "  for blockers and errors, e.g. `/mail-send foreman agent-error Cannot locate the target module`.",
    "",
    "Mail steering is authoritative: if a message narrows your scope or redirects you,",
    "follow it over your earlier plan. If mail is unavailable the command reports an",
    "error — carry on with the task rather than stopping.",
  ].join("\n");
}
