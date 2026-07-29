import type { PiRunOptions, PiRunResult } from "./pi-sdk-runner.js";
import { runWithPiSdk } from "./pi-sdk-runner.js";

export interface PhaseRunnerContext {
  phaseName: string;
  runId?: string;
  taskId: string;
  /**
   * Owning project. Needed by out-of-process backends, which address Foreman's
   * per-project storage over HTTP rather than by local path.
   */
  projectId?: string;
  taskTitle: string;
  taskType?: string;
  taskDescription?: string;
  worktreePath: string;
  targetBranch?: string;
  /**
   * 1-based count of how many times THIS phase has run in the current run.
   *
   * A QA-driven retry loops back within the same run, so `runId` alone cannot
   * tell one attempt from the next. Backends that name external resources per
   * phase need this: kelos rejects a re-applied `Task` because `Task.spec` is
   * immutable, so a name without it collides on the first retry.
   */
  phaseIteration?: number;
}

export interface PhaseRunnerOptions extends PiRunOptions {
  context: PhaseRunnerContext;
}

export type ConfiguredPhaseRunner = (opts: PhaseRunnerOptions) => Promise<PiRunResult>;

function getRuntimeMode(): string {
  return process.env.FOREMAN_RUNTIME_MODE?.trim().toLowerCase() || "normal";
}

function usesModuleBackend(): boolean {
  return process.env.FOREMAN_PHASE_BACKEND?.trim().toLowerCase() === "module";
}

async function loadConfiguredRunner(): Promise<ConfiguredPhaseRunner> {
  const runtimeMode = getRuntimeMode();
  if (runtimeMode !== "test" && !usesModuleBackend()) {
    return (opts) => runWithPiSdk(opts);
  }

  const modulePath = process.env.FOREMAN_PHASE_RUNNER_MODULE;
  if (!modulePath) {
    throw new Error(
      "FOREMAN_PHASE_RUNNER_MODULE must be set when FOREMAN_PHASE_BACKEND=module or FOREMAN_RUNTIME_MODE=test",
    );
  }

  const exportName = process.env.FOREMAN_PHASE_RUNNER_EXPORT || "runDeterministicPhase";
  const loaded = await import(modulePath);
  const runner = loaded[exportName] as ConfiguredPhaseRunner | undefined;
  if (typeof runner !== "function") {
    throw new Error(
      `Configured phase runner export '${exportName}' was not found in ${modulePath}`,
    );
  }
  return runner;
}

export async function runPhaseSession(opts: PhaseRunnerOptions): Promise<PiRunResult> {
  const runner = await loadConfiguredRunner();
  return runner(opts);
}
