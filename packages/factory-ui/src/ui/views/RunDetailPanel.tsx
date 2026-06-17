import { useState, useEffect } from "react";
import { useFactoryStore } from "../store/factoryStore";
import type { BroadcastEvent } from "../store/factoryStore";

interface PhaseEntry {
  name: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
}

function buildPhaseTimeline(events: BroadcastEvent[], runId: string): PhaseEntry[] {
  const phases = new Map<string, PhaseEntry>();
  const relevant = events.filter((e) => e.runId === runId);

  for (const ev of relevant) {
    const payload = ev.payload ?? {};
    const phase = (payload["phase"] ?? payload["phaseName"] ?? payload["name"]) as string | undefined;
    if (!phase) continue;

    if (ev.eventType === "phase-start") {
      phases.set(phase, { name: phase, status: "running", startedAt: ev.createdAt });
    } else if (ev.eventType === "complete" || ev.eventType === "phase-complete") {
      const existing = phases.get(phase);
      if (existing) {
        phases.set(phase, { ...existing, status: "completed", completedAt: ev.createdAt });
      }
    } else if (ev.eventType === "fail") {
      const existing = phases.get(phase);
      if (existing) {
        phases.set(phase, { ...existing, status: "failed", completedAt: ev.createdAt });
      }
    }
  }

  return Array.from(phases.values());
}

function phaseStatusColor(status: PhaseEntry["status"]): string {
  switch (status) {
    case "running":    return "text-[#f59e0b] bg-[#f59e0b]/10";
    case "completed":  return "text-[#22c55e] bg-[#22c55e]/10";
    case "failed":     return "text-[#ef4444] bg-[#ef4444]/10";
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function RunDetailPanel() {
  const selectedRunId = useFactoryStore((s) => s.selectedRunId);
  const setSelectedRunId = useFactoryStore((s) => s.setSelectedRunId);
  const runs = useFactoryStore((s) => s.runs);
  const events = useFactoryStore((s) => s.events);
  const logLines = useFactoryStore((s) => s.logLines);

  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (selectedRunId) {
      // Small delay so CSS transition fires
      const t = setTimeout(() => setVisible(true), 10);
      return () => clearTimeout(t);
    } else {
      setVisible(false);
    }
  }, [selectedRunId]);

  const run = runs.find((r) => r.id === selectedRunId);
  const phases = selectedRunId ? buildPhaseTimeline(events, selectedRunId) : [];
  const runLogs = logLines.filter((l) => l.runId === selectedRunId).slice(0, 20);

  if (!selectedRunId) return null;

  const handleClose = () => {
    setVisible(false);
    setTimeout(() => setSelectedRunId(null), 300);
  };

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/40 z-40 transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        className="fixed top-0 right-0 h-full w-[420px] z-50 flex flex-col bg-[#161a1f] border-l border-[#2a2f38] overflow-hidden transition-transform duration-300"
        style={{ transform: visible ? "translateX(0)" : "translateX(100%)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2f38] shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[#f59e0b] text-xs font-bold uppercase tracking-wider">Run Detail</span>
            <span className="font-mono text-xs text-[#6b7280]">{selectedRunId.slice(0, 8)}</span>
          </div>
          <button
            onClick={handleClose}
            className="text-[#6b7280] hover:text-white transition-colors text-lg leading-none px-1"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Metadata */}
          {run && (
            <div className="px-4 py-3 border-b border-[#2a2f38] flex flex-col gap-1.5 text-xs">
              <div className="flex gap-2">
                <span className="text-[#6b7280] w-20 shrink-0">Branch</span>
                <span className="text-white font-mono truncate">{run.branch}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-[#6b7280] w-20 shrink-0">Agent</span>
                <span className="text-white truncate">{run.agentType ?? "—"}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-[#6b7280] w-20 shrink-0">Status</span>
                <span className="text-white">{run.status}</span>
              </div>
              {run.startedAt && (
                <div className="flex gap-2">
                  <span className="text-[#6b7280] w-20 shrink-0">Started</span>
                  <span className="text-white">{relativeTime(run.startedAt)}</span>
                </div>
              )}
            </div>
          )}

          {/* Phase Timeline */}
          <div className="px-4 py-3 border-b border-[#2a2f38]">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider font-semibold mb-2">Phase Timeline</div>
            {phases.length === 0 ? (
              <div className="text-xs text-[#4b5563]">No phase events yet</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {phases.map((p) => (
                  <div key={p.name} className="flex items-center gap-2 text-xs">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${phaseStatusColor(p.status)}`}>
                      {p.status}
                    </span>
                    <span className="text-white font-mono">{p.name}</span>
                    <span className="text-[#4b5563] ml-auto">{relativeTime(p.startedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Phase Costs */}
          {(() => {
            const costRegex = /\[PHASE:\s*(\w+)\]\s*COMPLETED\s*\(\$([0-9.]+)\)/;
            const phaseCosts: { phase: string; cost: number }[] = [];
            for (const l of runLogs) {
              const m = l.message.match(costRegex);
              if (m) phaseCosts.push({ phase: m[1], cost: parseFloat(m[2]) });
            }
            const total = phaseCosts.reduce((s, p) => s + p.cost, 0);
            return (
              <div className="px-4 py-3 border-b border-[#2a2f38]">
                <div className="text-xs text-[#6b7280] uppercase tracking-wider font-semibold mb-2">Phase Costs</div>
                {phaseCosts.length === 0 ? (
                  <div className="text-xs text-[#4b5563]">No phase cost data yet</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {phaseCosts.map((p) => (
                      <div key={p.phase} className="flex justify-between text-xs">
                        <span className="text-[#9ca3af] font-mono">{p.phase}</span>
                        <span className="text-white font-mono">${p.cost.toFixed(4)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between text-xs border-t border-[#2a2f38] mt-1 pt-1">
                      <span className="text-[#6b7280] font-semibold">TOTAL</span>
                      <span className="text-[#f59e0b] font-mono font-semibold">${total.toFixed(4)}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Log Lines */}
          <div className="px-4 py-3">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider font-semibold mb-2">
              Recent Logs {runLogs.length > 0 && <span className="font-normal normal-case">({runLogs.length})</span>}
            </div>
            {runLogs.length === 0 ? (
              <div className="text-xs text-[#4b5563]">No log lines for this run</div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {runLogs.map((l, i) => (
                  <div key={i} className="flex gap-2 text-[11px] font-mono leading-relaxed">
                    <span className="text-[#4b5563] shrink-0 w-16 text-right">
                      {new Date(l.ts).toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span className={
                      l.level === "error" ? "text-[#ef4444]" :
                      l.level === "warn"  ? "text-[#f59e0b]" :
                                            "text-[#9ca3af]"
                    }>
                      {l.message.slice(0, 120)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
