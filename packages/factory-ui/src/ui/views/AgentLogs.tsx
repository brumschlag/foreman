import { useRef, useEffect } from "react";
import { useFactoryStore } from "../store/factoryStore";

const LEVEL_COLOR: Record<string, string> = {
  error: "text-[#ef4444]",
  warn:  "text-[#f59e0b]",
  info:  "text-[#6b7280]",
  log:   "text-[#6b7280]",
};

function levelBadge(level: string) {
  const color =
    level === "error" ? "bg-[#ef4444]" :
    level === "warn"  ? "bg-[#f59e0b]" :
    "bg-[#2a2f38]";
  return (
    <span className={`${color} text-[10px] font-mono px-1.5 py-0.5 rounded mr-2 text-gray-200 shrink-0`}>
      {level.toUpperCase().slice(0, 4)}
    </span>
  );
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return iso.slice(11, 19);
  }
}

/** Highlight phase transitions and key events in the message */
function highlightMessage(msg: string): string {
  return msg;
}

function msgColor(msg: string): string {
  if (msg.includes("COMPLETED") || msg.includes("success=true"))  return "text-[#22c55e]";
  if (msg.includes("FAILED") || msg.includes("success=false"))    return "text-[#ef4444]";
  if (msg.includes("[PHASE:") && msg.includes("Starting"))        return "text-[#3b82f6]";
  if (msg.includes("turns=") || msg.includes("cost="))            return "text-[#f59e0b]";
  if (msg.includes("guardrail") || msg.includes("veto"))          return "text-[#ef4444]";
  return "text-gray-300";
}

export function AgentLogs() {
  const logLines = useFactoryStore((s) => s.logLines);
  const runs = useFactoryStore((s) => s.runs);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to top (newest first)
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [logLines.length]);

  const activeRunIds = new Set(runs.map((r) => r.id));

  if (logLines.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-[#6b7280] font-mono text-sm">
        ⬡ No agent log lines yet — waiting for an active run...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-4 mb-3 text-xs text-[#6b7280] font-mono">
        <span>{logLines.length} lines</span>
        {runs.length > 0 && (
          <span className="text-[#f59e0b]">
            {runs.filter(r => r.status === "running").length} active run(s)
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto font-mono text-xs space-y-0.5"
      >
        {logLines.map((line, i) => (
          <div
            key={i}
            className={`flex items-start gap-2 px-2 py-0.5 rounded hover:bg-[#161a1f] ${
              activeRunIds.has(line.runId) ? "" : "opacity-60"
            }`}
          >
            <span className="text-[#6b7280] shrink-0 w-20">{fmtTime(line.ts)}</span>
            {levelBadge(line.level)}
            <span className="text-[#6b7280] shrink-0 w-16 truncate" title={line.runId}>
              {line.runId.slice(0, 8)}
            </span>
            <span className={`flex-1 break-all ${msgColor(line.message)}`}>
              {highlightMessage(line.message)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
