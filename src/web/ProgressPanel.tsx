import { useMemo } from 'react';
import { Bot, CheckCircle2, CircleDashed, FlaskConical, Loader2, XCircle } from 'lucide-react';
import type { DevContourState, Run, Task, TaskStatus, Role } from '../core/model.ts';
import { Badge } from '@/ui/badge.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.tsx';

// What the operator wants to know while work runs: how far the whole thing is,
// how far each architectural block is, who is holding which task right now, and
// what the tests actually cover. All of it already lives in the state; this
// view only arranges it.

const roleNames: Record<Role, string> = {
  architect: 'Архитектор',
  backend: 'Разработчик бэкенда',
  frontend: 'Разработчик интерфейса',
  qa: 'Тестировщик',
};
const statusNames: Record<TaskStatus, string> = {
  draft: 'Черновик',
  ready: 'Готова к выдаче',
  running: 'В работе',
  verifying: 'Проверки',
  reviewing: 'Ревью',
  integrating: 'Интеграция',
  done: 'Готово',
  failed: 'Упала',
  cancelled: 'Отменена',
};
const statusTone: Record<TaskStatus, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  draft: 'secondary',
  ready: 'secondary',
  running: 'warning',
  verifying: 'warning',
  reviewing: 'warning',
  integrating: 'warning',
  done: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
};
const active: TaskStatus[] = ['running', 'verifying', 'reviewing', 'integrating'];

function elapsed(from: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return seconds + ' с';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' мин';
  return Math.floor(seconds / 3600) + ' ч ' + Math.floor((seconds % 3600) / 60) + ' мин';
}

// A worker is named by what it does, not by its process id: the operator asks
// "who is on this task", and "Разработчик бэкенда 2" answers that. The number
// is stable per owner within a role, so it does not jump between refreshes.
function workerName(run: Run, task: Task, runs: Run[]) {
  const peers = [...new Set(runs.filter((r) => r.owner).map((r) => r.owner))].sort();
  const index = peers.indexOf(run.owner) + 1;
  return roleNames[task.role] + (peers.length > 1 ? ' ' + index : '');
}

function Bar({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-muted-foreground font-mono text-sm">
          {done} / {total} · {percent}%
        </span>
      </div>
      <div
        className="bg-secondary h-2 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="bg-primary h-full rounded-full" style={{ width: percent + '%' }} />
      </div>
    </div>
  );
}

