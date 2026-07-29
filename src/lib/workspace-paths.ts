import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";

/**
 * Resolve the directory that stores Foreman workspaces for a repository.
 *
 * Default layout keeps workspaces outside the repository root to avoid parent
 * repo state writes (for example .tasks/issues.jsonl) dirtying active agent
 * workspaces:
 *   <repo-parent>/.foreman-worktrees/<repo-name>/<taskId>
 *
 * FOREMAN_WORKTREE_ROOT may override the parent directory used to hold all
 * project workspaces. When set, Foreman appends the repo basename so multiple
 * projects do not collide under the same root.
 */
export function getWorkspaceRoot(repoPath: string): string {
  const repoName = basename(normalize(repoPath));
  const override = process.env.FOREMAN_WORKTREE_ROOT?.trim();
  if (override) {
    const base = isAbsolute(override)
      ? override
      : join(dirname(normalize(repoPath)), override);
    return join(base, repoName);
  }

  return join(dirname(normalize(repoPath)), ".foreman-worktrees", repoName);
}

/** Return the full workspace path for a specific task. */
export function getWorkspacePath(repoPath: string, taskId: string): string {
  return join(getWorkspaceRoot(repoPath), taskId);
}

/**
 * Infer the project root from a workspace path.
 *
 * Supports both layouts:
 *   legacy:   <repo>/.foreman-worktrees/<taskId>
 *   external: <repo-parent>/.foreman-worktrees/<repo-name>/<taskId>
 */
export function inferProjectPathFromWorkspacePath(workspacePath: string): string {
  const normalized = normalize(workspacePath);
  const workspaceParent = dirname(normalized);
  const maybeWorkspaceRoot = dirname(workspaceParent);

  if (basename(maybeWorkspaceRoot) === ".foreman-worktrees") {
    return join(dirname(maybeWorkspaceRoot), basename(workspaceParent));
  }

  return join(normalized, "..", "..");
}

/**
 * Return the tasks JSONL path as it should be referenced from a workspace.
 *
 * - Nested legacy workspaces need a relative path back to the main repo copy.
 * - External workspaces should use their local checkout path `.tasks/issues.jsonl`.
 */
export function getTasksIssuesPathForWorkspace(
  workspacePath: string,
  mainRepoRoot: string,
): string {
  const relWorkspace = relative(mainRepoRoot, workspacePath);
  const isNestedWorkspace = relWorkspace !== "" && !relWorkspace.startsWith("..");

  if (isNestedWorkspace) {
    return relative(workspacePath, join(mainRepoRoot, ".tasks", "issues.jsonl"));
  }

  return ".tasks/issues.jsonl";
}

/**
 * Root-level artifacts the pipeline itself writes into a worktree, which must
 * never reach a PR.
 *
 * Globbed rather than enumerated: agents name their logs freely — SESSION_LOG.md,
 * DEVELOPER_SESSION_LOG.md and SESSION_LOG_DOCS.md all appeared across live runs —
 * so an exact list stays one invented name behind. The first end-to-end
 * in-cluster run opened a PR carrying TASK.md and REVIEW_SESSION_LOG.md because
 * neither was listed.
 *
 * Patterns are pathspecs interpreted by git, and stay root-anchored so a repo's
 * own `docs/SESSION_LOG.md` is untouched.
 */
const WORKER_ARTIFACT_PATHSPECS = [
  "node_modules",
  "TASK.md",
  "BLOCKED.md",
  // Broad enough to survive agent naming invention: QA_DETAILED_SESSION_LOG.md
  // and QA_VERIFICATION_SESSION.md each defeated a narrower predecessor. Kept
  // SHOUTY_CASE and root-anchored so README.md / docs/SESSION_LOG.md are safe.
  "*SESSION*.md",
  "*RUN_LOG*.md",
  "*REPORT*.md",
  "*HANDOFF*.json",
  "REVIEW.md",
  "FINALIZE_VALIDATION.md",
  "FINALIZE_TEST_OUTPUT.txt",
];

/**
 * Build a best-effort restore command that removes workspace-only state and
 * diagnostic artifacts before finalize commits. The `node_modules` pattern is
 * deliberately listed without a trailing slash because setup-cache uses a
 * symlink, and Git's `node_modules/` ignore pattern does not ignore symlinks.
 */
export function buildTrackedStateRestoreCommand(
  workspacePath: string,
  mainRepoRoot: string,
): string {
  const tasksPath = getTasksIssuesPathForWorkspace(workspacePath, mainRepoRoot);
  // Quoted so the shell passes the globs through to git rather than expanding
  // them against the worktree, which would silently drop unmatched patterns.
  const pathspecs = WORKER_ARTIFACT_PATHSPECS.map((p) => `':(glob,top)${p}'`).join(" ");
  return [
    `git restore --source=HEAD --staged --worktree -- ${tasksPath} 2>/dev/null || git restore --source=HEAD --worktree -- ${tasksPath} 2>/dev/null || true`,
    `git restore --source=HEAD --staged --worktree -- ${pathspecs} 2>/dev/null || true`,
    `git rm -r --cached --ignore-unmatch ${pathspecs} ':(glob,top)docs/reports' 2>/dev/null || true`,
  ].join("\n");
}
