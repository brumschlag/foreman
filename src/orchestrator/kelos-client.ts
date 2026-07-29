import type { KelosClient, KelosTaskRequest, KelosTaskResult } from "./kelos-phase-runner.js";
import { toolPolicyHookEnv, toolPolicyInstallCommands } from "./kelos-tool-policy-hook.js";
import {
  mailShimEnv,
  mailShimInstallCommands,
  mailShimPromptGuidance,
} from "./kelos-mail-shim.js";
import {
  reportShimEnv,
  reportShimInstallCommands,
  reportShimPromptGuidance,
} from "./kelos-report-shim.js";

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
  /**
   * Presigned download of Foreman's accumulated worktree state, applied before the
   * agent starts.
   *
   * Each phase runs in a fresh clone, so without this a phase cannot see earlier
   * phases' work — a verdict phase reported the task's own output missing while it
   * sat in Foreman's worktree.
   */
  seed?: { url: string; envVar: string; key?: string };
  /**
   * Enforce Foreman's tool policy inside the agent pod via a PreToolUse hook.
   * The gate itself stays server-side (`/worker/v1/tool-policy`); only the
   * interception point moves, because an in-process tool wrapper cannot reach a
   * separate program in a separate pod.
   */
  toolPolicy?: {
    serverUrl: string;
    authToken?: string;
    runId: string;
    taskId: string;
    phaseId: string;
  };
  /**
   * Give the agent an Agent Mail channel via a pod-side shim over
   * `/worker/v1/mail*`. Without it a kelos phase cannot read operator steering
   * or report a blocker, because the Pi path's mail tools are in-process
   * closures that cannot reach another pod.
   */
  mail?: {
    serverUrl: string;
    authToken?: string;
    runId: string;
    taskId: string;
    phaseId: string;
    agentName?: string;
  };
  /**
   * Let the agent upload its phase report through `/worker/v1/reports`.
   *
   * A phase's patch carries only the repository diff, so a report written to
   * Foreman's reports directory never travels and the artifact gate fails a phase
   * whose agent succeeded.
   */
  reports?: {
    serverUrl: string;
    authToken?: string;
    projectId: string;
    taskId: string;
    runId: string;
    phaseId: string;
  };
  pollIntervalMs?: number;
  maxPolls?: number;
}

const TERMINAL_PHASES = new Set(["Succeeded", "Failed"]);

/** Where the pre-phase baseline ref is recorded inside the pod. */
const BASELINE_FILE = "/tmp/foreman-baseline";

/**
 * Records the workspace state before the agent runs. A pooled worker's workspace
 * persists across every task it serves, so diffing against HEAD afterwards would
 * attribute other tasks' leftovers to this phase.
 *
 * `git stash create` writes a commit object for the current dirty state without
 * touching the worktree or the stash list. It prints nothing when the worktree is
 * clean, hence the fallback to HEAD.
 */
/**
 * Applies Foreman's accumulated worktree state before the agent runs.
 *
 * MUST precede baselineCaptureCommand: the baseline is what this phase's own diff
 * is measured against, so a seed applied after it would be attributed to this
 * phase and uploaded again as its work.
 *
 * A missing or empty seed is not an error — the first phase of a run has nothing
 * to inherit. A seed that exists but will not apply IS an error, because running
 * the agent against a wrong tree produces a result nobody can trust.
 */
function seedApplyCommand(envVar: string): string[] {
  return [
    "sh",
    "-c",
    `set -e; curl -sSf --max-time 120 -o /tmp/foreman-seed.patch "$${envVar}" || exit 0; ` +
      `[ -s /tmp/foreman-seed.patch ] || exit 0; ` +
      `git apply --index /tmp/foreman-seed.patch`,
  ];
}

function baselineCaptureCommand(): string[] {
  return [
    "sh",
    "-c",
    `set -e; B=$(git stash create 2>/dev/null || true); ` +
      `[ -n "$B" ] || B=$(git rev-parse HEAD); printf '%s' "$B" > ${BASELINE_FILE}`,
  ];
}

/**
 * Captures the phase's work as a patch and uploads it. Untracked files are staged
 * first so the diff includes new files, which a plain `git diff` would miss — a
 * phase whose only output is a new report would otherwise upload an empty patch.
 * The diff is taken against the recorded baseline so it holds only this phase's
 * changes.
 */
