import { useMemo } from 'react';
import {
  Bot,
  CheckCircle2,
  CircleDashed,
  FileSignature,
  FlaskConical,
  Loader2,
  Settings2,
  ScrollText,
  XCircle,
} from 'lucide-react';
import type {
  AuditEvent,
  ContractAttempt,
  DevContourState,
  Gate,
  Run,
  Task,
  TaskStatus,
  Role,
} from '../core/model.ts';
import { roleLabel } from './roles.ts';
import { WorkerCards } from './Workers.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.tsx';

// What the operator wants to know while work runs: how far the whole thing is,
// how far each architectural block is, who is holding which task right now, and
// what the tests actually cover. All of it already lives in the state; this
// view only arranges it.

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

function ago(at: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  if (seconds < 60) return seconds + ' с назад';
  if (seconds < 3600) return Math.round(seconds / 60) + ' мин назад';
  if (seconds < 86400) return Math.round(seconds / 3600) + ' ч назад';
  return new Date(at).toLocaleDateString('ru-RU');
}
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
  return roleLabel(task.role) + (peers.length > 1 ? ' ' + index : '');
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

// Setting a project up produces configuration, not tasks, so the board stayed
// empty while real work happened: a repository was attached, a profile of
// checks was pinned, context packs were locked. The journal already recorded
// all of it as audit events; only nobody rendered them.
const eventNames: Record<string, string> = {
  'preparation.enabled': 'Подготовка включена',
  'preparation.operator-decision': 'Решение пользователя',
  'preparation.operator-answer': 'Ответ пользователя на вопрос',
  preparation_create: 'Создано изменение продукта',
  preparation_product: 'Сохранена постановка',
  preparation_architecture: 'Сохранена архитектура',
  preparation_references: 'Сохранены референсы',
  preparation_concept: 'Сохранён концепт',
  preparation_design: 'Сохранена дизайн-система',
  preparation_submit: 'Отправлено на согласование',
  preparation_resolve: 'Зафиксировано решение',
  preparation_question: 'Задан вопрос пользователю',
  preparation_progress: 'Заметка о работе агента',
  'config.saved': 'Сохранена конфигурация',
  'context.locked': 'Закреплены context packs',
  'task.created': 'Создана задача',
  'task.status': 'Изменён статус задачи',
  'board.created': 'Создана доска',
  'board.accepted': 'Доска принята',
  'contract.registered': 'Зарегистрирован контракт',
  'run.started': 'Запущен прогон',
  'run.finished': 'Прогон завершён',
};

