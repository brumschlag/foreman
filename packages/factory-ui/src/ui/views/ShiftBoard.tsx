import { useFactoryStore } from '../store/factoryStore';
import type { TaskRow } from '../store/factoryStore';

type Column = 'backlog' | 'ready' | 'in-progress' | 'review' | 'closed';
const COLUMNS: Column[] = ['backlog', 'ready', 'in-progress', 'review', 'closed'];

const ATTENTION_STATUSES = new Set(['conflict', 'failed', 'stuck']);

function mapToColumn(status: string): Column {
  if (status === 'backlog')     return 'backlog';
  if (status === 'ready')       return 'ready';
  if (status === 'in-progress' || status === 'in_progress' || status === 'running') return 'in-progress';
  if (status === 'review')      return 'review';
  if (status === 'closed' || status === 'done' || status === 'merged' || status === 'success') return 'closed';
  return 'backlog';
}

function priorityBadge(p: number): string {
  if (p === 0) return 'bg-[#ef4444]/20 text-[#ef4444]';
  if (p === 1) return 'bg-[#f97316]/20 text-[#f97316]';
  if (p === 2) return 'bg-[#eab308]/20 text-[#eab308]';
  return 'bg-[#6b7280]/20 text-[#6b7280]';
}

function typeBadge(type: string): string {
  if (type === 'bug')     return 'bg-[#ef4444]/20 text-[#ef4444]';
  if (type === 'feature') return 'bg-[#3b82f6]/20 text-[#3b82f6]';
  return 'bg-[#6b7280]/20 text-[#6b7280]';
}

function TaskCard({ task }: { task: TaskRow }) {
  const needsAttention = ATTENTION_STATUSES.has(task.status);
  return (
    <div className={`bg-[#0d0f12] rounded p-3 flex flex-col gap-1.5 border ${needsAttention ? 'border-[#f59e0b]' : 'border-[#2a2f38]'}`}>
      <div className="flex gap-1.5 flex-wrap">
        <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${priorityBadge(task.priority)}`}>
          P{task.priority}
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${typeBadge(task.type)}`}>
          {task.type}
        </span>
      </div>
      <div className="text-sm text-white leading-snug" title={task.title}>
        {task.title.length > 60 ? task.title.slice(0, 60) + '…' : task.title}
      </div>
      <div className="text-xs text-[#6b7280]">{task.status}</div>
    </div>
  );
}

function KanbanColumn({ col, tasks }: { col: Column; tasks: TaskRow[] }) {
  return (
    <div className="flex flex-col gap-2 min-w-[180px] flex-1">
      <div className="flex items-center gap-2 px-1">
        <span className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider">{col}</span>
        <span className="text-xs bg-[#2a2f38] text-[#6b7280] px-1.5 py-0.5 rounded-full">{tasks.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {tasks.map((t) => <TaskCard key={t.id} task={t} />)}
        {tasks.length === 0 && (
          <div className="text-xs text-[#2a2f38] text-center py-4 border border-dashed border-[#2a2f38] rounded">
            empty
          </div>
        )}
      </div>
    </div>
  );
}

export function ShiftBoard() {
  const tasks = useFactoryStore((s) => s.tasks);

  const grouped = COLUMNS.reduce<Record<Column, TaskRow[]>>((acc, col) => {
    acc[col] = [];
    return acc;
  }, {} as Record<Column, TaskRow[]>);

  for (const task of tasks) {
    grouped[mapToColumn(task.status)].push(task);
  }

  return (
    <div className="p-4 flex gap-4 overflow-x-auto h-full">
      {COLUMNS.map((col) => (
        <KanbanColumn key={col} col={col} tasks={grouped[col]} />
      ))}
    </div>
  );
}
