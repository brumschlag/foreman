/**
 * Entry point for running Foreman phases on kelos.
 *
 * Selected with:
 *   FOREMAN_PHASE_BACKEND=module
 *   FOREMAN_PHASE_RUNNER_MODULE=<dist>/orchestrator/kelos-backend.js
 *   FOREMAN_PHASE_RUNNER_EXPORT=runKelosPhase
 *
 * @module kelos-backend
 */

import { GitBackend } from "../lib/vcs/git-backend.js";
import { createKelosCrdClient } from "./kelos-client.js";
import { createKubectlKelosApi } from "./kelos-kubectl-api.js";
import { createKelosPhaseRunner } from "./kelos-phase-runner.js";
import type { ConfiguredPhaseRunner, PhaseRunnerOptions } from "./phase-runner.js";
import type { PiRunResult } from "./pi-sdk-runner.js";

export interface KelosBackendConfig {
  namespace: string;
  context?: string;
  workerPool?: string;
  workspace: string;
  agentType: string;
  pollIntervalMs?: number;
  /** Per-phase env for a pooled task; empty when no model env var is configured. */
  envOverridesFor(model: string): { name: string; value: string }[];
}

export function kelosBackendConfigFromEnv(): KelosBackendConfig {
  const namespace = process.env.KELOS_NAMESPACE?.trim();
  if (!namespace) {
    throw new Error("KELOS_NAMESPACE must be set to run phases on kelos");
  }

  // A pooled task cannot carry podOverrides, so the phase's model reaches the
  // agent through envOverrides under whichever variable the image reads.
  const modelEnv = process.env.KELOS_MODEL_ENV?.trim();
  const pollIntervalMs = Number(process.env.KELOS_POLL_INTERVAL_MS);

  return {
    namespace,
    context: process.env.KELOS_CONTEXT?.trim() || undefined,
    workerPool: process.env.KELOS_WORKER_POOL?.trim() || undefined,
    workspace: process.env.KELOS_WORKSPACE?.trim() || "",
    agentType: process.env.KELOS_AGENT_TYPE?.trim() || "claude-code",
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : undefined,
    envOverridesFor: (model) => (modelEnv ? [{ name: modelEnv, value: model }] : []),
  };
}

export function createKelosBackend(config: KelosBackendConfig): ConfiguredPhaseRunner {
  const api = createKubectlKelosApi({
    namespace: config.namespace,
    context: config.context,
  });

  return async (opts: PhaseRunnerOptions): Promise<PiRunResult> => {
    const client = createKelosCrdClient({
      api,
      workspace: config.workspace,
      agentType: config.agentType,
      // A pooled task takes its credentials from the pool.
      credentials: { type: "none", secretRef: { name: "" } },
      workerPool: config.workerPool,
      envOverrides: config.envOverridesFor(opts.model),
      pollIntervalMs: config.pollIntervalMs,
    });

    const runner = createKelosPhaseRunner(client, { vcs: new GitBackend(opts.cwd) });
    return runner(opts);
  };
}

export const runKelosPhase: ConfiguredPhaseRunner = (opts) =>
  createKelosBackend(kelosBackendConfigFromEnv())(opts);
