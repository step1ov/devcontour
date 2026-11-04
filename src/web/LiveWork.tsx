import { useEffect, useRef, useState } from 'react';
import { Bot, Eye } from 'lucide-react';
import type { Run, Task } from '../core/model.ts';
import { Button } from '@/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { roleLabel } from './roles.ts';
import { Activity, Phases, elapsed, engine } from './Workers.tsx';
import { chainBlockers, type QueueStopView } from '../core/work-status.ts';
import { QueueStopBanner } from './QueueStopBanner.tsx';

// «Кто сейчас над чем работает» — первый вопрос, пока идёт разработка. Ответ
// был на отдельной вкладке хода работ, ниже настроек контура; на графе и в
// списке его не было вовсе. Полоса стоит над вкладками и видна на любой из
// них: роль и модель, задача и её доска, фаза, время и попытка. Свободные
// места — одной строкой, а не пустыми карточками.

/** Работа ведущего цикла, которую тоже делает агент: ревью плана, совместная проверка. */
export type LiveWorkflow = {
  key: string;
  kind: 'board' | 'changeset';
  id: string;
  stage: number;
  status: string;
  authorRuntime?: string;
  /** Ревьюер плана по правилу вендора; `sameVendor` — разрешённое ревью тем же вендором. */
  reviewer?: { runtime: string; sameVendor: boolean };
  history?: { at: string; stage: number; event: string }[];
};
export type LiveState = {
  runs: (Pick<
    Run,
    | 'id'
    | 'taskId'
    | 'status'
    | 'phase'
    | 'attempt'
    | 'runtime'
    | 'model'
    | 'reviewer'
    | 'reviewerModel'
    | 'startedAt'
    | 'reusedFrom'
    | 'timings'
  > & { boardId?: string })[];
  workflows?: LiveWorkflow[];
  changeSets?: { id: string; title: string }[];
  /** Задачи текущей работы; доска задачи — `boardId` из сводки. */
  tasks: (Task & { blockers?: string[]; boardId?: string })[];
  boards: { id: string; title: string }[];
  paused: boolean;
  ready: string[];
  config: { concurrency: number; maxAttempts?: number };
};

export function activeWork(state: LiveState) {
  return state.runs
    .filter((r) => r.status === 'active')
    .map((run) => {
      const task = state.tasks.find((t) => t.id === run.taskId);
      const board = state.boards.find((b) => b.id === (run.boardId ?? task?.boardId));
      // Фаза идёт с момента последней отметки времени стадии, а не с начала
      // попытки: «на ревью 2 мин» говорит больше, чем «попытка идёт 40 мин».
      const since = run.timings?.at(-1)?.startedAt ?? run.startedAt;
      return { run, task, board, since };
    });
}

// Ревью плана и совместная проверка идут без прогона задачи: раньше полоса
// в это время говорила «никто не работает», хотя codex читал план.
export function workflowWork(state: LiveState) {
  return (state.workflows ?? [])
    .filter(
      (w) =>
        w.status === 'running' &&
        ((w.kind === 'board' && w.stage === 0) || (w.kind === 'changeset' && w.stage === 1)),
    )
    .map((w) => {
      const board = w.kind === 'board' ? state.boards.find((b) => b.id === w.id) : undefined;
      const change = state.changeSets?.find((c) => c.id === w.id);
      const since =
        [...(w.history ?? [])].reverse().find((h) => h.event === 'running')?.at ??
        new Date().toISOString();
      return w.kind === 'board'
        ? {
            key: w.key,
            label: 'Ревью плана',
            who: w.reviewer
              ? w.reviewer.runtime + (w.reviewer.sameVendor ? ' (тот же вендор)' : '')
              : 'ревьюер',
            subject: board?.title ?? w.id,
            since,
          }
        : {
            key: w.key,
            label: 'Совместная проверка',
            who: 'проверки',
            subject: change?.title ?? w.id,
            since,
          };
    });
}

