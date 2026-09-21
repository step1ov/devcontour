import { useMemo } from 'react';
import {
  ReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { C4Diagram } from '../core/preparation-model.ts';
import { cn } from '@/lib/utils.ts';

// The class names stay: React Flow styles the node wrapper and the panel's
// tests address elements by them.
const elementTone = {
  person: 'border-(--text-secondary) bg-secondary',
  system: 'border-primary bg-accent',
  'external-system': 'border-(--text-secondary) bg-secondary',
  container: 'border-primary bg-card',
};
const kinds = {
  person: 'Пользователь',
  system: 'Система',
  'external-system': 'Внешняя система',
  container: 'Приложение / хранилище',
};
type ElementData = C4Diagram['nodes'][number] & Record<string, unknown>;
function Element({ data }: NodeProps<Node<ElementData>>) {
  return (
    <div
      className={cn(
        'c4-element min-h-[150px] w-[280px] rounded-md border p-4',
        elementTone[data.kind],
      )}
    >
      <Handle type="target" position={Position.Left} />
      <small className="text-muted-foreground text-xs">{kinds[data.kind]}</small>
      <strong className="block">{data.name}</strong>
      {data.technology && (
        <span className="text-muted-foreground block text-sm">{data.technology}</span>
      )}
      <p className="mt-2 text-sm">{data.description}</p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
function Relationship(props: EdgeProps) {
  const [path, x, y] = getSmoothStepPath(props);
  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} />
      <EdgeLabelRenderer>
        <div
          className="c4-edge-label bg-card absolute z-[2] max-w-[150px] rounded-sm px-2 py-1 text-center text-xs leading-tight break-words"
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        >
          {props.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { relationship: Relationship };
const nodeTypes = { element: Element };
export default function C4Panel({
  diagram,
  level,
  systemName,
}: {
  diagram: C4Diagram;
  level: 1 | 2;
  systemName: string;
}) {
  const nodes = useMemo(() => {
    const result: Node[] = [];
    const people = diagram.nodes.filter((n) => n.kind === 'person');
    const internal = diagram.nodes.filter((n) => n.kind === (level === 1 ? 'system' : 'container'));
    const external = diagram.nodes.filter((n) => n.kind === 'external-system');
    if (level === 2)
      result.push({
        id: 'boundary-' + diagram.systemId,
        type: 'group',
        position: { x: 460, y: 0 },
        data: { label: systemName },
        style: { width: 800, height: Math.max(300, Math.ceil(internal.length / 2) * 240 + 70) },
        className: 'c4-boundary',
        ariaLabel: 'Граница системы: ' + systemName,
      });
    for (const [column, elements] of [people, internal, external].entries())
      elements.forEach((n, index) =>
        result.push({
          id: n.id,
          type: 'element',
          data: { ...n },
          position: {
            x:
              level === 2 && column === 1
                ? 30 + (index % 2) * 440
                : level === 2 && column === 2
                  ? 1420
                  : column * 490,
            y: (level === 2 && column === 1 ? Math.floor(index / 2) : index) * 240 + 65,
          },
          ...(level === 2 && column === 1
            ? { parentId: 'boundary-' + diagram.systemId, extent: 'parent' as const }
            : {}),
          draggable: false,
          ariaLabel: `${kinds[n.kind]}: ${n.name}. ${n.description}`,
        }),
      );
    return result;
  }, [diagram, level, systemName]);
  const edges = diagram.relationships.map((r, i) => ({
    id: `rel-${i}`,
    source: r.from,
    target: r.to,
    label: [r.description, r.technology].filter(Boolean).join(' · '),
    markerEnd: { type: MarkerType.ArrowClosed },
    type: 'relationship',
    style: { stroke: 'var(--canvas-edge)' },
    labelStyle: { fill: 'var(--text-primary)' },
    labelBgStyle: { fill: 'var(--surface-panel)' },
  }));
  return (
    <figure className="c4-figure my-8">
      <figcaption className="text-md mb-3 font-semibold">
        C{level} · {level === 1 ? 'Контекст системы' : 'Приложения, сервисы и хранилища'}
        {level === 2 && (
          <small className="text-muted-foreground block text-sm font-normal">
            Граница системы: {systemName}. Container в C4 — приложение или хранилище, не обязательно
            Docker.
          </small>
        )}
      </figcaption>
      <div className="c4-canvas bg-card h-(--canvas-height) rounded-md border">
        <ReactFlow
          key={JSON.stringify(diagram)}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          nodesConnectable={false}
          nodesDraggable={false}
          zoomOnScroll={false}
          preventScrolling={false}
          minZoom={0.15}
          maxZoom={1.5}
          aria-label={`Диаграмма C${level}`}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer font-medium">Элементы и связи текстом</summary>
        <ul className="mt-2 grid gap-1">
          {diagram.nodes.map((n) => (
            <li key={n.id}>
              <strong>{n.name}</strong> — {kinds[n.kind]}. {n.description}
              {n.technology && ` Технология: ${n.technology}.`}
            </li>
          ))}
        </ul>
        <ul className="mt-2 grid gap-1">
          {diagram.relationships.map((r, i) => (
            <li key={i}>
              {diagram.nodes.find((n) => n.id === r.from)?.name} →{' '}
              {diagram.nodes.find((n) => n.id === r.to)?.name}: {r.description}
              {r.technology && ` (${r.technology})`}
            </li>
          ))}
        </ul>
      </details>
    </figure>
  );
}
