/**
 * SSE handler for GET /events.
 *
 * Upgrades an HTTP connection to a Server-Sent Events stream.
 * On connect:
 *   1. Sets SSE headers (no buffering).
 *   2. Replays any events missed since Last-Event-ID (using listEventsSince).
 *   3. Subscribes to the EventBroadcaster for live push.
 *   4. Sends keepalive comments every 15 s to prevent proxy timeouts.
 *   5. Cleans up subscription and keepalive on disconnect.
 *
 * Wire format:
 *   id: {seq}\nevent: pipeline-event\ndata: {JSON}\n\n
 *
 * The `id:` field is the bigserial seq (integer), not the UUID.
 * The EventSource API sends `Last-Event-ID: {seq}` on reconnect automatically.
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import type { EventBroadcaster } from "./event-broadcaster.js";
import type { BroadcastEvent } from "./broadcast-event.js";

export interface SseAdapterLike {
  listEventsSince(afterSeq: number, projectId: string | null): Promise<BroadcastEvent[]>;
}

export async function sseHandler(
  req: FastifyRequest,
  res: FastifyReply,
  broadcaster: EventBroadcaster,
  adapter: SseAdapterLike,
  keepaliveMs = 15_000,
): Promise<void> {
  const query = req.query as Record<string, string>;
  const projectId = query.projectId ?? null;

  // Last-Event-ID header (standard SSE reconnect) takes priority over query param.
  const rawHeader = req.headers["last-event-id"];
  const rawSeq = Array.isArray(rawHeader)
    ? rawHeader[0]
    : (rawHeader ?? query.lastEventId);
  const afterSeq = rawSeq ? parseInt(rawSeq, 10) : 0;

  // Set SSE response headers — disable all buffering.
  res.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",  // Nginx proxy: disable buffering
  });
  // Flush headers immediately so the client gets them before any events.
  res.raw.write("");

  const write = (chunk: string): void => {
    if (!res.raw.writableEnded) res.raw.write(chunk);
  };

  // Replay missed events when Last-Event-ID is provided.
  if (afterSeq > 0) {
    try {
      const missed = await adapter.listEventsSince(afterSeq, projectId);
      for (const ev of missed) {
        write(formatSseEvent(ev));
      }
    } catch {
      // Non-fatal — client still gets live events from here on.
    }
  }

  // Subscribe to live events.
  const unsub = broadcaster.subscribe(projectId, (ev) => {
    write(formatSseEvent(ev));
  });

  // Keepalive comment every keepaliveMs to prevent proxy / load-balancer timeouts.
  const keepalive = setInterval(() => write(": keepalive\n\n"), keepaliveMs);

  // Cleanup on disconnect.
  const cleanup = (): void => {
    unsub();
    clearInterval(keepalive);
  };
  req.raw.on("close", cleanup);
  req.raw.on("error", cleanup);

  // Hold the response open until the client disconnects.
  await new Promise<void>((resolve) => req.raw.once("close", resolve));
}

function formatSseEvent(ev: BroadcastEvent): string {
  return `id: ${ev.seq}\nevent: pipeline-event\ndata: ${JSON.stringify(ev)}\n\n`;
}
