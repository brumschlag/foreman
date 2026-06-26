/**
 * Tests for EventBroadcaster wiring in PostgresAdapter.recordPipelineEvent
 * and the new listEventsSince method.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PostgresAdapter } from "../../lib/db/postgres-adapter.js";
import { initPool, destroyPool, type PoolLike } from "../../lib/db/pool-manager.js";
import type { BroadcastEvent } from "../broadcast-event.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_ROW = {
  id: "evt-uuid-1",
  project_id: "proj-1",
  run_id: "run-1",
  task_id: null,
  event_type: "phase-start",
  payload: { phase: "explorer" },
  created_at: "2026-01-01T00:00:00.000Z",
  seq: 42,
};

function makeInsertPool(): PoolLike {
  return {
    query: vi.fn(async () => ({ rows: [FAKE_ROW] as never, rowCount: 1 })),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
}

function makeCapturePool(
  onQuery: (text: string, params?: unknown[]) => { rows: unknown[]; rowCount: number },
): PoolLike {
  return {
    query: vi.fn(async (text: string, params?: unknown[]) => onQuery(text, params) as never),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// recordPipelineEvent + broadcaster
// ---------------------------------------------------------------------------

describe("PostgresAdapter.recordPipelineEvent — broadcaster wiring", () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
    initPool({ poolOverride: makeInsertPool() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    destroyPool();
  });

  it("calls broadcaster.publish with mapped fields after INSERT", async () => {
    const broadcaster = { publish: vi.fn() };
    await adapter.recordPipelineEvent(
      { projectId: "proj-1", runId: "run-1", eventType: "phase-start", payload: { phase: "explorer" } },
      broadcaster,
    );
    expect(broadcaster.publish).toHaveBeenCalledOnce();
    const called = broadcaster.publish.mock.calls[0][0] as BroadcastEvent;
    expect(called.id).toBe(FAKE_ROW.id);
    expect(called.seq).toBe(42);
    expect(called.projectId).toBe(FAKE_ROW.project_id);
    expect(called.runId).toBe(FAKE_ROW.run_id);
    expect(called.eventType).toBe(FAKE_ROW.event_type);
  });

  it("does not throw when broadcaster is omitted", async () => {
    await expect(
      adapter.recordPipelineEvent({ projectId: "proj-1", runId: "run-1", eventType: "phase-start" }),
    ).resolves.not.toThrow();
  });

  it("returns the inserted row regardless of broadcaster", async () => {
    const broadcaster = { publish: vi.fn() };
    const row = await adapter.recordPipelineEvent(
      { projectId: "proj-1", runId: "run-1", eventType: "dispatch" },
      broadcaster,
    );
    expect(row.id).toBe(FAKE_ROW.id);
    expect(row.seq).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// listEventsSince
// ---------------------------------------------------------------------------

describe("PostgresAdapter.listEventsSince", () => {
  let adapter: PostgresAdapter;

  afterEach(() => {
    vi.restoreAllMocks();
    destroyPool();
  });

  it("queries events with seq > afterSeq for a given project", async () => {
    const capturedQueries: { text: string; params: unknown[] }[] = [];
    adapter = new PostgresAdapter();
    initPool({
      poolOverride: makeCapturePool((text, params) => {
        capturedQueries.push({ text, params: params ?? [] });
        return { rows: [], rowCount: 0 };
      }),
    });
    await adapter.listEventsSince(10, "proj-1");
    expect(capturedQueries).toHaveLength(1);
    expect(capturedQueries[0].text).toMatch(/seq\s*>\s*\$1/i);
    expect(capturedQueries[0].params).toContain(10);
    expect(capturedQueries[0].params).toContain("proj-1");
  });

  it("queries all projects when projectId is null", async () => {
    const capturedQueries: { text: string; params: unknown[] }[] = [];
    adapter = new PostgresAdapter();
    initPool({
      poolOverride: makeCapturePool((text, params) => {
        capturedQueries.push({ text, params: params ?? [] });
        return { rows: [], rowCount: 0 };
      }),
    });
    await adapter.listEventsSince(5, null);
    expect(capturedQueries).toHaveLength(1);
    expect(capturedQueries[0].text).toMatch(/seq\s*>\s*\$1/i);
    expect(capturedQueries[0].params).not.toContain("proj-1");
  });

  it("maps returned rows to BroadcastEvent shape", async () => {
    adapter = new PostgresAdapter();
    initPool({ poolOverride: makeInsertPool() });
    const events = await adapter.listEventsSince(0, null);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(42);
    expect(events[0].projectId).toBe("proj-1");
    expect(events[0].eventType).toBe("phase-start");
  });
});
