import { useFactoryStore } from '../store/factoryStore';
import type { RunSummary } from '../store/factoryStore';

function statusLed(status: string): string {
  switch (status) {
    case 'running':    return 'bg-[#f59e0b]';
    case 'success':
    case 'merged':     return 'bg-[#22c55e]';
    case 'failed':
    case 'stuck':
    case 'conflict':   return 'bg-[#ef4444]';
    case 'pending':    return 'bg-[#3b82f6]';
    default:           return 'bg-[#6b7280]';
  }
}

function statusBadgeColor(status: string): string {
  switch (status) {
    case 'running':    return 'bg-[#f59e0b]/20 text-[#f59e0b]';
    case 'success':
    case 'merged':     return 'bg-[#22c55e]/20 text-[#22c55e]';
    case 'failed':
    case 'stuck':
    case 'conflict':   return 'bg-[#ef4444]/20 text-[#ef4444]';
    case 'pending':    return 'bg-[#3b82f6]/20 text-[#3b82f6]';
    default:           return 'bg-[#6b7280]/20 text-[#6b7280]';
  }
}

function worktreeSegment(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || null;
}

function RunCard({ run }: { run: RunSummary }) {
  const { progress } = run;
  const segment = worktreeSegment(run.worktreePath);

  return (
    <div className="bg-[#161a1f] border border-[#2a2f38] rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusLed(run.status)}`} />
        <span className="font-mono text-sm text-white">{run.beadId.slice(0, 12)}</span>
        <span className={`ml-auto text-xs px-2 py-0.5 rounded font-medium ${statusBadgeColor(run.status)}`}>
          {run.status}
        </span>
      </div>

      <div className="text-xs text-[#6b7280] truncate" title={run.branch}>
        <span className="text-[#3b82f6]">⎇</span> {run.branch}
      </div>

      {run.agentType && (
        <div className="text-xs text-[#6b7280]">
          agent: <span className="text-white">{run.agentType}</span>
        </div>
      )}

      {progress?.currentPhase && (
        <div className="text-xs text-[#6b7280]">
          phase: <span className="text-[#f59e0b]">{progress.currentPhase}</span>
        </div>
      )}

      {progress && (
        <div className="flex gap-3 text-xs text-[#6b7280]">
          <span>turns: <span className="text-white">{progress.turns}</span></span>
          <span>cost: <span className="text-white">${progress.costUsd.toFixed(3)}</span></span>
        </div>
      )}

      {segment && (
        <div className="text-xs text-[#6b7280] truncate font-mono" title={run.worktreePath ?? undefined}>
          {segment}
        </div>
      )}
    </div>
  );
}

export function FloorView() {
  const runs = useFactoryStore((s) => s.runs);
  const active = runs.filter((r) => r.status === 'running' || r.status === 'pending');

  if (active.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#6b7280] text-lg">
        ⬡ No active runs — factory floor is idle
      </div>
    );
  }

  return (
    <div className="p-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 auto-rows-min">
      {active.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </div>
  );
}
