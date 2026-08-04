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
 * Foreman's workflow tools are served to the agent over MCP (see
 * foreman-tool-mcp-server.ts), so write phases run too — a phase is refused only
 * when it needs a gate or tools this client cannot provide.
 *
 * Configuration:
 *
 *   FOREMAN_ACP_COMMAND     adapter executable (default: claude-agent-acp)
 *   FOREMAN_ACP_ARGS        whitespace-separated args for it
 *   FOREMAN_ACP_TIMEOUT_MS  ceiling on one phase
 *   FOREMAN_ACP_MODEL_MAP   comma-separated `<workflow-model>=<provider-model>`
 *
 * The model map exists because workflow YAML resolves shorthands to Pi-style ids
 * that a provider behind the adapter may reject. On Bedrock, for example:
 *
 *   FOREMAN_ACP_MODEL_MAP=anthropic/claude-haiku-4-5=us.anthropic.claude-haiku-4-5-20251001-v1:0,\
 *                         anthropic/claude-sonnet-4-6=us.anthropic.claude-sonnet-4-6
 *
 * Once any mapping is set, an UNMAPPED model fails the phase rather than being
 * passed through — silently running a phase on a model the workflow did not ask
 * for changes its cost and quality.
 */

import { createAcpSubprocessClient, DEFAULT_ACP_COMMAND, type AcpSubprocessClientOptions } from "./acp-client.js";
import { createAcpPhaseRunner, type AcpClient } from "./acp-phase-runner.js";
import type { ConfiguredPhaseRunner, PhaseRunnerOptions } from "./phase-runner.js";
import type { PiRunResult } from "./pi-sdk-runner.js";

export interface AcpBackendConfig {
  command: string;
  args: string[];
  timeoutMs?: number;
  /**
   * Workflow model id → the id this provider actually accepts.
   *
   * Workflow YAML resolves shorthands to Pi-style ids ("anthropic/claude-haiku-4-5"),
   * which a provider behind the adapter may not recognise — Bedrock rejects that one
   * with a 400 and wants "us.anthropic.claude-haiku-4-5-20251001-v1:0". Empty means
   * pass everything through unchanged.
   */
  modelMap: Map<string, string>;
  /**
   * Builds the ACP client. Injectable so the backend's own wiring — model
   * translation, tool passthrough, policy gating — is testable without spawning an
   * agent subprocess. Defaults to the real subprocess client.
   */
  createClient?: (opts: AcpSubprocessClientOptions) => AcpClient;
}

/**
 * Translate a workflow model id for the configured provider.
 *
 * An unmapped model is REFUSED rather than substituted, once a map exists: running a
 * phase on a model the workflow did not ask for silently changes its cost and
 * quality, so a P0 phase configured for opus quietly running on haiku is worse than
 * one that will not start. Matches kelos's gatewayModel.
 */
export function resolveAcpModel(model: string, modelMap: Map<string, string>): string {
  if (modelMap.size > 0 && !modelMap.has(model)) {
    throw new Error(
      `model ${model} is not mapped for the ACP provider; add it to FOREMAN_ACP_MODEL_MAP`,
    );
  }
  return modelMap.get(model) ?? model;
}

function parseModelMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw?.trim()) return map;

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Split on the FIRST '=' only: Bedrock target ids contain ':' and '.', and
    // provider ids contain '/', so the target must be taken verbatim.
    const separator = trimmed.indexOf("=");
    const from = separator === -1 ? "" : trimmed.slice(0, separator).trim();
    const to = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
    if (!from || !to) {
      throw new Error(
        `FOREMAN_ACP_MODEL_MAP entry '${trimmed}' must be '<workflow-model>=<provider-model>'`,
      );
    }
    map.set(from, to);
  }
  return map;
}

export function acpBackendConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AcpBackendConfig {
  const timeout = Number(env.FOREMAN_ACP_TIMEOUT_MS);
  return {
    command: env.FOREMAN_ACP_COMMAND?.trim() || DEFAULT_ACP_COMMAND,
    args: env.FOREMAN_ACP_ARGS?.trim() ? env.FOREMAN_ACP_ARGS.trim().split(/\s+/) : [],
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    modelMap: parseModelMap(env.FOREMAN_ACP_MODEL_MAP),
  };
}

export function createAcpBackend(config: AcpBackendConfig): ConfiguredPhaseRunner {
  return async (opts: PhaseRunnerOptions): Promise<PiRunResult> => {
    // Bound once so the narrowing survives into the callback below.
    const policy = opts.toolPolicy;

    // Translate before anything is spawned. An unmapped model would otherwise reach
    // the provider and come back as a 400 mid-phase, after the agent has started and
    // the attempt has been charged. Reported as a phase failure rather than a throw:
    // the pipeline handles agent-error, whereas an exception escaping the backend
    // takes down the worker and loses the run's bookkeeping.
    let model: string;
    try {
      model = resolveAcpModel(opts.model, config.modelMap);
    } catch (err: unknown) {
      return {
        success: false,
        costUsd: 0,
        turns: 0,
        toolCalls: 0,
        toolBreakdown: {},
        tokensIn: 0,
        tokensOut: 0,
        errorMessage: `agent-error: ${err instanceof Error ? err.message : String(err)}`,
        filesChanged: [],
      };
    }

    // Built per phase: the client carries this phase's policy gate and text sink,
    // and one subprocess per phase is what makes per-phase model routing work.
    const client = (config.createClient ?? createAcpSubprocessClient)({
      command: config.command,
      args: config.args,
      timeoutMs: config.timeoutMs,
      onText: opts.onText,
      // Served to the agent over MCP. Left undefined when the phase registered no
      // tools, so providesCustomTools stays false rather than claiming support for
      // an empty set.
      ...(opts.customTools ? { customTools: opts.customTools } : {}),
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

    // The translated model, so the agent is spawned with the id its provider accepts.
    return createAcpPhaseRunner(client)({ ...opts, model });
  };
}

export const runAcpPhase: ConfiguredPhaseRunner = (opts) =>
  createAcpBackend(acpBackendConfigFromEnv())(opts);
