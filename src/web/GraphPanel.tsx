import type { ComponentProps } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type NodeProps } from '@xyflow/react';

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
    <div className={`task-node node-${t.status}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-meta">
        <span title={t.id}>{t.shortId}</span>
        <span>
          {t.repositoryId} · {t.role}
        </span>
      </div>
      <strong>{t.title}</strong>
      <span className={`badge badge-${t.status}`}>{t.statusLabel}</span>
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
