import { useFactoryStore } from '../store/factoryStore';
import type { TaskRow } from '../store/factoryStore';

const ACTIVE_STATUSES = new Set([
  'in-progress', 'explorer', 'developer', 'qa', 'reviewer', 'finalize',
]);

function relativeTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusLedColor(status: string): string {
  if (ACTIVE_STATUSES.has(status)) return 'bg-[#f59e0b]';
  switch (status) {
    case 'ready':           return 'bg-[#3b82f6]';
    case 'backlog':         return 'bg-[#6b7280]';
    case 'failed':
    case 'stuck':
    case 'conflict':        return 'bg-[#ef4444]';
    case 'closed':
    case 'merged':          return 'bg-[#22c55e]';
    default:                return 'bg-[#6b7280]';
  }
}

function priorityBadge(priority: number): { label: string; color: string } {
  switch (priority) {
    case 0:  return { label: 'P0', color: 'bg-[#ef4444]/20 text-[#ef4444]' };
    case 1:  return { label: 'P1', color: 'bg-[#f97316]/20 text-[#f97316]' };
    case 2:  return { label: 'P2', color: 'bg-[#f59e0b]/20 text-[#f59e0b]' };
    case 3:  return { label: 'P3', color: 'bg-[#3b82f6]/20 text-[#3b82f6]' };
    default: return { label: `P${priority}`, color: 'bg-[#6b7280]/20 text-[#6b7280]' };
  }
}

interface Group {
  label: string;
  tasks: TaskRow[];
}

function groupTasks(tasks: TaskRow[]): Group[] {
  const active   = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  const ready    = tasks.filter((t) => t.status === 'ready');
  const backlog  = tasks.filter((t) => t.status === 'backlog');
  const failed   = tasks.filter((t) => t.status === 'failed' || t.status === 'stuck' || t.status === 'conflict');
  const closed   = tasks.filter((t) => t.status === 'closed' || t.status === 'merged');

  const sortByPriority = (a: TaskRow, b: TaskRow) => a.priority - b.priority;

  return [
    { label: 'ACTIVE',  tasks: active.sort(sortByPriority) },
    { label: 'READY',   tasks: ready.sort(sortByPriority) },
    { label: 'BACKLOG', tasks: backlog.sort(sortByPriority) },
    { label: 'FAILED',  tasks: failed.sort(sortByPriority) },
    { label: 'CLOSED',  tasks: closed.sort(sortByPriority) },
  ].filter((g) => g.tasks.length > 0);
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1f2428] animate-pulse">
      <div className="w-2.5 h-2.5 rounded-full bg-[#2a2f38] flex-shrink-0" />
      <div className="h-3 bg-[#2a2f38] rounded w-12 flex-shrink-0" />
      <div className="h-3 bg-[#2a2f38] rounded flex-1" />
      <div className="h-3 bg-[#2a2f38] rounded w-16 flex-shrink-0" />
      <div className="h-3 bg-[#2a2f38] rounded w-16 flex-shrink-0" />
    </div>
  );
}

function TaskRowItem({ task }: { task: TaskRow }) {
  const led = statusLedColor(task.status);
  const p = priorityBadge(task.priority);
  const title = task.title.length > 60 ? task.title.slice(0, 60) + '…' : task.title;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1f2428] hover:bg-[#1a1f26] transition-colors text-sm">
      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${led}`} />
      <span className={`text-xs px-1.5 py-0.5 rounded font-mono font-semibold flex-shrink-0 ${p.color}`}>
        {p.label}
      </span>
      <span className="text-[#e5e7eb] flex-1 truncate" title={task.title}>{title}</span>
      <span className="text-xs text-[#6b7280] flex-shrink-0 w-20 text-right">{task.type}</span>
      <span className="text-xs text-[#6b7280] flex-shrink-0 w-20 text-right font-mono">
        {relativeTime(task.createdAt)}
      </span>
    </div>
  );
}

export function TasksView() {
  const tasks = useFactoryStore((s) => s.tasks);

  if (tasks.length === 0) {
    return (
      <div className="p-4 flex flex-col gap-2">
        {/* Show skeletons until first snapshot */}
        <div className="bg-[#161a1f] border border-[#2a2f38] rounded-lg overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)}
        </div>
      </div>
    );
  }

  const groups = groupTasks(tasks);

  return (
    <div className="p-4 flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.label} className="bg-[#161a1f] border border-[#2a2f38] rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-[#2a2f38] flex items-center gap-2">
            <span className="text-xs text-[#6b7280] uppercase tracking-wider font-semibold">
              {group.label}
            </span>
            <span className="text-xs text-[#6b7280]">{group.tasks.length}</span>
          </div>
          {group.tasks.map((task) => (
            <TaskRowItem key={task.id} task={task} />
          ))}
        </div>
      ))}
    </div>
  );
}
