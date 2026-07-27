import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PiRunResult } from "./pi-sdk-runner.js";
import type { ConfiguredPhaseRunner, PhaseRunnerOptions } from "./phase-runner.js";

export interface KelosTaskFile {
  path: string;
  content: string;
}

export interface KelosTaskResult {
  succeeded: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  files: KelosTaskFile[];
  errorMessage?: string;
  /**
   * How the agent's work reaches Foreman's worktree. `volume` means the agent
   * wrote directly into a shared worktree, so nothing is pushed and Foreman
   * keeps sole ownership of git. Defaults to branch transport when a branch is
   * reported.
   */
  transport?: "branch" | "volume";
  /** Branch the kelos agent pushed, from TaskStatus.Results["branch"]. */
  branch?: string;
  /** Head commit on that branch, from TaskStatus.Results["commit"]. */
  commit?: string;
}

export interface KelosTaskRequest {
  prompt: string;
  systemPrompt: string;
  model: string;
  phaseName: string;
  taskId: string;
}

export interface KelosClient {
  runTask(request: KelosTaskRequest): Promise<KelosTaskResult>;
}

/**
 * Narrow slice of VcsBackend the runner needs to pull a kelos-pushed branch
 * into the local worktree.
 */
export interface KelosVcs {
  fetch(repoPath: string): Promise<void>;
  merge(
    repoPath: string,
    sourceBranch: string,
    targetBranch?: string,
  ): Promise<{ success: boolean; conflicts?: string[] }>;
  getChangedFiles(repoPath: string, from: string, to: string): Promise<string[]>;
  /** Uncommitted changes in the worktree — the signal for volume transport. */
  getModifiedFiles?(workspacePath: string): Promise<string[]>;
}

export interface KelosPhaseRunnerDeps {
  vcs?: KelosVcs;
  /** Remote the kelos agent pushes to. Defaults to `origin`. */
  remote?: string;
}

function accounting(result: KelosTaskResult) {
  return {
    costUsd: result.costUsd,
    turns: 0,
    toolCalls: 0,
    toolBreakdown: {},
    tokensIn: result.inputTokens,
    tokensOut: result.outputTokens,
  };
}

export function createKelosPhaseRunner(
  client: KelosClient,
  deps: KelosPhaseRunnerDeps = {},
): ConfiguredPhaseRunner {
  return async (opts: PhaseRunnerOptions): Promise<PiRunResult> => {
    const result = await client.runTask({
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      phaseName: opts.context.phaseName,
      taskId: opts.context.taskId,
    });

    if (result.transport === "volume") {
      return syncVolume(result, opts, deps.vcs);
    }

    if (result.branch && deps.vcs) {
      return syncBranch(result, opts, deps.vcs, deps.remote ?? "origin");
    }

    return syncFiles(result, opts);
  };
}

/**
 * Volume transport: the agent shared Foreman's worktree over a PVC, so the work
 * is already on disk. Nothing is fetched, merged, or pushed — Foreman's own
 * finalize/merge-queue keeps sole ownership of git.
 */
async function syncVolume(
  result: KelosTaskResult,
  opts: PhaseRunnerOptions,
  vcs: KelosVcs | undefined,
): Promise<PiRunResult> {
  const filesChanged = vcs?.getModifiedFiles
    ? await vcs.getModifiedFiles(opts.cwd)
    : [];

  return {
    ...accounting(result),
    success: result.succeeded,
    errorMessage: result.errorMessage,
    filesChanged,
  };
}

async function syncBranch(
  result: KelosTaskResult,
  opts: PhaseRunnerOptions,
  vcs: KelosVcs,
  remote: string,
): Promise<PiRunResult> {
  const branch = result.branch as string;
  await vcs.fetch(opts.cwd);
  // The kelos agent pushed to the remote, so after fetch the work exists only as
  // a remote-tracking ref — merging the bare branch name fails with
  // "not something we can merge".
  const ref = `${remote}/${branch}`;
  // Capture the changed files BEFORE merging: getChangedFiles is a three-dot
  // diff, so once the branch is merged its merge-base is the branch tip and the
  // diff comes back empty.
  const base = opts.context.targetBranch ?? "HEAD";
  const filesChanged = await vcs.getChangedFiles(opts.cwd, base, ref);

  const merged = await vcs.merge(opts.cwd, ref, opts.context.targetBranch);
  if (!merged.success) {
    const conflicts = merged.conflicts ?? [];
    return {
      ...accounting(result),
      success: false,
      errorMessage: `merge_conflict: kelos branch ${branch} conflicts in ${conflicts.join(", ")}`,
      filesChanged: [],
    };
  }

  return {
    ...accounting(result),
    success: result.succeeded,
    errorMessage: result.errorMessage,
    filesChanged,
  };
}

async function syncFiles(
  result: KelosTaskResult,
  opts: PhaseRunnerOptions,
): Promise<PiRunResult> {
  const root = resolve(opts.cwd);
  const resolved: { target: string; path: string; content: string }[] = [];
  for (const file of result.files) {
    const target = isAbsolute(file.path) ? resolve(file.path) : resolve(root, file.path);
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return {
        ...accounting(result),
        success: false,
        errorMessage: `kelos task returned a file path that would escape the worktree: ${file.path}`,
        filesChanged: [],
      };
    }
    resolved.push({ target, path: file.path, content: file.content });
  }

  const filesChanged: string[] = [];
  for (const file of resolved) {
    mkdirSync(dirname(file.target), { recursive: true });
    writeFileSync(file.target, file.content, "utf-8");
    filesChanged.push(file.path);
  }

  return {
    ...accounting(result),
    success: result.succeeded,
    errorMessage: result.errorMessage,
    filesChanged,
  };
}
