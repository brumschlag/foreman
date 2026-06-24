/**
 * LogTailer
 *
 * Watches ~/.foreman/logs/ for active run log files and tails them,
 * broadcasting each line to WS clients as a log_line message.
 *
 * Foreman writes two log files per run:
 *   <runId>.log  — human-readable pipe-delimited lines (PHASE, tool calls, etc.)
 *   <runId>.err  — structured JSON lines { level, timestamp, message }
 *
 * We parse the .err file for structured data but also include .log for
 * richer phase/tool activity lines.
 *
 * A "log_line" WsMessage is broadcast for each new line detected.
 */

import { watch, createReadStream, statSync, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import type { WsRelay } from "./ws-relay.js";

export interface LogLine {
  runId: string;
  /** "err" = structured JSON from .err, "log" = human text from .log */
  source: "err" | "log";
  /** ISO timestamp — from JSON if available, else Date.now() */
  ts: string;
  /** Log level: info | warn | error (from .err) or "log" for .log lines */
  level: string;
  /** The message text */
  message: string;
}

const LOGS_DIR = join(homedir(), ".foreman", "logs");

// Track tail position per file
type TailState = {
  path: string;
  byteOffset: number;
};

export class LogTailer {
  private readonly tails = new Map<string, TailState>();
  private watcher: ReturnType<typeof watch> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly relay: WsRelay) {}

  start(): void {
    if (!existsSync(LOGS_DIR)) return;

    // Watch for new files appearing in the logs dir
    try {
      this.watcher = watch(LOGS_DIR, (event, filename) => {
        if (filename && filename.endsWith(".err")) {
          const runId = filename.replace(".err", "");
          this.ensureTail(runId);
        }
      });
    } catch {
      // Non-fatal — fall back to polling only
    }

    // Poll every 1s to read new lines from all tracked files
    this.pollTimer = setInterval(() => this.pollAll(), 1000);

    // Pick up any existing .err files (runs already in progress)
    this.scanExisting();

    console.log("[log-tailer] watching ~/.foreman/logs/");
  }

  stop(): void {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.tails.clear();
  }

  /** Register a new run's .err file for tailing. */
  private ensureTail(runId: string): void {
    if (this.tails.has(runId)) return;
    // Prefer .err (structured JSON). Also register a .log watcher for non-JSON prefix lines.
    const errPath = join(LOGS_DIR, `${runId}.err`);
    const logPath = join(LOGS_DIR, `${runId}.log`);
    if (existsSync(errPath)) {
      // Start from current end of file to show only new lines
      const size = (() => { try { return statSync(errPath).size; } catch { return 0; } })();
      this.tails.set(runId, { path: errPath, byteOffset: size });
      console.log(`[log-tailer] tailing run ${runId.slice(0, 8)}`);
    }
    // Also tail .log for human-readable lines
    if (existsSync(logPath)) {
      const key = `${runId}:log`;
      const size = (() => { try { return statSync(logPath).size; } catch { return 0; } })();
      this.tails.set(key, { path: logPath, byteOffset: size });
    }
  }

  /** Scan for .err files already present (pre-existing runs). */
  private scanExisting(): void {
    try {
      const files: string[] = readdirSync(LOGS_DIR);
      for (const f of files) {
        if (f.endsWith(".err")) {
          const runId = f.replace(".err", "");
          // Only tail if the file was modified in last 30 min
          const path = join(LOGS_DIR, f);
          try {
            const stat = statSync(path);
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs < 30 * 60 * 1000) {
              this.ensureTail(runId);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  /** Read any new bytes from all tailed files. */
  private pollAll(): void {
    const entries = Array.from(this.tails.entries());
    for (const [key, state] of entries) {
      // key is either runId (for .err) or "runId:log" (for .log)
      const isLog = key.endsWith(":log");
      const runId = isLog ? key.slice(0, -4) : key;
      try {
        const stat = statSync(state.path);
        if (stat.size <= state.byteOffset) continue;

        const stream = createReadStream(state.path, {
          start: state.byteOffset,
          end: stat.size - 1,
          encoding: "utf-8",
        });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        const lines: string[] = [];
        rl.on("line", (line) => { if (line.trim()) lines.push(line); });
        rl.on("close", () => {
          state.byteOffset = stat.size;
          for (const line of lines) {
            this.processLine(runId, line, isLog);
          }
        });
      } catch {
        this.tails.delete(key);
      }
    }
  }

  /** Parse a line and broadcast it. */
  private processLine(runId: string, raw: string, isLogFile = false): void {
    let level = "info";
    let message = raw;
    let ts = new Date().toISOString();

    if (isLogFile) {
      // .log file: only forward human-readable prefix lines, skip JSON telemetry
      if (raw.startsWith("{")) return;
      // Only forward meaningful phase/tool lines
      const keep =
        raw.includes("[PHASE:") ||
        raw.includes("[PIPELINE]") ||
        raw.includes("[pi-sdk-runner]") ||
        raw.includes("COMPLETED") ||
        raw.includes("FAILED") ||
        raw.includes("[foreman-worker]") ||
        raw.match(/^─+$/); // separator lines
      if (!keep) return;
      level = raw.includes("FAILED") ? "error" : "log";
    } else {
      // .err file: try JSON parse
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (obj.message && typeof obj.message === "string") {
          message = obj.message;
          level = typeof obj.level === "string" ? obj.level : "info";
          ts = typeof obj.timestamp === "string" ? obj.timestamp : ts;
        }
      } catch {
        // plain text — use as-is
      }
    }

    // Skip noisy/low-value lines
    if (
      message.includes("[agent-mail]") ||
      message.includes("incoming request") ||
      message.includes("request completed") ||
      message.includes("bv triage") ||
      message.length === 0
    ) {
      return;
    }

    const logLine: LogLine = { runId, source: isLogFile ? "log" : "err", ts, level, message };
    this.relay.broadcastLogLine(logLine);
  }
}
