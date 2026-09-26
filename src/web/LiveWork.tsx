import { Bot, Eye, PauseCircle } from 'lucide-react';
import type { Board, Run, Task } from '../core/model.ts';
import { Button } from '@/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { roleLabel } from './roles.ts';
import { Phases, elapsed, engine } from './Workers.tsx';

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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
