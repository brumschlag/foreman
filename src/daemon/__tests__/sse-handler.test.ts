/**
 * Tests for sseHandler — GET /events SSE stream.
 *
 * Uses a real HTTP server (Fastify) with a mock broadcaster and mock adapter
 * to exercise the SSE protocol without touching Postgres.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { EventBroadcaster } from "../event-broadcaster.js";
import { sseHandler } from "../sse-handler.js";
import type { BroadcastEvent } from "../broadcast-event.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides?: Partial<BroadcastEvent>): BroadcastEvent {
  return {
    id: "evt-uuid-1",
    seq: 7,
    projectId: "proj-1",
    runId: "run-1",
    taskId: null,
    eventType: "phase-start",
    payload: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Read SSE chunks from a Response body stream until the predicate is satisfied
 * or the timeout fires. Returns the accumulated text.
 */
async function collectSse(
  res: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 1000,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    accumulated += decoder.decode(value, { stream: true });
    if (predicate(accumulated)) break;
  }
  reader.cancel().catch(() => {});
  return accumulated;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let broadcaster: EventBroadcaster;
let mockAdapter: { listEventsSince: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  broadcaster = new EventBroadcaster();
  mockAdapter = { listEventsSince: vi.fn(async () => []) };

  app = Fastify({ logger: false });
  app.get("/events", (req, res) =>
    sseHandler(req, res, broadcaster, mockAdapter as never, 60_000),
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  // Destroy all open connections so SSE handlers unblock before app.close()
  app.server.closeAllConnections?.();
  await app.close();
  vi.restoreAllMocks();
});

function baseUrl(): string {
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected address");
  return `http://127.0.0.1:${addr.port}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sseHandler", () => {
  it("responds with Content-Type text/event-stream", async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl()}/events`, { signal: ac.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    ac.abort();
  });

  it("pushes a published event to the stream", async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl()}/events`, { signal: ac.signal });

    // Give the subscription a tick to register
    await new Promise((r) => setTimeout(r, 50));

    broadcaster.publish(makeEvent({ seq: 42, eventType: "phase-start" }));

    const text = await collectSse(res, (t) => t.includes("pipeline-event"));
    ac.abort();

    expect(text).toContain("event: pipeline-event");
    expect(text).toContain("phase-start");
  });

  it("uses seq as the SSE id field", async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl()}/events`, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 50));

    broadcaster.publish(makeEvent({ seq: 99 }));

    const text = await collectSse(res, (t) => t.includes("id: 99"));
    ac.abort();

    expect(text).toContain("id: 99");
  });

  it("calls listEventsSince with afterSeq from Last-Event-ID header", async () => {
    const ac = new AbortController();
    await fetch(`${baseUrl()}/events`, {
      headers: { "Last-Event-ID": "15" },
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    expect(mockAdapter.listEventsSince).toHaveBeenCalledWith(15, null);
  });

  it("passes projectId query param to listEventsSince and subscription", async () => {
    const ac = new AbortController();
    await fetch(`${baseUrl()}/events?projectId=proj-99&lastEventId=5`, {
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    expect(mockAdapter.listEventsSince).toHaveBeenCalledWith(5, "proj-99");
  });

  it("replays missed events before live push", async () => {
    const missedEvent = makeEvent({ seq: 3, eventType: "dispatch" });
    mockAdapter.listEventsSince.mockResolvedValueOnce([missedEvent]);

    const ac = new AbortController();
    const res = await fetch(`${baseUrl()}/events?lastEventId=2`, {
      signal: ac.signal,
    });

    const text = await collectSse(res, (t) => t.includes("dispatch"));
    ac.abort();

    expect(text).toContain("dispatch");
    expect(text).toContain("id: 3");
  });

  it("does not call listEventsSince when no lastEventId", async () => {
    const ac = new AbortController();
    await fetch(`${baseUrl()}/events`, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    expect(mockAdapter.listEventsSince).not.toHaveBeenCalled();
  });

  it("scoped subscription only receives matching project events", async () => {
    const received: string[] = [];
    const ac = new AbortController();
    const res = await fetch(`${baseUrl()}/events?projectId=proj-A`, {
      signal: ac.signal,
    });

    await new Promise((r) => setTimeout(r, 50));

    broadcaster.publish(makeEvent({ projectId: "proj-B", eventType: "fail" }));
    broadcaster.publish(makeEvent({ projectId: "proj-A", eventType: "complete" }));

    const text = await collectSse(res, (t) => t.includes("complete"), 500);
    ac.abort();

    expect(text).not.toContain("fail");
    expect(text).toContain("complete");
  });
});
