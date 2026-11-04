import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  GitBranch,
  Plus,
  Play,
  Pause,
  Check,
  CircleCheck,
  Clock,
  AlertCircle,
  ArrowUpRight,
  X,
  FileCheck,
  FileText,
  RotateCcw,
  Workflow,
  ChevronRight,
  Bot,
  Eye,
  Loader2,
  Copy,
} from 'lucide-react';
import type { Task, Run } from '../core/model.ts';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog.tsx';
import { Input } from '@/ui/input.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { cn } from '@/lib/utils.ts';
import { levels } from '../core/graph.ts';
import type { taskProgress } from '../application/context.ts';
import type { PanelEvidence, PanelRun, PanelSummary } from '../application/panel.ts';
const GraphPanel = lazy(() => import('./GraphPanel.tsx'));
const CheckPanel = lazy(() =>
  import('./CheckPanel.tsx').then((module) => ({ default: module.CheckPanel })),
);
const ProgressPanel = lazy(() =>
  import('./ProgressPanel.tsx').then((module) => ({ default: module.ProgressPanel })),
);
const AuthorOverviewPanel = lazy(() =>
  import('./AuthorOverview.tsx').then((module) => ({ default: module.AuthorOverviewPanel })),
);
const ProductPanel = lazy(() =>
  import('./ProductPanel.tsx').then((module) => ({ default: module.ProductPanel })),
);
// Панель опрашивает ограниченную сводку (`/api/summary`), а тела истории —
// попытки, evidence, логи, снимки проверок — загружает по запросу.
type Snapshot = PanelSummary;
type UITask = Snapshot['tasks'][number];
type DetailTask = Task & {
  specDigest: string;
  blockers: string[];
  progress?: ReturnType<typeof taskProgress>;
};
interface TaskDetail {
  revision: number;
  task: DetailTask;
  dependencies: { id: string; title?: string; status?: string }[];
  runs: { total: number; items: Run[]; next: number | null; nextBefore: string | null };
}
import { roleLabel, currentRoles, setRoleSource } from './roles.ts';
import { Phases, engine, elapsed } from './Workers.tsx';
import { AttemptTimeline, LiveWork } from './LiveWork.tsx';
import { boardPhaseLabels, chainBlockers } from '../core/work-status.ts';
import { statusKey, statusNames, statusOfKey, taskStatus, flashOf } from './status.ts';
import { Toaster, toast } from 'sonner';
import { createPortal } from 'react-dom';

const waitingReasons: Record<string, string> = {
  product_approval_required:
    'Нужно согласовать продукт и архитектуру или обновить привязку черновика задачи.',
  plan_review_required: 'План ещё не утверждён. Требуется ревью.',
  dependencies_incomplete: 'Сначала должны завершиться связанные задачи.',
  queue_paused: 'Очередь на паузе. Выдача задач возобновится после запуска.',
  assigned_to_another_member: 'Задача назначена другому участнику команды.',
  workers_busy: 'Все исполнители заняты. Задача ждёт свободного места.',
  workspace_operation_active: 'Идёт общая проверка или проверка публикации.',
  inactive_revision: 'Задача относится к неактивной ревизии.',
  held_by_operation:
    'Задачу удерживает операция изменения контракта: выдача возобновится, когда операция снимет удержание.',
  approval_stale:
    'План утверждён при другой политике исполнения: задача не выдаётся до повторного утверждения.',
  budget_blocked: 'Бюджет расходов не пускает задачу к выдаче.',
  failure_requires_diagnosis: 'Разберите причину сбоя перед повторной попыткой.',
  attempts_exhausted: 'Лимит попыток исчерпан. Нужна диагностика и пересмотр решения.',
};
// Колонки привычной доски задач. Статус задачи и фаза её прогона уже
// говорят, где она: черновик ждёт утверждения плана, готовая — исполнителя,
// разработка и сбой — в работе, проверки, ревью и интеграция — на проверке.
// Сбой остаётся в работе с красной меткой, а не прячется в отдельную колонку.
const kanbanColumns: { key: string; label: string; hint: string; statuses: string[] }[] = [
  { key: 'inbox', label: 'Входящие', hint: 'План не утверждён', statuses: ['draft'] },
  {
    key: 'todo',
    label: 'К выполнению',
    hint: 'Утверждены, ждут исполнителя или зависимостей',
    statuses: ['ready'],
  },
  { key: 'doing', label: 'В работе', hint: 'Разработка и сбои', statuses: ['running', 'failed'] },
  {
    key: 'review',
    label: 'На проверке',
    hint: 'Проверки, ревью, интеграция',
    statuses: ['verifying', 'reviewing', 'integrating'],
  },
  { key: 'done', label: 'Готово', hint: 'Прошли проверки', statuses: ['done', 'cancelled'] },
];
const stamp = (value?: string) =>
  value
    ? new Date(value).toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const status = (t: UITask) => statusKey(t);
const taskStatusName = (t: UITask) => taskStatus(t).label;
// Что делает агент на узле графа: модель и фаза. Без этого граф отвечал
// только «в работе» и не показывал, кто и на каком шаге.
const phaseLabel: Record<string, string> = {
  running: 'пишет код',
  verifying: 'проверки',
  reviewing: 'на ревью',
  integrating: 'интеграция',
};
function liveLabel(run?: PanelRun) {
  if (!run) return undefined;
  const who =
    run.phase === 'reviewing'
      ? engine(run.reviewer, run.reviewerModel)
      : engine(run.runtime, run.model);
  return `${phaseLabel[run.phase] ?? run.phase} · ${who}${run.attempt > 1 ? ` · попытка ${run.attempt}` : ''}`;
}
const shortId = (id: string) =>
  /^[A-Z]+-[a-f0-9-]{36}$/.test(id) ? id.slice(0, id.indexOf('-') + 9) : id;
