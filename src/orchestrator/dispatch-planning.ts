/**
 * Dispatch planning helpers — story worktree grouping and epic task expansion.
 */

import type { Issue } from "../lib/task-client.js";
import type { NativeTask } from "../lib/store.js";
import type { EpicTask } from "./pipeline-executor.js";

export interface DispatchSeedPlan {
  seed: Issue;
  worktreeSeedId: string;
  groupedTasks?: EpicTask[];
  groupingParentId?: string;
}

export interface StoryParentDetail {
  type?: string;
  labels?: string[];
  title?: string;
  status?: string;
  parent?: string | null;
  created_at?: string;
  updated_at?: string;
  description?: string | null;
}

export interface StoryParentLookup {
  getTaskById(id: string): Promise<NativeTask | null>;
  show?(id: string): Promise<StoryParentDetail>;
}

export function isActionableGroupedChildType(type: string | undefined): boolean {
  return type === "task" || type === "bug" || type === "chore";
}

export function isStoryContainer(detail: { type?: string | null; labels?: string[] | null | undefined }): boolean {
  if (detail.type === "story" || detail.type === "feature") return true;
  const labels = detail.labels ?? [];
  return labels.includes("kind:story");
}

export async function resolveNativeStoryParent(
  taskId: string,
  lookup: {
    getParentTaskId(taskId: string): Promise<string | null>;
    getTaskById(id: string): Promise<NativeTask | null>;
  },
): Promise<NativeTask | null> {
  const visited = new Set<string>();
  let currentId: string | null = taskId;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parentId = await lookup.getParentTaskId(currentId);
    if (!parentId) return null;

    const parentTask = await lookup.getTaskById(parentId);
    if (!parentTask) return null;
    if (parentTask.type === "story" || parentTask.type === "feature") return parentTask;

    currentId = parentTask.id;
  }

  return null;
}

export async function buildDispatchSeedPlan(
  seed: Issue,
  opts: {
    groupedTasks?: EpicTask[];
    resolveStoryParent?: (taskId: string) => Promise<NativeTask | null>;
  },
): Promise<DispatchSeedPlan> {
  if (opts.resolveStoryParent) {
    const nativeStoryParent = await opts.resolveStoryParent(seed.id);
    if (nativeStoryParent) {
      return {
        seed,
        worktreeSeedId: nativeStoryParent.id,
        groupingParentId: nativeStoryParent.id,
        groupedTasks: opts.groupedTasks,
      };
    }
  }

  if (opts.groupedTasks && opts.groupedTasks.length > 0) {
    return {
      seed,
      worktreeSeedId: seed.id,
      groupedTasks: opts.groupedTasks,
      groupingParentId: seed.id,
    };
  }

  return {
    seed,
    worktreeSeedId: seed.id,
  };
}

/**
 * Collapse multiple ready tasks under the same story into one synthetic story
 * seed carrying __epicTasks for a grouped epic runner dispatch.
 */
export async function collapseReadyStoryChildren(
  readySeeds: Issue[],
  lookup: StoryParentLookup,
): Promise<Issue[]> {
  const storyGroups = new Map<string, EpicTask[]>();
  const parentDetails = new Map<string, StoryParentDetail>();
  const seedById = new Map(readySeeds.map((seed) => [seed.id, seed]));

  const loadParentDetail = async (parentId: string): Promise<StoryParentDetail> => {
    if (parentDetails.has(parentId)) return parentDetails.get(parentId)!;
    let detail: StoryParentDetail | null = null;
    if (lookup.show) {
      try {
        detail = await lookup.show(parentId);
      } catch {
        detail = null;
      }
    }
    if (!detail) {
      const native = await lookup.getTaskById(parentId);
      if (native) {
        detail = {
          type: native.type,
          labels: native.labels ?? [],
          title: native.title,
          status: native.status,
          parent: null,
          created_at: native.created_at,
          updated_at: native.updated_at,
          description: native.description,
        };
      }
    }
    if (detail) {
      parentDetails.set(parentId, detail);
      return detail;
    }
    throw new Error(`Missing parent detail for ${parentId}`);
  };

  for (const seed of readySeeds) {
    if (!isActionableGroupedChildType(seed.type) || !seed.parent) continue;

    let parentDetail;
    try {
      parentDetail = await loadParentDetail(seed.parent);
    } catch {
      continue;
    }

    if (!isStoryContainer(parentDetail)) continue;

    const groupedTasks = storyGroups.get(seed.parent) ?? [];
    groupedTasks.push({
      seedId: seed.id,
      seedTitle: seed.title,
      seedDescription: seed.description ?? undefined,
    });
    storyGroups.set(seed.parent, groupedTasks);
  }

  if (storyGroups.size === 0) return readySeeds;

  const insertedParents = new Set<string>();
  const collapsed: Issue[] = [];

  const buildStoryParentSeed = (parentId: string): Issue => {
    const parentDetail = parentDetails.get(parentId)!;
    const baseSeed = seedById.get(parentId);
    const nowIso = new Date().toISOString();
    const storySeed: Issue = {
      id: parentId,
      title: parentDetail.title ?? baseSeed?.title ?? parentId,
      type: "story",
      priority: baseSeed?.priority ?? "P2",
      status: parentDetail.status ?? "open",
      assignee: baseSeed?.assignee ?? null,
      parent: parentDetail.parent ?? baseSeed?.parent ?? null,
      created_at: parentDetail.created_at ?? baseSeed?.created_at ?? nowIso,
      updated_at: parentDetail.updated_at ?? baseSeed?.updated_at ?? nowIso,
      description: parentDetail.description ?? baseSeed?.description ?? null,
      labels: parentDetail.labels ?? baseSeed?.labels ?? [],
    };
    (storySeed as unknown as Record<string, unknown>).__epicTasks = storyGroups.get(parentId);
    (storySeed as unknown as Record<string, unknown>).__groupedParentType = "story";
    return storySeed;
  };

  for (const seed of readySeeds) {
    if (storyGroups.has(seed.id)) {
      if (!insertedParents.has(seed.id)) {
        collapsed.push(buildStoryParentSeed(seed.id));
        insertedParents.add(seed.id);
      }
      continue;
    }

    const parentId = seed.parent;
    if (parentId && storyGroups.has(parentId)) {
      if (!insertedParents.has(parentId)) {
        collapsed.push(buildStoryParentSeed(parentId));
        insertedParents.add(parentId);
      }
      continue;
    }

    collapsed.push(seed);
  }

  return collapsed;
}
