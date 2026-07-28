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

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_FILE = "tool-policy-pretooluse.sh";

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
 * Claude Code settings registering the hook for every tool. Written into the agent's
 * config directory before the agent starts.
 */
export function toolPolicyHookSettings(hookPath: string, timeoutSeconds = 10): unknown {
  return {
    hooks: {
      PreToolUse: [
        {
          // Every tool is gated: the policy authority decides, not the matcher.
          matcher: "*",
          hooks: [{ type: "command", command: `sh ${hookPath}`, timeout: timeoutSeconds }],
        },
      ],
    },
  };
}
