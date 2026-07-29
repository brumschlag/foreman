import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PiRunResult } from "./pi-sdk-runner.js";
import type { ConfiguredPhaseRunner, PhaseRunnerOptions } from "./phase-runner.js";
import type { PatchStore } from "./kelos-patch-store.js";

export interface KelosTaskFile {
  path: string;
  content: string;
}

export interface KelosTaskResult {
  succeeded: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Agent turns, from TaskStatus.Results["num-turns"] when reported. */
  turns?: number;
  /** Tool calls, from TaskStatus.Results["tool-calls"] when reported. */
  toolCalls?: number;
  /** Per-tool counts, parsed from TaskStatus.Results["tool-breakdown"]. */
  toolBreakdown?: Record<string, number>;
  files: KelosTaskFile[];
  errorMessage?: string;
  /**
   * Set by a client that installed the tool-policy PreToolUse hook into the
   * agent pod. Absent means the phase ran unguarded, so a policy-gated phase
   * must be refused rather than silently trusted.
   */
  enforcesToolPolicy?: boolean;
  /**
   * How the agent's work reaches Foreman's worktree. `volume` means the agent
   * wrote directly into a shared worktree, so nothing is pushed and Foreman
   * keeps sole ownership of git. Defaults to branch transport when a branch is
   * reported.
   */
  transport?: "branch" | "volume" | "patch";
  /** Object key the agent uploaded its patch to, for patch transport. */
  patchKey?: string;
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
  /**
   * True when this client installs the tool-policy hook into the agent pod.
   * Checked BEFORE dispatch: discovering it afterwards would mean the agent
   * already ran unguarded.
   */
  enforcesToolPolicy?: boolean;
  /**
   * True when this client gives the agent a working Agent Mail channel.
   *
   * False means the phase runs without one: it cannot read operator steering or
   * report a blocker over mail. Unlike the tool policy that is NOT a reason to
   * refuse the phase — mail is a capability, not a guard — so callers use this to
   * warn and to skip mail-dependent workflow hooks, not to abort.
   */
  deliversMail?: boolean;
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
  /** Applies a patch file to the worktree and index. */
  applyPatchToIndex?(workspacePath: string, patchFilePath: string): Promise<void>;
  /** Clears one path from the index, leaving the worktree file alone. */
  removeFromIndex?(workspacePath: string, filePath: string): Promise<void>;
}

export interface KelosPhaseRunnerDeps {
  vcs?: KelosVcs;
  /** Remote the kelos agent pushes to. Defaults to `origin`. */
  remote?: string;
  /** Object storage the agent uploads its patch to, for patch transport. */
  patchStore?: PatchStore;
  /**
   * Foreman's own path to the worktree, when it differs from the path the agent
   * sees inside the pod. Volume transport shares one filesystem across two
   * machines, so `opts.cwd` (the pod's mount path) is not resolvable locally;
   * git has to run against this path instead. Defaults to `opts.cwd`.
   */
  localWorktreePath?: string;
}

function accounting(result: KelosTaskResult) {
  return {
    costUsd: result.costUsd,
    turns: result.turns ?? 0,
    toolCalls: result.toolCalls ?? 0,
    toolBreakdown: result.toolBreakdown ?? {},
    tokensIn: result.inputTokens,
    tokensOut: result.outputTokens,
  };
}

export function createKelosPhaseRunner(
  client: KelosClient,
  deps: KelosPhaseRunnerDeps = {},
): ConfiguredPhaseRunner {
  return async (opts: PhaseRunnerOptions): Promise<PiRunResult> => {
    // In-process the policy wraps Pi SDK tool objects, which cannot reach a kelos
    // agent running as a separate program in a separate pod. A client configured
    // with a tool policy installs a PreToolUse hook instead; one that is not
    // leaves every tool call unchecked, so refuse rather than run the phase
    // looking protected while it is not.
    if (opts.toolPolicy && !client.enforcesToolPolicy) {
      return {
        success: false,
        costUsd: 0,
        turns: 0,
        toolCalls: 0,
        toolBreakdown: {},
        tokensIn: 0,
        tokensOut: 0,
        errorMessage:
          "agent-error: tool policy cannot be enforced on the kelos backend; " +
          "the policy gate wraps in-process Pi SDK tools and a kelos agent runs in a separate pod",
        filesChanged: [],
      };
    }

    const result = await client.runTask({
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      phaseName: opts.context.phaseName,
      taskId: opts.context.taskId,
    });

    if (result.transport === "patch") {
      return syncPatch(result, opts, deps, deps.localWorktreePath ?? opts.cwd);
    }

    if (result.transport === "volume") {
      return syncVolume(result, opts, deps.vcs, deps.localWorktreePath ?? opts.cwd);
    }

    if (result.branch && deps.vcs) {
      return syncBranch(result, opts, deps.vcs, deps.remote ?? "origin");
    }

    return syncFiles(result, opts);
  };
}

