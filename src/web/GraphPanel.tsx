import type { ComponentProps } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type NodeProps } from '@xyflow/react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/ui/badge.tsx';
import { cn } from '@/lib/utils.ts';

const tone: Record<string, 'secondary' | 'ready' | 'success' | 'warning' | 'destructive'> = {
  ready: 'ready',
  running: 'ready',
  verifying: 'ready',
  reviewing: 'ready',
  integrating: 'ready',
  done: 'success',
  blocked: 'warning',
  failed: 'destructive',
};

export interface GraphTaskData extends Record<string, unknown> {
  id: string;
  shortId: string;
  title: string;
  repositoryId?: string;
  role: string;
  status: string;
  statusLabel: string;
  /** Фаза и модель работающего агента; нет — никто не работает. */
  live?: string;
}
function TaskNode({ data }: NodeProps) {
  const t = data as GraphTaskData;
  return (
    <div
      className={cn(
        'task-node bg-card flex min-h-(--node-height) w-(--node-width) flex-col items-start gap-3 rounded-md border p-4 shadow-sm',
        t.live && 'border-primary ring-primary/30 ring-4',
        t.status === 'cancelled' && 'opacity-60',
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="text-muted-foreground flex w-full justify-between gap-2 text-xs">
        {/* Короткий id не переносится по дефису: «T-» на одной строке и
            хвост на другой читались как два разных значения. */}
        <span className="shrink-0 whitespace-nowrap" title={t.id}>
          {t.shortId}
        </span>
        <span className="min-w-0 text-right">
          {t.repositoryId} · {t.role}
        </span>
      </div>
      <strong className="text-sm leading-normal">{t.title}</strong>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tone[t.status] ?? 'secondary'}>{t.statusLabel}</Badge>
        {t.live && (
          <span className="text-primary flex items-center gap-1 text-xs font-medium">
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            {t.live}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { task: TaskNode };
export default function GraphPanel(props: ComponentProps<typeof ReactFlow>) {
  return (
    <ReactFlow {...props} nodeTypes={nodeTypes}>
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
