/**
 * DaemonSseClient
 *
 * Connects to the Foreman daemon's GET /events SSE stream via Unix socket
 * (primary) or HTTP fallback (localhost:3847).
 *
 * On connect, sends lastEventId so the daemon replays any missed events.
 * Auto-reconnects with exponential backoff on disconnect.
 */

import * as http from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { BroadcastEvent } from "./types.js";

const DEFAULT_SOCKET = join(homedir(), ".foreman", "daemon.sock");
const DEFAULT_HTTP_PORT = 3847;
const RECONNECT_DELAY_MS = [500, 1000, 2000, 4000, 8000];

export type SseEventHandler = (event: BroadcastEvent) => void;
export type SseStatusHandler = (status: "connected" | "disconnected" | "error") => void;

export interface DaemonSseClientOptions {
  projectId?: string | null;
  socketPath?: string;
  httpPort?: number;
  onEvent?: SseEventHandler;
  onStatus?: SseStatusHandler;
}

export class DaemonSseClient {
  private lastSeq = 0;
  private reconnectAttempt = 0;
  private running = false;
  private currentReq: http.ClientRequest | null = null;

  constructor(private readonly opts: DaemonSseClientOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.currentReq?.destroy();
    this.currentReq = null;
  }

  private connect(): void {
    if (!this.running) return;

    const socketPath = this.opts.socketPath ?? DEFAULT_SOCKET;
    const useSocket = existsSync(socketPath);

    const projectParam = this.opts.projectId
      ? `&projectId=${encodeURIComponent(this.opts.projectId)}`
      : "";
    const path = `/events?lastEventId=${this.lastSeq}${projectParam}`;

    const reqOpts: http.RequestOptions = useSocket
      ? { socketPath, path, method: "GET", headers: { Accept: "text/event-stream" } }
      : { hostname: "127.0.0.1", port: this.opts.httpPort ?? DEFAULT_HTTP_PORT, path, method: "GET", headers: { Accept: "text/event-stream" } };

    const req = http.request(reqOpts, (res) => {
      if (res.statusCode !== 200) {
        console.error(`[sse-client] daemon returned ${res.statusCode} for /events`);
        res.resume();
        this.scheduleReconnect();
        return;
      }

      this.reconnectAttempt = 0;
      this.opts.onStatus?.("connected");
      console.log(`[sse-client] connected via ${useSocket ? "unix socket" : `http :${this.opts.httpPort ?? DEFAULT_HTTP_PORT}`}`);

      let buf = "";
      res.setEncoding("utf-8");

      res.on("data", (chunk: string) => {
        buf += chunk;
        // SSE messages are separated by double newlines
        const messages = buf.split(/\n\n/);
        buf = messages.pop() ?? "";
        for (const msg of messages) {
          this.processMessage(msg);
        }
      });

      res.on("end", () => {
        this.opts.onStatus?.("disconnected");
        console.log("[sse-client] stream ended — reconnecting");
        this.scheduleReconnect();
      });

      res.on("error", (err) => {
        this.opts.onStatus?.("error");
        console.error("[sse-client] response error:", err.message);
        this.scheduleReconnect();
      });
    });

    req.on("error", (err) => {
      this.opts.onStatus?.("error");
      console.error("[sse-client] request error:", err.message);
      this.scheduleReconnect();
    });

    req.end();
    this.currentReq = req;
  }

  private processMessage(raw: string): void {
    // Parse SSE message fields
    let id: string | undefined;
    let data: string | undefined;

    for (const line of raw.split("\n")) {
      if (line.startsWith("id: ")) {
        id = line.slice(4).trim();
      } else if (line.startsWith("data: ")) {
        data = line.slice(6).trim();
      }
      // ignore "event:" and ":" (comments/keepalives)
    }

    if (!data) return;

    // Update cursor
    if (id) {
      const seq = parseInt(id, 10);
      if (!isNaN(seq) && seq > this.lastSeq) this.lastSeq = seq;
    }

    try {
      const event = JSON.parse(data) as BroadcastEvent;
      this.opts.onEvent?.(event);
    } catch {
      console.error("[sse-client] failed to parse event data:", data?.slice(0, 100));
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = RECONNECT_DELAY_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAY_MS.length - 1)];
    this.reconnectAttempt++;
    console.log(`[sse-client] reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => this.connect(), delay);
  }
}
