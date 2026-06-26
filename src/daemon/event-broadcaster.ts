/**
 * EventBroadcaster — in-process pub/sub for pipeline events.
 *
 * recordPipelineEvent() calls broadcaster.publish() after every INSERT.
 * The SSE handler calls broadcaster.subscribe() on connect and the returned
 * unsubscribe function on disconnect.
 *
 * Design:
 * - subscribe(projectId, handler): scoped to one project
 * - subscribe(null, handler):      wildcard — receives ALL events
 * - publish(event): synchronous fan-out, no EventEmitter overhead
 */
import type { BroadcastEvent } from "./broadcast-event.js";

export type { BroadcastEvent };

type Handler = (event: BroadcastEvent) => void;

export class EventBroadcaster {
  // null key = wildcard (all projects)
  private readonly subs = new Map<string | null, Set<Handler>>();

  /**
   * Subscribe to events for a specific project (or all projects with null).
   * Returns an unsubscribe function — call it on client disconnect.
   */
  subscribe(projectId: string | null, handler: Handler): () => void {
    let set = this.subs.get(projectId);
    if (!set) {
      set = new Set();
      this.subs.set(projectId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.subs.delete(projectId);
    };
  }

  /**
   * Publish an event to all matching subscribers.
   * Called synchronously by recordPipelineEvent after every INSERT.
   */
  publish(event: BroadcastEvent): void {
    this.subs.get(event.projectId)?.forEach((h) => h(event));
    this.subs.get(null)?.forEach((h) => h(event));
  }

  /** Total number of active subscriptions (useful for tests and metrics). */
  get subscriberCount(): number {
    let n = 0;
    this.subs.forEach((set) => { n += set.size; });
    return n;
  }
}

/** Daemon singleton — shared across all SSE connections. */
export const eventBroadcaster = new EventBroadcaster();