export function LiveWork({
  state,
  onOpenTask,
  queue,
}: {
  state: LiveState;
  onOpenTask: (boardId: string | undefined, taskId: string) => void;
  /** Остановка очереди: причина и что сделать — в той же зарезервированной ячейке. */
  queue?: QueueStopView;
}) {
  const work = activeWork(state);
  const flows = workflowWork(state);
  const free = Math.max(0, state.config.concurrency - work.length);
  // Исполнители свободны, а задачи ждут: чего именно. Без этого полоса
  // говорила «никто не работает» и только числом «ждут зависимостей».
  const stuck =
    work.length || flows.length ? [] : chainBlockers(state.tasks, state.config.maxAttempts);
  const stopped = !!(queue?.paused && queue.stopReason);
  // Высота ячейки зарезервирована под исполнителей (не больше двух строк):
  // старт и конец попытки не сдвигают граф и вкладки под курсором. Больше
  // строк — прокрутка внутри ячейки.
  const slots = Math.max(1, Math.min(state.config.concurrency, 2));
  const rows = flows.length + work.length + stuck.length + (stopped ? 1 : 0);
  const list = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const check = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
    // Наблюдатель пересоздаётся, только когда меняется состав строк.
  }, [rows, stopped, slots, queue?.stopReason, queue?.action]);
  return (
    <section aria-label="Сейчас работают" className="grid min-w-0 content-start gap-1 px-3 py-2">
      <div className="flex h-5 min-w-0 items-center gap-2 overflow-hidden text-xs whitespace-nowrap">
        <span
          aria-hidden="true"
          className={cn(
            'inline-block size-2 shrink-0 rounded-full',
            work.length || flows.length ? 'bg-success' : 'bg-(--text-faint)',
          )}
        />
        <strong className="text-sm font-medium">
          {work.length
            ? `Работают: ${work.length} из ${state.config.concurrency}`
            : flows.length
              ? flows.map((f) => f.label).join(', ')
              : 'Сейчас никто не работает'}
        </strong>
        {/* Пауза при идущей работе — не противоречие: новые задачи не
            выдаются, текущие доработают. */}
        {state.paused && work.length > 0 && (
          <span className="text-muted-foreground truncate">
            пауза: новые не выдаются, текущие доработают
          </span>
        )}
        {!state.paused && work.length > 0 && free > 0 && (
          <span className="text-muted-foreground tabular">свободно мест {free}</span>
        )}
      </div>
      {/* Высота зарезервирована под исполнителей. Остановка очереди растягивает
          ячейку: причина и «Что сделать» видны целиком, а не обрезаны.
          Прокрутка лишних строк доступна и с клавиатуры. */}
      <div
        ref={list}
        role="group"
        aria-label="Исполнители и причины ожидания"
        tabIndex={overflowing ? 0 : undefined}
        className="grid min-w-0 content-start gap-1 overflow-y-auto rounded-xs"
        style={
          stopped
            ? { minHeight: `calc(var(--live-row-height) * ${slots})` }
            : { height: `calc(var(--live-row-height) * ${slots})` }
        }
      >
        {stopped && <QueueStopBanner queue={queue} compact />}
        {flows.length > 0 && (
          <ul className="m-0 grid list-none gap-1 p-0" aria-label="Работа ведущего цикла">
            {flows.map((f) => (
              <li
                key={f.key}
                className="flex h-(--live-row-height) min-w-0 items-center gap-x-3 text-sm"
              >
                <span className="flex shrink-0 items-center gap-1 font-medium">
                  <Eye aria-hidden="true" className="text-info size-4 shrink-0" />
                  {f.label}
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-xs">{f.who}</span>
                <span className="min-w-0 truncate font-medium" title={f.subject}>
                  {f.subject}
                </span>
                <span className="text-muted-foreground tabular ml-auto shrink-0 text-xs">
                  {elapsed(f.since)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {work.length > 0 && (
          <ul className="m-0 grid list-none gap-1 p-0">
            {work.map(({ run, task, board, since }) => (
              <li
                key={run.id}
                className="grid h-(--live-row-height) min-w-0 content-center gap-0.5"
                title={`${engine(run.runtime, run.model)}${run.phase === 'reviewing' ? ` · проверяет ${engine(run.reviewer, run.reviewerModel)}` : ''}`}
              >
                <div className="flex min-w-0 items-center gap-x-2 text-sm whitespace-nowrap">
                  <span className="flex shrink-0 items-center gap-1 font-medium">
                    <Bot aria-hidden="true" className="text-info size-4 shrink-0" />
                    {task ? roleLabel(task.role) : 'Исполнитель'}
                  </span>
                  <Button
                    variant="link"
                    className="text-foreground h-auto min-w-0 justify-start p-0 font-normal"
                    onClick={() => onOpenTask(board?.id, run.taskId)}
                  >
                    <span className="truncate">{task?.title ?? run.taskId}</span>
                  </Button>
                  {board && (
                    <span className="text-muted-foreground hidden min-w-0 truncate text-xs min-[1280px]:inline">
                      {board.title}
                    </span>
                  )}
                  <span className="text-muted-foreground tabular ml-auto shrink-0 text-xs">
                    {elapsed(since)} в фазе
                    {run.attempt > 1
                      ? ` · попытка ${run.attempt}${state.config.maxAttempts ? ` из ${state.config.maxAttempts}` : ''}`
                      : ''}
                    {run.reusedFrom ? ' · код взят у прошлой попытки' : ''}
                  </span>
                </div>
                <div className="flex min-w-0 items-center gap-x-3 overflow-hidden whitespace-nowrap">
                  <Phases current={run.phase} />
                  {/* Последнее действие агента: фаза «пишет код» одинакова и на
                      первой минуте, и на двадцатой. */}
                  <Activity runId={run.id} lines={1} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {stuck.length > 0 && (
          <ul className="m-0 grid list-none gap-1 p-0" aria-label="Чего ждёт цепочка">
            {stuck.map((b) => {
              const owner = state.tasks.find((t) => t.id === b.taskId)?.boardId;
              const board = state.boards.find((x) => x.id === owner);
              return (
                <li
                  key={b.taskId}
                  className="flex min-h-(--live-row-height) min-w-0 flex-wrap items-center gap-x-2 text-sm"
                >
                  <span className="text-muted-foreground">Цепочка ждёт</span>
                  <Button
                    variant="link"
                    className="h-auto min-w-0 p-0 text-sm font-medium whitespace-normal [overflow-wrap:anywhere]"
                    onClick={() => onOpenTask(board?.id, b.taskId)}
                  >
                    {b.title}
                  </Button>
                  <span>{b.reason}</span>
                  <span className="text-muted-foreground">
                    → {b.next} · ждут задач: {b.waiting}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {/* Свободные места — приглушённые строки той же высоты: появление
            исполнителя занимает место, а не раздвигает полосу. */}
        {Array.from({ length: stopped ? 0 : Math.max(0, Math.min(free, slots - rows)) }, (_, i) => (
          <div
            key={'free-' + i}
            className="text-faint flex h-(--live-row-height) items-center text-xs"
          >
            Свободное место исполнителя
          </div>
        ))}
      </div>
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
            run.status === 'active' && 'text-info',
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
export function AttemptTimeline({ runs, total = runs.length }: { runs: Run[]; total?: number }) {
  if (!runs.length) return null;
  // Номер — сквозной порядок попыток: счётчик бюджета после сброса начинается
  // заново, и «попытка 1» над «попыткой 3» читалась как ошибка. Загружены
  // последние попытки (ранние — страницами), поэтому номер считается от их
  // общего числа: он не меняется, когда раскрываются ранние страницы.
  const numbered = runs.map((run, i) => ({
    run,
    number: total - runs.length + i + 1,
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