function Setup({
  repositories,
  gates,
  packs,
}: {
  repositories?: { id: string; name?: string; kind?: string; path?: string }[];
  gates?: Gate[];
  packs?: {
    id: string;
    version?: string;
    capabilities?: string[];
    source?: { path?: string };
  }[];
}) {
  const configured = (repositories?.length ?? 0) > 0;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="text-primary size-4" aria-hidden="true" />
          Настройка контура
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        {configured ? (
          <>
            <div className="grid gap-2">
              <span className="text-muted-foreground text-xs tracking-wider uppercase">
                Компоненты ({repositories!.length})
              </span>
              <ul className="grid gap-1 text-sm">
                {repositories!.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs">{r.id}</code>
                    <span>{r.name ?? r.id}</span>
                    {r.kind && <Badge variant="secondary">{r.kind}</Badge>}
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid gap-2">
              <span className="text-muted-foreground text-xs tracking-wider uppercase">
                Проверки профиля ({gates?.length ?? 0})
              </span>
              {gates?.length ? (
                <ul className="grid gap-1">
                  {gates.map((g) => (
                    <li key={g.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge variant={g.kind === 'test' ? 'success' : 'secondary'}>
                        {g.kind === 'test' ? 'тест' : 'проверка'}
                      </Badge>
                      <code className="font-mono text-xs">{g.id}</code>
                      <code className="text-muted-foreground font-mono text-xs break-all">
                        {g.command.join(' ')}
                      </code>
                      {g.report && (
                        <span className="text-muted-foreground text-xs">отчёт {g.report.type}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">Профиль ещё не закреплён.</p>
              )}
            </div>
            <div className="grid gap-2">
              <span className="text-muted-foreground text-xs tracking-wider uppercase">
                Профиль проверок
              </span>
              {packs?.length ? (
                <ul className="grid gap-1 text-sm">
                  {packs.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-xs">{p.id}</code>
                      {p.version && (
                        <span className="text-muted-foreground text-xs">{p.version}</span>
                      )}
                      {p.capabilities?.map((c) => (
                        <Badge key={c} variant="secondary">
                          {c}
                        </Badge>
                      ))}
                      {p.source?.path && (
                        <code className="text-muted-foreground font-mono text-xs break-all">
                          {p.source.path}
                        </code>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">Профиль ещё не закреплён.</p>
              )}
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">
            Контур ещё не настроен. Здесь появятся компоненты, проверки профиля и context packs.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Ревью контракта — работа с попытками, и каждая стоила вызова модели.
// Показываем их целиком: отклонение с находками полезнее, чем тишина.
function Contracts({
  contracts,
  attempts,
}: {
  contracts: { id: string; title: string; approvedAt: string }[];
  attempts: ContractAttempt[];
}) {
  const recent = [...attempts].reverse();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <FileSignature className="text-primary size-4" aria-hidden="true" />
          Ревью ({contracts.length} принято, попыток {attempts.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {contracts.length > 0 && (
          <ul className="grid gap-1 text-sm">
            {contracts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="text-primary size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{c.title}</span>
                <span className="text-muted-foreground text-xs">{ago(c.approvedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {/* Число замечаний по попыткам: по нему видно, сходится процесс или
            кружит. Без этого автор сравнивает круги вручную. */}
        {recent.length > 1 && (
          <p className="text-muted-foreground text-sm">
            Замечаний по попыткам:{' '}
            {[...attempts].map((a, i) => (
              <span key={a.id}>
                {i > 0 && ' → '}
                <span className={a.approved ? 'text-primary' : undefined}>{a.findings.length}</span>
              </span>
            ))}
          </p>
        )}
        {recent.length ? (
          <ol className="grid gap-3">
            {recent.map((a, i) => (
              <li key={a.id} className="border-b pb-3 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={a.approved ? 'success' : 'destructive'}>
                    Попытка {a.attempt ?? attempts.length - i}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {a.subject === 'task plan' ? 'план задач' : 'контракт'} · {a.findings.length}{' '}
                    замечаний
                  </span>
                  <strong className="min-w-0 flex-1">{a.title}</strong>
                  <code className="text-muted-foreground font-mono text-xs">
                    {a.authorRuntime} → {a.reviewerRuntime}
                  </code>
                  <span className="text-muted-foreground text-xs">{ago(a.at)}</span>
                </div>
                <p className="text-muted-foreground mt-1 max-w-[80ch] text-sm">{a.summary}</p>
                {a.findings.length > 0 && (
                  <ul className="mt-2 grid gap-1">
                    {a.findings.map((f, at) => (
                      <li key={at} className="flex gap-2 text-sm">
                        <Badge
                          variant={f.severity === 'blocking' ? 'destructive' : 'secondary'}
                          className="shrink-0"
                        >
                          {f.severity === 'blocking' ? 'блокер' : f.severity}
                        </Badge>
                        <span className="max-w-[80ch]">{f.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">
            Ревью контрактов ещё не запускалось. Здесь будет видно каждую попытку и её находки.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
function Journal({ events }: { events: AuditEvent[] }) {
  const recent = [...events].sort((a, b) => b.id - a.id).slice(0, 40);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="text-primary size-4" aria-hidden="true" />
          Журнал ({events.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {recent.length ? (
          <ul className="grid gap-2">
            {recent.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-3 border-b pb-2 text-sm">
                <span className="text-muted-foreground font-mono text-xs">
                  {new Date(e.at).toLocaleString('ru-RU')}
                </span>
                <span className="min-w-0 flex-1">{eventNames[e.type] ?? e.type}</span>
                <code className="text-muted-foreground font-mono text-xs">{e.type}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Событий пока нет.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Безопасное представление работы: без fencing-полей, только для показа. */
type WorkflowView = {
  key: string;
  status: string;
  error?: string;
  repairs: number;
  repairBudget: number;
};

// Вкладка отвечала графиками, но не отвечала одним предложением: на каком
// этапе разработка и чего она ждёт. Полосы показывают объём, карточки — кто
// занят; между ними не было ответа на вопрос, с которого читатель начинает.
function Stage({
  tasks,
  running,
  paused,
  pauseReason,
  events,
  workflows,
}: {
  tasks: Task[];
  running: number;
  paused?: boolean;
  pauseReason?: string;
  events: AuditEvent[];
  workflows?: WorkflowView[];
}) {
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const drafts = tasks.filter((t) => t.status === 'draft').length;
  // Пауза рантайма называется своим именем; прежние записи её не называли
  // вовсе, поэтому обе формы означают одно: выдачу остановил сам диспетчер.
  const stopped =
    paused && (!pauseReason || pauseReason === 'runtime')
      ? (
          [...events].reverse().find((e) => e.type === 'scheduler.error')?.data as
            { error?: string } | undefined
        )?.error?.replace(/^Error:\s*/, '')
      : undefined;
  // Остановленный цикл восстановления выглядел как обычное ожидание свободного
  // исполнителя: причина лежала в записи работы и доходила до агентского API,
  // но не до интерфейса. Человек не видел, что чинить уже никто не будет.
  const halted = (workflows ?? []).filter((w) => w.status === 'failed' && w.error);
  // Основной статус выводится из работы: при остановленном восстановлении
  // строка «ожидание выдачи» обещала продолжение, которого не будет.
  const line = !tasks.length
    ? 'Объём ещё не собран: доска пуста.'
    : halted.length && !running
      ? `Восстановление остановлено и ждёт решения человека, принято ${done} из ${tasks.length}.`
      : drafts === tasks.length
        ? 'План собран и ждёт независимого ревью — черновики очередь не выдаёт.'
        : done === tasks.length
          ? 'Весь объём принят исполнителями; доска ждёт приёмки.'
          : running
            ? `Идёт выдача: занято исполнителей — ${running}, принято ${done} из ${tasks.length}.`
            : paused
              ? `Выдача остановлена, принято ${done} из ${tasks.length}.`
              : `Ожидание выдачи: принято ${done} из ${tasks.length}.`;
  return (
    <Card>
      <CardContent className="grid gap-2 p-4">
        <p className="text-md m-0">{line}</p>
        {failed > 0 && (
          <p className="text-destructive m-0 text-sm">
            Задач со сбоем: {failed}.{' '}
            {halted.length
              ? 'Автоматического повтора не будет: повторите вручную, когда причина устранена.'
              : 'Повтор возможен, пока не исчерпан бюджет попыток.'}
          </p>
        )}
        {stopped && (
          <p className="text-destructive m-0 text-sm break-words">
            Очередь остановилась сама: {stopped}
          </p>
        )}
        {halted.map((w) => (
          <p key={w.key} className="text-destructive m-0 text-sm break-words">
            Автоматическое восстановление остановлено ({w.repairs} из {w.repairBudget}): {w.error}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}
export function ProgressPanel({
  state,
  onSelect,
}: {
  state: Pick<DevContourState, 'tasks' | 'runs' | 'contracts'> & {
    events?: AuditEvent[];
    contractAttempts?: ContractAttempt[];
    concurrency?: number;
    paused?: boolean;
    pauseReason?: 'operator' | 'shutdown' | 'runtime';
    workflows?: WorkflowView[];
    config: {
      repositories?: { id: string; name?: string; kind?: string }[];
      gates?: Gate[];
      packs?: {
        id: string;
        version?: string;
        capabilities?: string[];
        source?: { path?: string };
      }[];
    };
  };
  onSelect?: (taskId: string) => void;
}) {
  // Черновик — это запланированная работа, а не мусор: до утверждения плана
  // все задачи именно черновики, и прятать их значит показывать пустую доску
  // там, где объём уже собран. Скрывается только отменённое.
  const tasks = state.tasks.filter((t) => t.status !== 'cancelled');
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
      <Stage
        tasks={tasks}
        running={runs.length}
        paused={state.paused}
        pauseReason={state.pauseReason}
        events={state.events ?? []}
        workflows={state.workflows}
      />
      <Setup
        repositories={state.config.repositories}
        gates={state.config.gates}
        packs={state.config.packs}
      />

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
          {tasks.length > 0 && tasks.every((t) => t.status === 'draft') && (
            <p className="text-muted-foreground text-sm">
              Все задачи в черновике: план ещё не прошёл независимое ревью, поэтому очередь их не
              выдаёт.
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
          <WorkerCards
            workers={working.map(({ task, run }) => ({
              runId: run?.id ?? task.id,
              taskId: task.id,
              title: task.title,
              role: task.role,
              phase: run?.phase ?? task.status,
              runtime: run?.runtime,
              model: run?.model,
              reviewer: run?.reviewer,
              reviewerModel: run?.reviewerModel,
              attempt: task.attempt,
              startedAt: run?.startedAt ?? task.createdAt,
            }))}
            concurrency={state.concurrency}
          />
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
                    <span className="text-muted-foreground text-xs">{roleLabel(t.role)}</span>
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

      <Contracts contracts={state.contracts} attempts={state.contractAttempts ?? []} />

      <Journal events={state.events ?? []} />
    </div>
  );
}
