/**
 * ProcessPoller — polls `ps aux` every N seconds and classifies foreman-related
 * processes into roles for the Processes tab.
 */

import { exec } from "node:child_process";
import type { ProcessInfo } from "./types.js";
import type { WsRelay } from "./ws-relay.js";

const POLL_MS = 5000;

// UUID-shaped segment in a command line
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function classify(cmd: string): { role: ProcessInfo["role"]; label: string; taskId: string | null } {
  const taskId = UUID_RE.exec(cmd)?.[0] ?? null;

  if (/dist\/daemon\/index/.test(cmd)) {
    return { role: "daemon", label: "Foreman Daemon", taskId: null };
  }
  if (/dist\/cli\/index.*run/.test(cmd) || /dist\/orchestrator\/dispatcher/.test(cmd)) {
    return { role: "dispatcher", label: "Dispatcher", taskId: null };
  }
  if (/dist\/orchestrator\/agent-worker|agent-worker\.js/.test(cmd)) {
    return { role: "worker", label: taskId ? `Worker ${taskId.slice(0, 8)}` : "Worker", taskId };
  }
  if (/bridge\/index\.ts|bridge\/index\.js/.test(cmd)) {
    return { role: "bridge", label: "Factory UI Bridge", taskId: null };
  }
  if (/vite/.test(cmd) && !/grep/.test(cmd)) {
    return { role: "vite", label: "Vite Dev Server", taskId: null };
  }
  return { role: "other", label: "other", taskId };
}

function parsePs(output: string): ProcessInfo[] {
  const results: ProcessInfo[] = [];
  for (const line of output.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;
    // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND...
    const pid = parseInt(parts[1] ?? "0", 10);
    const cpu = parts[2] ?? "0";
    const mem = parts[3] ?? "0";
    const elapsed = parts[9] ?? "";
    const cmd = parts.slice(10).join(" ");

    if (!cmd) continue;

    // Only care about foreman / vite / bridge processes
    const isRelevant =
      /dist\/(daemon|cli|orchestrator)/.test(cmd) ||
      /agent-worker/.test(cmd) ||
      /bridge\/index/.test(cmd) ||
      /[/ ]vite[\s$]/.test(cmd);

    if (!isRelevant) continue;

    // Skip the bash wrapper processes (they just exec node)
    if (/^\/usr\/bin\/bash/.test(cmd) || /^bash/.test(cmd)) continue;

    const { role, label, taskId } = classify(cmd);
    results.push({
      pid,
      role,
      label,
      taskId,
      cpu: `${cpu}%`,
      mem: `${mem}%`,
      elapsed,
      command: cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd,
    });
  }
  return results;
}

export class ProcessPoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly relay: WsRelay) {}

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private poll(): void {
    exec("ps aux", (err, stdout) => {
      if (err) return;
      const procs = parsePs(stdout);
      this.relay.broadcast({ kind: "processes_snapshot", data: procs });
    });
  }
}
