/**
 * Entry point for running Foreman phases on kelos.
 *
 * Selected with:
 *   FOREMAN_PHASE_BACKEND=module
 *   FOREMAN_PHASE_RUNNER_MODULE=<dist>/orchestrator/kelos-backend.js
 *   FOREMAN_PHASE_RUNNER_EXPORT=runKelosPhase
 *
 * The tool policy gate IS supported here. In-process it wraps Pi SDK tool objects,
 * which cannot reach an agent running as a separate program in a separate pod; on
 * this backend it travels as a Claude Code PreToolUse hook installed by
 * `Task.spec.preCommands`, calling the server's /worker/v1/tool-policy endpoint.
 * A client not configured with `toolPolicy` still refuses a policy-gated phase
 * rather than running it unguarded — see `kelos-phase-runner.ts`.
 *
 * @module kelos-backend
 */

import { GitBackend } from "../lib/vcs/git-backend.js";
import { createKelosCrdClient } from "./kelos-client.js";
import { createKubectlKelosApi } from "./kelos-kubectl-api.js";
import { createKelosPhaseRunner } from "./kelos-phase-runner.js";
import {
  createS3PatchStore,
  patchObjectKey,
  seedObjectKey,
  type PatchStore,
} from "./kelos-patch-store.js";
import {
  projectWorkspaceFromConfig,
  resolveKelosWorkspace,
  type ResolveKelosWorkspaceInput,
} from "./kelos-workspace.js";
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

/**
 * Parses `resolvedModel=gatewayName,...`. Workflow YAML shorthands resolve to
 * provider-qualified ids, which a gateway does not serve under those names.
 */
function parseModelMap(spec: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of spec.split(",").map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq < 1) {
      throw new Error(`KELOS_MODEL_MAP entry must be resolvedModel=gatewayName, got ${entry}`);
    }
    map.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  return map;
}

export interface KelosBackendConfig {
  namespace: string;
  context?: string;
  workerPool?: string;
  /**
   * Deployment-wide default workspace (`KELOS_WORKSPACE`), used for projects
   * that do not declare a `kelosWorkspace` of their own.
   */
  workspace: string;
  /**
   * Reads the owning project's `config` blob so a project can name its own kelos
   * Workspace. Injected rather than called inline so resolution is testable
   * without a live server.
   *
   * Must REJECT (not resolve `undefined`) when the config cannot be read:
   * falling back to the deployment default would run the agent against a
   * different repository than the task targets.
   */
  projectConfigFor?: (projectId: string) => Promise<Record<string, unknown> | undefined>;
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
  /**
   * Translates a resolved model id to the gateway's own name. kelos turns
   * spec.model into the agent CLI's --model flag, which wins over any env var, so
   * the Task's model must be mapped too — not just the env.
   */
  gatewayModel(model: string): string;
  /** Per-phase env for a pooled task; empty when no model env var is configured. */
  envOverridesFor(model: string): { name: string; value: string }[];
  /**
   * Server base URL the PreToolUse hook calls for tool-policy decisions.
   *
   * Undefined when unset, which keeps a policy-gated phase refused: the hook
   * fails closed, so pointing it at nothing would deny every tool call instead.
   */
  toolPolicyServerUrl?: string;
  /** Bearer token for that endpoint; the hook accepts either token name. */
  toolPolicyAuthToken?: string;
}

