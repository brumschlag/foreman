/**
 * WsRelay
 *
 * WebSocket server that browser clients connect to.
 * Receives events and snapshots from DaemonSseClient and TrpcPoller,
 * broadcasts them to all connected clients.
 *
 * On new client connect: sends a "connected" message with the projectId,
 * then immediately sends the latest cached snapshots so the UI has data
 * without waiting for the next poll cycle.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { FactoryWsMessage, BroadcastEvent, RunSummary, TaskRow, ProjectStats, ForemanConfig, ChatTurn } from "./types.js";
import { TranscriptReader } from "./transcript-reader.js";

export interface WsRelayOptions {
  port: number;
  projectId: string;
  eventCacheSize?: number;
}

export class WsRelay {
  private wss: WebSocketServer | null = null;

  // Latest cached state — sent to new clients on connect
  private cachedRuns: RunSummary[] = [];
  private cachedTasks: TaskRow[] = [];
  private cachedStats: ProjectStats | null = null;
  private cachedConfig: ForemanConfig | null = null;
  // Ring buffer of recent pipeline events (newest first)
  private cachedEvents: BroadcastEvent[] = [];
  private readonly eventCacheSize: number;
  private readonly transcriptReader: TranscriptReader;

  constructor(private readonly opts: WsRelayOptions) {
    this.eventCacheSize = opts.eventCacheSize ?? 200;
    this.transcriptReader = new TranscriptReader();
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.opts.port });
    this.wss.on("connection", (ws) => this.onConnect(ws));
    console.log(`[ws-relay] listening on ws://localhost:${this.opts.port}`);
  }

  stop(): void {
    this.wss?.close();
    this.wss = null;
  }

  get port(): number { return this.opts.port; }
  get clientCount(): number { return this.wss?.clients.size ?? 0; }

  broadcast(msg: FactoryWsMessage): void {
    if (!this.wss) return;
    const text = JSON.stringify(msg);
    this.wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(text);
      }
    });
  }

  updateRuns(runs: RunSummary[]): void {
    this.cachedRuns = runs;
    this.broadcast({ kind: "runs_snapshot", data: runs });
  }

  updateTasks(tasks: TaskRow[]): void {
    this.cachedTasks = tasks;
    this.broadcast({ kind: "tasks_snapshot", data: tasks });
  }

  updateStats(stats: ProjectStats): void {
    this.cachedStats = stats;
    this.broadcast({ kind: "stats_snapshot", data: stats });
  }

  /** Cache and broadcast a config snapshot. */
  updateConfig(config: ForemanConfig): void {
    this.cachedConfig = config;
    this.broadcast({ kind: "config_snapshot", data: config });
  }

  /** Cache and broadcast a single pipeline event. */
  broadcastEvent(ev: BroadcastEvent): void {
    this.cachedEvents = [ev, ...this.cachedEvents].slice(0, this.eventCacheSize);
    this.broadcast({ kind: "pipeline_event", data: ev });
  }

  /** Broadcast a log line — not cached, just fan out to live clients. */
  broadcastLogLine(line: import("./log-tailer.js").LogLine): void {
    this.broadcast({
      kind: "log_line",
      data: { runId: line.runId, ts: line.ts, level: line.level, message: line.message },
    });
  }

  private onConnect(ws: WebSocket): void {
    console.log(`[ws-relay] client connected (total: ${(this.wss?.clients.size ?? 0)})`);

    const send = (msg: FactoryWsMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    // Greet with projectId
    send({ kind: "connected", data: { projectId: this.opts.projectId } });

    // Replay cached state immediately so the UI doesn't wait for the next poll
    if (this.cachedRuns.length > 0) send({ kind: "runs_snapshot", data: this.cachedRuns });
    if (this.cachedTasks.length > 0) send({ kind: "tasks_snapshot", data: this.cachedTasks });
    if (this.cachedStats) send({ kind: "stats_snapshot", data: this.cachedStats });
    if (this.cachedConfig) send({ kind: "config_snapshot", data: this.cachedConfig });

    // Replay cached events oldest-first so the UI sees them in chronological order
    const ordered = [...this.cachedEvents].reverse();
    for (const ev of ordered) {
      send({ kind: "pipeline_event", data: ev });
    }

    ws.on("close", () => {
      console.log(`[ws-relay] client disconnected (total: ${(this.wss?.clients.size ?? 0)})`);
    });

    ws.on("error", (err) => {
      console.error("[ws-relay] client error:", err.message);
    });

    ws.on("message", (rawData) => {
      try {
        const data = rawData.toString();
        const msg = JSON.parse(data) as FactoryWsMessage;

        if (msg.kind === "transcript_request") {
          const { runId } = msg.data;
          this.transcriptReader
            .read(runId)
            .then((turns) => {
              send({ kind: "transcript_snapshot", data: { runId, turns } });
            })
            .catch((err) => {
              console.error(`[ws-relay] error reading transcript for ${runId}:`, err);
            });
        }
      } catch (err) {
        // Ignore non-JSON messages (e.g., text from client)
      }
    });
  }
}
