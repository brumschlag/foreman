import { useState } from "react";
import { useFactorySocket } from "./hooks/useFactorySocket";
import { useFactoryStore } from "./store/factoryStore";
import { FloorView } from "./views/FloorView";
import { ShiftBoard } from "./views/ShiftBoard";
import { EventFeed } from "./views/EventFeed";
import { MetricsView } from "./views/MetricsView";

type Tab = "floor" | "board" | "feed" | "metrics";

const TABS: { id: Tab; label: string }[] = [
  { id: "floor",   label: "⬡ Factory Floor" },
  { id: "board",   label: "⬡ Shift Board" },
  { id: "feed",    label: "⬡ Event Feed" },
  { id: "metrics", label: "⬡ Metrics" },
];

function ConnectionBadge() {
  const status = useFactoryStore((s) => s.connectionStatus);
  const projectId = useFactoryStore((s) => s.projectId);
  const runs = useFactoryStore((s) => s.runs);
  const events = useFactoryStore((s) => s.events);

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
        {tab === "floor"   && <FloorView />}
        {tab === "board"   && <ShiftBoard />}
        {tab === "feed"    && <EventFeed />}
        {tab === "metrics" && <MetricsView />}
      </main>
    </div>
  );
}