export function ProgressPanel({
  state,
  onSelect,
}: {
  state: Pick<DevContourState, 'tasks' | 'runs' | 'contracts'> & {
    config: { repositories?: { id: string }[] };
  };
  onSelect?: (taskId: string) => void;
}) {
  const tasks = state.tasks.filter((t) => t.status !== 'cancelled' && t.status !== 'draft');
  const runs = state.runs.filter((r) => r.status === 'active');

  const blocks = useMemo(() => {
    const ids = [
      ...new Set([
        ...(state.config.repositories ?? []).map((r) => r.id),
        ...tasks.map((t) => t.repositoryId),
      ]),
    ].sort();
    return ids.map((id) => {
      const own = tasks.filter((t) => t.repositoryId === id);
      return { id, done: own.filter((t) => t.status === 'done').length, total: own.length };
    });
  }, [state.config.repositories, tasks]);

  const working = tasks
    .filter((t) => active.includes(t.status))
    .map((t) => ({ task: t, run: runs.find((r) => r.id === t.activeRunId) }));

  // Every gate that has ever reported, with what it last said and on which task.
  const gates = useMemo(() => {
    const byGate = new Map<
      string,
      { gate: string; passed: number; failed: number; tasks: Set<string>; phases: Set<string> }
    >();
    for (const run of state.runs)
      for (const e of run.evidence ?? []) {
        if (e.kind !== 'test') continue;
        const row = byGate.get(e.gate) ?? {
          gate: e.gate,
          passed: 0,
          failed: 0,
          tasks: new Set<string>(),
          phases: new Set<string>(),
        };
        row[e.passed ? 'passed' : 'failed'] += 1;
        row.tasks.add(run.taskId);
        row.phases.add(e.phase);
        byGate.set(e.gate, row);
      }
    return [...byGate.values()].sort((a, b) => a.gate.localeCompare(b.gate));
  }, [state.runs]);

  const covered = new Set(
    state.runs.flatMap((r) =>
      (r.evidence ?? []).filter((e) => e.kind === 'test').map(() => r.taskId),
    ),
  );
  const uncovered = tasks.filter((t) => t.status === 'done' && !covered.has(t.id));

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Готовность</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Bar
            label="Весь объём"
            done={tasks.filter((t) => t.status === 'done').length}
            total={tasks.length}
          />
          {blocks.map((b) => (
            <Bar key={b.id} label={b.id} done={b.done} total={b.total} />
          ))}
          {!tasks.length && (
            <p className="text-muted-foreground">
              Задач ещё нет. Полосы заполнятся, когда агент соберёт доску.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Bot className="text-primary size-4" aria-hidden="true" />
            Сейчас в работе ({working.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {working.length ? (
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Сейчас в работе"
            >
              <table className="w-full min-w-[52rem] border-collapse text-sm">
                <thead>
                  <tr>
                    {['Задача', 'Блок', 'Кто работает', 'Модель', 'Этап', 'Попытка', 'Идёт'].map(
                      (h) => (
                        <th key={h} className="border-b p-2 text-left align-top font-medium">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {working.map(({ task, run }) => (
                    <tr key={task.id}>
                      <td className="border-b p-2 align-top">
                        {onSelect ? (
                          <button
                            type="button"
                            className="text-primary text-left underline-offset-4 hover:underline"
                            onClick={() => onSelect(task.id)}
                          >
                            {task.title}
                          </button>
                        ) : (
                          task.title
                        )}
                      </td>
                      <td className="border-b p-2 align-top font-mono text-xs">
                        {task.repositoryId}
                      </td>
                      <td className="border-b p-2 align-top">
                        {run ? workerName(run, task, state.runs) : roleNames[task.role]}
                      </td>
                      <td className="border-b p-2 align-top font-mono text-xs">
                        {run ? (run.model ?? run.runtime) : '—'}
                        {run?.reviewerModel && (
                          <span className="text-muted-foreground">
                            {' '}
                            · ревью {run.reviewerModel}
                          </span>
                        )}
                      </td>
                      <td className="border-b p-2 align-top">
                        <Badge variant={statusTone[task.status]}>
                          <Loader2 className="mr-1 size-3 animate-spin" aria-hidden="true" />
                          {statusNames[task.status]}
                        </Badge>
                      </td>
                      <td className="border-b p-2 align-top font-mono text-xs">{task.attempt}</td>
                      <td className="border-b p-2 align-top font-mono text-xs">
                        {run ? elapsed(run.startedAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Сейчас никто не занят задачей. Здесь появятся исполнитель, модель и время работы.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Очередь ({tasks.filter((t) => !active.includes(t.status)).length})</CardTitle>
        </CardHeader>
        <CardContent>
          {tasks.length ? (
            <ul className="grid gap-2">
              {tasks
                .filter((t) => !active.includes(t.status))
                .map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-3 border-b pb-2">
                    {t.status === 'done' ? (
                      <CheckCircle2 className="text-primary size-4 shrink-0" aria-hidden="true" />
                    ) : t.status === 'failed' ? (
                      <XCircle className="text-destructive size-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <CircleDashed
                        className="text-muted-foreground size-4 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1">{t.title}</span>
                    <code className="text-muted-foreground font-mono text-xs">
                      {t.repositoryId}
                    </code>
                    <span className="text-muted-foreground text-xs">{roleNames[t.role]}</span>
                    <Badge variant={statusTone[t.status]}>{statusNames[t.status]}</Badge>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Очередь пуста.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="text-primary size-4" aria-hidden="true" />
            Что чем покрыто ({gates.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {gates.length ? (
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Проверки">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <thead>
                  <tr>
                    {['Проверка', 'Фаза', 'Задач покрыто', 'Прошло', 'Упало'].map((h) => (
                      <th key={h} className="border-b p-2 text-left align-top font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {gates.map((g) => (
                    <tr key={g.gate}>
                      <td className="border-b p-2 align-top font-mono text-xs">{g.gate}</td>
                      <td className="border-b p-2 align-top text-xs">
                        {[...g.phases]
                          .map((p) => (p === 'candidate' ? 'кандидат' : 'интеграция'))
                          .join(' · ')}
                      </td>
                      <td className="border-b p-2 align-top font-mono text-xs">{g.tasks.size}</td>
                      <td className="border-b p-2 align-top font-mono text-xs">{g.passed}</td>
                      <td className="border-b p-2 align-top font-mono text-xs">
                        {g.failed ? <span className="text-destructive">{g.failed}</span> : g.failed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Проверки ещё не запускались. Здесь будет видно, какая задача какой проверкой закрыта.
            </p>
          )}
          {uncovered.length > 0 && (
            <p className="text-destructive text-sm">
              Задач завершено без доказательства проверки: {uncovered.length}. Это дыра в покрытии,
              а не мелочь.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
