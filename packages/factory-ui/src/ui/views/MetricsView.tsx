import { useFactoryStore } from '../store/factoryStore';
import type { ProjectStats } from '../store/factoryStore';

interface MetricCardProps {
  label: string;
  value: number;
  accent: string;
}

function MetricCard({ label, value, accent }: MetricCardProps) {
  return (
    <div className="bg-[#161a1f] border border-[#2a2f38] rounded-lg p-5 flex flex-col gap-2">
      <span className="text-xs text-[#6b7280] uppercase tracking-wider font-semibold">{label}</span>
      <span className={`text-4xl font-bold ${accent}`}>{value}</span>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-[#161a1f] border border-[#2a2f38] rounded-lg p-5 flex flex-col gap-2 animate-pulse">
      <div className="h-3 bg-[#2a2f38] rounded w-24" />
      <div className="h-9 bg-[#2a2f38] rounded w-16 mt-1" />
    </div>
  );
}

interface BreakdownBarProps {
  tasks: ProjectStats['tasks'];
}

interface Segment {
  key: keyof ProjectStats['tasks'];
  color: string;
  label: string;
}

const SEGMENTS: Segment[] = [
  { key: 'backlog',    color: 'bg-[#6b7280]', label: 'backlog' },
  { key: 'ready',      color: 'bg-[#3b82f6]', label: 'ready' },
  { key: 'inProgress', color: 'bg-[#f59e0b]', label: 'in-progress' },
  { key: 'review',     color: 'bg-[#a855f7]', label: 'review' },
  { key: 'closed',     color: 'bg-[#22c55e]', label: 'closed' },
];

function BreakdownBar({ tasks }: BreakdownBarProps) {
  const total = tasks.total || 1;

  return (
    <div className="bg-[#161a1f] border border-[#2a2f38] rounded-lg p-4 flex flex-col gap-3">
      <span className="text-xs text-[#6b7280] uppercase tracking-wider font-semibold">Task Status Breakdown</span>
      <div className="flex h-6 rounded overflow-hidden gap-px">
        {SEGMENTS.map(({ key, color, label }) => {
          const count = tasks[key] as number;
          if (count === 0) return null;
          const pct = (count / total) * 100;
          return (
            <div
              key={key}
              className={`${color} flex items-center justify-center text-[10px] text-white font-bold overflow-hidden`}
              style={{ width: `${pct}%` }}
              title={`${label}: ${count}`}
            >
              {count}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3">
        {SEGMENTS.map(({ key, color, label }) => {
          const count = tasks[key] as number;
          return (
            <div key={key} className="flex items-center gap-1.5 text-xs text-[#6b7280]">
              <span className={`w-2.5 h-2.5 rounded-sm ${color}`} />
              <span>{label}</span>
              <span className="text-white">{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MetricsView() {
  const stats = useFactoryStore((s) => s.stats);

  if (!stats) {
    return (
      <div className="p-4 flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <div className="bg-[#161a1f] border border-[#2a2f38] rounded-lg p-5 animate-pulse">
          <div className="h-3 bg-[#2a2f38] rounded w-40 mb-4" />
          <div className="h-6 bg-[#2a2f38] rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <MetricCard label="Active Runs"      value={stats.activeRuns}        accent="text-[#f59e0b]" />
        <MetricCard label="Tasks In Progress" value={stats.tasks.inProgress}  accent="text-[#3b82f6]" />
        <MetricCard label="Tasks Ready"       value={stats.tasks.ready}       accent="text-[#22c55e]" />
        <MetricCard label="Tasks Total"       value={stats.tasks.total}       accent="text-white" />
      </div>
      <BreakdownBar tasks={stats.tasks} />
    </div>
  );
}
