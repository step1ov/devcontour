import type { ComponentProps } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type NodeProps } from '@xyflow/react';
import { Badge } from '@/ui/badge.tsx';

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
}
function TaskNode({ data }: NodeProps) {
  const t = data as GraphTaskData;
  return (
    <div className="task-node bg-card flex min-h-(--node-height) w-(--node-width) flex-col items-start gap-3 rounded-md border p-4 shadow-sm">
      <Handle type="target" position={Position.Left} />
      <div className="text-muted-foreground flex w-full justify-between text-xs">
        <span title={t.id}>{t.shortId}</span>
        <span>
          {t.repositoryId} · {t.role}
        </span>
      </div>
      <strong className="text-sm leading-normal">{t.title}</strong>
      <Badge variant={tone[t.status] ?? 'secondary'}>{t.statusLabel}</Badge>
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
