/**
 * ACP phase backend. Selected with:
 *
 *   FOREMAN_PHASE_BACKEND=module
 *   FOREMAN_PHASE_RUNNER_MODULE=<dist>/orchestrator/acp-backend.js
 *   FOREMAN_PHASE_RUNNER_EXPORT=runAcpPhase
 *
 * Foreman acts as the ACP client: it spawns an agent adapter per phase and drives
 * one session over stdio. Model routing rides the spawn environment because ACP
 * has no in-protocol model parameter.
 *
 * Scope: read-only phases (explorer, reviewer). Foreman's workflow tools are not
 * yet exposed over ACP, so the runner refuses any phase requiring them rather
 * than running one that cannot write its artifact or signal a retry.
 */

import { createAcpSubprocessClient, DEFAULT_ACP_COMMAND } from "./acp-client.js";
import { createAcpPhaseRunner } from "./acp-phase-runner.js";
import type { ConfiguredPhaseRunner, PhaseRunnerOptions } from "./phase-runner.js";
import type { PiRunResult } from "./pi-sdk-runner.js";

export interface AcpBackendConfig {
  command: string;
  args: string[];
  timeoutMs?: number;
}

export function acpBackendConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AcpBackendConfig {
  const timeout = Number(env.FOREMAN_ACP_TIMEOUT_MS);
  return {
    command: env.FOREMAN_ACP_COMMAND?.trim() || DEFAULT_ACP_COMMAND,
    args: env.FOREMAN_ACP_ARGS?.trim() ? env.FOREMAN_ACP_ARGS.trim().split(/\s+/) : [],
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
  };
}

export function createAcpBackend(config: AcpBackendConfig): ConfiguredPhaseRunner {
  return async (opts: PhaseRunnerOptions): Promise<PiRunResult> => {
    // Bound once so the narrowing survives into the callback below.
    const policy = opts.toolPolicy;

    // Built per phase: the client carries this phase's policy gate and text sink,
    // and one subprocess per phase is what makes per-phase model routing work.
    const client = createAcpSubprocessClient({
      command: config.command,
      args: config.args,
      timeoutMs: config.timeoutMs,
      onText: opts.onText,
      // Only when the phase actually requests a gate. Passing an undefined policy
      // would advertise enforcement the phase never asked for.
      ...(policy
        ? {
            toolPolicy: {
              check: (toolCallId, toolName, args) => policy.check(toolCallId, toolName, args),
            },
          }
        : {}),
    });

    return createAcpPhaseRunner(client)(opts);
  };
}

export const runAcpPhase: ConfiguredPhaseRunner = (opts) =>
  createAcpBackend(acpBackendConfigFromEnv())(opts);
