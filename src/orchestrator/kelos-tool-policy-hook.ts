/**
 * Locates the PreToolUse hook that enforces Foreman's tool policy inside a kelos
 * agent pod.
 *
 * The policy authority is already an HTTP endpoint (`/worker/v1/tool-policy`), so
 * the gate does not need to move — only the interception point does. In-process the
 * interception wraps Pi SDK tool objects; in a pod it is a Claude Code PreToolUse
 * hook calling the same endpoint.
 *
 * Claude Code hooks fail OPEN — any exit code but 2 lets the tool run — so the
 * script denies on every path that does not receive an explicit allow. See its
 * header for the configuration it reads.
 *
 * @module kelos-tool-policy-hook
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_FILE = "tool-policy-pretooluse.sh";

/** Where the hook script lands inside the agent pod. */
export const POD_HOOK_PATH = "/tmp/foreman/tool-policy-pretooluse.sh";

/**
 * Claude Code only loads settings from `$CLAUDE_CONFIG_DIR/settings.json`
 * (default `$HOME/.claude`). A live pod proved this matters: settings written
 * anywhere else are never read, so the hook silently does not fire and the agent
 * runs unguarded — a failure that looks like success.
 */
export const POD_HOOK_SETTINGS_PATH = '${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json';

/**
 * Absolute path to the hook script. Resolved from this module so it works from
 * both `src/` under tsx and `dist/` after a build, where `src/defaults/` is
 * packaged alongside.
 */
export function toolPolicyHookPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/orchestrator/... -> dist/defaults/hooks (packaged layout)
    join(here, "..", "defaults", "hooks", HOOK_FILE),
    // src/orchestrator/... -> src/defaults/hooks
    join(here, "..", "..", "src", "defaults", "hooks", HOOK_FILE),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`tool policy hook script not found; looked in ${candidates.join(", ")}`);
}

/**
 * `Task.spec.preCommands` entries that materialise the hook inside the agent pod.
 *
 * The script's CONTENTS are embedded rather than referenced by path: preCommands
 * run in the agent pod, where the orchestrator's `src/defaults/` tree does not
 * exist. A heredoc with a quoted delimiter keeps the shell from expanding the
 * script's own `$VAR` references while it is being written.
 */
export function toolPolicyInstallCommands(
  timeoutSeconds = 10,
  extraPreToolUse: unknown[] = [],
): string[][] {
  const script = readFileSync(toolPolicyHookPath(), "utf8");
  const settings = JSON.stringify(
    toolPolicyHookSettings(POD_HOOK_PATH, timeoutSeconds, extraPreToolUse),
  );

  return [
    [
      "sh",
      "-c",
      `set -e; mkdir -p ${dirname(POD_HOOK_PATH)}; ` +
        `cat > ${POD_HOOK_PATH} <<'FOREMAN_HOOK_EOF'\n${script}\nFOREMAN_HOOK_EOF\n` +
        `chmod +x ${POD_HOOK_PATH}`,
    ],
    [
      "sh",
      "-c",
      // The settings dir is a shell expansion, so it is resolved in the pod
      // rather than by Node's path helpers.
      `set -e; DIR="${"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"}"; mkdir -p "$DIR"; ` +
        `cat > "$DIR/settings.json" <<'FOREMAN_SETTINGS_EOF'\n${settings}\nFOREMAN_SETTINGS_EOF`,
    ],
  ];
}

/**
 * Environment the hook reads, as kelos `envOverrides` entries.
 *
 * The token is omitted when absent rather than sent empty: the hook treats an
 * empty token as "no auth header", and an empty-but-present variable would look
 * configured while failing every call with a 401 (which denies).
 */
export function toolPolicyHookEnv(opts: {
  serverUrl: string;
  authToken?: string;
  runId: string;
  taskId: string;
  phaseId: string;
}): { name: string; value: string }[] {
  const env = [
    { name: "FOREMAN_SERVER_URL", value: opts.serverUrl },
    { name: "FOREMAN_RUN_ID", value: opts.runId },
    { name: "FOREMAN_TASK_ID", value: opts.taskId },
    { name: "FOREMAN_PHASE_ID", value: opts.phaseId },
  ];
  if (opts.authToken) {
    env.push({ name: "FOREMAN_SERVER_AUTH_TOKEN", value: opts.authToken });
  }
  return env;
}

/**
 * Claude Code settings registering the hook for every tool. Written into the agent's
 * config directory before the agent starts.
 *
 * Claude Code reads exactly ONE settings.json, and this function is its only
 * writer, so any other pod-side PreToolUse hook has to be merged in here through
 * `extraPreToolUse` rather than writing the file itself — a second `cat >` would
 * silently drop this gate.
 *
 * The policy gate stays FIRST. Matching hooks run in parallel and a deny from any
 * one of them blocks the call, so ordering is not what enforces the gate; leading
 * with it keeps the file readable as "policy first, conveniences after".
 */
export function toolPolicyHookSettings(
  hookPath: string,
  timeoutSeconds = 10,
  extraPreToolUse: unknown[] = [],
): unknown {
  return {
    hooks: {
      PreToolUse: [
        {
          // Every tool is gated: the policy authority decides, not the matcher.
          matcher: "*",
          hooks: [{ type: "command", command: `sh ${hookPath}`, timeout: timeoutSeconds }],
        },
        ...extraPreToolUse,
      ],
    },
  };
}
