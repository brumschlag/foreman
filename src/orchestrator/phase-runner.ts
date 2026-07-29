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
