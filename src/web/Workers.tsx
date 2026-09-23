import { useEffect, useState } from 'react';
import { Bot, CircleDashed, Eye, Loader2 } from 'lucide-react';
import { Badge } from '@/ui/badge.tsx';
import { Card, CardContent } from '@/ui/card.tsx';
import { cn } from '@/lib/utils.ts';
import { roleLabel } from './roles.ts';

// «Кто сейчас работает» — первый вопрос оператора, пока идёт выдача. Строка
// таблицы на него отвечает плохо: нужно видеть роль, фазу и модель сразу, не
// перечитывая заголовки столбцов.

export type Worker = {
  runId: string;
  taskId: string;
  title: string;
  role?: string;
  phase?: string;
  runtime?: string;
  model?: string;
  reviewer?: string;
  reviewerModel?: string;
  attempt?: number;
  startedAt: string;
};

// Фазы идут по порядку: видно не только где агент сейчас, но и сколько позади.
const phases = [
  { id: 'running', label: 'пишет код' },
  { id: 'verifying', label: 'гоняет проверки' },
  { id: 'reviewing', label: 'на ревью' },
  { id: 'integrating', label: 'интегрирует' },
] as const;

export function elapsed(from: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return seconds + ' с';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' мин';
  return Math.floor(seconds / 3600) + ' ч ' + Math.floor((seconds % 3600) / 60) + ' мин';
}
export const engine = (runtime?: string, model?: string) =>
  [runtime, model].filter(Boolean).join(' · ') || '—';

export function Phases({ current }: { current?: string }) {
  const at = phases.findIndex((p) => p.id === current);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {phases.map((phase, i) => {
        const done = at >= 0 && i < at;
        const now = phase.id === current;
        return (
          <li key={phase.id} className="flex items-center gap-2">
            {i > 0 && (
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
            )}
            <span
              className={cn(
                'flex items-center gap-1 rounded-full px-2 py-0.5',
                now && 'bg-primary/15 text-primary font-medium',
                done && 'text-muted-foreground',
                !now && !done && 'text-muted-foreground/60',
              )}
            >
              {now && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
              {phase.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}


// Фаза отвечает грубо: `running` одинаков и через минуту после выдачи, и на
// десятом инструменте. Последние действия runtime показывают, чем агент занят
// на самом деле — читать журнал для этого больше не нужно.
function Activity({ runId }: { runId: string }) {
  const [lines, setLines] = useState<{ phase: string; text: string }[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const response = await fetch(`api/runs/${runId}/activity`);
        if (!response.ok) return;
        const data = (await response.json()) as { activity?: { phase: string; text: string }[] };
        if (live) setLines(data.activity?.slice(-3) ?? []);
      } catch {
        // Панель переживает недоступный сервер: строки просто не обновятся.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [runId]);
  if (!lines.length) return null;
  return (
    <ol className="text-muted-foreground m-0 grid gap-0.5 font-mono text-xs">
      {lines.map((line, i) => (
        <li key={i} className="truncate" title={line.text}>
          {line.text}
        </li>
      ))}
    </ol>
  );
}
export function WorkerCards({ workers, concurrency }: { workers: Worker[]; concurrency?: number }) {
  const free = Math.max(0, (concurrency ?? workers.length) - workers.length);
  return (
    <div className="grid gap-3">
      {workers.map((w) => (
        <Card key={w.runId} className="border-primary/30">
          <CardContent className="grid gap-3 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Bot className="text-primary size-5 shrink-0" aria-hidden="true" />
              <strong className="text-md">
                {w.role ? roleLabel(w.role) : 'Исполнитель'}
              </strong>
              <Badge variant="secondary" className="font-mono text-xs">
                {engine(w.runtime, w.model)}
              </Badge>
              <span className="text-muted-foreground ml-auto text-xs">
                {elapsed(w.startedAt)}
                {w.attempt && w.attempt > 1 ? ` · попытка ${w.attempt}` : ''}
              </span>
            </div>
            <p className="min-w-0 break-words">{w.title}</p>
            <Phases current={w.phase} />
            <Activity runId={w.runId} />
            {(w.reviewer ?? w.reviewerModel) && (
              <p className="text-muted-foreground flex items-center gap-2 text-xs">
                <Eye aria-hidden="true" className="size-3 shrink-0" />
                проверит независимо: {engine(w.reviewer, w.reviewerModel)}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
      {Array.from({ length: free }, (_, i) => (
        <Card key={'free-' + i} className="border-dashed">
          <CardContent className="text-muted-foreground flex items-center gap-3 p-4 text-sm">
            <CircleDashed aria-hidden="true" className="size-5 shrink-0" />
            Исполнитель свободен
          </CardContent>
        </Card>
      ))}
      {!workers.length && !free && (
        <p className="text-muted-foreground text-sm">
          Исполнители не запускались. Здесь появятся роль, фаза, модель и время работы.
        </p>
      )}
    </div>
  );
}
