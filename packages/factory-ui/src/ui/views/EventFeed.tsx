import { useRef, useEffect, useState } from 'react';
import { useFactoryStore } from '../store/factoryStore';
import type { BroadcastEvent } from '../store/factoryStore';

// ── Filter types ──────────────────────────────────────────────────────────

type FilterMode = 'all' | 'active' | 'errors';

const ERROR_TYPES = new Set(['fail', 'stuck', 'guardrail-veto', 'conflict']);

function matchesFilter(ev: BroadcastEvent, filter: FilterMode): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return ev.eventType !== 'heartbeat';
  return ERROR_TYPES.has(ev.eventType);
}

// ── Relative timestamp ───────────────────────────────────────────────────

function relativeTime(iso: string): string {
  try {
    const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return '??';
  }
}

// ── Badge colors per event type ──────────────────────────────────────────

function eventBadgeClass(eventType: string): string {
  if (eventType === 'phase-start')
    return 'bg-[#3b82f6]/20 text-[#3b82f6]';
  if (eventType === 'phase-complete' || eventType === 'complete' || eventType === 'merge')
    return 'bg-[#22c55e]/20 text-[#22c55e]';
  if (eventType === 'fail' || eventType === 'stuck' || eventType === 'conflict')
    return 'bg-[#ef4444]/20 text-[#ef4444]';
  if (eventType === 'guardrail-veto' || eventType === 'guardrail-corrected')
    return 'bg-[#f59e0b]/20 text-[#f59e0b]';
  if (eventType === 'heartbeat')
    return 'bg-[#6b7280]/10 text-[#6b7280]';
  if (eventType.startsWith('sentinel-'))
    return 'bg-[#a855f7]/20 text-[#a855f7]';
  if (eventType === 'dispatch' || eventType === 'claim' || eventType === 'run:queued')
    return 'bg-[#f59e0b]/20 text-[#f59e0b]';
  return 'bg-[#6b7280]/20 text-[#6b7280]';
}

// ── Human-readable description ───────────────────────────────────────────

function describeEvent(ev: BroadcastEvent): string {
  const shortId = ev.runId?.slice(0, 8) ?? '???';
  const phase = (ev.payload?.phase ?? ev.payload?.currentPhase ?? '') as string;

  switch (ev.eventType) {
    case 'phase-start':
      return `▶ ${phase || 'unknown'} phase started for ${shortId}`;
    case 'phase-complete':
      return `✓ ${phase || 'unknown'} phase completed for ${shortId}`;
    case 'complete':
      return `✓ ${shortId} completed`;
    case 'fail':
      return `✗ ${shortId} failed`;
    case 'stuck':
      return `⚠ ${shortId} stuck`;
    case 'guardrail-veto':
      return `🛡 guardrail veto on ${shortId}`;
    case 'guardrail-corrected':
      return `🛡 guardrail corrected on ${shortId}`;
    case 'heartbeat':
      return `♡ heartbeat ${shortId}`;
    case 'dispatch':
      return `→ dispatched ${shortId}`;
    case 'merge':
      return `✓ ${shortId} merged`;
    case 'conflict':
      return `✗ ${shortId} conflict`;
    default:
      return `${ev.eventType} ${shortId}`;
  }
}

// ── Event row ────────────────────────────────────────────────────────────

function EventRow({
  ev,
  expanded,
  onToggle,
}: {
  ev: BroadcastEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        className="w-full flex items-baseline gap-3 px-4 py-2 border-b border-[#2a2f38]/50 hover:bg-[#161a1f] text-xs font-mono cursor-pointer select-none text-left bg-transparent border-0"
        onClick={onToggle}
      >
        <span className="text-[#6b7280] flex-shrink-0 w-16 text-right">
          {relativeTime(ev.createdAt)}
        </span>
        <span
          className={`flex-shrink-0 px-1.5 py-0.5 rounded text-xs ${eventBadgeClass(ev.eventType)}`}
        >
          {ev.eventType}
        </span>
        <span className="text-[#d1d5db] truncate">{describeEvent(ev)}</span>
      </button>
      {expanded && ev.payload && (
        <pre className="bg-[#161a1f] text-[#6b7280] text-xs p-3 mx-4 mb-1 rounded overflow-x-auto">
          {JSON.stringify(ev.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Filter bar ───────────────────────────────────────────────────────────

const FILTER_OPTIONS: { key: FilterMode; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'errors', label: 'Errors' },
];

function FilterBar({
  current,
  onChange,
}: {
  current: FilterMode;
  onChange: (f: FilterMode) => void;
}) {
  return (
    <div className="flex gap-1 px-4 py-2 border-b border-[#2a2f38]">
      {FILTER_OPTIONS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            current === key
              ? 'bg-[#2a2f38] text-[#f59e0b]'
              : 'text-[#6b7280] hover:text-gray-300'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export function EventFeed() {
  const events = useFactoryStore((s) => s.events);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(events.length);

  useEffect(() => {
    if (events.length !== prevLenRef.current) {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      prevLenRef.current = events.length;
    }
  }, [events.length]);

  const filtered = events.filter((ev) => matchesFilter(ev, filter));

  if (events.length === 0) {
    return (
      <div className="flex-1 flex flex-col">
        <FilterBar current={filter} onChange={setFilter} />
        <div className="flex-1 flex items-center justify-center text-[#6b7280] text-lg">
          ⬡ Waiting for events...
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <FilterBar current={filter} onChange={setFilter} />
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {filtered.map((ev) => (
          <EventRow
            key={ev.id}
            ev={ev}
            expanded={expandedId === ev.id}
            onToggle={() =>
              setExpandedId((prev) => (prev === ev.id ? null : ev.id))
            }
          />
        ))}
        {filtered.length === 0 && (
          <div className="text-center text-[#6b7280] text-sm py-8">
            No events match this filter.
          </div>
        )}
      </div>
    </div>
  );
}