export function kelosBackendConfigFromEnv(): KelosBackendConfig {
  const namespace = process.env.KELOS_NAMESPACE?.trim();
  if (!namespace) {
    throw new Error("KELOS_NAMESPACE must be set to run phases on kelos");
  }

  // A pooled task cannot carry podOverrides, so the phase's model reaches the
  // agent through envOverrides under whichever variable the image reads.
  const modelEnv = process.env.KELOS_MODEL_ENV?.trim();
  const modelMap = parseModelMap(process.env.KELOS_MODEL_MAP ?? "");
  const pollIntervalMs = Number(process.env.KELOS_POLL_INTERVAL_MS);

  const workerPool = process.env.KELOS_WORKER_POOL?.trim() || undefined;
  const worktreePvc = process.env.KELOS_WORKTREE_PVC?.trim() || undefined;
  // A pooled worker owns its own persistent workspace, so also mounting
  // Foreman's worktree would give the same files two sources of truth.
  if (workerPool && worktreePvc) {
    throw new Error("KELOS_WORKER_POOL and KELOS_WORKTREE_PVC are mutually exclusive");
  }

  const patchBucket = process.env.KELOS_PATCH_BUCKET?.trim() || undefined;

  // One server endpoint backs the tool-policy gate, the report shim, the mail
  // shim, and now the per-project workspace lookup.
  const serverUrl = process.env.FOREMAN_SERVER_URL?.trim() || undefined;
  const serverToken =
    process.env.FOREMAN_WORKER_EVENT_TOKEN?.trim() ||
    process.env.FOREMAN_SERVER_AUTH_TOKEN?.trim() ||
    undefined;

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

  // An unmapped model is refused rather than substituted: running a phase on a
  // model the workflow did not ask for changes cost and quality silently.
  const gatewayModel = (model: string): string => {
    if (modelMap.size > 0 && !modelMap.has(model)) {
      throw new Error(
        `model ${model} is not mapped to a gateway model; add it to KELOS_MODEL_MAP`,
      );
    }
    return modelMap.get(model) ?? model;
  };

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
    toolPolicyServerUrl: serverUrl,
    toolPolicyAuthToken: serverToken,
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
    // Lets a project name its own kelos Workspace instead of every project
    // sharing KELOS_WORKSPACE. Reuses the server URL/token the reports and mail
    // shims already require, so this adds no new configuration.
    ...(serverUrl ? { projectConfigFor: projectConfigReader(serverUrl, serverToken) } : {}),
    agentType: process.env.KELOS_AGENT_TYPE?.trim() || "claude-code",
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : undefined,
    gatewayModel,
    envOverridesFor: (model) =>
      modelEnv ? [{ name: modelEnv, value: gatewayModel(model) }] : [],
  };
}

/**
 * Reads a project's `config` blob from the Foreman server.
 *
 * THROWS on any failure — an unreachable server, a non-2xx, or an unparseable
 * body. The caller turns that into a refusal to dispatch, because resolving
 * `undefined` instead would look like "this project declares no workspace" and
 * silently fall back to a default naming a different repository.
 */
