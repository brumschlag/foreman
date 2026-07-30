/**
 * Chooses which kelos Workspace a phase's Task should clone.
 *
 * A `Workspace` is a per-repo clone recipe (repo + ref + secretRef), so one
 * deployment-wide `KELOS_WORKSPACE` pinned all of Foreman to a single repository:
 * targeting a second project meant patching the Deployment env and restarting,
 * which silently repointed every other project too.
 *
 * `tasks.kelos.dev` already accepts `spec.workspaceRef` per Task — the CEL rule
 * `self == oldSelf` freezes the spec only after creation — so this was Foreman's
 * plumbing, not a kelos limit. A project names its own workspace and the env var
 * remains the default for those that don't.
 *
 * @module kelos-workspace
 */

/** Project-config key naming the kelos Workspace for a project. */
export const PROJECT_WORKSPACE_CONFIG_KEY = "kelosWorkspace";

/**
 * Reads the declared workspace out of a project's `config` blob.
 *
 * `config` is an untyped `Record<string, unknown>` off the wire, so a non-string
 * value is treated as undeclared rather than coerced — `String(42)` would produce
 * a workspace name that cannot exist and fail deep inside kelos.
 */
export function projectWorkspaceFromConfig(config?: Record<string, unknown>): string | undefined {
  const value = config?.[PROJECT_WORKSPACE_CONFIG_KEY];
  return typeof value === "string" ? value : undefined;
}

export interface ResolveKelosWorkspaceInput {
  /** `config.kelosWorkspace` from the owning project, when it declares one. */
  projectWorkspace?: string;
  /** `KELOS_WORKSPACE`, the deployment-wide default. */
  envWorkspace: string;
  /**
   * The project's config could not be READ (server unreachable, request failed).
   *
   * Distinct from "the project declares no workspace", which is a legitimate
   * answer that falls back. An unread config must NOT fall back: the default
   * points at a different repository, so an agent would run — and could write —
   * against a repo the task was never filed for.
   */
  lookupFailed?: boolean;
}

/**
 * Resolves the workspace name, preferring the project's own declaration.
 *
 * @throws If the project's config could not be read, or if neither source names
 * a workspace. Both would otherwise surface as `workspaceRef: {name: ""}`
 * rejected by the API server, far from the actual cause.
 */
export function resolveKelosWorkspace(input: ResolveKelosWorkspaceInput): string {
  const declared = input.projectWorkspace?.trim();
  if (declared) return declared;

  if (input.lookupFailed) {
    throw new Error(
      "kelos workspace could not be resolved: the owning project's config was unreadable. " +
        `Refusing to fall back to KELOS_WORKSPACE ("${input.envWorkspace}") because it may ` +
        "name a different repository than this task targets.",
    );
  }

  const fallback = input.envWorkspace?.trim();
  if (fallback) return fallback;

  throw new Error(
    "no kelos workspace: the owning project declares no " +
      `${PROJECT_WORKSPACE_CONFIG_KEY} and KELOS_WORKSPACE is unset.`,
  );
}
