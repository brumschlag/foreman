import { describe, it, expect, vi } from "vitest";
import { EventBroadcaster } from "../event-broadcaster.js";
import type { BroadcastEvent } from "../broadcast-event.js";

const makeEvent = (overrides?: Partial<BroadcastEvent>): BroadcastEvent => ({
  id: "uuid-1",
  seq: 1,
  projectId: "proj-1",
  runId: "run-1",
  taskId: null,
  eventType: "phase-start",
  payload: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("EventBroadcaster", () => {
  it("delivers event to subscriber for matching project", () => {
    const bc = new EventBroadcaster();
    const handler = vi.fn();
    bc.subscribe("proj-1", handler);
    bc.publish(makeEvent({ projectId: "proj-1" }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not deliver to subscriber for different project", () => {
    const bc = new EventBroadcaster();
    const handler = vi.fn();
    bc.subscribe("proj-2", handler);
    bc.publish(makeEvent({ projectId: "proj-1" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("wildcard subscriber (null) receives all events", () => {
    const bc = new EventBroadcaster();
    const handler = vi.fn();
    bc.subscribe(null, handler);
    bc.publish(makeEvent({ projectId: "proj-1" }));
    bc.publish(makeEvent({ projectId: "proj-2" }));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe stops delivery", () => {
    const bc = new EventBroadcaster();
    const handler = vi.fn();
    const unsub = bc.subscribe("proj-1", handler);
    unsub();
    bc.publish(makeEvent({ projectId: "proj-1" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("publish does not throw with no subscribers", () => {
    const bc = new EventBroadcaster();
    expect(() => bc.publish(makeEvent())).not.toThrow();
  });

  it("subscriberCount reflects live subscriptions", () => {
    const bc = new EventBroadcaster();
    const unsub1 = bc.subscribe("proj-1", vi.fn());
    const unsub2 = bc.subscribe(null, vi.fn());
    expect(bc.subscriberCount).toBe(2);
    unsub1();
    expect(bc.subscriberCount).toBe(1);
    unsub2();
    expect(bc.subscriberCount).toBe(0);
  });

  it("multiple subscribers for same project all receive event", () => {
    const bc = new EventBroadcaster();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bc.subscribe("proj-1", h1);
    bc.subscribe("proj-1", h2);
    bc.publish(makeEvent({ projectId: "proj-1" }));
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("wildcard and project-scoped subscribers both receive event", () => {
    const bc = new EventBroadcaster();
    const wildcard = vi.fn();
    const scoped = vi.fn();
    bc.subscribe(null, wildcard);
    bc.subscribe("proj-1", scoped);
    bc.publish(makeEvent({ projectId: "proj-1" }));
    expect(wildcard).toHaveBeenCalledOnce();
    expect(scoped).toHaveBeenCalledOnce();
  });

  it("handler receives the exact event object published", () => {
    const bc = new EventBroadcaster();
    const received: BroadcastEvent[] = [];
    bc.subscribe("proj-1", (e) => received.push(e));
    const ev = makeEvent({ seq: 42, eventType: "phase-complete" });
    bc.publish(ev);
    expect(received[0]).toBe(ev);
  });
});
