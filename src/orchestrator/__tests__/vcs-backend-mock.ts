import { vi } from "vitest";
import type { VcsBackend } from "../../lib/vcs/index.js";

/**
 * Fully-stubbed `VcsBackend` for tests that need one but are not testing VCS
 * behaviour itself. Every method defaults to success; pass `overrides` for the
 * ones a given test asserts on.
 *
 * Shared because the interface has 50+ methods, so a hand-rolled literal covering
 * only the two a test happens to think about compiles behind an `as never` cast
 * and then throws `<method> is not a function` the first time production code
 * calls anything else. That is how `pipeline-rebase-after-phase.test.ts` merged
 * red: its mock supplied `rebase` while the executor also calls
 * `getFinalizeCommands`. Extend THIS factory when the interface grows, so one
 * addition fixes every consumer at once.
 */
export function makeMockVcsBackend(
  overrides: Partial<Record<keyof VcsBackend, ReturnType<typeof vi.fn>>> = {},
): VcsBackend {
  return {
    name: "git",
    // Repository introspection
    getRepoRoot: vi.fn().mockResolvedValue("/repo"),
    getMainRepoRoot: vi.fn().mockResolvedValue("/repo"),
    detectDefaultBranch: vi.fn().mockResolvedValue("main"),
    getCurrentBranch: vi.fn().mockResolvedValue("foreman/bd-test-001"),
    getRemoteUrl: vi.fn().mockResolvedValue("https://github.com/example/repo.git"),
    // Branch operations
    checkoutBranch: vi.fn().mockResolvedValue(undefined),
    branchExists: vi.fn().mockResolvedValue(true),
    branchExistsOnRemote: vi.fn().mockResolvedValue(true),
    deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
    deleteRemoteBranch: vi.fn().mockResolvedValue({ deleted: true }),
    // Workspace operations
    createWorkspace: vi
      .fn()
      .mockResolvedValue({ workspacePath: "/workspace", branchName: "foreman/bd-test-001" }),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    // Staging and commit
    stageAll: vi.fn().mockResolvedValue(undefined),
    stageFile: vi.fn().mockResolvedValue(undefined),
    stageFiles: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    commitNoEdit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(undefined),
    saveWorktreeState: vi.fn().mockResolvedValue(false),
    restoreWorktreeState: vi.fn().mockResolvedValue(undefined),
    // Rebase and merge
    rebase: vi.fn().mockResolvedValue({ success: true, hasConflicts: false }),
    rebaseBranch: vi.fn().mockResolvedValue({ success: true, hasConflicts: false }),
    restackBranch: vi.fn().mockResolvedValue({ success: true, hasConflicts: false }),
    abortRebase: vi.fn().mockResolvedValue(undefined),
    merge: vi.fn().mockResolvedValue({ success: true, conflictingFiles: [] }),
    mergeWithStrategy: vi.fn().mockResolvedValue({ success: true, conflicts: [] }),
    mergeWithoutCommit: vi.fn().mockResolvedValue({ success: true, conflictingFiles: [] }),
    rollbackFailedMerge: vi.fn().mockResolvedValue(undefined),
    // Diff, status, conflict detection
    getHeadId: vi.fn().mockResolvedValue("abc1234"),
    resolveRef: vi.fn().mockResolvedValue("abc1234"),
    fetch: vi.fn().mockResolvedValue(undefined),
    diff: vi.fn().mockResolvedValue(""),
    getChangedFiles: vi.fn().mockResolvedValue([]),
    getRefCommitTimestamp: vi.fn().mockResolvedValue(0),
    getModifiedFiles: vi.fn().mockResolvedValue([]),
    getConflictingFiles: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue(""),
    statusSync: vi.fn().mockReturnValue(""),
    cleanWorkingTree: vi.fn().mockResolvedValue(undefined),
    createWorktreePatch: vi.fn().mockResolvedValue(""),
    // Finalize support
    getFinalizeCommands: vi.fn().mockReturnValue({
      stageCommand: "git add -A",
      commitCommand: "git commit -m",
      pushCommand: "git push -u origin",
      integrateTargetCommand: "git pull --rebase origin",
      branchVerifyCommand: "git rev-parse --abbrev-ref HEAD",
      cleanCommand: "git clean -fd",
      restoreTrackedStateCommand:
        "git restore --source=HEAD --staged --worktree -- .tasks/issues.jsonl",
    }),
    ...overrides,
  } as unknown as VcsBackend;
}
