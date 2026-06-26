/**
 * AgentLogs — Interactive log viewer with per-run filter tabs, auto-scroll,
 * and log-level filtering.
 *
 * Chalk-based TUI following the watch-ui.ts pattern.
 */

import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Run } from "../../lib/store.js";
import { tailFileLines } from "./logs.js";

// ── Types ────────────────────────────────────────────────────────────────

export type LogLevel = "INFO" | "WARN" | "ERROR";
export type LevelFilter = LogLevel | "ALL";

export interface LogLine {
  timestamp: string;
  level: LogLevel;
  message: string;
  runId: string;
}

export interface RunTab {
  runId: string;
  seedId: string;
  label: string;
  status: Run["status"];
}

export interface AgentLogsState {
  selectedRunId: string | null; // null = "All"
  levelFilter: LevelFilter;
  autoScroll: boolean;
}

// ── Log level detection ──────────────────────────────────────────────────

const ERROR_PATTERNS = /\[ERROR\]|Error:|FAIL|failed|✗|error:|BLOCKED|fatal/i;
const WARN_PATTERNS = /\[WARN\]|⚠|warning:|stuck|conflict|retry|timeout/i;

export function detectLevel(message: string): LogLevel {
  if (ERROR_PATTERNS.test(message)) return "ERROR";
  if (WARN_PATTERNS.test(message)) return "WARN";
  return "INFO";
}

// ── Timestamp formatting ─────────────────────────────────────────────────

export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "??:??:??";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return "??:??:??";
  }
}

// ── Parse log files into LogLines ────────────────────────────────────────

function tryJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function logDir(): string {
  return join(homedir(), ".foreman", "logs");
}

export function parseLogLines(runId: string, tailCount: number): LogLine[] {
  const lines: LogLine[] = [];

  // Read from .err file (pipeline/phase events)
  const errPath = join(logDir(), `${runId}.err`);
  if (existsSync(errPath)) {
    for (const raw of tailFileLines(errPath, tailCount)) {
      if (!raw.trim()) continue;
      const obj = tryJson(raw);
      const message = typeof obj?.message === "string" ? obj.message : raw;
      const timestamp = typeof obj?.timestamp === "string" ? obj.timestamp : new Date().toISOString();
      lines.push({ timestamp, level: detectLevel(message), message, runId });
    }
  }

  // Read from .log file (tool events)
  const logPath = join(logDir(), `${runId}.log`);
  if (existsSync(logPath)) {
    for (const raw of tailFileLines(logPath, tailCount)) {
      if (!raw.trim()) continue;
      const obj = tryJson(raw);
      if (!obj) continue;
      let message: string;
      if (obj.type === "tool_execution_start") {
        message = `[tool] ${obj.toolName ?? "tool"} started`;
      } else if (obj.type === "tool_execution_end") {
        message = `[tool] ${obj.toolName ?? "tool"} completed`;
      } else if (typeof obj.message === "string") {
        message = obj.message;
      } else {
        continue;
      }
      const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString();
      lines.push({ timestamp, level: detectLevel(message), message, runId });
    }
  }

  // Sort by timestamp
  lines.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return lines;
}

// ── Build run tabs from runs ─────────────────────────────────────────────

export function buildRunTabs(runs: Run[]): RunTab[] {
  return runs.map((run) => ({
    runId: run.id,
    seedId: run.seed_id,
    label: run.seed_id.slice(0, 8),
    status: run.status,
  }));
}

// ── Status LED ───────────────────────────────────────────────────────────

const STATUS_LEDS: Record<string, string> = {
  running: "🟢",
  completed: "🟢",
  failed: "🔴",
  stuck: "🟡",
  pending: "⚪",
  cooldown: "🟡",
  merged: "🟢",
  conflict: "🔴",
  "test-failed": "🔴",
  "pr-created": "🟢",
  reset: "⚪",
};

export function statusLed(status: Run["status"]): string {
  return STATUS_LEDS[status] ?? "⚪";
}

// ── Filter log lines ─────────────────────────────────────────────────────

export function filterLogLines(
  lines: LogLine[],
  state: AgentLogsState,
): LogLine[] {
  let filtered = lines;
  if (state.selectedRunId !== null) {
    filtered = filtered.filter((l) => l.runId === state.selectedRunId);
  }
  if (state.levelFilter !== "ALL") {
    filtered = filtered.filter((l) => l.level === state.levelFilter);
  }
  return filtered;
}

// ── Render a single log line ─────────────────────────────────────────────

function levelBadge(level: LogLevel): string {
  switch (level) {
    case "INFO":  return chalk.green(" INFO ");
    case "WARN":  return chalk.yellow(" WARN ");
    case "ERROR": return chalk.red("ERROR ");
  }
}

export function renderLogLine(line: LogLine): string {
  const ts = chalk.dim(formatTimestamp(line.timestamp));
  const badge = levelBadge(line.level);
  const msg = line.message;
  const content = `${ts} ${chalk.dim("│")} ${badge} ${chalk.dim("│")} ${msg}`;
  if (line.level === "ERROR") {
    return `${chalk.red("┃")} ${content}`;
  }
  return `  ${content}`;
}

// ── Render run tabs bar ──────────────────────────────────────────────────

export function renderRunTabs(tabs: RunTab[], selectedRunId: string | null): string {
  const parts: string[] = [];
  // "All" tab
  const allActive = selectedRunId === null;
  parts.push(allActive ? chalk.bgWhite.black(" All ") : chalk.dim(" All "));

  for (const tab of tabs) {
    const led = statusLed(tab.status);
    const label = `${led} ${tab.label}`;
    const isActive = tab.runId === selectedRunId;
    parts.push(isActive ? chalk.bgWhite.black(` ${label} `) : chalk.dim(` ${label} `));
  }
  return parts.join(chalk.dim(" │ "));
}

