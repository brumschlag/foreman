/**
 * BroadcastEvent — the SSE envelope pushed by the Foreman daemon's GET /events.
 * Mirrors src/daemon/broadcast-event.ts (inlined to avoid cross-package TS paths).
 */
export interface BroadcastEvent {
  id: string;
  seq: number;
  projectId: string;
  runId: string | null;
  taskId: string | null;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * FactoryWsMessage — the envelope the bridge sends over WebSocket to browsers.
 * Each kind maps to one data source.
 */
export type FactoryWsMessage =
  | { kind: "connected";       data: { projectId: string } }
  | { kind: "pipeline_event";  data: BroadcastEvent }
  | { kind: "runs_snapshot";   data: RunSummary[] }
  | { kind: "tasks_snapshot";  data: TaskRow[] }
  | { kind: "stats_snapshot";  data: ProjectStats }
  | { kind: "log_line";        data: { runId: string; ts: string; level: string; message: string } }
  | { kind: "error";           data: { message: string } };

// ── Foreman domain types (minimal subset used by the bridge) ──────────────

export interface RunSummary {
  id: string;
  beadId: string;
  status: string;
  branch: string;
  agentType: string | null;
  worktreePath: string | null;
  startedAt: string | null;
  createdAt: string;
  progress: RunProgress | null;
}

export interface RunProgress {
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  filesChanged: string[];
  turns: number;
  costUsd: number;
  lastToolCall: string | null;
  lastActivity: string;
  currentPhase: string | null;
}

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  type: string;
  priority: number;
}

export interface ProjectStats {
  activeRuns: number;
  tasks: {
    backlog: number;
    ready: number;
    inProgress: number;
    review: number;
    closed: number;
    total: number;
  };
}