// Строка задачи отвечала только «в каком она статусе». На вопрос «чем агент
// занят прямо сейчас» это не отвечает: статус `running` одинаков и через минуту
// после выдачи, и на третьей попытке в ревью. Живая часть строки показывает
// фазу, исполнителя, пройденные проверки и причину ожидания — то, ради чего
// иначе приходится открывать карточку задачи и читать журнал.
function TaskLive({
  task,
  runs,
  maxAttempts,
  compact = false,
  titles,
  hideWaiting = false,
}: {
  task: UITask;
  runs: PanelRun[];
  maxAttempts?: number;
  /** Карточка колонок: одна строка фазы и сводка проверок. */
  compact?: boolean;
  /** Названия задач по id: «ждёт» называет задачу, а не её UUID. */
  titles?: Map<string, string>;
  /** Строка уже называет зависимости («после: …»): «ждёт» не повторяется. */
  hideWaiting?: boolean;
}) {
  const run = runs.filter((r) => r.taskId === task.id).at(-1);
  const active = run?.status === 'active';
  const exhausted = maxAttempts !== undefined && task.attempt >= maxAttempts;
  if (active && compact)
    return (
      <span className="grid min-w-0 gap-0.5 text-xs">
        <span className="text-info truncate font-medium">
          ● {phaseLabel[run.phase] ?? run.phase} · {elapsed(run.startedAt)}
        </span>
        <GateSummary run={run} />
      </span>
    );
  if (active)
    return (
      <div className="mt-2 grid gap-1">
        <Phases current={run.phase} />
        <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
          <Bot aria-hidden="true" className="size-3 shrink-0" />
          {engine(run.runtime, run.model)}
          <Eye aria-hidden="true" className="size-3 shrink-0" />
          {engine(run.reviewer, run.reviewerModel)}
          <span>· {elapsed(run.startedAt)}</span>
          {run.attempt > 1 && <span>· попытка {run.attempt}</span>}
        </span>
        <GateChips run={run} />
      </div>
    );
  if (task.status === 'ready' && task.blockers.length)
    return hideWaiting ? null : (
      <small className="text-muted-foreground mt-1 block min-w-0 [overflow-wrap:anywhere]">
        Ждёт: {task.blockers.map((id) => titles?.get(id) ?? shortId(id)).join(', ')}
      </small>
    );
  if (task.status === 'ready')
    return (
      <small className={cn('mt-1 block', exhausted ? 'text-destructive' : 'text-muted-foreground')}>
        {/* Задача на потолке попыток стоит в ready и молча не выдаётся:
            диспетчер её не берёт, а строка обещала «ждёт исполнителя». */}
        {exhausted
          ? `Бюджет попыток исчерпан (${task.attempt} из ${maxAttempts}) — очередь её не выдаст. Повторите со сбросом: retry --task ${task.id} --reset --reason …`
          : 'Готова, ждёт свободного исполнителя'}
      </small>
    );
  if (task.status === 'failed' && task.failure)
    return (
      <small className="text-destructive mt-1 block w-full min-w-0 break-words [overflow-wrap:anywhere]">
        {run?.blocked ? 'Отказ окружения, попытка не засчитана: ' : ''}
        {/* Ответ ревьюера вне протокола — не замечание к коду: повтор writer
            ничего не исправит, продолжение назначает человек. */}
        {run?.failureKind === 'review-protocol'
          ? 'Ответ ревьюера нарушил протокол ревью, код не оценён: '
          : ''}
        {task.failure}
        {/* Исчерпанный бюджет — тупик, пока о сбросе никто не знает: без этой
            строки остаётся только править базу руками. */}
        {exhausted && (
          <>
            {' '}
            Бюджет попыток исчерпан ({task.attempt} из {maxAttempts}). Устраните причину и повторите
            со сбросом: <code>retry --task {task.id} --reset --reason …</code>
          </>
        )}
      </small>
    );
  if (task.status === 'done' && run)
    return compact ? <GateSummary run={run} /> : <GateChips run={run} />;
  return null;
}
// Какие проверки задача уже прошла на своём SHA: зелёный gate — это и есть
// доказательство, а не отметка «тесты запускались».
function GateChips({ run }: { run: PanelRun }) {
  const latest = new Map<string, PanelEvidence>();
  for (const e of run.evidence) latest.set(e.gate + e.phase, e);
  const gates = [...latest.values()];
  if (!gates.length) return null;
  return (
    <span className="mt-1 flex min-w-0 flex-wrap gap-1">
      {gates.map((e) => (
        <Badge
          key={e.id}
          variant={e.passed ? 'success' : 'destructive'}
          className="min-w-0 font-mono"
          title={`${e.gate} · ${e.phase} · ${e.summary}`}
        >
          <span className="truncate">
            {e.passed ? '✓' : '✗'} {e.gate}
            {e.phase === 'integration' ? ' · интеграция' : ''}
          </span>
        </Badge>
      ))}
    </span>
  );
}
// Карточка колонок — сводка, а не протокол: проверки одной строкой по фазам,
// полный список — в инспекторе.
function GateSummary({ run }: { run: PanelRun }) {
  const latest = new Map<string, PanelEvidence>();
  for (const e of run.evidence) latest.set(e.gate + e.phase, e);
  const gates = [...latest.values()];
  if (!gates.length) return null;
  const phase = (name: string) => gates.filter((e) => e.phase === name);
  const part = (label: string, items: PanelEvidence[]) => {
    if (!items.length) return null;
    const failed = items.filter((e) => !e.passed).length;
    return (
      <span className={failed ? 'text-destructive' : 'text-success'}>
        {label} {failed ? `✗${failed}` : `✓${items.length}`}
      </span>
    );
  };
  return (
    <span
      className="tabular flex flex-wrap gap-x-2 text-xs"
      title={gates.map((e) => `${e.passed ? '✓' : '✗'} ${e.gate} · ${e.phase}`).join('\n')}
    >
      {part('кандидат', phase('candidate'))}
      {part('интеграция', phase('integration'))}
    </span>
  );
}
// Раунд ревью кода: какие прежние находки reviewer закрыл, снял или оставил.
// Невалидный ответ — не замечание к коду: причина в пути поля ответа, а
// одобрения или отказа по существу у такого вызова нет.
function reviewRoundLine(r: NonNullable<Run['evidence'][number]['reviewRound']>) {
  // Номер вызова виден, только когда был повтор reviewer или сам вызов невалиден.
  const call = `вызов ${r.call} из ${r.calls}`;
  if (r.protocol !== 'valid')
    return [call, (r.issues ?? []).map((i) => `${i.reason} ${i.path}`).join(', ') || r.protocol]
      .filter(Boolean)
      .join(': ');
  const moved = (to: string) => (r.transitions ?? []).filter((t) => t.to === to).length;
  return [
    `раунд ${r.round}`,
    r.call > 1 ? call : '',
    ...(
      [
        ['закрыто', moved('closed')],
        ['снято', moved('withdrawn')],
        ['открыто', moved('open')],
      ] as const
    )
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${label} ${n}`),
    r.mode === 'legacy' ? 'без переходов находок' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
// «Где сейчас разработка» — это соотношение принятого, идущего и оставшегося,
// а не название ревизии. Одна строка под доской отвечает на это без открытия.
// Строки досок с прогрессом и фазой считает сервер; порядок: где идёт
// работа, затем активные, затем принятые. Доска, где вся работа отменена, —
// история, а не выбор: раньше панель открывала её, хотя в навигации её не было.
function liveBoards(data: Snapshot) {
  const rank = (b: Snapshot['boards'][number]) =>
    b.running ? 0 : b.revisions.at(-1)!.status === 'active' ? 1 : 2;
  return data.boards
    .map((b, i) => ({ b, i }))
    .filter((x) => x.b.live)
    .sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i)
    .map((x) => x.b);
}
function BoardLink({
  board: b,
  current,
  onSelect,
}: {
  board: Snapshot['boards'][number];
  current: boolean;
  onSelect: (id: string) => void;
}) {
  // Прогресс справа числом, фаза — строкой ниже: подпись больше не рвётся
  // посередине «0 / из 5».
  const share = /^(\d+) из (\d+)/.exec(b.progress ?? '');
  const working = /· (\d+) в работе/.exec(b.progress ?? '');
  const accepted = b.revisions.at(-1)!.status === 'accepted';
  return (
    <button
      type="button"
      className={cn(
        'text-foreground flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-(--duration-hover) hover:bg-raised max-[760px]:w-auto max-[760px]:min-w-44 max-[760px]:shrink-0',
        current && 'bg-active hover:bg-active font-medium',
      )}
      onClick={() => onSelect(b.id)}
      aria-current={current ? 'page' : undefined}
    >
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 [overflow-wrap:anywhere]">{b.title}</span>
        <small className="truncate font-normal">
          {boardPhaseLabels[b.phase]} · r{b.revisions.at(-1)!.number}
          {working && ` · в работе ${working[1]}`}
        </small>
      </span>
      {share ? (
        <span className="text-muted-foreground tabular shrink-0 pt-px text-xs font-normal">
          {share[1]}/{share[2]}
        </span>
      ) : accepted ? (
        <Check aria-hidden="true" className="text-success size-4 shrink-0" />
      ) : null}
    </button>
  );
}
// Причина ревизии в сводке сокращена; целиком — из деталей ревизии.
function RevisionReason({
  boardId,
  revision,
}: {
  boardId: string;
  revision: { number: number; reason: string; reasonTruncated?: boolean };
}) {
  const [full, setFull] = useState('');
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api(`boards/${encodeURIComponent(boardId)}/revisions/${revision.number}`)
      .then((value: { reason: string }) => setFull(value.reason))
      .catch((e: Error) => setError(e.message));
  };
  return (
    <>
      <strong>{full || revision.reason}</strong>
      {!full && revision.reasonTruncated && (
        <Button variant="outline" size="sm" onClick={load}>
          Показать причину полностью
        </Button>
      )}
      {error && (
        <span role="alert" className="text-destructive text-sm">
          Причина не загрузилась: {error}{' '}
          <Button variant="outline" size="sm" onClick={load}>
            Повторить
          </Button>
        </span>
      )}
    </>
  );
}
// Длинное описание ChangeSet в сводке сокращено; целиком — из деталей.
function ChangeSetDescription({
  id,
  text,
  truncated,
}: {
  id: string;
  text: string;
  truncated: boolean;
}) {
  const [full, setFull] = useState('');
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api(`changesets/${encodeURIComponent(id)}?limit=1`)
      .then((value: { description: string }) => setFull(value.description))
      .catch((e: Error) => setError(e.message));
  };
  return (
    <>
      <p>{full || text}</p>
      {!full && truncated && (
        <Button variant="outline" size="sm" onClick={load}>
          Показать описание полностью
        </Button>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          Описание не загрузилось: {error}{' '}
          <Button variant="outline" size="sm" onClick={load}>
            Повторить
          </Button>
        </p>
      )}
    </>
  );
}
// История проверок ChangeSet и снимки задач любой проверки — по запросу:
// в сводке только последняя проверка без снимка.
function ChangeSetHistory({
  id,
  count,
  revision,
}: {
  id: string;
  count: number;
  revision: string;
}) {
  type Verification = {
    id: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    taskCount: number;
    error?: string;
    evidence: { gate: string; passed: boolean; summary: string }[];
  };
  type Page<T> = { total: number; items: T[]; next: number | null };
  // История дописывается: страницы — по стабильному курсору `before`.
  type History = { total: number; items: Verification[]; nextBefore: number | null };
  type SnapshotTask = { id: string; title: string; status: string; resultSha?: string };
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<History>();
  // Снимок, который выбран последним: ответ и ошибка прежнего выбора
  // отбрасываются.
  const wanted = useRef('');
  // Поколение истории: перезагрузка первой страницы (новая сводка) начинает
  // новый набор, и продолжение, запрошенное для прежнего, его не дополняет —
  // иначе в непрерывной истории осталась бы дыра.
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<{ verificationId: string } & Page<SnapshotTask>>();
  // Сбой хранит свой повтор: «Повторить» повторяет именно неудавшийся запрос
  // (историю, её следующую страницу или снимок задач), а не первую страницу.
  const [failure, setFailure] = useState<{ what: string; message: string; retry: () => void }>();
  const [attempt, setAttempt] = useState(0);
  const base = `changesets/${encodeURIComponent(id)}`;
  useEffect(() => {
    if (!open) return;
    let valid = true;
    generation.current += 1;
    setFailure(undefined);
    api(`${base}?limit=10`)
      .then((value: { history: History }) => valid && setHistory(value.history))
      .catch(
        (e: Error) =>
          valid &&
          setFailure({
            what: 'История не загрузилась',
            message: e.message,
            retry: () => setAttempt((n) => n + 1),
          }),
      );
    return () => {
      valid = false;
    };
  }, [open, base, revision, attempt]);
  const more = (before: number) => {
    setFailure(undefined);
    const mine = generation.current;
    return api(`${base}?limit=10&before=${before}`)
      .then((value: { history: History }) => {
        if (mine !== generation.current) return;
        // Страницы сливаются по id в порядке «новые сначала»: повторный или
        // опоздавший ответ не задвоит записи и не обрежет уже загруженные.
        setHistory((prev) => {
          const byId = new Map(
            [...(prev?.items ?? []), ...value.history.items].map((v) => [v.id, v]),
          );
          return {
            total: value.history.total,
            items: [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
            nextBefore:
              prev?.nextBefore === null || value.history.nextBefore === null
                ? null
                : Math.min(prev?.nextBefore ?? Infinity, value.history.nextBefore),
          };
        });
      })
      .catch((e: Error) => {
        if (mine !== generation.current) return;
        setFailure({
          what: 'Ранние проверки не загрузились',
          message: e.message,
          retry: () => void more(before),
        });
      });
  };
  const showSnapshot = (verification: string, cursor = 0): Promise<void> => {
    setFailure(undefined);
    if (!cursor) wanted.current = verification;
    return api(`${base}?limit=1&verification=${verification}&taskLimit=50&taskCursor=${cursor}`)
      .then((value: { snapshot: { verificationId: string } & Page<SnapshotTask> }) => {
        if (verification !== wanted.current) return;
        // Снимок неизменен: страница встаёт на своё смещение, не обрезая
        // уже загруженное дальше неё.
        // Повтор первой страницы того же снимка тоже встаёт на место.
        setSnapshot((prev) =>
          prev?.verificationId === verification
            ? (() => {
                const items = [
                  ...prev.items.slice(0, cursor),
                  ...value.snapshot.items,
                  ...prev.items.slice(cursor + value.snapshot.items.length),
                ];
                return {
                  ...value.snapshot,
                  items,
                  next: items.length < value.snapshot.total ? items.length : null,
                };
              })()
            : value.snapshot,
        );
      })
      .catch((e: Error) => {
        if (verification !== wanted.current) return;
        setFailure({
          what: 'Снимок задач не загрузился',
          message: e.message,
          retry: () => void showSnapshot(verification, cursor),
        });
      });
  };
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>История проверок ({count})</summary>
      {failure && (
        <p role="alert" className="text-destructive text-sm">
          {failure.what}: {failure.message}{' '}
          <Button variant="outline" size="sm" onClick={failure.retry}>
            Повторить
          </Button>
        </p>
      )}
      {open && !history && !failure && <p role="status">Загрузка истории…</p>}
      {history && (
        <ol className="grid gap-2">
          {history.items.map((h) => (
            <li key={h.id} className="text-sm">
              <StatusBadge
                value={
                  h.status === 'passed' ? 'done' : h.status === 'active' ? 'running' : 'failed'
                }
              >
                {h.status === 'passed' ? 'PASS' : h.status === 'active' ? 'идёт' : 'FAIL'}
              </StatusBadge>{' '}
              {stamp(h.startedAt)} ·{' '}
              {h.evidence.map((e) => `${e.passed ? '✓' : '✗'} ${e.gate}`).join(', ')}
              {h.error && <span className="text-destructive"> · {h.error}</span>}{' '}
              <Button variant="outline" size="sm" onClick={() => void showSnapshot(h.id)}>
                Снимок задач ({h.taskCount})
              </Button>
              {snapshot?.verificationId === h.id && (
                <ul aria-label={`Снимок задач проверки ${h.id}`} className="mt-1 grid gap-1">
                  {snapshot.items.map((t) => (
                    <li key={t.id}>
                      {t.id} · {t.title} ·{' '}
                      {(statusNames as Record<string, string>)[t.status] ?? t.status}
                      {t.resultSha && <code> {t.resultSha.slice(0, 8)}</code>}
                    </li>
                  ))}
                  {snapshot.next !== null && (
                    <li>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void showSnapshot(h.id, snapshot.next!)}
                      >
                        Ещё задачи ({snapshot.total - snapshot.items.length})
                      </Button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      {history?.nextBefore != null && (
        <Button variant="outline" size="sm" onClick={() => void more(history.nextBefore!)}>
          Ранние проверки ({history.total - history.items.length})
        </Button>
      )}
    </details>
  );
}
// Текст контракта не входит в периодическую сводку: загружается при раскрытии.
function ContractText({ id, bytes }: { id: string; bytes: number }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api(`contracts/${encodeURIComponent(id)}`)
      .then((c: { content: string }) => setText(c.content))
      .catch((e: Error) => setError(e.message));
  };
  return (
    <details onToggle={(e) => (e.currentTarget.open && text === undefined ? load() : undefined)}>
      <summary>Текст контракта ({Math.ceil(bytes / 1024)} КБ)</summary>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}{' '}
          <Button variant="outline" size="sm" onClick={load}>
            Повторить
          </Button>
        </p>
      ) : text === undefined ? (
        <p role="status">Загрузка…</p>
      ) : (
        <pre>{text}</pre>
      )}
    </details>
  );
}
function StatusBadge({ value, children }: { value: string; children?: ReactNode }) {
  const known = statusOfKey(value);
  return <Badge variant={known.badge}>{children ?? known.label}</Badge>;
}
async function api(path: string, input?: unknown, method = 'POST') {
  const response = await fetch(
    '/api/' + path,
    input === undefined
      ? undefined
      : {
          method,
          headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
          body: JSON.stringify(input),
        },
  );
  // Ответ без JSON (прокси, сбой сервера) называется по коду ответа, а не
  // сырым «Unexpected token» парсера.
  const data = await response.json().catch(() => undefined);
  if (!response.ok || data === undefined)
    throw new Error(
      data?.error ??
        `сервер ответил ${response.status}${response.statusText ? ' ' + response.statusText : ''}`,
    );
  return data;
}
// Сетевой отказ fetch — английское «Failed to fetch»: для человека это
// «сервер не отвечает», с адресом, который он открыл.
function humanError(message: string) {
  return /failed to fetch|networkerror|load failed/i.test(message)
    ? `Сервер DevContour не отвечает по адресу ${window.location.host}. Проверьте, что devcontour serve запущен.`
    : message;
}
// Экраны workspace — в боковой навигации; у доски свои вкладки. Вид, доска и
// задача — в адресе: ссылка ведёт к доказательству, «Назад» возвращает вид.
const boardTabs = [
  { key: 'graph', label: 'Граф' },
  { key: 'list', label: 'Список' },
  { key: 'kanban', label: 'Колонки' },
  { key: 'progress', label: 'Ход работ' },
  { key: 'history', label: 'Ревизии' },
] as const;
const workspaceScreens = [
  { key: 'overview', label: 'Обзор' },
  { key: 'product', label: 'Карта продукта' },
  { key: 'workspace', label: 'Общий граф' },
  { key: 'changesets', label: 'Изменения' },
  { key: 'contracts', label: 'Контракты' },
] as const;
const isBoardTab = (tab: string) => boardTabs.some((t) => t.key === tab);
function readAppLocation() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab') ?? '';
  const known = isBoardTab(tab) || workspaceScreens.some((s) => s.key === tab);
  return {
    tab: known ? tab : 'overview',
    board: params.get('board') ?? '',
    task: params.get('task') ?? '',
  };
}
function appHref(tab: string) {
  const params = new URLSearchParams(window.location.search);
  for (const key of ['tab', 'board', 'task']) params.delete(key);
  if (tab !== 'overview') params.set('tab', tab);
  const search = params.toString();
  return window.location.pathname + (search ? '?' + search : '');
}
// Задача, которая держит приёмку: незавершённая, без незакрытых зависимостей,
// и от неё (прямо или через других) ждёт больше всего задач доски.
function holdingTask(tasks: UITask[]) {
  const open = tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
  const openIds = new Set(open.map((t) => t.id));
  const dependents = new Map<string, string[]>();
  for (const t of open)
    for (const d of t.dependsOn) dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
  const reach = (id: string) => {
    const seen = new Set<string>();
    const queue = [...(dependents.get(id) ?? [])];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next) || !openIds.has(next)) continue;
      seen.add(next);
      queue.push(...(dependents.get(next) ?? []));
    }
    return seen;
  };
  let best: { task: UITask; waiting: Set<string> } | undefined;
  for (const t of open) {
    if (t.blockers.length) continue;
    const waiting = reach(t.id);
    if (waiting.size && (!best || waiting.size > best.waiting.size)) best = { task: t, waiting };
  }
  return best;
}
const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10,
    mod100 = n % 100;
  return mod10 === 1 && mod100 !== 11
    ? one
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? few
      : many;
};
function Modal({
  title,
  children,
  onClose,
  error,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  error?: string;
}) {
  // Radix marks the rest of the page inert while this is open, so background
  // graph nodes stop competing for the same accessible names.
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <div className="mb-5 flex items-center justify-between gap-4">
          <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
        </div>
        <DialogDescription className="sr-only">
          Диалог {title}. Закройте его, чтобы вернуться к доске.
        </DialogDescription>
        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}
// Подзаголовок экрана workspace: что на нём и для чего.
const workspaceNotes: Record<string, string> = {
  overview: 'Что можно попробовать, какое решение нужно и что делает система.',
  product: 'Пользовательские возможности, приложения и проверенный результат.',
  workspace: 'Задачи всех досок и связи между ними.',
  changesets:
    'Одна возможность продукта, несколько репозиториев. Приёмка фиксирует проверенную комбинацию SHA.',
  contracts:
    'Новая версия создаётся отдельным контрактом. Задачи закрепляют его содержимое при утверждении.',
};
// Описание задачи в инспекторе — три строки, целиком по запросу: длинная
// постановка отодвигала «что нужно» и доказательства за сгиб.
function TaskDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split('\n').length > 3;
  return (
    <div className="mt-2">
      <p
        className={cn(
          'text-muted-foreground m-0 break-words whitespace-pre-wrap',
          long && !open && 'line-clamp-3',
        )}
      >
        {text}
      </p>
      {long && (
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Свернуть' : 'Показать полностью'}
        </Button>
      )}
    </div>
  );
}
export function App() {
  const flowRef =
    useRef<(options: { padding: number; minZoom: number; maxZoom: number }) => Promise<boolean>>(
      null,
    );
  const [data, setData] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [boardId, setBoardId] = useState(() => readAppLocation().board);
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null);
  const [selected, setSelected] = useState(() => readAppLocation().task);
  // Задача из ссылки и задача, оставленная в инспекторе вне показанной ревизии.
  const linkedTask = useRef(readAppLocation().task);
  const [outside, setOutside] = useState('');
  // An empty graph is the least informative thing to land on: before the first
  // board exists, what the operator needs to see is how the contour is set up.
  // Автор продукта начинает с обзора: что попробовать и какое решение нужно.
  const [tab, setTab] = useState(() => readAppLocation().tab);
  // Экран доски — одна из её вкладок; остальное — экраны всего workspace.
  const boardScreen = isBoardTab(tab);
  // Выбор доски из workspace открывает её последнюю вкладку (сначала —
  // колонки, как привычная доска задач).
  const [boardTab, setBoardTab] = useState(() =>
    isBoardTab(readAppLocation().tab) ? readAppLocation().tab : 'kanban',
  );
  useEffect(() => {
    if (boardScreen) setBoardTab(tab);
  }, [tab, boardScreen]);
  // Адрес: замена записи для выбора задачи и первой записи, новая запись —
  // для смены вида или доски. Чужие параметры адреса (этап подготовки)
  // сохраняются.
  const wroteLocation = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const before = new URLSearchParams(params);
    for (const key of ['tab', 'board', 'task']) params.delete(key);
    if (tab !== 'overview') params.set('tab', tab);
    if (boardScreen && boardId) params.set('board', boardId);
    if ((boardScreen || tab === 'workspace') && selected) params.set('task', selected);
    const search = params.toString();
    const next = window.location.pathname + (search ? '?' + search : '');
    if (next === window.location.pathname + window.location.search) {
      wroteLocation.current = true;
      return;
    }
    // Дописанные недостающие доска и задача (адрес `?tab=kanban` без доски,
    // восстановленный «Назад») заменяют запись: иначе каждый «Назад»
    // возвращал на тот же адрес и затирал историю вперёд.
    const sameView =
      before.get('tab') === params.get('tab') &&
      (!before.get('board') || before.get('board') === params.get('board'));
    window.history[!wroteLocation.current || sameView ? 'replaceState' : 'pushState'](
      window.history.state,
      '',
      next,
    );
    wroteLocation.current = true;
  }, [tab, boardId, selected, boardScreen]);
  const shownBoard = useRef(boardId);
  shownBoard.current = boardId;
  useEffect(() => {
    const restore = () => {
      const place = readAppLocation();
      setTab(place.tab);
      // Другая доска — как при выборе в навигации: последняя ревизия, без
      // прежнего поиска.
      if (place.board && place.board !== shownBoard.current) {
        setBoardId(place.board);
        setRevisionNumber(null);
        setQuery('');
      }
      setSelected(place.task);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  // Переход из обзора к проверке изменения: фокус и прокрутка к его карточке.
  const [focusChange, setFocusChange] = useState('');
  useEffect(() => {
    if (!focusChange || tab !== 'changesets') return;
    const element = document.getElementById('changeset-' + focusChange);
    if (!element) return;
    element.scrollIntoView({ block: 'start' });
    element.focus();
    setFocusChange('');
    // Карточка появляется после отрисовки вкладки и очередного опроса.
  }, [focusChange, tab, data]);
  const [query, setQuery] = useState('');
  // Отменённые задачи — история перепланирования. На пилоте их было 70 из
  // 83, и граф из них не давал увидеть живую работу; показываются по запросу.
  const [showCancelled, setShowCancelled] = useState(false);
  const [repositoryFilter, setRepositoryFilter] = useState('');
  const [modal, setModal] = useState<
    'board' | 'task' | 'edit' | 'correct' | 'contract' | 'changeset' | null
  >(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [impact, setImpact] = useState<{
    taskIds: string[];
    boards: { id: string; title: string }[];
  }>();
  const [log, setLog] = useState<{ title: string; content: string }>();
  // Что показывает панель: от этого зависит состав сводки. Номер состояния
  // привязан к области, для которой он получен: после смены области (или
  // неудачной загрузки новой) запрос идёт без номера и возвращает полную
  // сводку. Ответ, пришедший для прежней области, отбрасывается.
  const view = useRef<{
    boardId: string;
    /** Прежняя ревизия доски, которую смотрят: её задачи входят в сводку. */
    boardRevision?: number;
    selected: string;
    workspace: boolean;
    accepted: boolean;
    revision?: string;
    revisionScope?: string;
    expiresAt?: number;
  }>({ boardId: '', selected: '', workspace: false, accepted: false });
  const [pollError, setPollError] = useState('');
  // Поколение запроса: ответ старше уже применённого (он опоздал, пока шёл
  // более новый запрос той же области) отбрасывается, как и его ошибка.
  const issued = useRef(0);
  const dataScope = useRef<{ board: string; task: string }>({ board: '', task: '' });
  const applied = useRef(0);
  const refresh = useCallback(async (force = true) => {
    const generation = ++issued.current;
    const v = view.current;
    const key = (x: typeof v, board = x.boardId) =>
      `${board}|${x.boardRevision ?? ''}|${x.selected}|${x.workspace}|${x.accepted}`;
    const scope = key(v);
    const params = new URLSearchParams();
    if (v.boardId) params.set('board', v.boardId);
    if (v.boardRevision) params.set('boardRevision', String(v.boardRevision));
    if (v.selected) params.set('task', v.selected);
    if (v.workspace) params.set('view', 'workspace');
    if (v.workspace && v.accepted) params.set('accepted', '1');
    // Истёкший lease операции workspace меняет доступность задач без записи.
    const expired = v.expiresAt !== undefined && Date.now() >= v.expiresAt;
    if (!force && !expired && v.revision !== undefined && v.revisionScope === scope)
      params.set('revision', v.revision);
    let next: Snapshot | { unchanged: true; revision: string };
    try {
      next = (await api('summary?' + params.toString())) as typeof next;
    } catch (e) {
      if (generation < applied.current) return;
      throw e;
    }
    if (key(view.current) !== scope) return;
    if (generation < applied.current) return;
    applied.current = generation;
    setPollError('');
    if ('unchanged' in next) return;
    // Без явной доски сервер выбирает её сам: номер относится к ней, и
    // переход панели на эту же доску не требует новой полной сводки.
    Object.assign(v, {
      revision: next.revision,
      revisionScope: key(v, v.boardId || (next.boardId ?? '')),
      expiresAt: next.expiresAt,
    });
    // Для какой доски и задачи получены данные: по ним видно, что доски или
    // задачи из ссылки на сервере нет, а не что ответ ещё не пришёл.
    dataScope.current = { board: v.boardId, task: v.selected };
    setData(next);
  }, []);
  useEffect(() => {
    let alive = true;
    // Сбой опроса виден строкой и не стирает показанное; следующий успешный
    // опрос её снимает.
    const load = () =>
      refresh(false).catch((e: Error) => {
        if (alive) setPollError(e.message);
      });
    void load();
    const id = setInterval(() => {
      void load();
    }, 1800);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refresh]);
  // Панель открывается обзором для автора продукта: что попробовать и какое
  // решение нужно. Граф и списки — технические представления, к ним
  // переходят вкладкой. Раньше при наличии задач панель сама открывала граф.
  useEffect(() => {
    if (!data) return;
    if (!boardId) setBoardId(data.boardId ?? liveBoards(data)[0]?.id ?? '');
    // Доски из адреса нет (удалена, устаревшая ссылка): сервер ответил по
    // своей доске — панель переходит на неё, а не показывает пустой экран.
    else if (
      dataScope.current.board === boardId &&
      !data.boards.some((b) => b.id === boardId) &&
      data.boardId
    ) {
      toast.error('Доска из ссылки не найдена — открыта текущая доска');
      setBoardId(data.boardId);
      setRevisionNumber(null);
      setSelected('');
    }
  }, [data, boardId]);
  // Смена доски, задачи или вида меняет состав сводки — запрос сразу.
  const [showAccepted, setShowAccepted] = useState(false);
  useEffect(() => {
    const v = view.current;
    const workspace = tab === 'workspace';
    const missing = !!selected && !!data && !data.tasks.some((t) => t.id === selected);
    // Пустая доска — та, что сервер выбрал по умолчанию.
    const effective = (id: string) => id || data?.boardId || '';
    // Прежняя ревизия: её задач нет в сводке текущей доски — запрос сразу.
    const latest = data?.board?.revisions.at(-1)?.number;
    const boardRevision =
      revisionNumber !== null && revisionNumber !== latest ? revisionNumber : undefined;
    const changed =
      effective(v.boardId) !== effective(boardId) ||
      v.boardRevision !== boardRevision ||
      v.workspace !== workspace ||
      v.accepted !== showAccepted;
    // Задача входит в область сводки, только если её нет в показанных данных
    // (прямая ссылка, задача другой доски): выбор задачи, которая уже есть,
    // не должен стоить полной сводки. Запрошенная так задача остаётся в
    // области, пока выбрана, — иначе она снова выпала бы из сводки.
    const wanted = missing || (!!selected && v.selected === selected) ? selected : '';
    Object.assign(v, {
      boardId,
      boardRevision,
      selected: wanted,
      workspace,
      accepted: showAccepted,
    });
    if (changed || missing) void refresh().catch((e: Error) => setPollError(e.message));
  }, [boardId, revisionNumber, selected, tab, showAccepted, data, refresh]);
  const board = data?.board?.id === boardId ? data.board : undefined;
  const revision =
    board?.revisions.find((r) => r.number === revisionNumber) ?? board?.revisions.at(-1);
  // История ревизий: в сводке — последние и выбранная; ранние — страницами
  // по стабильному курсору, сливаются по номеру.
  type RevisionLine = NonNullable<typeof board>['revisions'][number];
  const [older, setOlder] = useState<{
    boardId: string;
    items: RevisionLine[];
    nextBefore: number | null;
  }>();
  const olderOwn = older?.boardId === board?.id ? older : undefined;
  const shownRevisions = [
    ...new Map(
      [...(board?.revisions ?? []), ...(olderOwn?.items ?? [])].map((r) => [r.number, r]),
    ).values(),
  ].sort((a, b) => b.number - a.number);
  const revisionsBefore = olderOwn
    ? (olderOwn.nextBefore ?? 0)
    : Math.max(0, (board?.revisionCount ?? 0) - (board?.revisions.length ?? 0));
  const loadOlderRevisions = async () => {
    if (!board || !revisionsBefore) return;
    const id = board.id;
    setRevisionsError('');
    try {
      const page = (await api(
        `boards/${encodeURIComponent(id)}/revisions?limit=20&before=${revisionsBefore}`,
      )) as { items: RevisionLine[]; nextBefore: number | null };
      setOlder((prev) => ({
        boardId: id,
        items: [...(prev?.boardId === id ? prev.items : []), ...page.items],
        nextBefore: page.nextBefore,
      }));
    } catch (e) {
      setRevisionsError((e as Error).message);
    }
  };
  const [revisionsError, setRevisionsError] = useState('');
  const current = revision?.number === board?.revisions.at(-1)?.number;
  const editable = revision?.status === 'active' && current && boardScreen;
  const tasks = useMemo(
    () => data?.tasks.filter((t) => revision?.taskIds.includes(t.id)) ?? [],
    [data, revision],
  );
  const graphTasks = useMemo(
    () =>
      tab === 'workspace'
        ? (data?.tasks.filter((t) => data.workspaceTaskIds?.includes(t.id)) ?? [])
        : tasks,
    [tab, data, tasks],
  );
  const cancelledCount = graphTasks.filter((t) => t.status === 'cancelled').length;
  const filtered = graphTasks.filter(
    (t) =>
      (showCancelled || t.status !== 'cancelled') &&
      (!repositoryFilter || t.repositoryId === repositoryFilter) &&
      `${t.title} ${t.id} ${t.repositoryId} ${roleLabel(t.role)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  // Задача из ссылки вне показанной ревизии остаётся в инспекторе с пометкой.
  const task =
    graphTasks.find((t) => t.id === selected) ??
    (selected && selected === outside ? data?.tasks.find((t) => t.id === selected) : undefined);
  // Детали выбранной задачи — по запросу: полная запись и попытки страницами.
  // Ранние страницы берутся курсором по id попытки (он не сдвигается, когда
  // появляются новые попытки); уже раскрытые страницы при обновлении задачи
  // перезагружаются целиком, ответ для другой задачи отбрасывается.
  const [detail, setDetail] = useState<TaskDetail>();
  const [olderRuns, setOlderRuns] = useState<Run[]>([]);
  const [detailError, setDetailError] = useState('');
  const [detailAttempt, setDetailAttempt] = useState(0);
  const olderCount = useRef(0);
  const detailFor = useRef('');
  const detailKey = task ? `${task.id}@${data?.revision}#${detailAttempt}` : '';
  useEffect(() => {
    if (!detailKey) return;
    const id = detailKey.slice(0, detailKey.indexOf('@'));
    if (detailFor.current !== id) {
      detailFor.current = id;
      olderCount.current = 0;
      setOlderRuns([]);
      setOlderError('');
    }
    let valid = true;
    setDetailError('');
    const path = `tasks/${encodeURIComponent(id)}`;
    (async () => {
      const next = (await api(`${path}?limit=10`)) as TaskDetail;
      let older: Run[] = [];
      let before = next.runs.nextBefore;
      while (before && older.length < olderCount.current) {
        const page = (await api(
          `${path}/runs?limit=50&before=${encodeURIComponent(before)}`,
        )) as TaskDetail['runs'];
        older = [...older, ...page.items];
        before = page.nextBefore;
      }
      if (!valid || detailFor.current !== id) return;
      setDetail(next);
      setOlderRuns(older);
    })().catch((e: Error) => valid && setDetailError(e.message));
    return () => {
      valid = false;
    };
  }, [detailKey]);
  const full = detail?.task.id === task?.id ? detail : undefined;
  const taskRuns = full
    ? [...new Map([...full.runs.items, ...olderRuns].map((r) => [r.id, r])).values()].reverse()
    : [];
  const [olderError, setOlderError] = useState('');
  const loadOlderRuns = async () => {
    setOlderError('');
    if (!full) return;
    const id = full.task.id;
    const before = olderRuns.at(-1)?.id ?? full.runs.items.at(-1)?.id;
    if (!before) return;
    try {
      const page = (await api(
        `tasks/${encodeURIComponent(id)}/runs?limit=20&before=${encodeURIComponent(before)}`,
      )) as TaskDetail['runs'];
      if (detailFor.current !== id) return;
      setOlderRuns((runs) => {
        // Повторный клик приносит ту же страницу: попытки — по id без повторов.
        const merged = [...new Map([...runs, ...page.items].map((r) => [r.id, r])).values()];
        olderCount.current = merged.length;
        return merged;
      });
    } catch (e) {
      // Сбой ранней страницы — свой: его повтор берёт ту же страницу, а не
      // перезагружает первую.
      setOlderError((e as Error).message);
    }
  };
  // Задача из ссылки показывается, даже если она отменена или из прежней
  // ревизии: раньше её молча заменяла первая задача доски.
  useEffect(() => {
    const linked = linkedTask.current;
    if (linked && selected === linked && data) {
      const t = data.tasks.find((x) => x.id === linked);
      if (!t) {
        // Сервер спрашивали именно об этой задаче, и её нет.
        if (dataScope.current.task !== linked) return;
        linkedTask.current = '';
        toast.error('Задача из ссылки не найдена');
      } else if (graphTasks.some((x) => x.id === linked)) {
        linkedTask.current = '';
        if (t.status === 'cancelled' && !showCancelled) setShowCancelled(true);
        return;
      } else {
        const own = board?.revisions.find((r) => r.taskIds.includes(linked));
        if (own && own.number !== revision?.number) return setRevisionNumber(own.number);
        if (t.boardId && t.boardId !== boardId && tab !== 'workspace') return setBoardId(t.boardId);
        linkedTask.current = '';
        setOutside(linked);
        return;
      }
    }
    if (selected && selected === outside) return;
    const visible = graphTasks.filter((t) => showCancelled || t.status !== 'cancelled');
    if (visible.length && !visible.some((t) => t.id === selected)) setSelected(visible[0].id);
  }, [graphTasks, selected, showCancelled, data, board, revision, boardId, tab, outside]);
  useEffect(() => {
    let valid = true;
    if (modal !== 'correct' || !roots.length) {
      setImpact(undefined);
      return;
    }
    api(`boards/${boardId}/impact?roots=${roots.join(',')}`)
      .then((v) => {
        if (valid) setImpact(v);
      })
      .catch((e) => {
        if (valid) setError(e.message);
      });
    return () => {
      valid = false;
    };
  }, [modal, boardId, roots]);
  // Кадр графа: вписывается при смене размера и состава узлов, пока человек
  // сам не сдвинул или не приблизил граф. Смена доски, ревизии или вида
  // возвращает автоматическое вписывание.
  const userMoved = useRef(false);
  const fit = useCallback(() => {
    if (!userMoved.current) void flowRef.current?.({ padding: 0.12, minZoom: 0.75, maxZoom: 1 });
  }, []);
  const observer = useRef<ResizeObserver>(null);
  const canvasRef = useCallback(
    (element: HTMLDivElement | null) => {
      observer.current?.disconnect();
      if (!element) return;
      observer.current = new ResizeObserver(() => fit());
      observer.current.observe(element);
    },
    [fit],
  );
  useEffect(() => () => observer.current?.disconnect(), []);
  useEffect(() => {
    userMoved.current = false;
  }, [boardId, revision?.number, tab]);
  // Итог действия — уведомление поверх экрана (Sonner): поток страницы не
  // сдвигается, цель клика не уезжает. Ошибка в открытом диалоге показывается
  // в диалоге, иначе — уведомлением, которое закрывает человек.
  async function act(fn: () => Promise<unknown>, message: string, close = true) {
    setBusy(true);
    setError('');
    const inDialog = !!modal || !!log;
    try {
      await fn();
      await refresh();
      if (message) toast.success(message);
      if (close) setModal(null);
      return true;
    } catch (e) {
      const text = humanError(e instanceof Error ? e.message : String(e));
      if (inDialog) setError(text);
      else toast.error(text, { duration: Infinity, closeButton: true });
      return false;
    } finally {
      setBusy(false);
    }
  }
  function switchBoard(id: string) {
    setBoardId(id);
    setRevisionNumber(null);
    setSelected('');
    setQuery('');
    // Выбор доски на экране workspace — просьба показать доску.
    if (!boardScreen) setTab(boardTab);
  }
  const titles = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t.title])), [data]);
  // Задача, которая держит приёмку доски, и путь от неё: единственная краска
  // данных на графе — рёбра этого пути.
  const holder = useMemo(
    () => (boardScreen ? holdingTask(tasks) : undefined),
    [boardScreen, tasks],
  );
  // След изменения статуса: статус задачи сменился между двумя снимками одной
  // области (не при первой загрузке и не при смене доски или фильтра).
  const previous = useRef<{ scope: string; statuses: Map<string, string> }>({
    scope: '',
    statuses: new Map(),
  });
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set());
  const changedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const scope = `${boardId}|${revision?.number}|${tab}|${query}|${repositoryFilter}`;
    const statuses = new Map(graphTasks.map((t) => [t.id, status(t)]));
    const prior = previous.current;
    previous.current = { scope, statuses };
    if (prior.scope !== scope) return;
    const ids = [...statuses]
      .filter(([id, value]) => prior.statuses.has(id) && prior.statuses.get(id) !== value)
      .map(([id]) => id);
    if (!ids.length) return;
    setChanged(new Set(ids));
    clearTimeout(changedTimer.current);
    changedTimer.current = setTimeout(() => setChanged(new Set()), 1300);
  }, [graphTasks, boardId, revision?.number, tab, query, repositoryFilter]);
  useEffect(() => () => clearTimeout(changedTimer.current), []);
  const graph = useMemo(() => {
    const columns = new Map<number, number>();
    const lv = levels(filtered);
    const styles = getComputedStyle(document.documentElement);
    const token = (key: string) => parseFloat(styles.getPropertyValue(key));
    const dx = token('--node-width') + token('--node-gap-x'),
      dy = token('--node-height') + token('--node-gap-y');
    // Подсвечены рёбра от задачи, которая держит приёмку, к тем, кого она
    // держит напрямую: остальной граф тише, чтобы находка читалась.
    const holds = holder?.task.id;
    return {
      nodes: filtered.map((t) => {
        const level = lv.get(t.id)!;
        const row = columns.get(level) ?? 0;
        columns.set(level, row + 1);
        const shown = taskStatus(t);
        return {
          id: t.id,
          type: 'task',
          position: { x: level * dx, y: row * dy },
          data: {
            id: t.id,
            shortId: shortId(t.id),
            title: t.title,
            repositoryId: t.repositoryId,
            role: roleLabel(t.role),
            status: shown.key,
            statusLabel: shown.label,
            tone: shown.tone,
            live: liveLabel(
              data?.runs.find((r) => r.id === t.activeRunId && r.status === 'active'),
            ),
            holds: holder?.task.id === t.id,
            changed: changed.has(t.id),
          },
          selected: t.id === selected,
          ariaLabel: `${t.id}: ${t.title}, ${shown.label}`,
        };
      }),
      edges: filtered.flatMap((t) =>
        t.dependsOn
          .filter((d) => filtered.some((t) => t.id === d))
          .map((d) => ({
            id: `${d}-${t.id}`,
            source: d,
            target: t.id,
            type: 'smoothstep',
            className: status(t) === 'done' ? 'edge-done' : d === holds ? 'edge-path' : '',
          })),
      ),
    };
  }, [filtered, selected, data, holder, changed]);
  const nodeSet = filtered.map((t) => t.id).join();
  useEffect(() => {
    const timer = setTimeout(fit, 60);
    return () => clearTimeout(timer);
  }, [nodeSet, fit]);
  // «/» — к поиску задач, как в привычных инструментах.
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!search.current) return;
      e.preventDefault();
      search.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Переключатель очереди: после успешного запроса кнопка остывает 600 мс —
  // нетерпеливый второй клик в ту же точку не ставит очередь обратно на паузу.
  const [queueBusy, setQueueBusy] = useState(false);
  const [cooling, setCooling] = useState(false);
  const cooldown = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(cooldown.current), []);
  const [loadingAgain, setLoadingAgain] = useState(false);
  // Переход на экран из боковой навигации переносит фокус к заголовку экрана:
  // клавиатура и чтение экрана начинаются с нового содержимого.
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  const openScreen = (key: string) => {
    focusHeading.current = true;
    setTab(key);
  };
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    heading.current?.focus();
  }, [tab]);
  if (!data)
    return (
      <main className="bg-frame grid min-h-dvh place-content-center justify-items-center gap-3 p-6 text-center">
        <Workflow aria-hidden="true" />
        <h1>DevContour</h1>
        {error || pollError ? (
          <>
            <p role="alert" className="text-destructive m-0 max-w-[60ch]">
              Состояние не загрузилось: {humanError(error || pollError)}
            </p>
            <Button
              variant="outline"
              disabled={loadingAgain}
              onClick={() => {
                setLoadingAgain(true);
                setError('');
                refresh()
                  .catch((e: Error) => setPollError(e.message))
                  .finally(() => setLoadingAgain(false));
              }}
            >
              {loadingAgain && <Loader2 className="animate-spin" aria-hidden="true" />}
              Повторить
            </Button>
          </>
        ) : (
          <p role="status" className="text-muted-foreground m-0">
            Загружаем рабочий граф…
          </p>
        )}
      </main>
    );
  // Имена ролей объявляет workspace, а нужны они и там, где конфигурации под
  // рукой нет: источник ставится один раз, как только состояние загружено.
  setRoleSource(data.config);
  // Счётчики полосы — в охвате доски: те же задачи, что на графе и в списке.
  const liveTasks = tasks.filter((t) => t.status !== 'cancelled');
  const done = liveTasks.filter((t) => t.status === 'done').length;
  const inWork = liveTasks.filter((t) => t.activeRunId).length;
  const failedCount = liveTasks.filter((t) => t.status === 'failed').length;
  const blocked = liveTasks.filter((t) => status(t) === 'blocked').length;
  const ready = liveTasks.filter((t) => status(t) === 'ready').length;
  const drafts = tasks.filter((t) => t.status === 'draft').length;
  // Полная последняя попытка — из деталей; до их загрузки — компактная строка.
  const latestRun: Run | PanelRun | undefined =
    full?.runs.items[0] ??
    (task ? data.runs.filter((r) => r.taskId === task.id).at(-1) : undefined);
  const taskRepository = data.config.repositories.find((r) => r.id === task?.repositoryId);
  const taskBinding = task
    ? (taskRepository?.roles?.[task.role] ?? data.config.roles[task.role])
    : undefined;
  const plannedReviewer = taskBinding?.reviewer ?? taskRepository?.reviewer ?? data.config.reviewer;
  const displayedRun = task && !['draft', 'ready'].includes(task.status) ? latestRun : undefined;
  const displayedWriter = displayedRun ?? taskBinding;
  const displayedReviewer = displayedRun
    ? { runtime: displayedRun.reviewer, model: displayedRun.reviewerModel }
    : plannedReviewer;
  const activeRuns = data.runs.filter((r) => r.status === 'active').length;
  // Одна залитая кнопка на экран — следующее решение по состоянию доски.
  const primary =
    !boardScreen || !board
      ? undefined
      : current && revision?.status === 'accepted'
        ? 'correct'
        : editable && drafts > 0
          ? 'approve'
          : editable && tasks.length > 0 && done === tasks.length
            ? 'accept'
            : undefined;
  // Запуск очереди — главное действие доски, только когда другого нет и
  // запускать есть что; иначе переключатель живёт в верхней строке.
  const queuePrimary = boardScreen && !primary && data.paused && data.ready.length > 0;
  const toggleQueue = async () => {
    const start = data.paused;
    setQueueBusy(true);
    const ok = await act(
      () => api('scheduler', { start }),
      start ? 'Очередь всех досок запущена' : 'Новые задачи приостановлены; текущие продолжаются',
      false,
    );
    setQueueBusy(false);
    if (!ok) return;
    setCooling(true);
    clearTimeout(cooldown.current);
    cooldown.current = setTimeout(() => setCooling(false), 600);
  };
  const queueButton = (main: boolean) => (
    <Button
      variant={main ? 'default' : 'outline'}
      size={main ? 'default' : 'sm'}
      className={main ? 'min-w-44' : 'min-w-36'}
      disabled={busy || cooling || (data.paused && !data.ready.length)}
      aria-busy={queueBusy || undefined}
      onClick={() => void toggleQueue()}
    >
      {queueBusy ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : data.paused ? (
        <Play />
      ) : (
        <Pause />
      )}
      {queueBusy
        ? data.paused
          ? 'Запускаем…'
          : 'Ставим на паузу…'
        : data.paused
          ? 'Запустить очередь'
          : 'Пауза очереди'}
    </Button>
  );
  const screenTitle = boardScreen
    ? (board?.title ?? 'Создайте первую доску')
    : (workspaceScreens.find((s) => s.key === tab)?.label ?? 'Обзор');
  const openTask = (id: string) => {
    setQuery('');
    setSelected(id);
  };
  // Строка-находка под заголовком доски: что держит приёмку и какое следующее
  // решение. Одна строка, высота не меняется при опросе.
  const finding: ReactNode = (() => {
    if (!boardScreen) return workspaceNotes[tab];
    if (!board) return 'Опишите цель, добавьте задачи и их зависимости.';
    if (revision?.status === 'accepted')
      return (
        <span className="text-success">
          Ревизия {revision.number} принята {stamp(revision.acceptedAt)}. Снимок сохранён
          {revision.snapshot && (
            <>
              {' '}
              <code>{revision.snapshot.sha.slice(0, 8)}</code>
            </>
          )}
          ; изменения начнут новый цикл и сохранят эту историю.
        </span>
      );
    if (!liveTasks.length)
      return board.description ?? 'Добавьте первый результат и критерии его приёмки.';
    if (done === liveTasks.length) return 'Все задачи проверены — доску можно принять.';
    const link = (t: { id: string; title: string }) => (
      <button
        type="button"
        className="text-info cursor-pointer font-medium hover:underline"
        onClick={() => openTask(t.id)}
      >
        {t.title}
      </button>
    );
    const stuck = chainBlockers(tasks, data.config.maxAttempts).filter((b) =>
      tasks.some((t) => t.id === b.taskId),
    )[0];
    if (stuck)
      return (
        <>
          Приёмку держит {link({ id: stuck.taskId, title: stuck.title })}: {stuck.reason}.{' '}
          <span className="text-muted-foreground">
            Нужно: {stuck.next}
            {stuck.waiting
              ? ` · ждут ${stuck.waiting} ${plural(stuck.waiting, 'задача', 'задачи', 'задач')}`
              : ''}
            .
          </span>
        </>
      );
    if (holder) {
      const t = holder.task;
      const run = data.runs.find((r) => r.id === t.activeRunId && r.status === 'active');
      const n = holder.waiting.size;
      return (
        <>
          Приёмку держит {link(t)}: от неё {plural(n, 'ждёт', 'ждут', 'ждут')} {n}{' '}
          {plural(n, 'задача', 'задачи', 'задач')}.{' '}
          <span className="text-muted-foreground">
            {run
              ? `Сейчас: ${phaseLabel[run.phase] ?? run.phase}.`
              : t.status === 'draft'
                ? 'План не утверждён.'
                : t.status === 'failed'
                  ? 'Сбой, нужен повтор.'
                  : data.paused
                    ? 'Готова к запуску, ждёт очередь.'
                    : 'Готова, ждёт свободного исполнителя.'}
          </span>
        </>
      );
    }
    if (inWork) return `Идёт работа: в работе ${inWork}, принято ${done} из ${liveTasks.length}.`;
    if (drafts) return 'План собран и ждёт утверждения: черновики очередь не выдаёт.';
    return board.description ?? `Принято ${done} из ${liveTasks.length}.`;
  })();
  const showInspector = boardScreen ? tab !== 'progress' && tab !== 'history' : tab === 'workspace';
  const showToolbar =
    (boardScreen && tab !== 'progress' && tab !== 'history') || tab === 'workspace';
  const onTabKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const keys = boardTabs.map((t) => t.key as string);
    const at = keys.indexOf(tab);
    const next =
      e.key === 'ArrowRight'
        ? (at + 1) % keys.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + keys.length) % keys.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? keys.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(keys[next]);
    document.getElementById('tab-' + keys[next])?.focus();
  };
  // Отменённая задача ничего не ждёт: в «От неё зависят» её нет.
  const dependents = task
    ? data.tasks.filter((t) => t.dependsOn.includes(task.id) && t.status !== 'cancelled')
    : [];
  const evidence = full?.runs.items[0]?.evidence ?? [];
  return (
    <div className="bg-frame grid min-h-dvh grid-cols-[var(--sidebar-width)_minmax(0,1fr)] max-[1180px]:grid-cols-[var(--sidebar-width-narrow)_minmax(0,1fr)] max-[760px]:block min-[1181px]:h-dvh min-[1181px]:overflow-hidden">
      <aside className="flex min-h-0 min-w-0 flex-col gap-0.5 px-2 pt-3 pb-3 max-[760px]:gap-1 max-[760px]:px-4 max-[760px]:pb-1 min-[761px]:overflow-y-auto">
        <a
          className="text-foreground flex items-center gap-2 px-2 pt-0.5 pb-1 text-sm font-semibold no-underline"
          href="/"
          aria-label="DevContour, главная"
          // Главная — обзор в этой же панели: без перезагрузки и без выхода
          // из режима разработки на экране подготовки.
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            openScreen('overview');
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            aria-hidden="true"
            className="text-info shrink-0"
          >
            <path
              d="M3 5h5v4H3zM12 11h5v4h-5zM8 7h2v6h2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </svg>
          DevContour
        </a>
        <p
          className="text-muted-foreground m-0 truncate px-2 pb-3 text-xs"
          title={data.config.name}
        >
          {data.config.name} · локальный workspace
        </p>
        <nav
          aria-label="Workspace"
          className="grid gap-0.5 max-[760px]:flex max-[760px]:gap-1 max-[760px]:overflow-x-auto max-[760px]:pb-1"
        >
          {workspaceScreens.map((s) => (
            <a
              key={s.key}
              href={appHref(s.key)}
              aria-current={tab === s.key ? 'page' : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                openScreen(s.key);
              }}
              className={cn(
                'text-foreground flex h-8 shrink-0 items-center rounded-sm px-2 text-sm whitespace-nowrap no-underline transition-colors duration-(--duration-hover) hover:bg-raised',
                tab === s.key && 'bg-active hover:bg-active font-medium',
              )}
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="text-muted-foreground mt-4 flex items-center justify-between px-2 text-xs max-[760px]:mt-1">
          <span>Доски</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Создать доску"
            onClick={() => setModal('board')}
          >
            <Plus />
          </Button>
        </div>
        <nav
          aria-label="Доски"
          className="grid gap-0.5 max-[760px]:flex max-[760px]:items-start max-[760px]:gap-1 max-[760px]:overflow-x-auto max-[760px]:pb-1"
        >
          {liveBoards(data)
            .filter((b) => b.revisions.at(-1)!.status !== 'accepted')
            .map((b) => (
              <BoardLink
                key={b.id}
                board={b}
                current={boardScreen && b.id === boardId}
                onSelect={switchBoard}
              />
            ))}
          {/* Принятые доски — история, а не текущая работа. Вперемешку с
              активными они выглядели параллельными потоками того же релиза. */}
          {liveBoards(data).some((b) => b.revisions.at(-1)!.status === 'accepted') && (
            <details
              className="mt-1 max-[760px]:mt-0 max-[760px]:shrink-0"
              open={(boardScreen && board?.revisions.at(-1)?.status === 'accepted') || undefined}
            >
              <summary className="text-muted-foreground hover:bg-raised rounded-sm px-2 py-1.5 text-sm whitespace-nowrap">
                Принятые (
                {liveBoards(data).filter((b) => b.revisions.at(-1)!.status === 'accepted').length})
              </summary>
              {liveBoards(data)
                .filter((b) => b.revisions.at(-1)!.status === 'accepted')
                .map((b) => (
                  <BoardLink
                    key={b.id}
                    board={b}
                    current={boardScreen && b.id === boardId}
                    onSelect={switchBoard}
                  />
                ))}
            </details>
          )}
        </nav>
        <p className="text-muted-foreground mt-auto px-2 pt-6 text-xs max-[760px]:hidden">
          Интеграция в <code className="[overflow-wrap:anywhere]">{data.config.targetBranch}</code>{' '}
          · согласования: {data.config.approvalMode === 'operator' ? 'оператор' : 'агент'}
        </p>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-col">
        {/* Верхняя строка — единственное место состояния очереди. Высота
            постоянна: ошибка связи встаёт в неё, а не вставляется над
            контентом. */}
        <header className="flex h-(--topbar-height) min-w-0 shrink-0 items-center gap-3 pr-3 pl-2 text-sm max-[760px]:h-auto max-[760px]:flex-wrap max-[760px]:gap-x-3 max-[760px]:gap-y-1 max-[760px]:px-4 max-[760px]:py-2">
          <span className="text-muted-foreground min-w-0 truncate">
            {data.config.name} / <span className="text-foreground font-medium">{screenTitle}</span>
            {boardScreen && revision && ` · ревизия ${revision.number}`}
          </span>
          <span className="bg-active text-muted-foreground shrink-0 rounded-xs px-2 py-0.5 text-xs whitespace-nowrap max-[1180px]:hidden">
            {data.config.mode === 'demo'
              ? 'Учебный режим · без вызовов моделей'
              : 'Локальный runtime'}
          </span>
          {pollError && (
            <p
              role="alert"
              className="text-destructive m-0 flex min-w-0 items-center gap-1.5 text-xs"
              title={pollError}
            >
              <AlertCircle aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">
                Нет связи с сервером: {pollError}. На экране последнее полученное состояние; опрос
                повторяется.
              </span>
            </p>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <span className="text-muted-foreground flex items-center gap-2 text-sm whitespace-nowrap">
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block size-2 rounded-full',
                  data.paused ? 'bg-(--text-faint)' : 'bg-success',
                )}
              />
              <span className="text-foreground">
                {data.paused ? 'Очередь на паузе' : 'Очередь идёт'}
              </span>
              <span className="tabular max-[1180px]:hidden">
                · {activeRuns} из {data.config.concurrency} исполнителей
              </span>
            </span>
            {!queuePrimary && queueButton(false)}
          </div>
        </header>
        <main
          data-sheet
          className="bg-card mr-2 mb-2 flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border max-[760px]:m-0 max-[760px]:rounded-none max-[760px]:border-x-0"
        >
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3 px-6 pt-4 pb-3 max-[760px]:px-4">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h1
                  ref={heading}
                  tabIndex={-1}
                  className="m-0 min-w-0 truncate focus-visible:outline-none"
                  title={boardScreen ? board?.description : undefined}
                >
                  {screenTitle}
                </h1>
                {boardScreen && revision && (
                  <span className="text-muted-foreground shrink-0 rounded-xs border px-1.5 py-px font-mono text-xs">
                    r{revision.number}
                  </span>
                )}
              </div>
              <p className="m-0 mt-1 min-h-5 truncate text-sm max-[1180px]:whitespace-normal">
                {finding}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 max-[760px]:w-full">
              <Button variant="ghost" asChild>
                <a
                  href="/api/report?format=html"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Отчёт об эффекте: принятые задачи, возвраты проверками и ревью, время, расход и окружение"
                >
                  <FileText />
                  Отчёт
                </a>
              </Button>
              {tab === 'changesets' && (
                <Button variant="outline" onClick={() => setModal('changeset')}>
                  <Plus />
                  Новый ChangeSet
                </Button>
              )}
              {tab === 'contracts' && (
                <Button variant="outline" onClick={() => setModal('contract')}>
                  <Plus />
                  Контракт
                </Button>
              )}
              {editable && (
                <Button variant="outline" onClick={() => setModal('task')}>
                  <Plus />
                  Задача
                </Button>
              )}
              {primary === 'correct' && (
                <Button
                  onClick={() => {
                    setRoots([]);
                    setModal('correct');
                  }}
                >
                  <RotateCcw />
                  Создать корректировку
                </Button>
              )}
              {primary === 'approve' && (
                <Button
                  onClick={() =>
                    void act(() => api(`boards/${boardId}/approve`, {}), 'Задачи утверждены')
                  }
                  disabled={busy}
                >
                  Утвердить план
                </Button>
              )}
              {primary === 'accept' && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api(`boards/${boardId}/accept`, {}),
                      'Ревизия принята. Снимок сохранён.',
                    )
                  }
                >
                  <CircleCheck />
                  {data.config.completionMode === 'remote'
                    ? 'Принять доску локально'
                    : 'Принять доску'}
                </Button>
              )}
              {queuePrimary && queueButton(true)}
            </div>
          </div>
          {data.journalError && (
            <Alert variant="destructive" role="alert" className="mx-6 mb-3 w-auto max-[760px]:mx-4">
              <AlertDescription>Дневник: {data.journalError}</AlertDescription>
            </Alert>
          )}
          {/* Полоса состояния: счётчики доски и «Сейчас» в одном разделённом
              контейнере постоянной высоты. */}
          <div
            role="group"
            aria-label="Состояние доски"
            className={cn(
              'relative mx-6 grid shrink-0 overflow-hidden rounded-md border max-[760px]:mx-4',
              boardScreen
                ? 'grid-cols-[repeat(5,minmax(0,0.8fr))_minmax(0,3fr)] max-[1180px]:grid-cols-5 max-[760px]:grid-cols-3'
                : 'grid-cols-1',
            )}
          >
            {boardScreen &&
              (
                [
                  ['Принято', done, liveTasks.length],
                  ['Готово к запуску', ready],
                  ['Ждут зависимостей', blocked],
                  ['В работе', inWork],
                  ['Со сбоем', failedCount],
                ] as [string, number, number?][]
              ).map(([label, value, total]) => (
                <div
                  key={label}
                  className="border-r px-3 py-2 max-[1180px]:border-b max-[760px]:[&:nth-child(3)]:border-r-0"
                >
                  <span className="text-muted-foreground block truncate text-xs">{label}</span>
                  <span
                    className={cn(
                      'tabular block text-lg leading-7',
                      label === 'Со сбоем' && value > 0 && 'text-destructive',
                      label === 'Со сбоем' && value === 0 && 'text-muted-foreground',
                    )}
                  >
                    {value}
                    {total !== undefined && (
                      <span className="text-muted-foreground text-sm"> / {total}</span>
                    )}
                  </span>
                </div>
              ))}
            <div className={cn('min-w-0', boardScreen && 'max-[1180px]:col-span-full')}>
              <LiveWork
                state={data}
                queue={data.queue}
                onOpenTask={(id, taskId) => {
                  if (id && id !== boardId) {
                    setBoardId(id);
                    setRevisionNumber(null);
                  }
                  openTask(taskId);
                  if (!boardScreen || tab === 'progress' || tab === 'history') setTab('graph');
                }}
              />
            </div>
            {boardScreen && liveTasks.length > 0 && (
              <div
                className="bg-rule absolute inset-x-0 bottom-0 h-[3px]"
                role="progressbar"
                aria-label="Принято результатов"
                aria-valuemin={0}
                aria-valuemax={liveTasks.length}
                aria-valuenow={done}
              >
                <div
                  className="bg-success h-full transition-[width] duration-[400ms] ease-out"
                  style={{ width: `${(done / liveTasks.length) * 100}%` }}
                />
              </div>
            )}
          </div>
          {(boardScreen || showToolbar) && (
            <div className="mx-6 mt-3 flex min-h-11 shrink-0 flex-wrap items-end gap-x-4 gap-y-2 border-b max-[760px]:mx-4">
              {boardScreen && (
                <div
                  role="tablist"
                  aria-label="Представление доски"
                  className="-mb-px flex gap-5 overflow-x-auto max-[760px]:w-full max-[760px]:gap-4"
                  onKeyDown={onTabKey}
                >
                  {boardTabs.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      id={'tab-' + t.key}
                      aria-selected={tab === t.key}
                      aria-controls="board-view"
                      tabIndex={tab === t.key ? 0 : -1}
                      onClick={() => setTab(t.key)}
                      className={cn(
                        'text-muted-foreground hover:text-foreground cursor-pointer border-b-2 border-transparent pt-1 pb-2.5 text-sm whitespace-nowrap',
                        tab === t.key && 'border-foreground text-foreground font-medium',
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
              {showToolbar && (
                <div className="ml-auto flex flex-wrap items-center gap-2 pb-2 max-[760px]:ml-0 max-[760px]:w-full">
                  {data.config.repositories.length > 1 && (
                    <label className="w-48 max-[760px]:w-full">
                      <span className="sr-only">Репозиторий</span>
                      <select
                        aria-label="Репозиторий"
                        value={repositoryFilter}
                        onChange={(e) => setRepositoryFilter(e.target.value)}
                      >
                        <option value="">Все репозитории</option>
                        {data.config.repositories.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {cancelledCount > 0 && (
                    <label className="text-muted-foreground flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0"
                        checked={showCancelled}
                        onChange={(e) => setShowCancelled(e.target.checked)}
                      />
                      Показать отменённые ({cancelledCount})
                    </label>
                  )}
                  {tab === 'workspace' && data.acceptedBoards > 0 && (
                    // Задачи принятых досок, от которых зависит текущая работа,
                    // видны всегда; принятые доски целиком — по запросу.
                    <label className="text-muted-foreground flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0"
                        checked={showAccepted}
                        onChange={(e) => setShowAccepted(e.target.checked)}
                      />
                      Показать принятые доски ({data.acceptedBoards})
                    </label>
                  )}
                  <label className="relative w-56 max-[760px]:w-full">
                    <span className="sr-only">Поиск задач</span>
                    <Input
                      ref={search}
                      className="h-(--control-height) pr-8"
                      placeholder="Найти задачу…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <kbd
                      aria-hidden="true"
                      className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-xs border px-1 font-mono text-xs leading-4"
                    >
                      /
                    </kbd>
                  </label>
                </div>
              )}
            </div>
          )}
          <div
            id="board-view"
            role={boardScreen ? 'tabpanel' : undefined}
            aria-labelledby={boardScreen ? 'tab-' + tab : undefined}
            className={cn(
              'grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] max-[1180px]:grid-rows-none',
              showInspector
                ? 'grid-cols-[minmax(0,1fr)_var(--inspector-width)] max-[1180px]:grid-cols-1'
                : 'grid-cols-1',
            )}
          >
            <section className="min-h-0 min-w-0 overflow-auto" aria-label="Рабочая область">
              <Suspense
                fallback={
                  <p
                    role="status"
                    className="text-muted-foreground m-0 min-h-(--canvas-height) p-6"
                  >
                    Загружаем представление…
                  </p>
                }
              >
                {tab === 'progress' && data && (
                  <div className="px-6 pt-4 pb-6 max-[760px]:px-4">
                    {/* Ход работ — по всему workspace: охват подписан, чтобы
                        его цифры не спорили со счётчиками доски выше. */}
                    <p className="text-muted-foreground m-0 mb-3 text-xs">
                      Ход работ по всему workspace: все доски, очередь и проверки.
                    </p>
                    <ProgressPanel
                      state={data}
                      onSelect={(id) => {
                        setSelected(id);
                        setTab('list');
                      }}
                    />
                  </div>
                )}
                {tab === 'overview' && (
                  <div className="min-w-0 px-6 pt-4 pb-6 max-[760px]:px-4">
                    <AuthorOverviewPanel
                      onOpenChange={(id) => {
                        setTab('changesets');
                        setFocusChange(id);
                      }}
                    />
                  </div>
                )}
                {tab === 'product' && (
                  <ProductPanel
                    onRepository={(id) => {
                      setRepositoryFilter(id);
                      setTab('workspace');
                    }}
                  />
                )}
                {tab === 'kanban' && (
                  <div
                    className="grid h-full min-h-(--canvas-height) grid-flow-col gap-3 overflow-x-auto px-6 py-4 max-[760px]:px-4"
                    // Пустая колонка уже, чем занятая: пятая колонка не уходит
                    // за край, пока в ней нечего показать.
                    style={{
                      gridTemplateColumns: kanbanColumns
                        .map((c) =>
                          filtered.some((t) => c.statuses.includes(t.status))
                            ? 'minmax(12rem,1fr)'
                            : 'minmax(7.5rem,0.55fr)',
                        )
                        .join(' '),
                    }}
                    aria-label="Колонки задач"
                  >
                    {kanbanColumns.map((column) => {
                      const cards = filtered.filter((t) => column.statuses.includes(t.status));
                      return (
                        <section
                          key={column.key}
                          aria-label={column.label}
                          className="bg-raised flex min-w-0 flex-col gap-2 rounded-md p-2"
                        >
                          <header className="px-1 pt-1">
                            <h2 className="m-0 flex items-baseline justify-between gap-2 text-sm">
                              {column.label}
                              <span className="text-muted-foreground tabular text-xs font-normal">
                                {cards.length}
                              </span>
                            </h2>
                            <small className="text-muted-foreground">{column.hint}</small>
                          </header>
                          {cards.map((t) => {
                            const shown = taskStatus(t);
                            return (
                              <button
                                type="button"
                                key={t.id}
                                className={cn(
                                  'bg-card grid w-full min-w-0 cursor-pointer gap-1.5 rounded-md border p-3 text-left text-sm transition-colors duration-(--duration-hover) hover:border-control',
                                  shown.tone === 'waiting' && 'border-dashed border-control',
                                  selected === t.id &&
                                    'border-info ring-info ring-1 hover:border-info',
                                )}
                                aria-current={selected === t.id ? 'true' : undefined}
                                data-changed={changed.has(t.id) || undefined}
                                style={
                                  changed.has(t.id)
                                    ? ({ '--flash': flashOf[shown.tone] } as CSSProperties)
                                    : undefined
                                }
                                onClick={() => setSelected(t.id)}
                              >
                                <strong className="line-clamp-3 font-semibold [overflow-wrap:anywhere]">
                                  {t.title}
                                </strong>
                                <span className="text-muted-foreground flex min-w-0 justify-between gap-2 text-xs">
                                  <span className="truncate">{roleLabel(t.role)}</span>
                                  <span className="shrink-0 font-mono" title={t.id}>
                                    {shortId(t.id)}
                                  </span>
                                </span>
                                <TaskLive
                                  task={t}
                                  runs={data.runs}
                                  maxAttempts={data.config.maxAttempts}
                                  titles={titles}
                                  compact
                                />
                                <span>
                                  <StatusBadge value={shown.key}>{shown.label}</StatusBadge>
                                </span>
                              </button>
                            );
                          })}
                          {!cards.length && <p className="text-faint m-0 px-1 text-xs">Пусто</p>}
                        </section>
                      );
                    })}
                  </div>
                )}
                {(tab === 'graph' || tab === 'workspace') &&
                  (filtered.length ? (
                    <div
                      className="relative h-full min-h-[24rem] max-[1180px]:h-(--canvas-height) max-[760px]:h-(--canvas-height-phone) max-[760px]:min-h-0"
                      ref={canvasRef}
                    >
                      <GraphPanel
                        onInit={(instance) => {
                          flowRef.current = (options) => instance.fitView(options);
                        }}
                        onMoveStart={(event) => {
                          if (event) userMoved.current = true;
                        }}
                        key={`${boardId}-${revision?.number}-${tab}`}
                        nodes={graph.nodes}
                        edges={graph.edges}
                        nodesDraggable={false}
                        nodesConnectable={false}
                        edgesFocusable={false}
                        deleteKeyCode={null}
                        onNodeClick={(_, n) => setSelected(n.id)}
                        // Выбор с клавиатуры (Enter/Space на узле) — тот же
                        // выбор, что щелчком: инспектор и адрес следуют за ним.
                        onSelectionChange={({ nodes }) => {
                          if (nodes.length === 1) setSelected(nodes[0].id);
                        }}
                        onControlZoom={() => {
                          userMoved.current = true;
                        }}
                        onControlFit={() => {
                          userMoved.current = false;
                        }}
                        fitView
                        fitViewOptions={{ padding: 0.12, minZoom: 0.75, maxZoom: 1 }}
                        minZoom={0.3}
                      />
                      <div className="text-muted-foreground bg-card/90 pointer-events-none absolute bottom-3 left-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xs px-1 text-xs max-[760px]:right-14">
                        {holder && boardScreen && (
                          <span className="flex items-center gap-1.5">
                            <i
                              aria-hidden="true"
                              className="border-info inline-block w-4 border-t-2"
                            />
                            держит приёмку
                          </span>
                        )}
                        <span className="flex items-center gap-1.5">
                          <i
                            aria-hidden="true"
                            className="inline-block w-4 border-t border-(--canvas-edge)"
                          />
                          зависимость
                        </span>
                        <span className="flex items-center gap-1.5">
                          <i
                            aria-hidden="true"
                            className="border-control inline-block size-3 rounded-xs border border-dashed"
                          />
                          ждёт зависимостей
                        </span>
                        <span className="tabular">{graph.edges.length} связей</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-muted-foreground flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center [&>svg]:size-8 [&_h2]:text-md [&_h2]:text-foreground [&_h2]:m-0 [&_p]:m-0">
                      <GitBranch />
                      <h2>{query ? 'Нет совпадений' : 'Граф начинается с задачи'}</h2>
                      <p>
                        {query
                          ? 'Измените поисковый запрос.'
                          : 'Добавьте первый результат и критерии его приёмки.'}
                      </p>
                      {editable && !query && (
                        <Button variant="outline" onClick={() => setModal('task')}>
                          Добавить задачу
                        </Button>
                      )}
                    </div>
                  ))}
                {tab === 'list' && (
                  <div>
                    {filtered.length ? (
                      filtered.map((t) => {
                        const shown = taskStatus(t);
                        return (
                          <button
                            type="button"
                            className={cn(
                              'grid w-full min-w-0 cursor-pointer grid-cols-[6.5rem_minmax(0,1fr)_auto_auto] items-start gap-x-3 border-b px-6 py-3 text-left text-sm transition-colors duration-(--duration-hover) last:border-b-0 hover:bg-raised max-[760px]:grid-cols-[minmax(0,1fr)_auto] max-[760px]:gap-y-1 max-[760px]:px-4',
                              selected === t.id &&
                                'bg-active hover:bg-active shadow-[inset_2px_0_0_var(--data-accent)]',
                            )}
                            aria-current={selected === t.id ? 'true' : undefined}
                            data-changed={changed.has(t.id) || undefined}
                            style={
                              changed.has(t.id)
                                ? ({ '--flash': flashOf[shown.tone] } as CSSProperties)
                                : undefined
                            }
                            key={t.id}
                            onClick={() => setSelected(t.id)}
                          >
                            <span
                              className="text-muted-foreground pt-px font-mono text-xs"
                              title={t.id}
                            >
                              {shortId(t.id)}
                            </span>
                            <div className="min-w-0 max-[760px]:col-span-2 max-[760px]:row-start-2">
                              <strong className="font-semibold [overflow-wrap:anywhere]">
                                {t.title}
                              </strong>
                              <small className="[overflow-wrap:anywhere]">
                                {roleLabel(t.role)} · {t.repositoryId}
                                {t.dependsOn.length
                                  ? ` · после: ${t.dependsOn
                                      .map((d) => titles.get(d) ?? shortId(d))
                                      .join('; ')}`
                                  : ''}
                              </small>
                              <TaskLive
                                task={t}
                                runs={data.runs}
                                maxAttempts={data.config.maxAttempts}
                                titles={titles}
                                hideWaiting
                              />
                            </div>
                            <span className="max-[760px]:col-start-2 max-[760px]:row-start-1 max-[760px]:justify-self-end">
                              <StatusBadge value={shown.key}>{shown.label}</StatusBadge>
                            </span>
                            <ChevronRight
                              aria-hidden="true"
                              className="text-muted-foreground size-4 max-[760px]:hidden"
                            />
                          </button>
                        );
                      })
                    ) : (
                      <p className="text-muted-foreground flex min-h-64 items-center justify-center p-8 text-center">
                        Нет задач для отображения.
                      </p>
                    )}
                  </div>
                )}
                {tab === 'changesets' && (
                  <div className="px-6 pt-2 pb-6 max-[760px]:px-4 [&>p]:text-muted-foreground [&>p]:max-w-[65ch] [&>p]:text-sm">
                    {data.config.storage === 'component' && (
                      <p>
                        Задачи и журналы хранятся в компонентах. Здесь показан общий граф и
                        межпроектная приёмка.
                      </p>
                    )}
                    {!data.changeSets.length && (
                      <p>
                        Ведущий агент объединяет доски в ChangeSet и настраивает совместные проверки
                        продукта и библиотек.
                      </p>
                    )}
                    {[...data.changeSets].reverse().map((c) => {
                      const v = c.verifications.at(-1);
                      const delivery = c.deliveries
                        ?.filter((d) => d.verificationId === v?.id)
                        .at(-1);
                      const needsDelivery = data.config.completionMode === 'remote';
                      const state = c.acceptance
                        ? 'done'
                        : v?.status === 'failed'
                          ? 'failed'
                          : v?.status === 'active'
                            ? 'running'
                            : 'ready';
                      return (
                        <article
                          key={c.id}
                          id={'changeset-' + c.id}
                          tabIndex={-1}
                          className="grid gap-2 border-t py-4 text-sm [overflow-wrap:anywhere] [&_p]:m-0"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <strong className="text-md min-w-0">
                              {c.id} · {c.title}
                            </strong>
                            <StatusBadge value={state}>
                              {c.acceptance
                                ? 'Принят'
                                : v?.status === 'passed'
                                  ? 'Проверен локально'
                                  : v?.status === 'failed'
                                    ? 'Сбой проверки'
                                    : v?.status === 'active'
                                      ? 'Проверяется'
                                      : 'Ожидает проверки'}
                            </StatusBadge>
                          </div>
                          <ChangeSetDescription
                            id={c.id}
                            text={c.description}
                            truncated={c.descriptionTruncated}
                          />
                          {c.releaseId && (
                            <p>
                              Продуктовый релиз: <strong>{c.releaseId}</strong>
                            </p>
                          )}
                          <p>
                            Доски:{' '}
                            {c.boardIds
                              .map((id) => data.boards.find((b) => b.id === id)?.title ?? id)
                              .join(', ')}
                            {c.supersedes && ` · продолжает ${c.supersedes}`}
                          </p>
                          {v?.error && (
                            <p className="text-destructive bg-destructive-foreground rounded-sm px-3 py-2">
                              {v.error}
                            </p>
                          )}
                          {needsDelivery && (
                            <p>Публикация человеком; DevContour проверяет merge и CI.</p>
                          )}
                          {delivery && (
                            <div>
                              <p>
                                Публикация:{' '}
                                {delivery.status === 'delivered'
                                  ? 'Merge и CI подтверждены'
                                  : delivery.status === 'active'
                                    ? 'Проверяется'
                                    : 'Ожидает публикации или CI'}
                              </p>
                              {delivery.error && (
                                <p className="text-destructive bg-destructive-foreground rounded-sm px-3 py-2">
                                  {delivery.error}
                                </p>
                              )}
                              {Object.entries(delivery.components).map(([id, component]) => (
                                <p key={id}>
                                  <strong>{id}</strong> · {component.state} ·{' '}
                                  <code>{component.sha.slice(0, 12)}</code>{' '}
                                  {component.url && /^https?:\/\//.test(component.url) && (
                                    <a href={component.url} target="_blank" rel="noreferrer">
                                      PR/MR #{component.mr}
                                    </a>
                                  )}
                                  {component.checks?.map((check) => (
                                    <span key={check.name}>
                                      {' '}
                                      · {check.name}: {check.status}
                                    </span>
                                  ))}
                                </p>
                              ))}
                            </div>
                          )}
                          {v?.manifest && (
                            <div className="block break-words [&_code]:text-xs">
                              {Object.entries(v.manifest).map(([id, m]) => (
                                <p key={id}>
                                  <strong>{id}</strong> <code>{m.sha}</code>
                                </p>
                              ))}
                            </div>
                          )}
                          {v?.evidence.map((e) => (
                            <p key={e.gate}>
                              <StatusBadge value={e.passed ? 'done' : 'failed'}>
                                {e.passed ? 'PASS' : 'FAIL'}
                              </StatusBadge>{' '}
                              {e.gate} · {e.summary}{' '}
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  void act(
                                    async () => {
                                      const value = await api(
                                        `changesets/${c.id}/evidence?verification=${v.id}&gate=${encodeURIComponent(e.gate)}`,
                                      );
                                      setLog({ title: e.gate, content: value.content });
                                    },
                                    '',
                                    false,
                                  )
                                }
                              >
                                Лог проверки
                              </Button>
                            </p>
                          ))}
                          {v && (
                            <ChangeSetHistory
                              id={c.id}
                              count={c.verificationCount}
                              revision={data.revision}
                            />
                          )}
                          {c.acceptance && (
                            <p>
                              Принят {stamp(c.acceptance.at)} · {c.acceptance.approval.actor} ·
                              receipt <code>{c.acceptance.digest.slice(0, 16)}</code>
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            {!c.acceptance && (
                              <Button
                                variant="outline"
                                disabled={
                                  busy || v?.status === 'active' || delivery?.status === 'active'
                                }
                                onClick={() =>
                                  void act(
                                    () => api(`changesets/${c.id}/verify`, {}),
                                    'Совместная проверка запущена',
                                    false,
                                  )
                                }
                              >
                                <Play />
                                Проверить совместно
                              </Button>
                            )}
                            {!c.acceptance && needsDelivery && v?.status === 'passed' && (
                              <Button
                                variant="outline"
                                disabled={busy || delivery?.status === 'active'}
                                onClick={() =>
                                  void act(
                                    () => api(`changesets/${c.id}/handoff`, {}),
                                    'Инструкция ручной публикации сохранена в .devcontour-local/handoffs выбранного workspace',
                                    false,
                                  )
                                }
                              >
                                Подготовить передачу
                              </Button>
                            )}
                            {!c.acceptance &&
                              needsDelivery &&
                              v?.status === 'passed' &&
                              delivery?.status !== 'delivered' && (
                                <Button
                                  variant="outline"
                                  disabled={busy || delivery?.status === 'active'}
                                  onClick={() =>
                                    void act(
                                      () => api(`changesets/${c.id}/remote-check`, {}),
                                      'Состояние публикации обновлено',
                                      false,
                                    )
                                  }
                                >
                                  Проверить публикацию
                                </Button>
                              )}
                            {!c.acceptance &&
                              v?.status === 'passed' &&
                              (!needsDelivery || delivery?.status === 'delivered') && (
                                <Button
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(
                                      () => api(`changesets/${c.id}/accept`, {}),
                                      'ChangeSet принят',
                                      false,
                                    )
                                  }
                                >
                                  <Check />
                                  Принять ChangeSet
                                </Button>
                              )}
                            <Button
                              variant="outline"
                              onClick={() =>
                                void act(
                                  async () => {
                                    const value = await api(`changesets/${c.id}/journal`);
                                    setLog({ title: `Дневник ${c.id}`, content: value.content });
                                  },
                                  '',
                                  false,
                                )
                              }
                            >
                              Дневник
                            </Button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
                {tab === 'history' && (
                  <div className="px-6 pt-4 pb-6 max-[760px]:px-4 [&>p]:text-muted-foreground [&>p]:max-w-[65ch] [&>p]:text-sm">
                    <p className="mt-0">
                      Принятые снимки неизменяемы. Каждая корректировка имеет свой план и
                      доказательства.
                    </p>
                    {shownRevisions.map((r) => (
                      <article
                        key={r.number}
                        className="grid gap-2 border-t py-4 text-sm [overflow-wrap:anywhere] [&_p]:m-0"
                      >
                        <div className="flex items-start gap-3">
                          <span className="bg-active shrink-0 rounded-xs px-2 py-0.5 font-mono text-xs">
                            r{r.number}
                          </span>
                          <div className="min-w-0 flex-1">
                            <RevisionReason boardId={board!.id} revision={r} />
                            <small>
                              {stamp(r.createdAt)} · {r.taskIds.length} задач
                            </small>
                          </div>
                          <StatusBadge value={r.status === 'accepted' ? 'done' : 'ready'}>
                            {r.status === 'accepted' ? 'Принята' : 'В работе'}
                          </StatusBadge>
                        </div>
                        {r.snapshot && (
                          <p>
                            Снимок <code>{r.snapshot.digest.slice(0, 12)}</code> · Git{' '}
                            <code>
                              {Object.entries(r.snapshot.repositories ?? { main: r.snapshot.sha })
                                .map(([id, sha]) => `${id}:${sha.slice(0, 8)}`)
                                .join(' · ')}
                            </code>
                          </p>
                        )}
                        <Button
                          variant="outline"
                          className="justify-self-start"
                          onClick={() => {
                            setRevisionNumber(r.number);
                            setSelected('');
                            setTab('graph');
                          }}
                        >
                          Открыть ревизию {r.number}
                          <ArrowUpRight />
                        </Button>
                      </article>
                    ))}
                    {revisionsError && (
                      <p role="alert" className="text-destructive text-sm">
                        Ранние ревизии не загрузились: {revisionsError}{' '}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void loadOlderRevisions()}
                        >
                          Повторить
                        </Button>
                      </p>
                    )}
                    {!revisionsError && revisionsBefore > 0 && (
                      <Button variant="outline" onClick={() => void loadOlderRevisions()}>
                        Ранние ревизии ({revisionsBefore})
                      </Button>
                    )}
                  </div>
                )}
                {tab === 'contracts' && (
                  <div className="px-6 pt-2 pb-6 max-[760px]:px-4 [&>p]:text-muted-foreground [&>p]:max-w-[65ch] [&>p]:text-sm">
                    {data.contracts.map((c) => (
                      <article
                        key={c.id}
                        className="grid gap-2 border-t py-4 text-sm [overflow-wrap:anywhere] [&_p]:m-0"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <strong>{c.title}</strong>
                          <StatusBadge value="done">{c.id}</StatusBadge>
                        </div>
                        <ContractText id={c.id} bytes={c.contentBytes} />
                        <small>
                          SHA-256 {c.digest.slice(0, 16)} · {stamp(c.approvedAt)}
                        </small>
                      </article>
                    ))}
                    {!data.contracts.length && (
                      <p>
                        Добавьте API, события или дизайн-контракт перед утверждением связанных
                        задач.
                      </p>
                    )}
                  </div>
                )}
              </Suspense>
            </section>
            {showInspector && (
              <aside
                className="min-h-0 overflow-auto border-l px-5 pt-4 pb-6 text-sm max-[1180px]:border-t max-[1180px]:border-l-0 max-[760px]:px-4"
                aria-label="Детали задачи"
              >
                {task ? (
                  <>
                    <header className="grid gap-1.5">
                      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                        <span className="font-mono whitespace-nowrap" title={task.id}>
                          {shortId(task.id)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-6"
                          aria-label="Скопировать полный ID задачи"
                          title={task.id}
                          onClick={() =>
                            void navigator.clipboard
                              ?.writeText(task.id)
                              .then(() => toast.success('ID задачи скопирован'))
                              .catch(() => toast.error('Не удалось скопировать ID'))
                          }
                        >
                          <Copy />
                        </Button>
                        <StatusBadge value={status(task)}>{taskStatusName(task)}</StatusBadge>
                      </div>
                      <h2 className="m-0 line-clamp-3 [overflow-wrap:anywhere]" title={task.title}>
                        {task.title}
                      </h2>
                      <p className="text-muted-foreground m-0 text-xs [overflow-wrap:anywhere]">
                        {roleLabel(task.role)} · <code>{task.repositoryId}</code>
                        {task.assignee && (
                          <>
                            {' '}
                            · ответственный <strong className="font-medium">{task.assignee}</strong>
                          </>
                        )}
                      </p>
                    </header>
                    {!graphTasks.some((t) => t.id === task.id) && (
                      <p className="bg-raised text-muted-foreground mt-2 mb-0 rounded-sm px-2 py-1.5 text-xs">
                        Задача из ссылки не входит в показанную ревизию доски.
                      </p>
                    )}
                    <TaskDescription key={task.id} text={task.description} />
                    {/* Что нужно для продолжения — первым: это ответ на вопрос
                        «почему задача стоит» одной фразой. */}
                    {!!(task.progress?.reasons.length || task.progress?.workflowStale) && (
                      <section
                        className="bg-raised mt-3 rounded-md p-3 text-sm break-words [&_li+li]:mt-2 [&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0"
                        aria-label="Что нужно для продолжения"
                      >
                        <h3 className="text-muted-foreground mt-0 mb-1.5 text-xs font-medium">
                          Что нужно для продолжения
                        </h3>
                        <ul>
                          {task.progress.reasons.map((reason) => (
                            <li key={reason}>
                              {waitingReasons[reason] ?? reason}
                              {reason === 'held_by_operation' &&
                                task.progress?.hold &&
                                ` Операция ${task.progress.hold.operation}.`}
                              {reason === 'approval_stale' &&
                                task.progress?.approvalStale &&
                                ` ${task.progress.approvalStale.hint}.`}
                              {reason === 'budget_blocked' &&
                                task.progress?.budgetBlock &&
                                ` ${task.progress.budgetBlock.reason} ${task.progress.budgetBlock.hint}.`}
                            </li>
                          ))}
                          {task.progress.workflowStale && (
                            <li>
                              {task.progress.workflowStale.reason}.{' '}
                              {task.progress.workflowStale.hint}.
                            </li>
                          )}
                        </ul>
                      </section>
                    )}
                    {task.progress?.eligible && (
                      <p className="bg-raised mt-3 mb-0 rounded-md p-3 text-sm">
                        Задача доступна для выдачи исполнителю.
                      </p>
                    )}
                    {task.failure && (
                      <p className="bg-destructive-foreground text-destructive mt-3 mb-0 rounded-md p-3 break-words [overflow-wrap:anywhere]">
                        {task.failure}
                      </p>
                    )}
                    {((task.status === 'draft' && editable) ||
                      ['failed', 'cancelled'].includes(task.status)) && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {task.status === 'draft' && editable && (
                          <>
                            <Button variant="outline" size="sm" onClick={() => setModal('edit')}>
                              Редактировать
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  () => api(`boards/${boardId}/approve`, { taskIds: [task.id] }),
                                  'Задача утверждена',
                                  false,
                                )
                              }
                            >
                              Утвердить задачу
                            </Button>
                          </>
                        )}
                        {['failed', 'cancelled'].includes(task.status) && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () => api(`tasks/${task.id}/retry`, {}),
                                'Новая попытка поставлена в очередь',
                                false,
                              )
                            }
                          >
                            <RotateCcw />
                            Повторить
                          </Button>
                        )}
                      </div>
                    )}
                    <section aria-label="Доказательства на коммите" className="mt-5">
                      <h3 className="text-muted-foreground mt-0 mb-1 text-xs font-medium">
                        Доказательства на коммите
                      </h3>
                      <p className="text-faint m-0 mb-1 text-xs">
                        {data.config.completionMode === 'remote'
                          ? 'Приёмка ChangeSet = локальные проверки + merge + CI'
                          : 'Приёмка = тесты + ревью + проверенная интеграция'}
                      </p>
                      {evidence.length ? (
                        <ul className="m-0 grid list-none p-0">
                          {evidence.map((e) => (
                            <li key={e.id} className="border-rule border-b last:border-b-0">
                              <button
                                type="button"
                                className="hover:bg-raised grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 rounded-xs px-1 py-1.5 text-left text-sm transition-colors"
                                onClick={() =>
                                  void act(
                                    async () => {
                                      const result = await api(`evidence/${e.id}`);
                                      setLog({
                                        title: `${e.gate} / ${e.phase}`,
                                        content: result.content,
                                      });
                                    },
                                    '',
                                    false,
                                  )
                                }
                              >
                                <span
                                  className={cn(
                                    'pt-0.5 [&_svg]:size-3.5',
                                    e.passed ? 'text-success' : 'text-destructive',
                                  )}
                                  aria-label={e.passed ? 'прошла' : 'не прошла'}
                                >
                                  {e.passed ? <Check /> : <X />}
                                </span>
                                <span className="min-w-0">
                                  {e.kind !== 'review'
                                    ? e.gate
                                    : e.reviewRound && e.reviewRound.protocol !== 'valid'
                                      ? 'Ответ ревьюера вне протокола'
                                      : 'Независимое ревью'}
                                  <small className="[overflow-wrap:anywhere]">
                                    {e.phase === 'integration' ? 'После интеграции' : 'Кандидат'} ·{' '}
                                    <code>{e.sha.slice(0, 7)}</code>
                                    {e.kind === 'review' &&
                                      ` · ${e.inspection?.mode ?? 'команды не зафиксированы'}`}
                                    {e.reviewRound && ` · ${reviewRoundLine(e.reviewRound)}`}
                                  </small>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : task.sharedCompletion ? (
                        <p className="text-muted-foreground m-0 text-sm">
                          Свидетельство участника — ниже. Логи хранятся в исходном контуре
                          выполнения.
                        </p>
                      ) : (
                        <>
                          {/* Что будет доказано: строка на каждую проверку, «—» до попытки.
                              Отсутствие отчёта не считается успехом. */}
                          <ul className="m-0 grid list-none p-0">
                            {[
                              ...(data.config.gates ?? []).map((g) => g.id),
                              'Независимое ревью',
                              `Интеграция в ${data.config.targetBranch}`,
                            ].map((name) => (
                              <li
                                key={name}
                                className="border-rule grid grid-cols-[1rem_minmax(0,1fr)_auto] items-baseline gap-2 border-b px-1 py-1.5 last:border-b-0"
                              >
                                <span
                                  aria-hidden="true"
                                  className="bg-faint mt-1 inline-block size-2 rounded-full"
                                />
                                <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
                                <span className="text-muted-foreground">—</span>
                              </li>
                            ))}
                          </ul>
                          <p className="text-muted-foreground m-0 mt-1 text-xs">
                            Появятся после запуска. Отсутствие отчёта не считается успехом.
                          </p>
                        </>
                      )}
                      {task.resultSha && (
                        <p className="text-success m-0 mt-2">
                          Принятый коммит <code>{task.resultSha.slice(0, 12)}</code>
                        </p>
                      )}
                    </section>
                    {task.sharedCompletion && (
                      <div className="mt-3 text-sm [&_p]:m-0">
                        <p>
                          Результат принят из Git: <code>{task.resultSha?.slice(0, 12)}</code>.
                          Проверки выполнены участником команды; локальная попытка не запускалась.
                        </p>
                        <details className="mt-1">
                          <summary>Свидетельство участника</summary>
                          <p>
                            {task.sharedCompletion.receipt.runtime} →{' '}
                            {task.sharedCompletion.receipt.reviewer}; Git{' '}
                            <code>{task.sharedCompletion.sourceCommit.slice(0, 12)}</code>
                          </p>
                          <ul>
                            {(full?.task.sharedCompletion?.receipt.checks ?? []).map(
                              (check, index) => (
                                <li key={index}>
                                  {check.phase} / {check.gate}: {check.passed ? 'PASS' : 'FAIL'} ·{' '}
                                  <code>{check.sha.slice(0, 12)}</code>
                                </li>
                              ),
                            )}
                          </ul>
                        </details>
                      </div>
                    )}
                    {(task.properties?.length || task.recovery || task.checkVersion) && (
                      <Suspense fallback={null}>
                        <CheckPanel
                          taskId={task.id}
                          revision={[
                            task.status,
                            task.attempt,
                            task.recovery?.status,
                            task.recovery?.version,
                            task.checkVersion?.digest,
                          ].join(':')}
                        />
                      </Suspense>
                    )}
                    <h3 className="text-muted-foreground mt-5 mb-1.5 text-xs font-medium">
                      Критерии приёмки
                    </h3>
                    <ul className="m-0 grid list-none gap-1.5 p-0 [&_svg]:size-3.5">
                      {task.acceptance.map((a, i) => (
                        <li key={i} className="flex items-start gap-2 [overflow-wrap:anywhere]">
                          <span
                            className={cn(
                              'tabular flex size-5 shrink-0 items-center justify-center rounded-full border text-xs',
                              task.status === 'done'
                                ? 'text-success bg-success-foreground border-transparent'
                                : 'text-muted-foreground',
                            )}
                          >
                            {task.status === 'done' ? <Check /> : i + 1}
                          </span>
                          {a}
                        </li>
                      ))}
                    </ul>
                    {task.supersedes && (
                      <p className="bg-raised mt-3 mb-0 rounded-sm p-2">
                        Корректирует <strong>{task.supersedes}</strong>
                      </p>
                    )}
                    <h3 className="text-muted-foreground mt-5 mb-1 text-xs font-medium">
                      Зависимости
                    </h3>
                    {task.dependsOn.length ? (
                      <div className="grid">
                        {task.dependsOn.map((id) => {
                          const d = data.tasks.find((t) => t.id === id);
                          return (
                            <button
                              type="button"
                              key={id}
                              className="hover:bg-raised grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2 rounded-xs px-1 py-1.5 text-left text-sm transition-colors [&_svg]:size-3.5"
                              onClick={() => {
                                if (tasks.some((t) => t.id === id)) setSelected(id);
                                else {
                                  const b = d?.boardId;
                                  if (b) {
                                    switchBoard(b);
                                    setSelected(id);
                                  }
                                }
                              }}
                            >
                              <span
                                className={cn(
                                  'pt-0.5',
                                  d?.status === 'done' ? 'text-success' : 'text-muted-foreground',
                                )}
                              >
                                {d?.status === 'done' ? <Check /> : <Clock />}
                              </span>
                              <span className="min-w-0 [overflow-wrap:anywhere]">
                                {d?.title ?? shortId(id)}
                                <small className="font-mono">{id}</small>
                              </span>
                              <ChevronRight className="text-muted-foreground mt-0.5" />
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-muted-foreground m-0 text-sm">Можно начать независимо.</p>
                    )}
                    {dependents.length > 0 && (
                      <>
                        <h3 className="text-muted-foreground mt-4 mb-1 text-xs font-medium">
                          От неё зависят
                        </h3>
                        <div className="grid">
                          {dependents.map((d) => (
                            <button
                              type="button"
                              key={d.id}
                              className="hover:bg-raised flex cursor-pointer items-baseline justify-between gap-2 rounded-xs px-1 py-1.5 text-left text-sm transition-colors"
                              onClick={() => setSelected(d.id)}
                            >
                              <span className="min-w-0 [overflow-wrap:anywhere]">{d.title}</span>
                              <span className="text-muted-foreground shrink-0 font-mono text-xs">
                                {shortId(d.id)}
                              </span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {task.contracts.length > 0 && (
                      <>
                        <h3 className="text-muted-foreground mt-4 mb-1 text-xs font-medium">
                          Контракты
                        </h3>
                        <p className="text-muted-foreground m-0 text-sm [overflow-wrap:anywhere]">
                          {task.contracts.join(', ')}
                          {task.approvedDigest
                            ? ' · версии закреплены'
                            : ' · закрепятся при утверждении'}
                        </p>
                      </>
                    )}
                    <h3 className="text-muted-foreground mt-5 mb-0 text-xs font-medium">
                      Исполнение
                    </h3>
                    <dl className="mt-1">
                      <div>
                        <dt>Роль</dt>
                        <dd>{roleLabel(task.role)}</dd>
                      </div>
                      <div>
                        <dt>Исполнитель</dt>
                        <dd>
                          {displayedWriter?.runtime}
                          {displayedWriter?.model && ` / ${displayedWriter.model}`}
                        </dd>
                      </div>
                      <div>
                        <dt>Ревью</dt>
                        <dd>
                          {displayedReviewer.runtime}
                          {displayedReviewer.model && ` / ${displayedReviewer.model}`}
                          {/* Ревью тем же вендором бывает только по явному правилу
                              вендора; оно названо, а не подразумевается «другой». */}
                          {displayedReviewer.runtime &&
                            displayedReviewer.runtime === displayedWriter?.runtime && (
                              <span className="text-muted-foreground"> · тот же вендор</span>
                            )}
                        </dd>
                      </div>
                      <div>
                        <dt>Попытки</dt>
                        <dd className="tabular">{task.attempt}</dd>
                      </div>
                    </dl>
                    {detailError && (
                      <p role="alert" className="text-destructive text-sm">
                        Детали задачи не загрузились: {detailError}{' '}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDetailAttempt((n) => n + 1)}
                        >
                          Повторить
                        </Button>
                      </p>
                    )}
                    {!full && !detailError && (
                      <p role="status" className="text-muted-foreground text-sm">
                        Загрузка попыток…
                      </p>
                    )}
                    {full && <AttemptTimeline runs={taskRuns} total={full.runs.total} />}
                    {full && olderError && (
                      <p role="alert" className="text-destructive text-sm">
                        Ранние попытки не загрузились: {olderError}{' '}
                        <Button variant="outline" size="sm" onClick={() => void loadOlderRuns()}>
                          Повторить
                        </Button>
                      </p>
                    )}
                    {full && !olderError && full.runs.total > taskRuns.length && (
                      <Button variant="outline" size="sm" onClick={() => void loadOlderRuns()}>
                        Ранние попытки ({full.runs.total - taskRuns.length})
                      </Button>
                    )}
                    {/* Отмена — разрушительное действие: внизу карточки, отдельно от
                          следующего шага. */}
                    {!['done', 'cancelled'].includes(task.status) && (
                      <div className="mt-6 border-t pt-4">
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () => api(`tasks/${task.id}/cancel`, {}),
                              'Задача отменена',
                              false,
                            )
                          }
                        >
                          Отменить задачу
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-muted-foreground flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center [&>svg]:size-8">
                    <FileCheck />
                    <p className="m-0">
                      Выберите задачу, чтобы увидеть зависимости и результаты проверок.
                    </p>
                  </div>
                )}
              </aside>
            )}
          </div>
        </main>
      </div>
      {modal === 'changeset' && (
        <Modal error={error} title="Новый ChangeSet" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(
                () =>
                  api('changesets', {
                    title: f.get('title'),
                    description: f.get('description'),
                    boardIds: f.getAll('boardIds'),
                    supersedes: f.get('supersedes') || undefined,
                    releaseId: f.get('releaseId') || undefined,
                  }),
                'ChangeSet создан',
              );
            }}
          >
            <label>
              Название
              <Input name="title" required minLength={3} maxLength={180} />
            </label>
            <label>
              Ожидаемый результат продукта
              <Textarea name="description" required minLength={10} maxLength={12000} />
            </label>
            <fieldset>
              <legend>Доски</legend>
              {data.boards.map((b) => (
                <label className="flex cursor-pointer items-start gap-2 py-2 text-sm" key={b.id}>
                  <Input
                    type="checkbox"
                    name="boardIds"
                    value={b.id}
                    defaultChecked={b.id === boardId}
                  />
                  <span>{b.title}</span>
                </label>
              ))}
            </fieldset>
            <label>
              ID продуктового релиза (если принимаем релиз INTENT)
              <Input name="releaseId" pattern="[A-Za-z0-9_-]{1,50}" placeholder="Например, mvp" />
            </label>
            <label>
              Продолжает принятый ChangeSet
              <select name="supersedes">
                <option value="">Новое изменение</option>
                {data.changeSets
                  .filter((c) => c.acceptance)
                  .map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.id} · {c.title}
                    </option>
                  ))}
              </select>
            </label>
            <div className="mt-6 flex justify-end gap-3">
              <Button disabled={busy}>Создать ChangeSet</Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'board' && (
        <Modal error={error} title="Новая доска" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                const b = await api('boards', {
                  title: f.get('title'),
                  description: f.get('description'),
                });
                switchBoard(b.id);
              }, 'Доска создана');
            }}
          >
            <label>
              Название
              <Input
                name="title"
                required
                minLength={3}
                maxLength={180}
                placeholder="Например, редизайн личного кабинета"
              />
            </label>
            <label>
              Цель
              <Textarea name="description" rows={3} maxLength={5000} />
            </label>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" type="button" onClick={() => setModal(null)}>
                Отмена
              </Button>
              <Button disabled={busy}>Создать доску</Button>
            </div>
          </form>
        </Modal>
      )}
      {(modal === 'task' || modal === 'edit') && board && (
        <Modal
          error={error}
          title={modal === 'edit' ? 'Редактировать черновик' : 'Новая задача'}
          onClose={() => setModal(null)}
        >
          <TaskForm
            data={data}
            task={modal === 'edit' ? task : undefined}
            busy={busy}
            onSubmit={(input) =>
              void act(
                () =>
                  modal === 'edit' && task
                    ? api(
                        `tasks/${task.id}`,
                        { ...input, expectedDigest: task.specDigest },
                        'PATCH',
                      )
                    : api(`boards/${boardId}/tasks`, input),
                'Задача сохранена',
              )
            }
          />
        </Modal>
      )}
      {modal === 'contract' && (
        <Modal error={error} title="Утвердить контракт" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(
                () => api('contracts', { title: f.get('title'), content: f.get('content') }),
                'Контракт утверждён',
              );
            }}
          >
            <p className="text-muted-foreground text-sm">
              Подтверждая, вы фиксируете эту версию. Изменения оформляются новым контрактом.
            </p>
            <label>
              Название и версия
              <Input name="title" required maxLength={180} />
            </label>
            <label>
              Содержимое
              <Textarea name="content" required rows={10} maxLength={60000} />
            </label>
            <div className="mt-6 flex justify-end gap-3">
              <Button disabled={busy}>Утвердить контракт</Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'correct' && (
        <Modal error={error} title="Корректировка принятой доски" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                await api(`boards/${boardId}/correct`, { roots, reason: f.get('reason') });
                setRevisionNumber(null);
                setTab('graph');
              }, 'Создана новая ревизия. Проверьте и утвердите её задачи.');
            }}
          >
            <p>
              Прежние задачи и доказательства останутся в истории. Выберите результат, который нужно
              изменить.
            </p>
            <fieldset>
              <legend>Что требует изменения</legend>
              {tasks.map((t) => (
                <label className="flex cursor-pointer items-start gap-2 py-2 text-sm" key={t.id}>
                  <input
                    type="checkbox"
                    checked={roots.includes(t.id)}
                    onChange={(e) =>
                      setRoots(
                        e.target.checked ? [...roots, t.id] : roots.filter((id) => id !== t.id),
                      )
                    }
                  />
                  <span>
                    {t.id} · {t.title}
                  </span>
                </label>
              ))}
            </fieldset>
            {impact && (
              <div className="bg-accent mt-4 rounded-sm p-4 text-sm [&_p]:my-2 [&_ul]:mb-0 [&_ul]:pl-5">
                <strong>Затронуто задач: {impact.taskIds.length}</strong>
                <p>Будут созданы черновики для выбранных задач и всех зависимых результатов.</p>
                <ul>
                  {impact.taskIds.map((id) => (
                    <li key={id}>
                      {id} · {data.tasks.find((t) => t.id === id)?.title}
                    </li>
                  ))}
                </ul>
                {impact.boards.length > 1 && (
                  <p>
                    Влияние выходит за одну доску: {impact.boards.map((b) => b.title).join(', ')}.
                    Новые проверки войдут в эту корректировку.
                  </p>
                )}
              </div>
            )}
            <label>
              Что и почему меняем
              <Textarea
                name="reason"
                required
                minLength={10}
                maxLength={5000}
                rows={3}
                placeholder="Например, поиск должен учитывать архивные продукты…"
              />
            </label>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" type="button" onClick={() => setModal(null)}>
                Отмена
              </Button>
              <Button disabled={busy || !impact}>
                Создать ревизию {(revision?.number ?? 0) + 1}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {log && (
        <Modal error={error} title={log.title} onClose={() => setLog(undefined)}>
          <pre className="max-h-[65dvh] overflow-auto">{log.content}</pre>
        </Modal>
      )}
      {/* Уведомления — в портале поверх экрана, вне сетки каркаса. */}
      {createPortal(
        <Toaster position="bottom-right" visibleToasts={3} toastOptions={{ duration: 4000 }} />,
        document.body,
      )}
    </div>
  );
}
// Зависимости выбираются из всех досок серверным поиском страницами: сводка
// несёт только задачи выбранной доски и текущей работы. Задачи, у которых
// есть замена, не предлагаются — это считается по всем задачам на сервере.
function DependencyPicker({
  own,
  initial,
  known,
}: {
  own?: string;
  initial: string[];
  known: { id: string; title: string }[];
}) {
  type Found = { id: string; title: string; superseded: boolean };
  const [chosen, setChosen] = useState<string[]>(initial);
  const [titles, setTitles] = useState<Record<string, string>>(() =>
    Object.fromEntries(known.map((t) => [t.id, t.title])),
  );
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ items: Found[]; total: number; next: number | null }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let valid = true;
    const timer = setTimeout(() => {
      setError('');
      api(`tasks?limit=20&q=${encodeURIComponent(query)}`)
        .then((page: { items: Found[]; total: number; next: number | null }) => {
          if (!valid) return;
          setFound(page);
          setTitles((all) => ({
            ...all,
            ...Object.fromEntries(page.items.map((t) => [t.id, t.title])),
          }));
        })
        .catch((e: Error) => valid && setError(e.message));
    }, 200);
    return () => {
      valid = false;
      clearTimeout(timer);
    };
  }, [query, attempt]);
  const more = () =>
    api(`tasks?limit=20&q=${encodeURIComponent(query)}&cursor=${found?.next}`)
      .then((page: { items: Found[]; total: number; next: number | null }) => {
        setFound((prev) => ({ ...page, items: [...(prev?.items ?? []), ...page.items] }));
        setTitles((all) => ({
          ...all,
          ...Object.fromEntries(page.items.map((t) => [t.id, t.title])),
        }));
      })
      .catch((e: Error) => setError(e.message));
  const toggle = (id: string, on: boolean) =>
    setChosen((ids) => (on ? [...new Set([...ids, id])] : ids.filter((x) => x !== id)));
  const offered = (found?.items ?? []).filter((t) => t.id !== own && !t.superseded);
  return (
    <fieldset className="grid gap-2">
      <legend>Зависит от задач</legend>
      {chosen.map((id) => (
        <input key={id} type="hidden" name="dependsOn" value={id} />
      ))}
      {chosen.length > 0 && (
        <ul aria-label="Выбранные зависимости" className="grid gap-1 text-sm">
          {chosen.map((id) => (
            <li key={id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                {id} · {titles[id] ?? ''}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => toggle(id, false)}>
                Убрать
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Input
        type="search"
        aria-label="Найти задачу для зависимости"
        placeholder="Название или ID задачи на любой доске"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && (
        <p role="alert" className="text-destructive text-sm">
          Поиск задач не удался: {error}{' '}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Повторить
          </Button>
        </p>
      )}
      <div className="max-h-48 overflow-auto">
        {offered.map((t) => (
          <label className="flex cursor-pointer items-start gap-2 py-2 text-sm" key={t.id}>
            <Input
              type="checkbox"
              checked={chosen.includes(t.id)}
              onChange={(e) => toggle(t.id, e.target.checked)}
            />
            <span>
              {t.id} · {t.title}
            </span>
          </label>
        ))}
        {found && offered.length === 0 && <p>Подходящих задач нет.</p>}
        {!found && !error && <p role="status">Загрузка задач…</p>}
      </div>
      {found?.next != null && (
        <Button type="button" variant="outline" size="sm" onClick={() => void more()}>
          Показать ещё ({found.total - found.items.length})
        </Button>
      )}
    </fieldset>
  );
}
function TaskForm({
  data,
  task,
  busy,
  onSubmit,
}: {
  data: Snapshot;
  task?: UITask;
  busy: boolean;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSubmit({
          title: f.get('title'),
          description: f.get('description'),
          role: f.get('role'),
          repositoryId: f.get('repositoryId'),
          acceptance: String(f.get('acceptance'))
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          dependsOn: f.getAll('dependsOn'),
          contracts: f.getAll('contracts'),
        });
      }}
    >
      <label>
        Название
        <Input name="title" defaultValue={task?.title} required minLength={3} maxLength={180} />
      </label>
      <label>
        Описание результата
        <Textarea
          name="description"
          defaultValue={task?.description}
          required
          minLength={10}
          maxLength={12000}
          rows={3}
        />
      </label>
      <label>
        Репозиторий
        <select
          name="repositoryId"
          defaultValue={task?.repositoryId ?? data.config.repositories[0].id}
        >
          {data.config.repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {r.kind}
            </option>
          ))}
        </select>
      </label>
      <label>
        Роль
        <select name="role" defaultValue={task?.role ?? 'backend'}>
          {currentRoles().map((id) => (
            <option key={id} value={id}>
              {roleLabel(id)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Критерии приёмки, по одному на строку
        <Textarea name="acceptance" defaultValue={task?.acceptance.join('\n')} required rows={3} />
      </label>
      <DependencyPicker own={task?.id} initial={task?.dependsOn ?? []} known={data.tasks} />
      {data.contracts.length > 0 && (
        <fieldset className="max-h-48 overflow-auto">
          <legend>Контракты</legend>
          {data.contracts.map((c) => (
            <label className="flex cursor-pointer items-start gap-2 py-2 text-sm" key={c.id}>
              <Input
                type="checkbox"
                name="contracts"
                value={c.id}
                defaultChecked={task?.contracts.includes(c.id)}
              />
              <span>
                {c.id} · {c.title}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="mt-6 flex justify-end gap-3">
        <Button disabled={busy}>Сохранить черновик</Button>
      </div>
    </form>
  );
}
