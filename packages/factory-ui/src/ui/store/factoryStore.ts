import { create } from "zustand";
import type { BroadcastEvent, RunSummary, TaskRow, ProjectStats } from "../../bridge/types";

// Re-export types for UI consumers
export type { BroadcastEvent, RunSummary, TaskRow, ProjectStats };

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface FactoryState {
  // Connection
  connectionStatus: ConnectionStatus;
  projectId: string | null;

  // Runs
  runs: RunSummary[];

  // Tasks
  tasks: TaskRow[];

  // Stats
  stats: ProjectStats | null;

  // Pipeline event log (last 200, newest first)
  events: BroadcastEvent[];

  // Actions
  setConnectionStatus: (s: ConnectionStatus) => void;
  setProjectId: (id: string) => void;
  setRuns: (runs: RunSummary[]) => void;
  setTasks: (tasks: TaskRow[]) => void;
  setStats: (stats: ProjectStats) => void;
  addEvent: (ev: BroadcastEvent) => void;
  reset: () => void;
}

export const useFactoryStore = create<FactoryState>()((set) => ({
  connectionStatus: "connecting",
  projectId: null,
  runs: [],
  tasks: [],
  stats: null,
  events: [],

  setConnectionStatus: (s) => set({ connectionStatus: s }),
  setProjectId: (id) => set({ projectId: id }),
  setRuns: (runs) => set({ runs }),
  setTasks: (tasks) => set({ tasks }),
  setStats: (stats) => set({ stats }),
  addEvent: (ev) =>
    set((state) => ({
      events: [ev, ...state.events].slice(0, 200),
    })),
  reset: () =>
    set({
      connectionStatus: "connecting",
      projectId: null,
      runs: [],
      tasks: [],
      stats: null,
      events: [],
    }),
}));
