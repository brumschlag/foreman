/**
 * Installs the phase-report upload shim into a kelos agent pod.
 *
 * A kelos phase returns its work as a git patch of the REPOSITORY. Reports live
 * outside the repo (Foreman's `~/.foreman/reports/...`), so they never appeared in
 * the diff: the documentation phase's artifact gate failed a run whose agents had
 * all succeeded, and an agent trying to write there hit
 * `mkdir: cannot create directory '/home/foreman': Permission denied`.
 *
 * Same shape as the tool-policy hook and mail shim — the authority stays
 * server-side (`POST /worker/v1/reports`) and only the write point moves into the
 * pod, because `Task.spec.preCommands` is an agent's only pre-start seam.
 *
 * @module kelos-report-shim
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM_FILE = "report-shim.sh";
const WRITE_HOOK_FILE = "report-write-pretooluse.sh";

/** Where the shim script lands inside the agent pod. */
export const POD_REPORT_SHIM_PATH = "/tmp/foreman/report-shim.sh";

/** Where the Write-interception hook lands inside the agent pod. */
export const POD_REPORT_WRITE_HOOK_PATH = "/tmp/foreman/report-write-pretooluse.sh";

/**
 * Absolute path to the shim script. Resolved from this module so it works from
 * both `src/` under tsx and `dist/` after a build, where `src/defaults/` is
 * packaged alongside.
 */
export function reportShimPath(): string {
  return resolveHookScript(SHIM_FILE, "report shim script");
}

/**
 * Absolute path to the Write-interception hook, resolved the same way.
 */
export function reportWriteHookPath(): string {
  return resolveHookScript(WRITE_HOOK_FILE, "report write hook script");
}

function resolveHookScript(fileName: string, label: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "defaults", "hooks", fileName),
    join(here, "..", "..", "src", "defaults", "hooks", fileName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${label} not found; looked in ${candidates.join(", ")}`);
}

/**
 * `Task.spec.preCommands` entries that materialise the shim inside the pod.
 *
 * The script's CONTENTS are embedded rather than referenced by path: preCommands
 * run in the agent pod, where the orchestrator's `src/defaults/` tree does not
 * exist. A quoted heredoc keeps the shell from expanding the script's own `$VAR`
 * references while it is being written.
 */
export function reportShimInstallCommands(): string[][] {
  const script = readFileSync(reportShimPath(), "utf8");
  const writeHook = readFileSync(reportWriteHookPath(), "utf8");
  return [
    [
      "sh",
      "-c",
      `set -e; mkdir -p ${dirname(POD_REPORT_SHIM_PATH)}; ` +
        `cat > ${POD_REPORT_SHIM_PATH} <<'FOREMAN_REPORT_SHIM_EOF'\n${script}\nFOREMAN_REPORT_SHIM_EOF\n` +
        `chmod +x ${POD_REPORT_SHIM_PATH}`,
    ],
    // The interception hook is what covers a phase denied the Bash tool, which
    // cannot invoke the shim above at all.
    [
      "sh",
      "-c",
      `set -e; mkdir -p ${dirname(POD_REPORT_WRITE_HOOK_PATH)}; ` +
        `cat > ${POD_REPORT_WRITE_HOOK_PATH} <<'FOREMAN_REPORT_WRITE_HOOK_EOF'\n${writeHook}\nFOREMAN_REPORT_WRITE_HOOK_EOF\n` +
        `chmod +x ${POD_REPORT_WRITE_HOOK_PATH}`,
    ],
  ];
}

/**
 * The hook's `PreToolUse` settings entry.
 *
 * Returned rather than written: Claude Code loads ONE settings.json, and the
 * tool-policy install already writes that file with `cat >`. A second writer
 * would clobber the gate, so the report hook is merged into that single write
 * (see toolPolicyHookSettings).
 *
 * The matcher is narrow because both hooks fire in parallel on a match and each
 * adds latency to the call it matches; only file-writing tools can target the
 * reports directory.
 */
export function reportWriteHookSettingsEntry(timeoutSeconds = 30): unknown {
  return {
    matcher: "Write|Edit|NotebookWrite",
    hooks: [{ type: "command", command: `sh ${POD_REPORT_WRITE_HOOK_PATH}`, timeout: timeoutSeconds }],
  };
}

/**
 * Environment the shim reads, as kelos `envOverrides` entries.
 *
 * The token is omitted when absent rather than sent empty: an empty-but-present
 * variable looks configured and 401s every upload.
 */
export function reportShimEnv(opts: {
  serverUrl: string;
  authToken?: string;
  projectId: string;
  taskId: string;
  runId: string;
  phaseId: string;
}): { name: string; value: string }[] {
  const env = [
    { name: "FOREMAN_SERVER_URL", value: opts.serverUrl },
    { name: "FOREMAN_PROJECT_ID", value: opts.projectId },
    { name: "FOREMAN_TASK_ID", value: opts.taskId },
    { name: "FOREMAN_RUN_ID", value: opts.runId },
    { name: "FOREMAN_PHASE_ID", value: opts.phaseId },
  ];
  if (opts.authToken) {
    env.push({ name: "FOREMAN_SERVER_AUTH_TOKEN", value: opts.authToken });
  }
  return env;
}

/**
 * Prompt text telling the agent the shim exists.
 *
 * Required, not decorative: the mail shim established that an installed but
 * unmentioned capability is never invoked, because the agent's only knowledge of
 * its tools comes from the prompt.
 *
 * It must also explicitly BEAT the phase prompt's `mkdir -p "{{reportDir}}"`,
 * which is correct on the local path but impossible in a pod. Saying "the
 * directory is not writable" is too indirect: a MiniMax documentation phase read
 * both, followed the concrete mkdir, hit "Permission denied", and gave up without
 * calling the shim. So the conflicting instruction is named and overruled here,
 * and this guidance is appended after the phase prompt (see kelos-client).
 */
export function reportShimPromptGuidance(): string {
  return [
    "## Writing your phase report — overrides your instructions above",
    "",
    "You are running in a pod. Foreman's reports directory does NOT exist here and",
    "cannot be created, so ignore any instruction above telling you to `mkdir -p`",
    "that directory or to write your report into it — those apply only outside a",
    "pod, and following them will fail with `Permission denied`. Upload the report",
    "instead, which is the only way it reaches Foreman:",
    "",
    "```sh",
    `cat <<'EOF' | sh ${POD_REPORT_SHIM_PATH} <REPORT_FILE_NAME>`,
    "<the full report content>",
    "EOF",
    "```",
    "",
    "Use the exact file name your instructions ask for (for example",
    "`DOCUMENTATION_REPORT.md`). The command prints `uploaded <name>` on success",
    "and a `foreman report upload failed:` message otherwise — if it fails, say so",
    "in your final message rather than reporting the phase as complete.",
    "",
    "A `Permission denied` from the reports directory is expected and is not a",
    "blocker: run the upload command above instead of reporting the phase blocked.",
    "",
    "If you do not have the shell tool, just write the report to the reports path",
    "with your normal file-writing tool. Foreman intercepts that write and uploads",
    "it for you, then tells you it did so and skips the write — that response means",
    "the report IS saved, so do not retry it or report the phase blocked.",
  ].join("\n");
}
