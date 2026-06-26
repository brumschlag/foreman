/**
 * Shared type for events broadcast from the daemon event stream.
 * Lives in a standalone file to avoid circular imports between
 * postgres-adapter (lib) and event-broadcaster (daemon).
 */
export interface BroadcastEvent {
  /** UUID primary key of the events row. */
  id: string;
  /** Monotonic bigserial cursor — used as SSE Last-Event-ID. */
  seq: number;
  projectId: string;
  runId: string | null;
  taskId: string | null;
  eventType: string;
  payload: Record<string, unknown> | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
}