function patchUploadCommand(envVar: string): string[] {
  return [
    "sh",
    "-c",
    `set -e; FOREMAN_BASELINE=$(cat ${BASELINE_FILE}); git add -A; ` +
      `git diff --cached --binary "$FOREMAN_BASELINE" > /tmp/foreman.patch; ` +
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

/** Parses kelos-capture's `Name=count,Name2=count` tool breakdown. */
function parseToolBreakdown(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of (raw ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.lastIndexOf("=");
    if (eq < 1) continue;
    const count = Number(entry.slice(eq + 1));
    if (Number.isFinite(count)) out[entry.slice(0, eq)] = count;
  }
  return out;
}

function taskName(request: KelosTaskRequest): string {
  return `foreman-${request.taskId}-${request.phaseName}`.toLowerCase();
}

/**
 * Whether an install delivered via `Task.spec.preCommands` will actually run.
 *
 * kelos executes preCommands in `internal/workerrunner/runner.go`, which is the
 * container command only on the POOLED path. A non-pooled Job runs
 * `/kelos_entrypoint.sh`, which accepts and stores the fields and silently
 * ignores them — so a pod-side install looks configured and never happens.
 *
 * Anything relying on preCommands must consult this rather than assume the
 * install ran. See docs/TRD/TRD-2026-026-followups.md.
 */
export function preCommandsRun(options: Pick<KelosCrdClientOptions, "workerPool">): boolean {
  return Boolean(options.workerPool);
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
    // Declared before dispatch so the phase runner can refuse a policy-gated
    // phase rather than discover the gap after the agent has already run.
    enforcesToolPolicy: Boolean(options.toolPolicy),
    // Mail is requested AND actually installable. On the non-pooled path kelos
    // silently ignores preCommands, so a configured channel that never gets
    // installed must not report itself as working.
    deliversMail: Boolean(options.mail) && preCommandsRun(options),
    async runTask(request: KelosTaskRequest): Promise<KelosTaskResult> {
      const name = await options.api.createTask({
        apiVersion: "kelos.dev/v1alpha2",
        kind: "Task",
        metadata: { name: taskName(request) },
        spec: {
          model: request.model,
          // Mail guidance rides in the prompt because the Pi path's tool
          // descriptions — which is where an agent normally learns the channel
          // exists — do not travel to a pod. Installed-but-unmentioned slash
          // commands are never invoked.
          prompt: [
            request.systemPrompt,
            ...(options.mail ? [mailShimPromptGuidance()] : []),
            ...(options.reports ? [reportShimPromptGuidance()] : []),
            request.prompt,
          ].join("\n\n"),
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
            if (options.seed) {
              env.push({ name: options.seed.envVar, value: options.seed.url });
            }
            if (options.toolPolicy) {
              env.push(...toolPolicyHookEnv(options.toolPolicy));
            }
            if (options.mail || options.reports) {
              // The policy, mail, and report env overlap (server URL, correlation
              // ids). kelos rejects a duplicated envOverrides name, so later
              // entries for a name already present are dropped, not appended.
              const seen = new Set(env.map((entry) => entry.name));
              const extra = [
                ...(options.mail ? mailShimEnv(options.mail) : []),
                ...(options.reports ? reportShimEnv(options.reports) : []),
              ];
              for (const entry of extra) {
                if (!seen.has(entry.name)) {
                  env.push(entry);
                  seen.add(entry.name);
                }
              }
            }
            return env.length ? { envOverrides: env } : {};
          })(),
          ...(() => {
            // The hook must be on disk before the agent starts, so its install
            // leads the preCommands.
            const preCommands = [
              ...(options.toolPolicy ? toolPolicyInstallCommands() : []),
              ...(options.mail ? mailShimInstallCommands() : []),
              ...(options.reports ? reportShimInstallCommands() : []),
              ...(options.seed ? [seedApplyCommand(options.seed.envVar)] : []),
              ...(patchUpload ? [baselineCaptureCommand()] : []),
            ];
            return {
              ...(preCommands.length ? { preCommands } : {}),
              ...(patchUpload
                ? { postCommands: [patchUploadCommand(patchUpload.envVar)] }
                : {}),
            };
          })(),
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
            turns: numeric(results, "num-turns"),
            toolCalls: numeric(results, "tool-calls"),
            toolBreakdown: parseToolBreakdown(results?.["tool-breakdown"]),
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
