import type { KelosClient, KelosTaskRequest, KelosTaskResult } from "./kelos-phase-runner.js";

export interface KelosTaskObject {
  metadata?: { name?: string };
  status?: {
    phase?: string;
    message?: string;
    results?: Record<string, string>;
  };
}

export interface KelosApi {
  createTask(task: unknown): Promise<string>;
  getTask(name: string): Promise<KelosTaskObject>;
}

/**
 * Required by the kelos Task CRD: "either workerPoolRef, worker with type, or
 * type with credentials is required" — a Task with `type` but no `credentials`
 * is rejected by the API server.
 */
export interface KelosCredentials {
  type: string;
  /**
   * Required by the CRD for the api-key and oauth types, and must be non-empty
   * when present — an empty name is rejected by the API server. Omit it for
   * type=none, where the credential comes from the pod or pool.
   */
  secretRef?: { name: string };
}

export interface KelosCrdClientOptions {
  api: KelosApi;
  workspace: string;
  agentType: string;
  credentials: KelosCredentials;
  /** Passed through to Task.spec.podOverrides, e.g. Bedrock env wiring. */
  podOverrides?: unknown;
  /**
   * Mount an existing PVC holding Foreman's worktree instead of letting kelos
   * clone the repo. Phases hand off files on the volume, so nothing is pushed
   * and Foreman keeps sole ownership of git.
   */
  sharedWorktree?: { claimName: string; mountPath: string };
  /**
   * Dispatch onto a pre-warmed WorkerPool instead of creating a Job. The pool
   * owns the persistent workspace, so the repo is not re-cloned per phase. The
   * CRD forbids type/credentials/workspaceRef/podOverrides on a pooled Task, so
   * per-phase environment must travel via envOverrides.
   */
  workerPool?: string;
  /** Per-Task agent env, the only env channel available to a pooled Task. */
  envOverrides?: { name: string; value: string }[];
  /**
   * Presigned upload for the phase's git patch. The URL travels as env and the
   * upload runs as a postCommand after the agent exits, so the pod needs no AWS
   * credentials and the model is not asked to run the transfer itself.
   */
  patchUpload?: { url: string; envVar: string; key?: string };
  pollIntervalMs?: number;
  maxPolls?: number;
}

const TERMINAL_PHASES = new Set(["Succeeded", "Failed"]);

/**
 * Captures the phase's work as a patch and uploads it. Untracked files are added
 * to the index first so `git diff --cached` includes new files, which a plain
 * `git diff` would miss — a phase whose only output is a new report file would
 * otherwise upload an empty patch.
 */
function patchUploadCommand(envVar: string): string[] {
  return [
    "sh",
    "-c",
    `set -e; git add -A; git diff --cached --binary > /tmp/foreman.patch; ` +
      `curl -sSf -X PUT --upload-file /tmp/foreman.patch "$${envVar}"`,
  ];
}

/** Must not collide with kelos-reserved volume names (workspace, kelos-*). */
const WORKTREE_VOLUME = "foreman-worktree";

function numeric(results: Record<string, string> | undefined, key: string): number {
  const raw = results?.[key];
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function taskName(request: KelosTaskRequest): string {
  return `foreman-${request.taskId}-${request.phaseName}`.toLowerCase();
}

export function createKelosCrdClient(options: KelosCrdClientOptions): KelosClient {
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const maxPolls = options.maxPolls ?? 720;
  const shared = options.sharedWorktree;
  const patchUpload = options.patchUpload;
  const pool = options.workerPool;
  // Either way the work is already on disk when the agent finishes — a pool's
  // worker owns a persistent workspace — so nothing is pushed or fetched.
  const usesVolume = Boolean(shared || pool);

  // Volumes must be nested under podOverrides — the CRD rejects spec.volumes /
  // spec.volumeMounts as unknown fields.
  const podOverrides = shared
    ? {
        ...(options.podOverrides as Record<string, unknown> | undefined),
        volumes: [
          { name: WORKTREE_VOLUME, persistentVolumeClaim: { claimName: shared.claimName } },
        ],
        volumeMounts: [{ name: WORKTREE_VOLUME, mountPath: shared.mountPath }],
      }
    : options.podOverrides;

  return {
    async runTask(request: KelosTaskRequest): Promise<KelosTaskResult> {
      const name = await options.api.createTask({
        apiVersion: "kelos.dev/v1alpha2",
        kind: "Task",
        metadata: { name: taskName(request) },
        spec: {
          model: request.model,
          prompt: `${request.systemPrompt}\n\n${request.prompt}`,
          // A pooled Task carries only the pool reference: the CRD rejects
          // type, credentials, workspaceRef, and podOverrides alongside
          // workerPoolRef, so per-phase env must travel via envOverrides.
          ...(pool
            ? { workerPoolRef: { name: pool } }
            : {
                type: options.agentType,
                credentials: options.credentials,
                ...(shared ? {} : { workspaceRef: { name: options.workspace } }),
                ...(podOverrides ? { podOverrides } : {}),
              }),
          ...(() => {
            const env = [...(options.envOverrides ?? [])];
            if (patchUpload) {
              env.push({ name: patchUpload.envVar, value: patchUpload.url });
            }
            return env.length ? { envOverrides: env } : {};
          })(),
          ...(patchUpload ? { postCommands: [patchUploadCommand(patchUpload.envVar)] } : {}),
        },
      });

      for (let poll = 0; poll < maxPolls; poll++) {
        const task = await options.api.getTask(name);
        const phase = task.status?.phase;
        if (phase && TERMINAL_PHASES.has(phase)) {
          const results = task.status?.results;
          return {
            succeeded: phase === "Succeeded",
            costUsd: numeric(results, "cost-usd"),
            inputTokens: numeric(results, "input-tokens"),
            outputTokens: numeric(results, "output-tokens"),
            files: [],
            ...(patchUpload
              ? { transport: "patch" as const, patchKey: patchUpload.key }
              : usesVolume
                ? { transport: "volume" as const }
                : { branch: results?.branch, commit: results?.commit }),
            errorMessage: phase === "Failed" ? task.status?.message : undefined,
          };
        }
        if (pollIntervalMs > 0) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
      }

      return {
        succeeded: false,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        files: [],
        errorMessage: `kelos Task ${name} did not reach a terminal phase within ${maxPolls} polls`,
      };
    },
  };
}
