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
  | { kind: "connected";        data: { projectId: string } }
  | { kind: "pipeline_event";   data: BroadcastEvent }
  | { kind: "runs_snapshot";    data: RunSummary[] }
  | { kind: "tasks_snapshot";   data: TaskRow[] }
  | { kind: "stats_snapshot";   data: ProjectStats }
  | { kind: "config_snapshot";  data: ForemanConfig }
  | { kind: "log_line";         data: { runId: string; ts: string; level: string; message: string } }
  | { kind: "processes_snapshot"; data: ProcessInfo[] }
  | { kind: "error";            data: { message: string } }
  | { kind: "transcript_request"; data: { runId: string } }   // client → bridge
  | { kind: "transcript_snapshot"; data: { runId: string; turns: ChatTurn[] } }  // bridge → client

// ── Chat transcript types ──────────────────────────────────────────────────

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatToolResult {
  toolCallId: string;
  text: string;
}

export interface ChatTurn {
  role: "assistant" | "tool_result";
  text: string;
  toolCalls: ChatToolCall[];
  toolResults: ChatToolResult[];
  usage?: { input: number; output: number; cost: { total: number } };
}

// ── Foreman domain types (minimal subset used by the bridge) ──────────────

export interface RunSummary {
  id: string;
  beadId: string;
  status: string;
  branch: string;
  agentType: string | null;
  worktreePath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  progress: RunProgress | null;
  prUrl: string | null;
  prNumber: number | null;
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
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectStats {
  activeRuns: number;
  successRate24h: number;
  costUsd24h: number;
  avgCostPerRun: number;
  tasks: {
    backlog: number;
    ready: number;
    inProgress: number;
    review: number;
    closed: number;
    total: number;
  };
}

export interface ProcessInfo {
  pid: number;
  role: "daemon" | "dispatcher" | "worker" | "bridge" | "vite" | "other";
  label: string;
  taskId: string | null;
  cpu: string;
  mem: string;
  elapsed: string;
  command: string;
}

// ── Foreman Config type ───────────────────────────────────────────────────

export interface ForemanConfig {
  defaultBranch: string | null;
  models: {
    default: string | null;
  };
  pr: {
    baseBranch: string | null;
  };
  vcs: {
    backend: string | null;
  };
  raw: string;
}
