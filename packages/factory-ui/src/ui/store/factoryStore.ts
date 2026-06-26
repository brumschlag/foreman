import { create } from "zustand";
import type { BroadcastEvent, RunSummary, TaskRow, ProjectStats, ProcessInfo, ForemanConfig, ChatTurn } from "../../bridge/types";

// Re-export types for UI consumers
export type { BroadcastEvent, RunSummary, TaskRow, ProjectStats, ProcessInfo, ForemanConfig, ChatTurn };

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface LogLineEntry {
  runId: string;
  ts: string;
  level: string;
  message: string;
}

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

  // Agent log lines (last 500, newest first)
  logLines: LogLineEntry[];

  // OS processes
  processes: ProcessInfo[];

  // Selected run for detail panel
  selectedRunId: string | null;

  // Config
  config: ForemanConfig | null;

  // Chat transcripts (runId -> turns)
  transcripts: Record<string, ChatTurn[]>;

  // Actions
  setConnectionStatus: (s: ConnectionStatus) => void;
  setProjectId: (id: string) => void;
  setRuns: (runs: RunSummary[]) => void;
  setTasks: (tasks: TaskRow[]) => void;
  setStats: (stats: ProjectStats) => void;
  addEvent: (ev: BroadcastEvent) => void;
  addLogLine: (line: LogLineEntry) => void;
  setProcesses: (procs: ProcessInfo[]) => void;
  setSelectedRunId: (id: string | null) => void;
  setConfig: (config: ForemanConfig | null) => void;
  setTranscript: (runId: string, turns: ChatTurn[]) => void;
  reset: () => void;
}

export const useFactoryStore = create<FactoryState>()((set) => ({
  connectionStatus: "connecting",
  projectId: null,
  runs: [],
  tasks: [],
  stats: null,
  events: [],
  logLines: [],
  processes: [],
  selectedRunId: null,
  config: null,
  transcripts: {},

  setConnectionStatus: (s) => set({ connectionStatus: s }),
  setProjectId: (id) => set({ projectId: id }),
  setRuns: (runs) => set({ runs }),
  setTasks: (tasks) => set({ tasks }),
  setStats: (stats) => set({ stats }),
  addEvent: (ev) =>
    set((state) => ({
      events: [ev, ...state.events].slice(0, 200),
    })),
  addLogLine: (line) =>
    set((state) => ({
      logLines: [line, ...state.logLines].slice(0, 500),
    })),
  setProcesses: (procs) => set({ processes: procs }),
  setSelectedRunId: (id) => set({ selectedRunId: id }),
  setConfig: (config) => set({ config }),
  setTranscript: (runId, turns) =>
    set((state) => ({
      transcripts: { ...state.transcripts, [runId]: turns },
    })),
  reset: () =>
    set({
      connectionStatus: "connecting",
      projectId: null,
      runs: [],
      tasks: [],
      stats: null,
      events: [],
      logLines: [],
      processes: [],
      selectedRunId: null,
      transcripts: {},
    }),
}));
