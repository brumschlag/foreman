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
import type { FactoryWsMessage, RunSummary, TaskRow, ProjectStats } from "./types.js";

export interface WsRelayOptions {
  port: number;
  projectId: string;
}

export class WsRelay {
  private wss: WebSocketServer | null = null;

  // Latest cached state — sent to new clients on connect
  private cachedRuns: RunSummary[] = [];
  private cachedTasks: TaskRow[] = [];
  private cachedStats: ProjectStats | null = null;

  constructor(private readonly opts: WsRelayOptions) {}

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

    ws.on("close", () => {
      console.log(`[ws-relay] client disconnected (total: ${(this.wss?.clients.size ?? 0)})`);
    });

    ws.on("error", (err) => {
      console.error("[ws-relay] client error:", err.message);
    });
  }
}
