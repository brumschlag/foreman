import { useFactoryStore } from "../store/factoryStore";
import type { ProcessInfo } from "../store/factoryStore";

const ROLE_COLORS: Record<ProcessInfo["role"], string> = {
  daemon:     "text-[#f59e0b]",
  dispatcher: "text-[#3b82f6]",
  worker:     "text-[#22c55e]",
  bridge:     "text-[#a78bfa]",
  vite:       "text-[#6b7280]",
  other:      "text-[#6b7280]",
};

const ROLE_BADGE: Record<ProcessInfo["role"], string> = {
  daemon:     "bg-[#f59e0b]/20 text-[#f59e0b]",
  dispatcher: "bg-[#3b82f6]/20 text-[#3b82f6]",
  worker:     "bg-[#22c55e]/20 text-[#22c55e]",
  bridge:     "bg-[#a78bfa]/20 text-[#a78bfa]",
  vite:       "bg-[#6b7280]/20 text-[#6b7280]",
  other:      "bg-[#6b7280]/20 text-[#6b7280]",
};

const ROLE_ICON: Record<ProcessInfo["role"], string> = {
  daemon:     "⬡",
  dispatcher: "⟳",
  worker:     "⚙",
  bridge:     "⇌",
  vite:       "⚡",
  other:      "·",
};

function ProcessRow({ proc }: { proc: ProcessInfo }) {
  return (
    <tr className="border-b border-[#2a2f38] hover:bg-[#161a1f] transition-colors">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${ROLE_COLORS[proc.role]}`}>{ROLE_ICON[proc.role]}</span>
          <div>
            <div className={`font-medium text-sm ${ROLE_COLORS[proc.role]}`}>{proc.label}</div>
            {proc.taskId && (
              <div className="text-xs text-[#6b7280] font-mono mt-0.5">{proc.taskId.slice(0, 12)}…</div>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${ROLE_BADGE[proc.role]}`}>
          {proc.role}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-[#6b7280]">{proc.pid}</td>
      <td className="px-4 py-3 text-xs text-[#6b7280]">{proc.cpu}</td>
      <td className="px-4 py-3 text-xs text-[#6b7280]">{proc.mem}</td>
      <td className="px-4 py-3 text-xs text-[#6b7280]">{proc.elapsed}</td>
      <td className="px-4 py-3 font-mono text-xs text-[#4b5563] truncate max-w-[320px]" title={proc.command}>
        {proc.command}
      </td>
    </tr>
  );
}

export function ProcessesView() {
  const processes = useFactoryStore((s) => s.processes);

  const grouped = {
    daemon:     processes.filter((p) => p.role === "daemon"),
    dispatcher: processes.filter((p) => p.role === "dispatcher"),
    worker:     processes.filter((p) => p.role === "worker"),
    bridge:     processes.filter((p) => p.role === "bridge"),
    vite:       processes.filter((p) => p.role === "vite"),
    other:      processes.filter((p) => p.role === "other"),
  };

  if (processes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#6b7280] text-lg">
        ⬡ No foreman processes detected
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-6">
      {/* Summary chips */}
      <div className="flex items-center gap-3 flex-wrap">
        {(["daemon", "dispatcher", "worker", "bridge", "vite"] as ProcessInfo["role"][]).map((role) => {
          const count = grouped[role].length;
          if (count === 0) return null;
          return (
            <div key={role} className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full border border-[#2a2f38] ${ROLE_COLORS[role]}`}>
              <span>{ROLE_ICON[role]}</span>
              <span className="font-medium">{count}</span>
              <span className="text-[#6b7280] text-xs">{role}{count > 1 ? "s" : ""}</span>
            </div>
          );
        })}
        <div className="ml-auto text-xs text-[#4b5563]">refreshes every 5s</div>
      </div>

      {/* Process table */}
      <div className="rounded-lg border border-[#2a2f38] overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-[#161a1f] text-xs text-[#6b7280] uppercase tracking-wider">
            <tr>
              <th className="px-4 py-2">Process</th>
              <th className="px-4 py-2">Role</th>
              <th className="px-4 py-2">PID</th>
              <th className="px-4 py-2">CPU</th>
              <th className="px-4 py-2">MEM</th>
              <th className="px-4 py-2">Time</th>
              <th className="px-4 py-2">Command</th>
            </tr>
          </thead>
          <tbody>
            {processes.map((proc) => (
              <ProcessRow key={proc.pid} proc={proc} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
