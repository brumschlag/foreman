import { useState } from "react";
import { useFactorySocket } from "./hooks/useFactorySocket";
import { useFactoryStore } from "./store/factoryStore";
import { FloorView } from "./views/FloorView";
import { ShiftBoard } from "./views/ShiftBoard";
import { EventFeed } from "./views/EventFeed";
import { AgentLogs } from "./views/AgentLogs";
import { MetricsView } from "./views/MetricsView";
import { ProcessesView } from "./views/ProcessesView";
import { TasksView } from "./views/TasksView";

type Tab = "floor" | "board" | "feed" | "logs" | "metrics" | "processes" | "tasks";

const TABS: { id: Tab; label: string }[] = [
  { id: "floor",     label: "⬡ Factory Floor" },
  { id: "board",     label: "⬡ Shift Board" },
  { id: "feed",      label: "⬡ Event Feed" },
  { id: "logs",      label: "⬡ Agent Logs" },
  { id: "metrics",   label: "⬡ Metrics" },
  { id: "processes", label: "⚙ Processes" },
  { id: "tasks",     label: "⬡ Tasks" },
];

function ConnectionBadge() {
  const status = useFactoryStore((s) => s.connectionStatus);
  const projectId = useFactoryStore((s) => s.projectId);
  const runs = useFactoryStore((s) => s.runs);
  const events = useFactoryStore((s) => s.events);
  const logLines = useFactoryStore((s) => s.logLines);
  const stats = useFactoryStore((s) => s.stats);

  const color =
    status === "connected"    ? "bg-[#22c55e]" :
    status === "disconnected" ? "bg-[#ef4444]" :
                                "bg-[#f59e0b]";
  const ledClass =
    status === "connected"    ? "led-running" :
    status === "disconnected" ? "led-failed" : "";

  return (
    <div className="flex items-center gap-4 text-sm text-[#6b7280]">
      <div className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${color} ${ledClass}`} />
        <span className={status === "connected" ? "text-[#22c55e]" : status === "disconnected" ? "text-[#ef4444]" : "text-[#f59e0b]"}>
          {status}
        </span>
      </div>
      {projectId && (
        <span className="font-mono text-xs opacity-50">{projectId.slice(0, 8)}</span>
      )}
      <span>{runs.length} runs</span>
      <span>{events.length} events</span>
      <span>{logLines.length} log lines</span>
      {stats && (stats.costUsd24h ?? 0) > 0 && (
        <span>
          <span className="text-[#f59e0b] font-mono">${(stats.costUsd24h ?? 0).toFixed(2)}</span>
          {" today"}
        </span>
      )}
    </div>
  );
}

function Clock() {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  useState(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  });
  return <span className="font-mono text-xs text-[#6b7280]">{time}</span>;
}

export function App() {
  useFactorySocket();
  const [tab, setTab] = useState<Tab>("floor");

  return (
    <div className="min-h-screen flex flex-col bg-[#0d0f12] text-gray-200">
      {/* Top bar */}
      <header className="border-b border-[#2a2f38] px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-6">
          <h1 className="font-bold tracking-widest text-[#f59e0b] uppercase text-sm">
            ⬡ FOREMAN DARK FACTORY
          </h1>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-3 py-1.5 rounded text-xs font-mono transition-colors ${
                  tab === t.id
                    ? "bg-[#2a2f38] text-[#f59e0b]"
                    : "text-[#6b7280] hover:text-gray-300 hover:bg-[#161a1f]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-6">
          <ConnectionBadge />
          <Clock />
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-6">
        {tab === "floor"     && <FloorView />}
        {tab === "board"     && <ShiftBoard />}
        {tab === "feed"      && <EventFeed />}
        {tab === "logs"      && <AgentLogs />}
        {tab === "metrics"   && <MetricsView />}
        {tab === "processes" && <ProcessesView />}
        {tab === "tasks"     && <TasksView />}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#1a1a1a] bg-[#0a0a0a] px-4 py-2">
        <div className="flex justify-between text-[#4b5563] text-xs">
          <span>⬡ Foreman Dark Factory</span>
          <span>2026 — brumschlag/foreman</span>
        </div>
      </footer>
    </div>
  );
}
