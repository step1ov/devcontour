import { Bot, Eye, PauseCircle } from 'lucide-react';
import type { Board, Run, Task } from '../core/model.ts';
import { Button } from '@/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { roleLabel } from './roles.ts';
import { Activity, Phases, elapsed, engine } from './Workers.tsx';

// «Кто сейчас над чем работает» — первый вопрос, пока идёт разработка. Ответ
// был на отдельной вкладке хода работ, ниже настроек контура; на графе и в
// списке его не было вовсе. Полоса стоит над вкладками и видна на любой из
// них: роль и модель, задача и её доска, фаза, время и попытка. Свободные
// места — одной строкой, а не пустыми карточками.

export type LiveState = {
  runs: Run[];
  tasks: (Task & { blockers?: string[] })[];
  boards: Board[];
  paused: boolean;
  ready: string[];
  config: { concurrency: number; maxAttempts?: number };
};

export function activeWork(state: LiveState) {
  return state.runs
    .filter((r) => r.status === 'active')
    .map((run) => {
      const task = state.tasks.find((t) => t.id === run.taskId);
      const board = state.boards.find((b) =>
        b.revisions.some((r) => r.taskIds.includes(run.taskId)),
      );
      // Фаза идёт с момента последней отметки времени стадии, а не с начала
      // попытки: «на ревью 2 мин» говорит больше, чем «попытка идёт 40 мин».
      const since = run.timings?.at(-1)?.startedAt ?? run.startedAt;
      return { run, task, board, since };
    });
}

