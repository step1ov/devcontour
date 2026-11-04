import { useEffect, useState, type ComponentProps, type CSSProperties } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Badge } from '@/ui/badge.tsx';
import { cn } from '@/lib/utils.ts';
import type { StatusTone } from './status.ts';
import { badgeOf, flashOf } from './status.ts';

export interface GraphTaskData extends Record<string, unknown> {
  id: string;
  shortId: string;
  title: string;
  repositoryId?: string;
  role: string;
  status: string;
  statusLabel: string;
  tone: StatusTone;
  /** Фаза и модель работающего агента; нет — никто не работает. */
  live?: string;
  /** Задача держит приёмку: от неё ждут остальные. */
  holds?: boolean;
  /** Статус сменился с прошлого опроса: короткий след на узле. */
  changed?: boolean;
}
function TaskNode({ data }: NodeProps) {
  const t = data as GraphTaskData;
  return (
    <div
      className={cn(
        'task-node bg-card flex min-h-(--node-height) w-(--node-width) flex-col items-start gap-1 rounded-md border px-3 py-2.5',
        // Ожидание зависимостей — норма, а не тревога: пунктир вместо цвета.
        t.tone === 'waiting' && 'border-control border-dashed',
        t.holds && 'border-info',
        t.status === 'cancelled' && 'opacity-60',
      )}
      data-changed={t.changed || undefined}
      style={t.changed ? ({ '--flash': flashOf[t.tone] } as CSSProperties) : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <strong className="line-clamp-2 text-sm leading-[1.125rem] font-semibold">{t.title}</strong>
      <div className="text-muted-foreground flex w-full min-w-0 justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">
          {t.role} · {t.repositoryId}
        </span>
        {/* Короткий id не переносится по дефису: «T-» на одной строке и
            хвост на другой читались как два разных значения. */}
        <span className="shrink-0 font-mono whitespace-nowrap" title={t.id}>
          {t.shortId}
        </span>
      </div>
      <div className="mt-auto flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={badgeOf[t.tone]}>{t.statusLabel}</Badge>
        {t.live && (
          <span className="text-info min-w-0 truncate text-xs font-medium" title={t.live}>
            ● {t.live}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { task: TaskNode };
export default function GraphPanel({
  nodes: input = [],
  ...props
}: ComponentProps<typeof ReactFlow>) {
  // Узлы приходят новыми объектами с каждым опросом. Замеренный размер узла
  // переносится из прежнего состояния: без него React Flow прятал узлы
  // (`visibility: hidden`) до повторного замера, и граф пустел посреди работы.
  const [nodes, setNodes] = useState<Node[]>(input);
  useEffect(() => {
    setNodes((prev) => {
      const known = new Map(prev.map((n) => [n.id, n]));
      return input.map((n) => ({ ...n, measured: n.measured ?? known.get(n.id)?.measured }));
    });
  }, [input]);
  return (
    <ReactFlow
      {...props}
      nodes={nodes}
      onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
      nodeTypes={nodeTypes}
    >
      <Background />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}
