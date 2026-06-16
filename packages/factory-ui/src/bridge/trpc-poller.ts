/**
 * TrpcPoller
 *
 * Polls the Foreman daemon's tRPC API on a short interval to collect
 * run snapshots, task lists, and project stats.
 *
 * Uses the same Unix-socket-over-HTTP approach as the daemon's own trpc-client.
 * We make raw HTTP requests rather than importing the tRPC client (which would
 * pull in the entire Foreman monorepo dependency tree).
 */

import * as http from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { RunSummary, TaskRow, ProjectStats } from "./types.js";

const DEFAULT_SOCKET = join(homedir(), ".foreman", "daemon.sock");
const DEFAULT_HTTP_PORT = 3847;

export interface TrpcPollerOptions {
  projectId: string;
  pollIntervalMs?: number;
  socketPath?: string;
  httpPort?: number;
  onRuns?: (runs: RunSummary[]) => void;
  onTasks?: (tasks: TaskRow[]) => void;
  onStats?: (stats: ProjectStats) => void;
}

export class TrpcPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(private readonly opts: TrpcPollerOptions) {
    this.intervalMs = opts.pollIntervalMs ?? 4000;
  }

  start(): void {
    // Poll immediately, then on interval
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    const { projectId } = this.opts;
    await Promise.allSettled([
      this.fetchRuns(projectId),
      this.fetchTasks(projectId),
      this.fetchStats(projectId),
    ]);
  }

  // ── tRPC helpers ─────────────────────────────────────────────────────────

  private async trpcQuery<T>(procedure: string, input: Record<string, unknown>): Promise<T> {
    const socketPath = this.opts.socketPath ?? DEFAULT_SOCKET;
    const useSocket = existsSync(socketPath);
    // tRPC batch format: input={"0":<input>}
    const batchPath = `/trpc/${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": input }))}`;

    const reqOpts: http.RequestOptions = useSocket
      ? { socketPath, path: batchPath, method: "GET" }
      : { hostname: "127.0.0.1", port: this.opts.httpPort ?? DEFAULT_HTTP_PORT, path: batchPath, method: "GET" };

    return new Promise<T>((resolve, reject) => {
      const req = http.request(reqOpts, (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => {
          try {
            // tRPC batch wraps response in [{result:{data:...}}]
            const parsed = JSON.parse(body) as Array<{ result?: { data: T }; error?: unknown }>;
            if (parsed[0]?.error) {
              reject(new Error(`tRPC error: ${JSON.stringify(parsed[0].error)}`));
            } else if (parsed[0]?.result?.data !== undefined) {
              resolve(parsed[0].result.data);
            } else {
              reject(new Error(`Unexpected tRPC response shape: ${body.slice(0, 200)}`));
            }
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error("tRPC request timed out")); });
      req.end();
    });
  }

  private async fetchRuns(projectId: string): Promise<void> {
    try {
      const raw = await this.trpcQuery<unknown[]>("runs.listActive", { projectId });
      const runs: RunSummary[] = (raw ?? []).map((r: Record<string, unknown>) => ({
        id: r["id"] as string,
        beadId: (r["bead_id"] ?? r["seed_id"] ?? "") as string,
        status: r["status"] as string,
        branch: (r["branch"] ?? "") as string,
        agentType: (r["agent_type"] ?? null) as string | null,
        worktreePath: (r["worktree_path"] ?? null) as string | null,
        startedAt: (r["started_at"] ?? null) as string | null,
        createdAt: (r["created_at"] ?? r["queued_at"] ?? "") as string,
        progress: r["progress"] ? (r["progress"] as RunSummary["progress"]) : null,
      }));
      this.opts.onRuns?.(runs);
    } catch (err) {
      // Non-fatal — poll will retry
      console.warn("[trpc-poller] runs fetch failed:", (err as Error).message);
    }
  }

  private async fetchTasks(projectId: string): Promise<void> {
    try {
      const raw = await this.trpcQuery<unknown[]>("tasks.list", { projectId, limit: 500 });
      const tasks: TaskRow[] = (raw ?? []).map((t: Record<string, unknown>) => ({
        id: t["id"] as string,
        title: (t["title"] ?? "") as string,
        status: (t["status"] ?? "backlog") as string,
        type: (t["type"] ?? "task") as string,
        priority: (t["priority"] ?? 2) as number,
      }));
      this.opts.onTasks?.(tasks);
    } catch (err) {
      console.warn("[trpc-poller] tasks fetch failed:", (err as Error).message);
    }
  }

  private async fetchStats(projectId: string): Promise<void> {
    try {
      const raw = await this.trpcQuery<Record<string, unknown>>("projects.stats", { projectId });
      const tasks = (raw?.["tasks"] ?? {}) as Record<string, number>;
      const runs = (raw?.["runs"] ?? {}) as Record<string, number>;
      const stats: ProjectStats = {
        activeRuns: (runs["active"] ?? 0) + (runs["pending"] ?? 0),
        tasks: {
          backlog:    tasks["backlog"] ?? 0,
          ready:      tasks["ready"] ?? 0,
          inProgress: tasks["inProgress"] ?? 0,
          review:     tasks["review"] ?? 0,
          closed:     (tasks["merged"] ?? 0) + (tasks["closed"] ?? 0),
          total:      tasks["total"] ?? 0,
        },
      };
      this.opts.onStats?.(stats);
    } catch (err) {
      console.warn("[trpc-poller] stats fetch failed:", (err as Error).message);
    }
  }
}
