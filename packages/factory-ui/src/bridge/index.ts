/**
 * Factory UI Bridge
 *
 * Connects to the Foreman daemon and relays live data to browser clients.
 *
 * Data sources:
 *   1. GET /events  (SSE)  — real-time pipeline events pushed by daemon
 *   2. tRPC polls   (HTTP) — run snapshots, tasks, project stats every 4s
 *
 * Output:
 *   WebSocket on WS_PORT (default 4747) — browser connects here
 *
 * Usage:
 *   DATABASE_URL=... FOREMAN_PROJECT_ID=<uuid> tsx src/bridge/index.ts
 *   or:
 *   WS_PORT=4747 FOREMAN_PROJECT_ID=<uuid> tsx src/bridge/index.ts
 */

import { DaemonSseClient } from "./daemon-sse-client.js";
import { TrpcPoller } from "./trpc-poller.js";
import { WsRelay } from "./ws-relay.js";

// ── Config from env ───────────────────────────────────────────────────────

const PROJECT_ID = process.env["FOREMAN_PROJECT_ID"] ?? "";
const WS_PORT = parseInt(process.env["WS_PORT"] ?? "4747", 10);
const POLL_INTERVAL_MS = parseInt(process.env["POLL_INTERVAL_MS"] ?? "4000", 10);

if (!PROJECT_ID) {
  console.error("Error: FOREMAN_PROJECT_ID environment variable is required");
  console.error("  export FOREMAN_PROJECT_ID=<your-project-uuid>");
  console.error("  Get it from: psql $DATABASE_URL -c \"SELECT id, name FROM projects;\"");
  process.exit(1);
}

console.log(`[bridge] starting factory UI bridge`);
console.log(`[bridge]   project:    ${PROJECT_ID}`);
console.log(`[bridge]   ws port:    ${WS_PORT}`);
console.log(`[bridge]   poll every: ${POLL_INTERVAL_MS}ms`);

// ── Start WebSocket relay ─────────────────────────────────────────────────

const relay = new WsRelay({ port: WS_PORT, projectId: PROJECT_ID });
relay.start();

// ── Start SSE client (daemon event stream) ────────────────────────────────

const sseClient = new DaemonSseClient({
  projectId: PROJECT_ID,
  onEvent: (event) => {
    relay.broadcast({ kind: "pipeline_event", data: event });
    // Log interesting events to console
    if (!["heartbeat"].includes(event.eventType)) {
      console.log(`[event] seq=${event.seq} ${event.eventType}${event.taskId ? ` task=${event.taskId.slice(0, 8)}` : ""}`);
    }
  },
  onStatus: (status) => {
    console.log(`[sse-client] status → ${status}`);
    if (status === "error") {
      relay.broadcast({ kind: "error", data: { message: "Lost connection to daemon" } });
    }
  },
});

sseClient.start();

// ── Start tRPC poller ─────────────────────────────────────────────────────

const poller = new TrpcPoller({
  projectId: PROJECT_ID,
  pollIntervalMs: POLL_INTERVAL_MS,
  onRuns: (runs) => {
    relay.updateRuns(runs);
    console.log(`[poller] runs: ${runs.length} active`);
  },
  onTasks: (tasks) => {
    relay.updateTasks(tasks);
  },
  onStats: (stats) => {
    relay.updateStats(stats);
  },
});

poller.start();

// ── Graceful shutdown ─────────────────────────────────────────────────────

const shutdown = (): void => {
  console.log("\n[bridge] shutting down...");
  sseClient.stop();
  poller.stop();
  relay.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[bridge] ready — connect your UI to ws://localhost:${WS_PORT}`);
