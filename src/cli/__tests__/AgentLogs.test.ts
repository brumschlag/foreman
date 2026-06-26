import { describe, expect, it } from "vitest";
import {
  detectLevel,
  formatTimestamp,
  filterLogLines,
  renderLogLine,
  renderRunTabs,
  renderLevelFilter,
  renderAutoScrollToggle,
  renderAgentLogs,
  buildRunTabs,
  cycleLevelFilter,
  selectRunTab,
  createInitialState,
  statusLed,
  type LogLine,
  type RunTab,
  type AgentLogsState,
} from "../commands/AgentLogs.js";
import type { Run } from "../../lib/store.js";

// ── detectLevel ──────────────────────────────────────────────────────────

describe("detectLevel", () => {
  it("detects ERROR from error patterns", () => {
    expect(detectLevel("[ERROR] something broke")).toBe("ERROR");
    expect(detectLevel("Error: file not found")).toBe("ERROR");
    expect(detectLevel("FAIL test suite")).toBe("ERROR");
    expect(detectLevel("task failed")).toBe("ERROR");
    expect(detectLevel("✗ build failed")).toBe("ERROR");
  });

  it("detects WARN from warning patterns", () => {
    expect(detectLevel("[WARN] low disk")).toBe("WARN");
    expect(detectLevel("⚠ something")).toBe("WARN");
    expect(detectLevel("warning: deprecated")).toBe("WARN");
    expect(detectLevel("agent stuck")).toBe("WARN");
    expect(detectLevel("merge conflict detected")).toBe("WARN");
    expect(detectLevel("retry attempt 2")).toBe("WARN");
  });

  it("defaults to INFO", () => {
    expect(detectLevel("Starting explorer phase")).toBe("INFO");
    expect(detectLevel("[PIPELINE] normal message")).toBe("INFO");
    expect(detectLevel("")).toBe("INFO");
  });
});

// ── formatTimestamp ──────────────────────────────────────────────────────

describe("formatTimestamp", () => {
  it("formats ISO timestamp to HH:MM:SS", () => {
    // Use a fixed UTC time and account for local timezone
    const d = new Date("2026-06-09T13:45:30.000Z");
    const expected = `${String(d.getHours()).padStart(2, "0")}:45:30`;
    expect(formatTimestamp("2026-06-09T13:45:30.000Z")).toBe(expected);
  });

  it("returns placeholder for invalid timestamp", () => {
    expect(formatTimestamp("not-a-date")).toBe("??:??:??");
  });
});

// ── filterLogLines ───────────────────────────────────────────────────────

describe("filterLogLines", () => {
  const lines: LogLine[] = [
    { timestamp: "2026-06-09T01:00:00Z", level: "INFO", message: "a", runId: "run-1" },
    { timestamp: "2026-06-09T01:00:01Z", level: "WARN", message: "b", runId: "run-1" },
    { timestamp: "2026-06-09T01:00:02Z", level: "ERROR", message: "c", runId: "run-2" },
    { timestamp: "2026-06-09T01:00:03Z", level: "INFO", message: "d", runId: "run-2" },
  ];

  it("returns all lines when no filters active", () => {
    const state: AgentLogsState = { selectedRunId: null, levelFilter: "ALL", autoScroll: true };
    expect(filterLogLines(lines, state)).toHaveLength(4);
  });

  it("filters by runId", () => {
    const state: AgentLogsState = { selectedRunId: "run-1", levelFilter: "ALL", autoScroll: true };
    expect(filterLogLines(lines, state)).toHaveLength(2);
    expect(filterLogLines(lines, state).every((l) => l.runId === "run-1")).toBe(true);
  });

  it("filters by level", () => {
    const state: AgentLogsState = { selectedRunId: null, levelFilter: "ERROR", autoScroll: true };
    expect(filterLogLines(lines, state)).toHaveLength(1);
    expect(filterLogLines(lines, state)[0]?.message).toBe("c");
  });

  it("combines run and level filters", () => {
    const state: AgentLogsState = { selectedRunId: "run-2", levelFilter: "INFO", autoScroll: true };
    const result = filterLogLines(lines, state);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe("d");
  });
});

// ── renderLogLine ────────────────────────────────────────────────────────

describe("renderLogLine", () => {
  it("includes timestamp, level badge, and message", () => {
    const line: LogLine = { timestamp: "2026-06-09T13:00:00Z", level: "INFO", message: "hello", runId: "r1" };
    const rendered = renderLogLine(line);
    expect(rendered).toContain("hello");
    expect(rendered).toContain("INFO");
    expect(rendered).toContain("│");
  });

  it("adds red left border for ERROR lines", () => {
    const line: LogLine = { timestamp: "2026-06-09T13:00:00Z", level: "ERROR", message: "oh no", runId: "r1" };
    const rendered = renderLogLine(line);
    expect(rendered).toContain("┃");
    expect(rendered).toContain("ERROR");
  });
});

