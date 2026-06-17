/**
 * EventFeed.test.ts — Tests for event feed rendering with filters and expansion.
 */

import { describe, it, expect } from "vitest";
import { type WatchState, initialWatchState, type PipelineEventEntry } from "../WatchState.js";
import { computeLayoutSections } from "../WatchLayout.js";
import chalk from "chalk";

describe("Event Feed rendering", () => {
  const mockEvents: PipelineEventEntry[] = [
    {
      id: "evt1",
      eventType: "phase-start",
      runId: "run1",
      details: { seedId: "abc12345", phase: "fix" },
      createdAt: "2026-06-17T01:00:00Z",
      isNew: true,
    },
    {
      id: "evt2",
      eventType: "complete",
      runId: "run1",
      details: { seedId: "abc12345" },
      createdAt: "2026-06-17T01:01:00Z",
      isNew: false,
    },
    {
      id: "evt3",
      eventType: "fail",
      runId: "run2",
      details: { seedId: "def67890" },
      createdAt: "2026-06-17T01:02:00Z",
      isNew: false,
    },
    {
      id: "evt4",
      eventType: "stuck",
      runId: "run3",
      details: { seedId: "ghi11111" },
      createdAt: "2026-06-17T01:03:00Z",
      isNew: false,
    },
    {
      id: "evt5",
      eventType: "guardrail-veto",
      runId: "run4",
      details: { seedId: "jkl22222" },
      createdAt: "2026-06-17T01:04:00Z",
      isNew: false,
    },
    {
      id: "evt6",
      eventType: "heartbeat",
      runId: "run5",
      details: null,
      createdAt: "2026-06-17T01:05:00Z",
      isNew: false,
    },
  ];

  it("shows all events with 'all' filter", () => {
    const state: WatchState = {
      ...initialWatchState(),
      events: {
        events: mockEvents,
        totalCount: 6,
        newestTimestamp: "2026-06-17T01:05:00Z",
        oldestTimestamp: "2026-06-17T01:00:00Z",
      },
      eventFilterMode: "all",
      focusedPanel: "events",
    };

    // Use narrow mode (< 90 cols) to get full-width stacked panels
    const sections = computeLayoutSections(state, 85);
    const eventsSection = sections.find(s => s.panel === "events");
    const output = eventsSection?.lines.join("\n") ?? "";

    // Should show all 6 events
    expect(output).toContain("phase started");
    expect(output).toContain("completed");
    expect(output).toContain("failed");
    expect(output).toContain("stuck");
    expect(output).toContain("guardrail veto");
    expect(output).toContain("heartbeat");
    
    // Should show filter bar with "All" highlighted
    expect(output).toMatch(/\[1\] All/);
  });

  it("filters out heartbeats with 'active' filter", () => {
    const state: WatchState = {
      ...initialWatchState(),
      events: {
        events: mockEvents,
        totalCount: 6,
        newestTimestamp: "2026-06-17T01:05:00Z",
        oldestTimestamp: "2026-06-17T01:00:00Z",
      },
      eventFilterMode: "active",
      focusedPanel: "events",
    };

    const sections = computeLayoutSections(state, 85);
    const eventsSection = sections.find(s => s.panel === "events");
    const output = eventsSection?.lines.join("\n") ?? "";

    // Should show 5 events (all except heartbeat)
    expect(output).toContain("phase started");
    expect(output).toContain("completed");
    expect(output).toContain("failed");
    expect(output).toContain("stuck");
    expect(output).toContain("guardrail veto");
    expect(output).not.toContain("heartbeat");

    // Should show filter bar with "Active" highlighted
    expect(output).toMatch(/\[2\] Active/);
  });

  it("shows only errors with 'errors' filter", () => {
    const state: WatchState = {
      ...initialWatchState(),
      events: {
        events: mockEvents,
        totalCount: 6,
        newestTimestamp: "2026-06-17T01:05:00Z",
        oldestTimestamp: "2026-06-17T01:00:00Z",
      },
      eventFilterMode: "errors",
      focusedPanel: "events",
    };

    const sections = computeLayoutSections(state, 85);
    const eventsSection = sections.find(s => s.panel === "events");
    const output = eventsSection?.lines.join("\n") ?? "";

    // Should show only 3 error events
    expect(output).toContain("failed");
    expect(output).toContain("stuck");
    expect(output).toContain("guardrail veto");
    expect(output).not.toContain("phase started");
    expect(output).not.toContain("completed");
    expect(output).not.toContain("heartbeat");

    // Should show filter bar with "Errors" highlighted
    expect(output).toMatch(/\[3\] Errors/);
  });

  it("uses correct icons for different event types", () => {
    const state: WatchState = {
      ...initialWatchState(),
      events: {
        events: mockEvents.slice(0, 5), // exclude heartbeat for clarity
        totalCount: 5,
        newestTimestamp: "2026-06-17T01:04:00Z",
        oldestTimestamp: "2026-06-17T01:00:00Z",
      },
      eventFilterMode: "all",
      focusedPanel: "events",
    };

    const sections = computeLayoutSections(state, 85);
    const eventsSection = sections.find(s => s.panel === "events");
    const output = eventsSection?.lines.join("\n") ?? "";

    // Check for presence of icons (strip ANSI codes for simpler assertion)
    const plainOutput = output.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainOutput).toContain("▶"); // phase-start
    expect(plainOutput).toContain("✓"); // complete
    expect(plainOutput).toContain("✗"); // fail
    expect(plainOutput).toContain("⚠"); // stuck
    expect(plainOutput).toContain("🛡"); // guardrail-veto
  });

  it("expands raw payload when expandedEventId is set", () => {
    const state: WatchState = {
      ...initialWatchState(),
      events: {
        events: mockEvents.slice(0, 1), // just phase-start
        totalCount: 1,
        newestTimestamp: "2026-06-17T01:00:00Z",
        oldestTimestamp: "2026-06-17T01:00:00Z",
      },
      eventFilterMode: "all",
      focusedPanel: "events",
      expandedEventId: "evt1",
    };

    const sections = computeLayoutSections(state, 85);
    const eventsSection = sections.find(s => s.panel === "events");
    const output = eventsSection?.lines.join("\n") ?? "";

    // Should show expanded JSON payload
    expect(output).toContain('"seedId"');
    expect(output).toContain('"abc12345"');
    expect(output).toContain('"phase"');
    expect(output).toContain('"fix"');
  });

  it("does not expand payload when expandedEventId is null", () => {
    const state: WatchState = {
      ...initialWatchState(),
      events: {
        events: mockEvents.slice(0, 1),
        totalCount: 1,
        newestTimestamp: "2026-06-17T01:00:00Z",
        oldestTimestamp: "2026-06-17T01:00:00Z",
      },
      eventFilterMode: "all",
      focusedPanel: "events",
      expandedEventId: null,
    };

    const sections = computeLayoutSections(state, 85);
    const eventsSection = sections.find(s => s.panel === "events");
    const output = eventsSection?.lines.join("\n") ?? "";

    // Should NOT show JSON keys
    expect(output).not.toContain('"seedId"');
    expect(output).not.toContain('"phase"');
  });

  it("shows human-readable descriptions with truncated seed IDs", () => {
    const state: WatchState = {
      ...initialWatchState(),
      events: {
        events: [
          {
            id: "evt1",
            eventType: "complete",
            runId: "run1",
            details: { seedId: "abc12345-6789-1234-5678-1234567890ab" },
            createdAt: "2026-06-17T01:00:00Z",
            isNew: false,
          },
        ],
        totalCount: 1,
        newestTimestamp: "2026-06-17T01:00:00Z",
        oldestTimestamp: "2026-06-17T01:00:00Z",
      },
      eventFilterMode: "all",
      focusedPanel: "events",
    };

    const sections = computeLayoutSections(state, 85);
    const eventsSection = sections.find(s => s.panel === "events");
    const output = eventsSection?.lines.join("\n") ?? "";

    // Should truncate seed ID to 8 chars
    expect(output).toContain("abc12345");
    expect(output).not.toContain("abc12345-6789-1234-5678-1234567890ab");
  });
});
