/**
 * Restores Grep and Glob to a kelos agent by shadowing the `claude` binary.
 *
 * Claude Code 2.1.220 leaves Grep and Glob out of its default tool set, so an
 * explorer phase had no discovery tool: it called Grep, got "No such tool
 * available: Grep. ... search file contents with `grep` via the Bash tool
 * instead", and a real run produced zero exploration. The tools exist in the
 * binary — `--allowed-tools "Grep,Glob"` yields 27 — but the agent image's
 * entrypoint forwards no CLI flags, and every other channel was probed in-pod
 * and does nothing: settings.json (via `--settings` and via
 * `CLAUDE_CONFIG_DIR`), a `CLAUDE_CODE_ALLOWED_TOOLS` env var, and the
 * AgentConfig CRD, which exposes only agentsMD/mcpServers/plugins/skills.
 *
 * What remains is the PATH. The pod resolves `claude` through
 * `/home/claude/.local/bin` before `/usr/bin`, and that directory ships empty
 * and writable, so a `preCommands` entry can drop a wrapper there that re-execs
 * the real binary with the flag added.
 *
 * @module kelos-tool-wrapper
 */

/** The real binary, re-exec'd by absolute path so the wrapper cannot recurse. */
const REAL_CLAUDE_PATH = "/usr/bin/claude";

/**
 * Where the wrapper lands. This is the FIRST PATH entry in the agent image, so
 * it takes precedence over {@link REAL_CLAUDE_PATH}; anywhere else and the real
 * binary wins and the install is a silent no-op.
 */
export const POD_TOOL_WRAPPER_PATH = "/home/claude/.local/bin/claude";

/**
 * Tools absent from the CLI's default set that the pipeline's phase prompts and
 * the server's tool policy both expect to exist.
 */
export const RESTORED_TOOLS: readonly string[] = ["Grep", "Glob"];

/**
 * `Task.spec.preCommands` entries installing the wrapper.
 *
 * Written unconditionally: a pooled worker's filesystem persists across every
 * Task it serves, so a conditional install would let a wrapper from an earlier
 * Task keep supplying different flags.
 *
 * `--allowed-tools` ADDS to the default set. `--tools` replaces it, which would
 * strip Write, Edit and Bash — verified in-pod, where
 * `--tools "Bash,Read,Grep,Glob"` produced exactly those four tools.
 */
export function toolWrapperInstallCommands(): string[][] {
  const wrapper = [
    "#!/bin/sh",
    `exec ${REAL_CLAUDE_PATH} --allowed-tools "${RESTORED_TOOLS.join(",")}" "$@"`,
  ].join("\n");

  return [
    [
      "sh",
      "-c",
      `set -e; mkdir -p /home/claude/.local/bin; ` +
        `cat > ${POD_TOOL_WRAPPER_PATH} <<'FOREMAN_TOOL_WRAPPER_EOF'\n${wrapper}\nFOREMAN_TOOL_WRAPPER_EOF\n` +
        `chmod +x ${POD_TOOL_WRAPPER_PATH}`,
    ],
  ];
}