// ── Render level filter bar ──────────────────────────────────────────────

const LEVEL_OPTIONS: LevelFilter[] = ["ALL", "INFO", "WARN", "ERROR"];

export function renderLevelFilter(current: LevelFilter): string {
  return LEVEL_OPTIONS.map((opt) => {
    if (opt === current) return chalk.bgWhite.black(` ${opt} `);
    return chalk.dim(` ${opt} `);
  }).join(chalk.dim(" │ "));
}

// ── Render auto-scroll indicator ─────────────────────────────────────────

export function renderAutoScrollToggle(enabled: boolean): string {
  return enabled
    ? chalk.green("⇩ Auto-scroll ON")
    : chalk.dim("⇩ Auto-scroll OFF");
}

// ── Full render ──────────────────────────────────────────────────────────

export interface RenderOptions {
  tabs: RunTab[];
  logLines: LogLine[];
  state: AgentLogsState;
  terminalHeight?: number;
}

export function renderAgentLogs(opts: RenderOptions): string {
  const { tabs, logLines, state, terminalHeight = 24 } = opts;
  const output: string[] = [];

  // Header: run tabs
  output.push(renderRunTabs(tabs, state.selectedRunId));

  // Level filter + auto-scroll toggle
  output.push(`${renderLevelFilter(state.levelFilter)}  ${renderAutoScrollToggle(state.autoScroll)}`);
  output.push(chalk.dim("─".repeat(60)));

  // Filter lines
  const filtered = filterLogLines(logLines, state);

  if (filtered.length === 0) {
    output.push("");
    output.push(chalk.dim("  No logs yet for this run."));
    output.push("");
  } else {
    // Show last N lines that fit in terminal (reserve 5 lines for header/footer)
    const maxVisible = Math.max(1, terminalHeight - 5);
    const visible = filtered.slice(-maxVisible);
    for (const line of visible) {
      output.push(renderLogLine(line));
    }
  }

  // Footer with key hints
  output.push(chalk.dim("─".repeat(60)));
  output.push(chalk.dim(" Tab/1-9: switch run │ f: filter level │ a: auto-scroll │ q: quit"));

  return output.join("\n");
}

// ── Auto-scroll state management ─────────────────────────────────────────

export function createInitialState(): AgentLogsState {
  return {
    selectedRunId: null,
    levelFilter: "ALL",
    autoScroll: true,
  };
}

export function cycleLevelFilter(current: LevelFilter): LevelFilter {
  const idx = LEVEL_OPTIONS.indexOf(current);
  return LEVEL_OPTIONS[(idx + 1) % LEVEL_OPTIONS.length] ?? current;
}

export function selectRunTab(tabs: RunTab[], currentRunId: string | null): string | null {
  if (tabs.length === 0) return null;
  if (currentRunId === null) {
    // Move from "All" to first run
    return tabs[0]?.runId ?? null;
  }
  const idx = tabs.findIndex((t) => t.runId === currentRunId);
  if (idx === -1 || idx === tabs.length - 1) {
    // Wrap back to "All"
    return null;
  }
  return tabs[idx + 1]?.runId ?? null;
}

// ── Interactive TUI launcher ─────────────────────────────────────────────

export interface LaunchOptions {
  runs: Run[];
  pollIntervalMs?: number;
  tailCount?: number;
}

export async function launchAgentLogs(opts: LaunchOptions): Promise<void> {
  const { runs, pollIntervalMs = 1000, tailCount = 200 } = opts;
  const tabs = buildRunTabs(runs);
  const state = createInitialState();
  let running = true;

  function loadAllLogs(): LogLine[] {
    const all: LogLine[] = [];
    for (const run of runs) {
      all.push(...parseLogLines(run.id, tailCount));
    }
    all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return all;
  }

  function draw(): void {
    const logLines = loadAllLogs();
    const height = process.stdout.rows || 24;
    const display = renderAgentLogs({ tabs, logLines, state, terminalHeight: height });
    process.stdout.write(`\x1B[2J\x1B[H${display}\n`);
  }

  // Initial draw
  draw();

  // Poll timer
  const timer = setInterval(() => {
    if (state.autoScroll) draw();
  }, pollIntervalMs);

  // Key handling
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  const onData = (data: Buffer): void => {
    const key = data.toString();
    if (key === "q" || key === "\x1B" || key === "\x03") {
      // quit
      running = false;
      cleanup();
      return;
    }
    if (key === "f") {
      state.levelFilter = cycleLevelFilter(state.levelFilter);
      draw();
      return;
    }
    if (key === "a") {
      state.autoScroll = !state.autoScroll;
      draw();
      return;
    }
    if (key === "\t" || key === "n") {
      state.selectedRunId = selectRunTab(tabs, state.selectedRunId);
      draw();
      return;
    }
    // Number keys 1-9 select run tabs (0 = All)
    const num = Number.parseInt(key, 10);
    if (num === 0) {
      state.selectedRunId = null;
      draw();
      return;
    }
    if (num >= 1 && num <= 9 && num <= tabs.length) {
      state.selectedRunId = tabs[num - 1]?.runId ?? null;
      draw();
      return;
    }
    // Arrow up disables auto-scroll
    if (key === "\x1B[A") {
      state.autoScroll = false;
      draw();
      return;
    }
  };

  process.stdin.on("data", onData);

  function cleanup(): void {
    clearInterval(timer);
    process.stdin.removeListener("data", onData);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw ?? false);
    }
    process.stdin.pause();
  }

  // Wait until quit
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}