/**
 * Paths `git apply --index` reports as already present when a later phase's patch
 * re-adds a worker artifact.
 *
 * Every kelos phase runs in a fresh pod, so each agent writes its own session log
 * and reports at the worktree root. An earlier phase's patch already added those
 * paths to the index, and `git apply --index` refuses to add them again.
 */
// git reports this two ways depending on whether the path is already tracked in
// the index or merely present on disk. Matching only the index wording let the
// very next live run fail on "already exists in working directory".
const ALREADY_EXISTS = /error:\s*(?<path>[^\n:]+):\s*already exists in (?:index|working directory)/g;

function collidingIndexPaths(message: string): string[] {
  const paths = new Set<string>();
  for (const match of message.matchAll(ALREADY_EXISTS)) {
    const path = match.groups?.path?.trim();
    if (path) paths.add(path);
  }
  return [...paths];
}

/**
 * Applies a phase's patch, recovering from worker-artifact collisions.
 *
 * A collision on a file the pipeline itself generates is not a conflict in the
 * task's work — it stopped a run whose agent phases had all succeeded — so the
 * colliding paths are cleared from the index and the patch retried once. Anything
 * else propagates, so a genuine conflict still routes to the merge-resolver phase.
 *
 * Only paths git itself named are cleared, so this cannot silently discard
 * unrelated work.
 */
async function applyPhasePatch(
  deps: KelosPhaseRunnerDeps,
  worktreePath: string,
  patchFile: string,
): Promise<void> {
  try {
    await deps.vcs?.applyPatchToIndex?.(worktreePath, patchFile);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const colliding = collidingIndexPaths(message);
    if (colliding.length === 0 || !deps.vcs?.removeFromIndex) throw err;

    // BOTH are required, verified against real git: `git rm --cached` alone clears
    // the index and the retry then fails with "already exists in working
    // directory", because the file is still on disk. Dropping the worktree copy is
    // safe — the patch being applied carries this phase's own version of it.
    for (const path of colliding) {
      await deps.vcs.removeFromIndex(worktreePath, path);
      rmSync(join(worktreePath, path), { force: true });
    }
    await deps.vcs?.applyPatchToIndex?.(worktreePath, patchFile);
  }
}

/**
 * Patch transport: the agent uploaded a git patch to object storage, which Foreman
 * applies to its own worktree. Nothing is read from the pod, so the pod can be
 * reclaimed as soon as it exits.
 */
async function syncPatch(
  result: KelosTaskResult,
  opts: PhaseRunnerOptions,
  deps: KelosPhaseRunnerDeps,
  localWorktreePath: string,
): Promise<PiRunResult> {
  const patch = result.patchKey && deps.patchStore
    ? await deps.patchStore.get(result.patchKey)
    : null;

  // A read-only phase legitimately uploads nothing.
  if (patch) {
    const patchFile = join(tmpdir(), `kelos-${randomUUID()}.patch`);
    writeFileSync(patchFile, patch, "utf-8");
    try {
      await applyPhasePatch(deps, localWorktreePath, patchFile);
    } catch (err) {
      return {
        ...accounting(result),
        success: false,
        errorMessage: `merge_conflict: kelos patch ${result.patchKey} did not apply: ${
          err instanceof Error ? err.message : String(err)
        }`,
        filesChanged: [],
      };
    } finally {
      rmSync(patchFile, { force: true });
    }
  }

  const filesChanged = deps.vcs?.getModifiedFiles
    ? await deps.vcs.getModifiedFiles(localWorktreePath)
    : [];

  return {
    ...accounting(result),
    success: result.succeeded,
    errorMessage: result.errorMessage,
    filesChanged,
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
  localWorktreePath: string,
): Promise<PiRunResult> {
  const filesChanged = vcs?.getModifiedFiles
    ? await vcs.getModifiedFiles(localWorktreePath)
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