function projectConfigReader(
  serverUrl: string,
  authToken: string | undefined,
): (projectId: string) => Promise<Record<string, unknown> | undefined> {
  return async (projectId: string) => {
    const response = await fetch(new URL("/api/v1/projects", serverUrl), {
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    });
    if (!response.ok) {
      throw new Error(`project lookup failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as {
      projects?: { project_id?: string; id?: string; config?: Record<string, unknown> }[];
    };
    // A project absent from the list is a legitimate "declares nothing" answer,
    // not a failure: the list itself was read successfully.
    const project = body.projects?.find((p) => (p.project_id ?? p.id) === projectId);
    return project?.config;
  };
}

/**
 * Gathers the two workspace sources for a phase.
 *
 * A failed lookup is reported as `lookupFailed` rather than thrown here, so the
 * fail-closed decision lives in one place (`resolveKelosWorkspace`) instead of
 * being split across the caller.
 */
async function projectWorkspaceInputs(
  config: KelosBackendConfig,
  projectId: string | undefined,
): Promise<ResolveKelosWorkspaceInput> {
  // No lookup configured, or no project to look up: the deployment default is
  // the only available answer, and that is not a failure.
  if (!config.projectConfigFor || !projectId) {
    return { envWorkspace: config.workspace };
  }

  try {
    const projectConfig = await config.projectConfigFor(projectId);
    return {
      projectWorkspace: projectWorkspaceFromConfig(projectConfig),
      envWorkspace: config.workspace,
    };
  } catch {
    return { envWorkspace: config.workspace, lookupFailed: true };
  }
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

    // Seed the pod with Foreman's accumulated worktree state. Each phase runs in a
    // fresh clone, so without this a phase cannot see earlier phases' work — a
    // verdict phase reported the task's own output missing while it sat in
    // Foreman's worktree.
    //
    // ONE cumulative patch from Foreman's own worktree, not a chain of per-phase
    // patches: no ordering to get wrong and no re-collision at each boundary.
    let seed: { url: string; envVar: string; key: string } | undefined;
    const seedSource = config.localWorktreePath ?? opts.cwd;
    if (config.patchStore?.put && config.patchStore?.presignGet && config.patch && seedSource) {
      const body = await new GitBackend(seedSource).createWorktreePatch(seedSource);
      // An empty seed is normal for a run's first phase; skip the upload rather
      // than hand the pod an empty file to reason about.
      if (body !== "") {
        const key = seedObjectKey({
          prefix: config.patch.prefix,
          runId: opts.context.runId ?? opts.context.taskId,
          phaseName: opts.context.phaseName,
        });
        await config.patchStore.put(key, body);
        seed = {
          key,
          envVar: "FOREMAN_SEED_URL",
          url: await config.patchStore.presignGet(key),
        };
      }
    }

    // Resolved per invocation, not once at startup: a Workspace names ONE repo,
    // so a single deployment-wide value pinned every project to the same
    // repository. A pooled Task carries no workspaceRef at all (the pool owns
    // its clone), so skip the lookup entirely rather than fail a pooled run on
    // an unreachable server.
    const workspace = config.workerPool
      ? config.workspace
      : resolveKelosWorkspace(await projectWorkspaceInputs(config, opts.context.projectId));

    const client = createKelosCrdClient({
      api,
      workspace,
      agentType: config.agentType,
      // The credential comes from the pool or the pod env, not the Task. An
      // empty secretRef.name is rejected by the API server, so omit it.
      credentials: { type: "none" },
      workerPool: config.workerPool,
      sharedWorktree: config.sharedWorktree,
      podOverrides: config.podOverrides,
      envOverrides: config.envOverridesFor(opts.model),
      patchUpload,
      seed,
      pollIntervalMs: config.pollIntervalMs,
      // Only when a policy is actually requested AND we have an endpoint for it.
      // Without a reachable server the hook denies every tool call, so leaving
      // this undefined keeps the phase refused instead of silently unguarded.
      ...(opts.toolPolicy && config.toolPolicyServerUrl
        ? {
            toolPolicy: {
              serverUrl: config.toolPolicyServerUrl,
              authToken: config.toolPolicyAuthToken,
              runId: opts.toolPolicy.context.runId,
              taskId: opts.toolPolicy.context.taskId ?? opts.context.taskId,
              phaseId: opts.toolPolicy.context.phaseId,
            },
          }
        : {}),
      // Reports and mail reuse the same server and token as the policy gate.
      // Both need a projectId and runId to address Foreman's per-run storage, so
      // they are omitted when either is unknown rather than posting to a guessed
      // location — the phase then fails its artifact gate, which is honest.
      ...(config.toolPolicyServerUrl && opts.context.projectId && opts.context.runId
        ? {
            reports: {
              serverUrl: config.toolPolicyServerUrl,
              authToken: config.toolPolicyAuthToken,
              projectId: opts.context.projectId,
              taskId: opts.context.taskId,
              runId: opts.context.runId,
              phaseId: opts.context.phaseName,
            },
            mail: {
              serverUrl: config.toolPolicyServerUrl,
              authToken: config.toolPolicyAuthToken,
              runId: opts.context.runId,
              taskId: opts.context.taskId,
              phaseId: opts.context.phaseName,
            },
          }
        : {}),
    });

    // GitBackend runs on Foreman's machine, so it is rooted at Foreman's path —
    // not the pod mount path the agent was given.
    const localWorktree = config.localWorktreePath ?? opts.cwd;
    const runner = createKelosPhaseRunner(client, {
      vcs: new GitBackend(localWorktree),
      localWorktreePath: localWorktree,
      patchStore: config.patchStore,
    });
    // The Task's model becomes the agent CLI's --model flag, which wins over the
    // env var, so it has to carry the gateway's name rather than the resolved id.
    return runner({ ...opts, model: config.gatewayModel(opts.model) });
  };
}

export const runKelosPhase: ConfiguredPhaseRunner = (opts) =>
  createKelosBackend(kelosBackendConfigFromEnv())(opts);