export function LiveWork({
  state,
  stopReason,
  onOpenTask,
  onStart,
}: {
  state: LiveState;
  stopReason?: string;
  onOpenTask: (boardId: string | undefined, taskId: string) => void;
  onStart?: () => void;
}) {
  const work = activeWork(state);
  const free = Math.max(0, state.config.concurrency - work.length);
  const failed = state.tasks.filter((t) => t.status === 'failed').length;
  const waiting = state.tasks.filter((t) => t.status === 'ready' && t.blockers?.length).length;
  const ready = state.ready.length;
  return (
    <section
      aria-label="Сейчас работают"
      className="bg-card mb-4 grid gap-2 rounded-lg border p-3 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <strong className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              'inline-block size-2 rounded-full',
              work.length ? 'bg-success animate-pulse' : 'bg-(--text-secondary)',
            )}
          />
          {work.length
            ? `Работают: ${work.length} из ${state.config.concurrency}`
            : 'Сейчас никто не работает'}
        </strong>
        {state.paused && (
          <span className="text-muted-foreground flex items-center gap-1">
            <PauseCircle aria-hidden="true" className="size-4" />
            Очередь на паузе{stopReason ? `: ${stopReason}` : ''}
          </span>
        )}
        <span className="text-muted-foreground">
          готово к запуску {ready} · ждут зависимостей {waiting}
          {failed ? ` · со сбоем ${failed}` : ''}
          {work.length && free ? ` · свободно мест ${free}` : ''}
        </span>
        {state.paused && ready > 0 && onStart && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={onStart}>
            Запустить очередь
          </Button>
        )}
      </div>
      {work.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0">
          {work.map(({ run, task, board, since }) => (
            <li
              key={run.id}
              className="border-primary/30 bg-primary/5 grid min-w-0 gap-1 rounded-md border px-3 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="flex items-center gap-1 font-medium">
                  <Bot aria-hidden="true" className="text-primary size-4 shrink-0" />
                  {task ? roleLabel(task.role) : 'Исполнитель'}
                </span>
                <span className="text-muted-foreground font-mono text-xs">
                  {engine(run.runtime, run.model)}
                </span>
                <Button
                  variant="link"
                  className="h-auto min-w-0 p-0 text-left font-semibold whitespace-normal [overflow-wrap:anywhere]"
                  onClick={() => onOpenTask(board?.id, run.taskId)}
                >
                  {task?.title ?? run.taskId}
                </Button>
                {board && <span className="text-muted-foreground text-xs">{board.title}</span>}
                <span className="text-muted-foreground ml-auto text-xs">
                  {elapsed(since)} в фазе
                  {run.attempt > 1
                    ? ` · попытка ${run.attempt}${state.config.maxAttempts ? ` из ${state.config.maxAttempts}` : ''}`
                    : ''}
                  {run.reusedFrom ? ' · код взят у прошлой попытки' : ''}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <Phases current={run.phase} />
                {run.phase === 'reviewing' && (
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <Eye aria-hidden="true" className="size-3" />
                    проверяет {engine(run.reviewer, run.reviewerModel)}
                  </span>
                )}
              </div>
              {/* Последнее действие агента: фаза «пишет код» одинакова и на
                  первой минуте, и на двадцатой. */}
              <Activity runId={run.id} lines={1} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Ход попыток задачи. Карточка показывала одну цифру «Попытки: 3», и понять,
// где уходило время и почему попытка кончилась, можно было только по журналу.
// Здесь каждая попытка — строка: исход, модель, длительность фаз и причина.
const stageNames: Record<string, string> = {
  implementation: 'код',
  'implementation-reuse': 'код взят у прошлой попытки',
  'candidate-environment': 'окружение',
  'candidate-test': 'проверки',
  'candidate-review': 'ревью',
  'integration-wait': 'очередь интеграции',
  'integration-environment': 'окружение интеграции',
  'integration-test': 'проверки интеграции',
  'integration-review': 'ревью интеграции',
};
const outcomeNames: Record<Run['status'], string> = {
  active: 'идёт',
  succeeded: 'принята',
  failed: 'не прошла',
  cancelled: 'отменена',
  expired: 'владение потеряно',
};
function span(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + ' с';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? minutes + ' мин' : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}
function phaseDurations(run: Run) {
  const totals = new Map<string, number>();
  for (const t of run.timings ?? []) {
    const family = t.stage.split(':')[0];
    const end = t.finishedAt ?? (run.status === 'active' ? new Date().toISOString() : undefined);
    if (!end) continue;
    totals.set(family, (totals.get(family) ?? 0) + Date.parse(end) - Date.parse(t.startedAt));
  }
  return [...totals].map(([stage, ms]) => ({ stage, ms }));
}
function Attempt({ run, number, reset }: { run: Run; number: number; reset: boolean }) {
  const end = run.finishedAt ?? new Date().toISOString();
  return (
    <li className="grid gap-1 border-b pb-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2">
        <strong>Попытка {number}</strong>
        {reset && <span className="text-muted-foreground text-xs">после сброса бюджета</span>}
        <span
          className={cn(
            run.status === 'succeeded' && 'text-success',
            run.status === 'failed' && 'text-destructive',
            run.status === 'active' && 'text-primary',
          )}
        >
          {outcomeNames[run.status]}
        </span>
        <span className="text-muted-foreground font-mono text-xs">
          {engine(run.runtime, run.model)}
        </span>
        <span className="text-muted-foreground ml-auto text-xs">
          {span(Date.parse(end) - Date.parse(run.startedAt))}
        </span>
      </div>
      {phaseDurations(run).length > 0 && (
        <p className="text-muted-foreground m-0 text-xs">
          {phaseDurations(run)
            .map((p) => `${stageNames[p.stage] ?? p.stage} ${span(p.ms)}`)
            .join(' · ')}
        </p>
      )}
      {run.error && (
        <p className="text-destructive m-0 text-xs [overflow-wrap:anywhere]">
          {run.error.slice(0, 300)}
        </p>
      )}
    </li>
  );
}
export function AttemptTimeline({ runs }: { runs: Run[] }) {
  if (!runs.length) return null;
  // Номер — сквозной порядок попыток: счётчик бюджета после сброса начинается
  // заново, и «попытка 1» над «попыткой 3» читалась как ошибка.
  const numbered = runs.map((run, i) => ({
    run,
    number: i + 1,
    // Равный номер — возвращённая попытка (отказ окружения), не сброс.
    reset: i > 0 && run.attempt < runs[i - 1].attempt,
  }));
  const ordered = [...numbered].reverse();
  return (
    <section aria-label="Ход попыток" className="my-4">
      <h3>Ход попыток</h3>
      <ol className="m-0 grid list-none gap-2 p-0">
        {ordered.slice(0, 3).map((a) => (
          <Attempt key={a.run.id} {...a} />
        ))}
      </ol>
      {ordered.length > 3 && (
        <details className="mt-2">
          <summary className="text-muted-foreground cursor-pointer text-sm">
            Более ранние попытки ({ordered.length - 3})
          </summary>
          <ol className="m-0 mt-2 grid list-none gap-2 p-0">
            {ordered.slice(3).map((a) => (
              <Attempt key={a.run.id} {...a} />
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
