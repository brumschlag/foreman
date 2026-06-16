import { useRef, useEffect } from 'react';
import { useFactoryStore } from '../store/factoryStore';
import type { BroadcastEvent } from '../store/factoryStore';

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toTimeString().slice(0, 8);
  } catch {
    return '??:??:??';
  }
}

function eventBadgeClass(eventType: string): string {
  if (eventType === 'phase-start' || eventType === 'phase-complete')
    return 'bg-[#3b82f6]/20 text-[#3b82f6]';
  if (eventType === 'guardrail-veto' || eventType === 'guardrail-corrected')
    return 'bg-[#ef4444]/20 text-[#ef4444]';
  if (eventType === 'complete' || eventType === 'merge')
    return 'bg-[#22c55e]/20 text-[#22c55e]';
  if (eventType === 'fail' || eventType === 'stuck' || eventType === 'conflict')
    return 'bg-[#ef4444]/20 text-[#ef4444]';
  if (eventType.startsWith('sentinel-'))
    return 'bg-[#a855f7]/20 text-[#a855f7]';
  if (eventType === 'heartbeat')
    return 'bg-[#6b7280]/10 text-[#6b7280]';
  if (eventType === 'dispatch' || eventType === 'claim' || eventType === 'run:queued')
    return 'bg-[#f59e0b]/20 text-[#f59e0b]';
  return 'bg-[#6b7280]/20 text-[#6b7280]';
}

function payloadSummary(payload: Record<string, unknown> | null): string {
  if (!payload) return '';
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined) continue;
    pairs.push(`${k}=${String(v)}`);
    if (pairs.length >= 2) break;
  }
  const joined = pairs.join(' ');
  return joined.length > 80 ? joined.slice(0, 80) + '…' : joined;
}

function EventRow({ ev }: { ev: BroadcastEvent }) {
  const summary = payloadSummary(ev.payload);
  return (
    <div className="flex items-baseline gap-3 px-4 py-2 border-b border-[#2a2f38]/50 hover:bg-[#161a1f] text-xs font-mono">
      <span className="text-[#6b7280] flex-shrink-0 w-20">{formatTime(ev.createdAt)}</span>
      <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-xs ${eventBadgeClass(ev.eventType)}`}>
        {ev.eventType}
      </span>
      {ev.runId && (
        <span className="text-[#3b82f6] flex-shrink-0">{ev.runId.slice(0, 8)}</span>
      )}
      {summary && (
        <span className="text-[#6b7280] truncate">{summary}</span>
      )}
    </div>
  );
}

export function EventFeed() {
  const events = useFactoryStore((s) => s.events);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(events.length);

  useEffect(() => {
    if (events.length !== prevLenRef.current) {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      prevLenRef.current = events.length;
    }
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#6b7280] text-lg">
        ⬡ Waiting for events...
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      {events.map((ev) => (
        <EventRow key={ev.id} ev={ev} />
      ))}
    </div>
  );
}
