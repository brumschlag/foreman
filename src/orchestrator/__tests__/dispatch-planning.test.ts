import { describe, it, expect, vi } from "vitest";
import {
  buildDispatchSeedPlan,
  collapseReadyStoryChildren,
  isActionableGroupedChildType,
  isStoryContainer,
  resolveNativeStoryParent,
} from "../dispatch-planning.js";
import type { Issue } from "../../lib/task-client.js";

function makeIssue(id: string, type: string, parent?: string | null): Issue {
  return {
    id,
    title: `title ${id}`,
    type,
    priority: "P2",
    status: "open",
    assignee: null,
    parent: parent ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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
      getTaskById: vi.fn(async (id: string) => {
        if (id === "story-1") {
          return {
            id: "story-1",
            title: "Story One",
            type: "story",
            priority: 2,
            status: "open",
            run_id: null,
            branch: null,
            external_id: null,
            labels: [],
            description: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            approved_at: null,
            closed_at: null,
          };
        }
        if (id === "story-2") {
          return {
            id: "story-2",
            title: "Story Two",
            type: "story",
            priority: 2,
            status: "open",
            run_id: null,
            branch: null,
            external_id: null,
            labels: [],
            description: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            approved_at: null,
            closed_at: null,
          };
        }
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
      getTaskById: async (id) => {
        if (id === "task-mid") {
          return {
            id: "task-mid",
            title: "mid",
            type: "task",
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
          };
        }
        if (id === "story-root") {
          return {
            id: "story-root",
            title: "root story",
            type: "story",
            priority: 2,
            status: "open",
            run_id: null,
            branch: null,
            external_id: null,
            labels: [],
            description: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            approved_at: null,
            closed_at: null,
          };
        }
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
});
