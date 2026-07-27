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
  secretRef: { name: string };
}

export interface KelosCrdClientOptions {
  api: KelosApi;
  workspace: string;
  agentType: string;
  credentials: KelosCredentials;
  pollIntervalMs?: number;
  maxPolls?: number;
}

const TERMINAL_PHASES = new Set(["Succeeded", "Failed"]);

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

  return {
    async runTask(request: KelosTaskRequest): Promise<KelosTaskResult> {
      const name = await options.api.createTask({
        apiVersion: "kelos.dev/v1alpha2",
        kind: "Task",
        metadata: { name: taskName(request) },
        spec: {
          type: options.agentType,
          model: request.model,
          prompt: `${request.systemPrompt}\n\n${request.prompt}`,
          credentials: options.credentials,
          workspaceRef: { name: options.workspace },
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
            branch: results?.branch,
            commit: results?.commit,
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
