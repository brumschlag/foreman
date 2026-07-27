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
import { createS3PatchStore, patchObjectKey, type PatchStore } from "./kelos-patch-store.js";
import type { ConfiguredPhaseRunner, PhaseRunnerOptions } from "./phase-runner.js";
import type { PiRunResult } from "./pi-sdk-runner.js";

export type KelosEnvVar =
  | { name: string; value: string }
  | { name: string; valueFrom: { secretKeyRef: { name: string; key: string } } };

/** Parses `NAME=value,NAME2=value2`. Values may contain `=` (URLs, tokens). */
function parseLiteralEnv(spec: string): KelosEnvVar[] {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      if (eq < 1) {
        throw new Error(`KELOS_AGENT_ENV entry must be NAME=value, got ${entry}`);
      }
      return { name: entry.slice(0, eq), value: entry.slice(eq + 1) };
    });
}

/** Parses `NAME=secretName:secretKey`. */
function parseSecretEnv(spec: string): KelosEnvVar[] {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      const ref = entry.slice(eq + 1);
      const colon = ref.indexOf(":");
      if (eq < 1 || colon < 1) {
        throw new Error(
          `KELOS_AGENT_ENV_FROM_SECRET entry must be NAME=secretName:secretKey, got ${entry}`,
        );
      }
      return {
        name: entry.slice(0, eq),
        valueFrom: {
          secretKeyRef: { name: ref.slice(0, colon), key: ref.slice(colon + 1) },
        },
      };
    });
}

export interface KelosBackendConfig {
  namespace: string;
  context?: string;
  workerPool?: string;
  workspace: string;
  agentType: string;
  pollIntervalMs?: number;
  /**
   * Foreman's own worktree PVC, mounted into a per-phase Job. Phases run
   * sequentially so one pod mounts at a time and ReadWriteOnce suffices — no RWX
   * storage needed. The agent edits Foreman's worktree directly, so nothing is
   * pushed and Foreman keeps sole ownership of git.
   */
  sharedWorktree?: { claimName: string; mountPath: string };
  /**
   * Agent-container env for the non-pooled path, where a Task creates its own Job
   * and inherits nothing. Carries gateway routing and its credential reference.
   * Unavailable on the pooled path, where the CRD forbids podOverrides.
   */
  podOverrides?: { env: KelosEnvVar[] };
  /**
   * Foreman's own path to the shared worktree. The agent's cwd is the pod's
   * mount path, which does not resolve on Foreman's machine, so git runs here.
   */
  localWorktreePath?: string;
  /**
   * Object storage for patch transport. The agent uploads its diff with a
   * presigned URL, so the pod needs no AWS credentials, and Foreman applies the
   * patch after the pod is gone.
   */
  patchStore?: PatchStore;
  /** Key prefix and the env var carrying the presigned upload URL. */
  patch?: { prefix: string; envVar: string };
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

  const workerPool = process.env.KELOS_WORKER_POOL?.trim() || undefined;
  const worktreePvc = process.env.KELOS_WORKTREE_PVC?.trim() || undefined;
  // A pooled worker owns its own persistent workspace, so also mounting
  // Foreman's worktree would give the same files two sources of truth.
  if (workerPool && worktreePvc) {
    throw new Error("KELOS_WORKER_POOL and KELOS_WORKTREE_PVC are mutually exclusive");
  }

  const patchBucket = process.env.KELOS_PATCH_BUCKET?.trim() || undefined;

  const agentEnv = [
    ...parseLiteralEnv(process.env.KELOS_AGENT_ENV ?? ""),
    ...parseSecretEnv(process.env.KELOS_AGENT_ENV_FROM_SECRET ?? ""),
  ];
  // podOverrides is rejected alongside workerPoolRef; a pool supplies this env
  // from its own template instead.
  if (workerPool && agentEnv.length > 0) {
    throw new Error(
      "KELOS_AGENT_ENV/KELOS_AGENT_ENV_FROM_SECRET are not supported on the pooled path; configure the env on the WorkerPool instead",
    );
  }

  return {
    namespace,
    context: process.env.KELOS_CONTEXT?.trim() || undefined,
    workerPool,
    sharedWorktree: worktreePvc
      ? {
          claimName: worktreePvc,
          // kelos only sets the agent's WorkingDir when the Task has a
          // workspaceRef, which a shared-worktree Task omits so kelos does not
          // clone. The agent therefore starts in /workspace, so the worktree has
          // to be mounted there rather than a subdirectory.
          mountPath: process.env.KELOS_WORKTREE_MOUNT?.trim() || "/workspace",
        }
      : undefined,
    podOverrides: agentEnv.length > 0 ? { env: agentEnv } : undefined,
    localWorktreePath: process.env.KELOS_LOCAL_WORKTREE?.trim() || undefined,
    ...(patchBucket
      ? {
          patchStore: createS3PatchStore({
            bucket: patchBucket,
            region: process.env.KELOS_PATCH_REGION?.trim() || undefined,
          }),
          patch: {
            prefix: process.env.KELOS_PATCH_PREFIX?.trim() || "foreman",
            envVar: process.env.KELOS_PATCH_ENV?.trim() || "FOREMAN_PATCH_URL",
          },
        }
      : {}),
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
    // Sign a per-phase upload URL so the agent can return its patch without any
    // AWS credentials in the pod.
    let patchUpload: { url: string; envVar: string; key: string } | undefined;
    if (config.patchStore && config.patch) {
      const key = patchObjectKey({
        prefix: config.patch.prefix,
        runId: opts.context.runId ?? opts.context.taskId,
        phaseName: opts.context.phaseName,
      });
      patchUpload = {
        key,
        envVar: config.patch.envVar,
        url: await config.patchStore.presignPut(key),
      };
    }

    const client = createKelosCrdClient({
      api,
      workspace: config.workspace,
      agentType: config.agentType,
      // The credential comes from the pool or the pod env, not the Task. An
      // empty secretRef.name is rejected by the API server, so omit it.
      credentials: { type: "none" },
      workerPool: config.workerPool,
      sharedWorktree: config.sharedWorktree,
      podOverrides: config.podOverrides,
      envOverrides: config.envOverridesFor(opts.model),
      patchUpload,
      pollIntervalMs: config.pollIntervalMs,
    });

    // GitBackend runs on Foreman's machine, so it is rooted at Foreman's path —
    // not the pod mount path the agent was given.
    const localWorktree = config.localWorktreePath ?? opts.cwd;
    const runner = createKelosPhaseRunner(client, {
      vcs: new GitBackend(localWorktree),
      localWorktreePath: localWorktree,
      patchStore: config.patchStore,
    });
    return runner(opts);
  };
}

export const runKelosPhase: ConfiguredPhaseRunner = (opts) =>
  createKelosBackend(kelosBackendConfigFromEnv())(opts);
