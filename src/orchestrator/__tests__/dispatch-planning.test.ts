import { describe, it, expect, vi } from "vitest";
import {
  buildDispatchSeedPlan,
  collapseReadyStoryChildren,
  isActionableGroupedChildType,
  isStoryContainer,
  resolveNativeStoryParent,
} from "../dispatch-planning.js";
import type { Issue } from "../../lib/task-client.js";
import type { NativeTask } from "../../lib/store.js";

function makeIssue(id: string, type: string, parent?: string | null): Issue {
  return {
    id,
    title: `title ${id}`,
    type,
    priority: "P2",
    status: "ready",
    assignee: null,
    parent: parent ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeNativeTask(id: string, type: string, title?: string): NativeTask {
  const now = new Date().toISOString();
  return {
    id,
    title: title ?? `title ${id}`,
    type,
    priority: 2,
    status: "ready",
    run_id: null,
    branch: null,
    external_id: null,
    labels: [],
    description: null,
    created_at: now,
    updated_at: now,
    approved_at: null,
    closed_at: null,
  };
}

describe("dispatch-planning", () => {
  it("isActionableGroupedChildType accepts task, bug, chore only", () => {
    expect(isActionableGroupedChildType("task")).toBe(true);
    expect(isActionableGroupedChildType("bug")).toBe(true);
    expect(isActionableGroupedChildType("chore")).toBe(true);
    expect(isActionableGroupedChildType("story")).toBe(false);
  });

  it("isStoryContainer detects story, feature, and kind:story label", () => {
    expect(isStoryContainer({ type: "story" })).toBe(true);
    expect(isStoryContainer({ type: "feature" })).toBe(true);
    expect(isStoryContainer({ type: "task", labels: ["kind:story"] })).toBe(true);
    expect(isStoryContainer({ type: "task" })).toBe(false);
  });

  it("buildDispatchSeedPlan uses story parent worktree when resolveStoryParent finds one", async () => {
    const seed = makeIssue("task-1", "task");
    const plan = await buildDispatchSeedPlan(seed, {
      resolveStoryParent: async () => ({
        id: "story-1",
        title: "Story",
        type: "story",
        priority: 2,
        status: "ready",
        run_id: null,
        branch: null,
        external_id: null,
        labels: [],
        description: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        approved_at: null,
        closed_at: null,
      }),
    });

    expect(plan.worktreeSeedId).toBe("story-1");
    expect(plan.groupingParentId).toBe("story-1");
  });

  it("collapseReadyStoryChildren groups ready tasks under the same story", async () => {
    const ready = [
      makeIssue("task-a", "task", "story-1"),
      makeIssue("task-b", "task", "story-1"),
      makeIssue("task-c", "task", "story-2"),
    ];

    const lookup = {
      getTaskById: vi.fn(async (id: string): Promise<NativeTask | null> => {
        if (id === "story-1") return makeNativeTask("story-1", "story", "Story One");
        if (id === "story-2") return makeNativeTask("story-2", "story", "Story Two");
        return null;
      }),
    };

    const collapsed = await collapseReadyStoryChildren(ready, lookup);

    expect(collapsed).toHaveLength(2);
    const storyOne = collapsed.find((s) => s.id === "story-1");
    const storyTwo = collapsed.find((s) => s.id === "story-2");
    expect(storyOne?.type).toBe("story");
    expect((storyOne as unknown as Record<string, unknown>).__epicTasks).toEqual([
      { seedId: "task-a", seedTitle: "title task-a", seedDescription: undefined },
      { seedId: "task-b", seedTitle: "title task-b", seedDescription: undefined },
    ]);
    expect((storyTwo as unknown as Record<string, unknown>).__epicTasks).toEqual([
      { seedId: "task-c", seedTitle: "title task-c", seedDescription: undefined },
    ]);
  });

  it("collapseReadyStoryChildren prefers lookup.show over getTaskById for parent detail", async () => {
    const ready = [makeIssue("task-a", "task", "story-1")];
    const show = vi.fn().mockResolvedValue({
      type: "story",
      labels: ["kind:story"],
      title: "Shown Story Title",
      status: "ready",
      parent: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      description: "from show",
    });
    const getTaskById = vi.fn();

    const collapsed = await collapseReadyStoryChildren(ready, { show, getTaskById });

    expect(show).toHaveBeenCalledWith("story-1");
    expect(getTaskById).not.toHaveBeenCalled();
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].id).toBe("story-1");
    expect(collapsed[0].title).toBe("Shown Story Title");
    expect(collapsed[0].status).toBe("ready");
    expect(collapsed[0].description).toBe("from show");
  });

  it("collapseReadyStoryChildren falls back to getTaskById when lookup.show throws", async () => {
    const ready = [makeIssue("task-a", "task", "story-1")];
    const show = vi.fn().mockRejectedValue(new Error("show unavailable"));
    const getTaskById = vi.fn().mockResolvedValue(makeNativeTask("story-1", "story", "Native Story Title"));

    const collapsed = await collapseReadyStoryChildren(ready, { show, getTaskById });

    expect(show).toHaveBeenCalledWith("story-1");
    expect(getTaskById).toHaveBeenCalledWith("story-1");
    expect(collapsed[0].title).toBe("Native Story Title");
  });

  it("collapseReadyStoryChildren skips non-actionable children and seeds without parents", async () => {
    const ready = [
      makeIssue("story-child", "story", "story-1"),
      makeIssue("orphan-task", "task"),
    ];
    const lookup = {
      getTaskById: vi.fn(async (id: string) => {
        if (id === "story-1") return makeNativeTask("story-1", "story", "Story One");
        return null;
      }),
    };

    const collapsed = await collapseReadyStoryChildren(ready, lookup);

    expect(collapsed.map((seed) => seed.id)).toEqual(["story-child", "orphan-task"]);
    expect(collapsed.some((seed) => seed.id === "story-1")).toBe(false);
  });

  it("buildDispatchSeedPlan uses groupedTasks when provided", async () => {
    const seed = makeIssue("story-1", "story");
    const groupedTasks = [
      { seedId: "task-a", seedTitle: "Task A" },
      { seedId: "task-b", seedTitle: "Task B" },
    ];

    const plan = await buildDispatchSeedPlan(seed, { groupedTasks });
    expect(plan.worktreeSeedId).toBe("story-1");
    expect(plan.groupedTasks).toEqual(groupedTasks);
    expect(plan.groupingParentId).toBe("story-1");
  });

  it("resolveNativeStoryParent walks ancestors to find story container", async () => {
    const parent = await resolveNativeStoryParent("task-leaf", {
      getParentTaskId: async (id) => {
        if (id === "task-leaf") return "task-mid";
        if (id === "task-mid") return "story-root";
        return null;
      },
      getTaskById: async (id): Promise<NativeTask | null> => {
        if (id === "task-mid") return makeNativeTask("task-mid", "task", "mid");
        if (id === "story-root") return makeNativeTask("story-root", "story", "root story");
        return null;
      },
    });

    expect(parent?.id).toBe("story-root");
  });

  it("resolveNativeStoryParent returns null when no story ancestor exists", async () => {
    const parent = await resolveNativeStoryParent("task-leaf", {
      getParentTaskId: async () => null,
      getTaskById: async () => null,
    });
    expect(parent).toBeNull();
  });

  it("resolveNativeStoryParent returns null when parent task record is missing", async () => {
    const parent = await resolveNativeStoryParent("task-leaf", {
      getParentTaskId: async () => "missing-parent",
      getTaskById: async () => null,
    });
    expect(parent).toBeNull();
  });

  it("resolveNativeStoryParent returns null when parent chain cycles without a story", async () => {
    const parent = await resolveNativeStoryParent("task-a", {
      getParentTaskId: async (id) => {
        if (id === "task-a") return "task-b";
        if (id === "task-b") return "task-a";
        return null;
      },
      getTaskById: async (id) => makeNativeTask(id, "task"),
    });
    expect(parent).toBeNull();
  });
});