// ── buildRunTabs ─────────────────────────────────────────────────────────

describe("buildRunTabs", () => {
  it("builds tabs with truncated seed_id labels", () => {
    const runs = [
      { id: "run-1", seed_id: "abcdef1234567890", status: "running" },
      { id: "run-2", seed_id: "12345678abcdef00", status: "completed" },
    ] as Run[];
    const tabs = buildRunTabs(runs);
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.label).toBe("abcdef12");
    expect(tabs[1]?.label).toBe("12345678");
    expect(tabs[0]?.status).toBe("running");
  });
});

// ── statusLed ────────────────────────────────────────────────────────────

describe("statusLed", () => {
  it("returns green for running", () => {
    expect(statusLed("running")).toBe("🟢");
  });

  it("returns red for failed", () => {
    expect(statusLed("failed")).toBe("🔴");
  });

  it("returns fallback for unknown status", () => {
    expect(statusLed("unknown" as Run["status"])).toBe("⚪");
  });
});

// ── cycleLevelFilter ─────────────────────────────────────────────────────

describe("cycleLevelFilter", () => {
  it("cycles ALL → INFO → WARN → ERROR → ALL", () => {
    expect(cycleLevelFilter("ALL")).toBe("INFO");
    expect(cycleLevelFilter("INFO")).toBe("WARN");
    expect(cycleLevelFilter("WARN")).toBe("ERROR");
    expect(cycleLevelFilter("ERROR")).toBe("ALL");
  });
});

// ── selectRunTab ─────────────────────────────────────────────────────────

describe("selectRunTab", () => {
  const tabs: RunTab[] = [
    { runId: "r1", seedId: "s1", label: "s1", status: "running" },
    { runId: "r2", seedId: "s2", label: "s2", status: "completed" },
  ];

  it("moves from All to first tab", () => {
    expect(selectRunTab(tabs, null)).toBe("r1");
  });

  it("moves to next tab", () => {
    expect(selectRunTab(tabs, "r1")).toBe("r2");
  });

  it("wraps from last tab back to All", () => {
    expect(selectRunTab(tabs, "r2")).toBeNull();
  });

  it("returns null for empty tabs", () => {
    expect(selectRunTab([], null)).toBeNull();
  });
});

// ── createInitialState ───────────────────────────────────────────────────

describe("createInitialState", () => {
  it("starts with All tab, ALL level, autoScroll on", () => {
    const state = createInitialState();
    expect(state.selectedRunId).toBeNull();
    expect(state.levelFilter).toBe("ALL");
    expect(state.autoScroll).toBe(true);
  });
});

// ── renderRunTabs ────────────────────────────────────────────────────────

describe("renderRunTabs", () => {
  it("renders All tab and run tabs", () => {
    const tabs: RunTab[] = [
      { runId: "r1", seedId: "s1", label: "abcdef12", status: "running" },
    ];
    const rendered = renderRunTabs(tabs, null);
    expect(rendered).toContain("All");
    expect(rendered).toContain("abcdef12");
  });
});

// ── renderLevelFilter ────────────────────────────────────────────────────

describe("renderLevelFilter", () => {
  it("includes all level options", () => {
    const rendered = renderLevelFilter("ALL");
    expect(rendered).toContain("ALL");
    expect(rendered).toContain("INFO");
    expect(rendered).toContain("WARN");
    expect(rendered).toContain("ERROR");
  });
});

// ── renderAutoScrollToggle ───────────────────────────────────────────────

describe("renderAutoScrollToggle", () => {
  it("shows ON when enabled", () => {
    expect(renderAutoScrollToggle(true)).toContain("ON");
  });

  it("shows OFF when disabled", () => {
    expect(renderAutoScrollToggle(false)).toContain("OFF");
  });
});

// ── renderAgentLogs (integration) ────────────────────────────────────────

describe("renderAgentLogs", () => {
  it("shows empty state when no lines", () => {
    const result = renderAgentLogs({
      tabs: [],
      logLines: [],
      state: createInitialState(),
      terminalHeight: 24,
    });
    expect(result).toContain("No logs yet for this run.");
  });

  it("renders log lines in full output", () => {
    const logLines: LogLine[] = [
      { timestamp: "2026-06-09T01:00:00Z", level: "INFO", message: "test message", runId: "r1" },
      { timestamp: "2026-06-09T01:00:01Z", level: "ERROR", message: "bad thing", runId: "r1" },
    ];
    const result = renderAgentLogs({
      tabs: [{ runId: "r1", seedId: "s1", label: "s1label1", status: "running" }],
      logLines,
      state: createInitialState(),
      terminalHeight: 24,
    });
    expect(result).toContain("test message");
    expect(result).toContain("bad thing");
    expect(result).toContain("┃"); // ERROR border
    expect(result).toContain("quit"); // footer
  });
});
