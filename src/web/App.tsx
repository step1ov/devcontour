import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
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
  LayoutGrid,
  List,
  History,
  X,
  FileCheck,
  RotateCcw,
  Workflow,
  ChevronRight,
  Activity,
  Bot,
  Eye,
  Loader2,
  SquareKanban,
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
import { boardPhaseLabels } from '../core/work-status.ts';

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
  failure_requires_diagnosis: 'Разберите причину сбоя перед повторной попыткой.',
  attempts_exhausted: 'Лимит попыток исчерпан. Нужна диагностика и пересмотр решения.',
};
// Колонки привычной доски задач. Статус задачи и фаза её прогона уже
// говорят, где она: черновик ждёт утверждения плана, готовая — исполнителя,
// разработка и сбой — в работе, проверки, ревью и интеграция — на проверке.
// Сбой остаётся в работе с красной меткой, а не прячется в отдельную колонку.
const kanbanColumns: { key: string; label: string; hint: string; statuses: string[] }[] = [
  { key: 'inbox', label: 'Входящие', hint: 'План не утверждён', statuses: ['draft'] },
  { key: 'todo', label: 'К выполнению', hint: 'Утверждены, ждут исполнителя', statuses: ['ready'] },
  { key: 'doing', label: 'В работе', hint: 'Разработка и сбои', statuses: ['running', 'failed'] },
  {
    key: 'review',
    label: 'На проверке',
    hint: 'Проверки, ревью, интеграция',
    statuses: ['verifying', 'reviewing', 'integrating'],
  },
  { key: 'done', label: 'Готово', hint: 'Прошли проверки', statuses: ['done', 'cancelled'] },
];
const statusNames: Record<string, string> = {
  draft: 'Черновик',
  ready: 'Готова к запуску',
  running: 'Разработка',
  verifying: 'Проверки',
  reviewing: 'Ревью',
  integrating: 'Интеграция',
  done: 'Проверена локально',
  failed: 'Сбой',
  cancelled: 'Отменена',
  blocked: 'Ждёт зависимостей',
};
const stamp = (value?: string) =>
  value
    ? new Date(value).toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
function status(t: UITask) {
  return t.status === 'ready' && t.blockers.length ? 'blocked' : t.status;
}
const taskStatusName = (t: UITask) =>
  t.status === 'done' && t.sharedCompletion ? 'Принята из Git' : statusNames[status(t)];
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
const badgeTone: Record<string, 'secondary' | 'ready' | 'success' | 'warning' | 'destructive'> = {
  ready: 'ready',
  running: 'ready',
  verifying: 'ready',
  reviewing: 'ready',
  integrating: 'ready',
  done: 'success',
  blocked: 'warning',
  failed: 'destructive',
};
// Строка задачи отвечала только «в каком она статусе». На вопрос «чем агент
// занят прямо сейчас» это не отвечает: статус `running` одинаков и через минуту
// после выдачи, и на третьей попытке в ревью. Живая часть строки показывает
// фазу, исполнителя, пройденные проверки и причину ожидания — то, ради чего
// иначе приходится открывать карточку задачи и читать журнал.
function TaskLive({
  task,
  runs,
  maxAttempts,
}: {
  task: UITask;
  runs: PanelRun[];
  maxAttempts?: number;
}) {
  const run = runs.filter((r) => r.taskId === task.id).at(-1);
  const active = run?.status === 'active';
  const exhausted = maxAttempts !== undefined && task.attempt >= maxAttempts;
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
    return (
      <small className="text-muted-foreground mt-1 block">
        Ждёт: {task.blockers.map(shortId).join(', ')}
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
  if (task.status === 'done' && run) return <GateChips run={run} />;
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
    <span className="mt-1 flex flex-wrap gap-1">
      {gates.map((e) => (
        <Badge
          key={e.id}
          variant={e.passed ? 'success' : 'destructive'}
          className="font-mono text-[11px]"
          title={`${e.gate} · ${e.phase} · ${e.summary}`}
        >
          {e.passed ? '✓' : '✗'} {e.gate}
        </Badge>
      ))}
    </span>
  );
}
// Очередь встаёт не только по команде оператора: диспетчер останавливает её
// сам, когда выдавать работу нельзя — база отстала, checkout команды разошёлся.
// Причина лежит в журнале, и без неё панель показывает молчаливую паузу.
function stopReason(data: Snapshot) {
  return data.stopReason;
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
  return (
    <Button
      variant="outline"
      className={cn(
        'mt-1 h-auto w-full justify-start gap-3 border-0 p-3 text-left text-sm whitespace-normal max-[760px]:w-auto max-[760px]:min-w-48 max-[760px]:shrink-0 max-[760px]:p-2',
        current && 'text-primary bg-accent',
      )}
      onClick={() => onSelect(b.id)}
      aria-current={current ? 'page' : undefined}
    >
      <LayoutGrid />
      <span>
        {b.title}
        <small>
          {boardPhaseLabels[b.phase]} · ревизия {b.revisions.at(-1)!.number}
          {b.progress && ' · ' + b.progress}
        </small>
      </span>
      {b.revisions.at(-1)!.status === 'accepted' && <Check className="nav-check" />}
    </Button>
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
  // Снимок, который выбран последним: ответ для прежнего выбора отбрасывается.
  const wanted = useRef('');
  const [snapshot, setSnapshot] = useState<{ verificationId: string } & Page<SnapshotTask>>();
  // Сбой хранит свой повтор: «Повторить» повторяет именно неудавшийся запрос
  // (историю, её следующую страницу или снимок задач), а не первую страницу.
  const [failure, setFailure] = useState<{ what: string; message: string; retry: () => void }>();
  const [attempt, setAttempt] = useState(0);
  const base = `changesets/${encodeURIComponent(id)}`;
  useEffect(() => {
    if (!open) return;
    let valid = true;
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
    return api(`${base}?limit=10&before=${before}`)
      .then((value: { history: History }) =>
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
        }),
      )
      .catch((e: Error) =>
        setFailure({
          what: 'Ранние проверки не загрузились',
          message: e.message,
          retry: () => void more(before),
        }),
      );
  };
  const showSnapshot = (verification: string, cursor = 0): Promise<void> => {
    setFailure(undefined);
    if (!cursor) wanted.current = verification;
    return api(`${base}?limit=1&verification=${verification}&taskLimit=50&taskCursor=${cursor}`)
      .then((value: { snapshot: { verificationId: string } & Page<SnapshotTask> }) => {
        if (verification !== wanted.current) return;
        // Снимок неизменен: страница встаёт на своё смещение, не обрезая
        // уже загруженное дальше неё.
        setSnapshot((prev) =>
          cursor && prev?.verificationId === verification
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
      .catch((e: Error) =>
        setFailure({
          what: 'Снимок задач не загрузился',
          message: e.message,
          retry: () => void showSnapshot(verification, cursor),
        }),
      );
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
                      {t.id} · {t.title} · {statusNames[t.status] ?? t.status}
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
  return (
    <Badge variant={badgeTone[value] ?? 'secondary'}>
      {children ?? statusNames[value] ?? value}
    </Badge>
  );
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
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Ошибка запроса');
  return data;
}
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
export function App() {
  const flowRef =
    useRef<(options: { padding: number; minZoom: number; maxZoom: number }) => Promise<boolean>>(
      null,
    );
  const canvasRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [boardId, setBoardId] = useState('');
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null);
  const [selected, setSelected] = useState('');
  // An empty graph is the least informative thing to land on: before the first
  // board exists, what the operator needs to see is how the contour is set up.
  // Автор продукта начинает с обзора: что попробовать и какое решение нужно.
  const [tab, setTab] = useState('overview');
  // Обзор и карта продукта — представления всего workspace, а не одной доски.
  const workspaceView = tab === 'product' || tab === 'overview';
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
  const applied = useRef(0);
  const refresh = useCallback(async (force = true) => {
    const generation = ++issued.current;
    const v = view.current;
    const key = (x: typeof v, board = x.boardId) =>
      `${board}|${x.selected}|${x.workspace}|${x.accepted}`;
    const scope = key(v);
    const params = new URLSearchParams();
    if (v.boardId) params.set('board', v.boardId);
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
  }, [data, boardId]);
  // Смена доски, задачи или вида меняет состав сводки — запрос сразу.
  const [showAccepted, setShowAccepted] = useState(false);
  useEffect(() => {
    const v = view.current;
    const workspace = tab === 'workspace';
    const missing = !!selected && !!data && !data.tasks.some((t) => t.id === selected);
    // Пустая доска — та, что сервер выбрал по умолчанию.
    const effective = (id: string) => id || data?.boardId || '';
    const changed =
      effective(v.boardId) !== effective(boardId) ||
      v.workspace !== workspace ||
      v.accepted !== showAccepted;
    // Задача входит в область сводки, только если её нет в показанных данных
    // (прямая ссылка, задача другой доски): выбор задачи, которая уже есть,
    // не должен стоить полной сводки. Запрошенная так задача остаётся в
    // области, пока выбрана, — иначе она снова выпала бы из сводки.
    const wanted = missing || (!!selected && v.selected === selected) ? selected : '';
    Object.assign(v, { boardId, selected: wanted, workspace, accepted: showAccepted });
    if (changed || missing) void refresh().catch((e: Error) => setPollError(e.message));
  }, [boardId, selected, tab, showAccepted, data, refresh]);
  const board = data?.board?.id === boardId ? data.board : undefined;
  const revision =
    board?.revisions.find((r) => r.number === revisionNumber) ?? board?.revisions.at(-1);
  const current = revision?.number === board?.revisions.at(-1)?.number;
  const editable =
    revision?.status === 'active' && current && tab !== 'workspace' && !workspaceView;
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
  const task = graphTasks.find((t) => t.id === selected);
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
  useEffect(() => {
    const visible = graphTasks.filter((t) => showCancelled || t.status !== 'cancelled');
    if (visible.length && !visible.some((t) => t.id === selected)) setSelected(visible[0].id);
  }, [graphTasks, selected, showCancelled]);
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
  const hasData = !!data;
  useEffect(() => {
    if (!canvasRef.current) return;
    const observer = new ResizeObserver(() => {
      void flowRef.current?.({ padding: 0.12, minZoom: 0.65, maxZoom: 1 });
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [tab, boardId, hasData]);
  async function act(fn: () => Promise<unknown>, message: string, close = true) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      setNotice(message);
      if (close) setModal(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
    // Выбор доски из обзора или карты продукта — просьба показать доску.
    if (workspaceView) setTab('kanban');
  }
  const graph = useMemo(() => {
    const columns = new Map<number, number>();
    const lv = levels(filtered);
    const styles = getComputedStyle(document.documentElement);
    const token = (key: string) => parseFloat(styles.getPropertyValue(key));
    const dx = token('--node-width') + token('--node-gap-x'),
      dy = token('--node-height') + token('--node-gap-y');
    return {
      nodes: filtered.map((t) => {
        const level = lv.get(t.id)!;
        const row = columns.get(level) ?? 0;
        columns.set(level, row + 1);
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
            status: status(t),
            statusLabel: taskStatusName(t),
            live: liveLabel(
              data?.runs.find((r) => r.id === t.activeRunId && r.status === 'active'),
            ),
          },
          selected: t.id === selected,
          ariaLabel: `${t.id}: ${t.title}, ${taskStatusName(t)}`,
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
            className: status(t) === 'done' ? 'edge-done' : '',
          })),
      ),
    };
  }, [filtered, selected, data]);
  if (!data)
    return (
      <main className="grid min-h-dvh place-content-center justify-items-center gap-4">
        <Workflow />
        <h1>DevContour</h1>
        <p role="status">{error || pollError || 'Загружаем рабочий граф…'}</p>
        {(error || pollError) && (
          <Button variant="outline" onClick={() => location.reload()}>
            Повторить
          </Button>
        )}
      </main>
    );
  // Имена ролей объявляет workspace, а нужны они и там, где конфигурации под
  // рукой нет: источник ставится один раз, как только состояние загружено.
  setRoleSource(data.config);
  const liveTasks = tasks.filter((t) => t.status !== 'cancelled');
  const done = liveTasks.filter((t) => t.status === 'done').length;
  const inWork = liveTasks.filter((t) => t.activeRunId).length;
  const failedCount = liveTasks.filter((t) => t.status === 'failed').length;
  const blocked = tasks.filter((t) => status(t) === 'blocked').length;
  const ready = tasks.filter((t) => data.ready.includes(t.id)).length;
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
  return (
    <div className="grid min-h-dvh grid-cols-[var(--sidebar-width)_minmax(0,1fr)] max-[1180px]:grid-cols-[12rem_minmax(0,1fr)] max-[760px]:block">
      <aside className="bg-card flex flex-col border-r px-3 py-6 max-[1180px]:px-2 max-[760px]:border-r-0 max-[760px]:border-b max-[760px]:p-3">
        <a
          className="text-md text-foreground flex items-center gap-2 px-3 pb-8 font-semibold no-underline max-[1180px]:px-2 max-[760px]:p-0 max-[760px]:pb-3"
          href="/"
          aria-label="DevContour, главная"
        >
          <span className="bg-primary text-primary-foreground flex size-(--logo-size) shrink-0 items-center justify-center rounded-md">
            <Workflow />
          </span>
          DevContour
          <span className="text-muted-foreground ml-auto text-xs font-normal max-[760px]:ml-0">
            mvp
          </span>
        </a>
        <div className="mb-6 flex gap-3 rounded-md border p-3 text-sm max-[760px]:hidden">
          <span className="bg-accent text-primary grid size-(--logo-size) shrink-0 place-items-center rounded-sm max-[1180px]:hidden">
            D
          </span>
          <div>
            <strong>{data.config.name}</strong>
            <small>Локальное рабочее пространство</small>
          </div>
        </div>
        <div className="text-muted-foreground flex items-center justify-between pl-3 text-sm max-[760px]:pl-0">
          <span>Доски проекта</span>
          <Button
            variant="outline"
            className="icon-button"
            aria-label="Создать доску"
            onClick={() => setModal('board')}
          >
            <Plus />
          </Button>
        </div>
        <nav aria-label="Доски">
          {liveBoards(data)
            .filter((b) => b.revisions.at(-1)!.status !== 'accepted')
            .map((b) => (
              <BoardLink key={b.id} board={b} current={b.id === boardId} onSelect={switchBoard} />
            ))}
          {/* Принятые доски — история, а не текущая работа. Вперемешку с
              активными они выглядели параллельными потоками того же релиза. */}
          {liveBoards(data).some((b) => b.revisions.at(-1)!.status === 'accepted') && (
            <details
              className="mt-3 max-[760px]:mt-0 max-[760px]:shrink-0"
              open={board?.revisions.at(-1)?.status === 'accepted' || undefined}
            >
              <summary className="text-muted-foreground cursor-pointer px-3 py-1 text-sm">
                Принятые (
                {liveBoards(data).filter((b) => b.revisions.at(-1)!.status === 'accepted').length})
              </summary>
              {liveBoards(data)
                .filter((b) => b.revisions.at(-1)!.status === 'accepted')
                .map((b) => (
                  <BoardLink
                    key={b.id}
                    board={b}
                    current={b.id === boardId}
                    onSelect={switchBoard}
                  />
                ))}
            </details>
          )}
        </nav>
        <div className="text-muted-foreground mt-auto px-3 pt-8 text-xs [&_p]:my-2 max-[760px]:hidden">
          <div className="text-foreground flex items-center gap-2">
            <span
              className={cn(
                'inline-block size-2 rounded-full',
                data.paused ? 'bg-(--text-secondary)' : 'bg-success',
              )}
            />
            <strong>{data.paused ? 'Очередь на паузе' : 'Оркестратор работает'}</strong>
          </div>
          {/* Очередь останавливается не только по команде: диспетчер тормозит
              сам, когда выдавать работу нельзя. Без причины на виду панель
              просто молчит, и приходится читать журнал. */}
          {data.paused && stopReason(data) && (
            <p className="text-destructive break-words">{stopReason(data)}</p>
          )}
          <p>
            {data.runs.filter((r) => r.status === 'active').length} из {data.config.concurrency}{' '}
            исполнителей занято
          </p>
          <p>
            Интеграция в <code>{data.config.targetBranch}</code>
          </p>
          <p>Репозитории: {data.config.repositories.map((r) => r.id).join(', ')}</p>
          <p>Согласования: {data.config.approvalMode === 'operator' ? 'оператор' : 'агент'}</p>
        </div>
      </aside>
      <main className="min-w-0">
        <div className="bg-card text-muted-foreground flex flex-wrap items-center justify-between gap-4 border-b px-8 py-4 text-xs max-[1180px]:px-5 max-[760px]:p-3 [&_svg]:size-3.5 [&>span:first-child]:flex [&>span:first-child]:items-center [&>span:first-child]:gap-2">
          <span>
            Проект <ChevronRight />{' '}
            {tab === 'overview'
              ? 'Обзор'
              : tab === 'product'
                ? 'Карта продукта'
                : (board?.title ?? 'Новая доска')}
          </span>
          <span className="text-primary bg-accent rounded-sm px-2 py-1">
            {data.config.mode === 'demo'
              ? 'Учебный режим · без вызовов моделей'
              : 'Локальный runtime'}
          </span>
        </div>
        <div className="p-8 max-[1180px]:p-5 max-[760px]:p-4">
          <header className="mb-6 flex flex-wrap items-start justify-between gap-6 max-[760px]:mb-4 max-[760px]:gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1>
                  {tab === 'overview'
                    ? 'Обзор'
                    : tab === 'product'
                      ? 'Карта продукта'
                      : (board?.title ?? 'Создайте первую доску')}
                </h1>
                {revision && !workspaceView && (
                  <span className="text-muted-foreground rounded-sm border px-2 py-1 text-sm">
                    r{revision.number}
                  </span>
                )}
              </div>
              <p>
                {tab === 'overview'
                  ? 'Что можно попробовать, какое решение нужно и что делает система.'
                  : tab === 'product'
                    ? 'Пользовательские возможности, приложения и проверенный результат.'
                    : (board?.description ?? 'Опишите цель, добавьте задачи и их зависимости.')}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 max-[760px]:w-full">
              {!workspaceView && board && current && revision?.status === 'accepted' && (
                <Button
                  variant="outline"
                  className="primary"
                  onClick={() => {
                    setRoots([]);
                    setModal('correct');
                  }}
                >
                  <RotateCcw />
                  Создать корректировку
                </Button>
              )}
              {editable && (
                <>
                  <Button variant="outline" onClick={() => setModal('task')}>
                    <Plus />
                    Задача
                  </Button>
                  {tasks.some((t) => t.status === 'draft') && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        void act(() => api(`boards/${boardId}/approve`, {}), 'Задачи утверждены')
                      }
                      disabled={busy}
                    >
                      Утвердить план
                    </Button>
                  )}
                  {tasks.length > 0 && done === tasks.length && (
                    <Button
                      variant="outline"
                      className="primary"
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
                </>
              )}
            </div>
          </header>
          {pollError && (
            <div className="alert error" role="alert">
              <AlertCircle />
              <span>
                Нет связи с сервером: {pollError}. На экране последнее полученное состояние; опрос
                повторяется.
              </span>
            </div>
          )}
          {error && !modal && !log && (
            <div className="alert error" role="alert">
              <AlertCircle />
              <span>{error}</span>
              <Button
                variant="outline"
                className="icon-button"
                onClick={() => setError('')}
                aria-label="Скрыть ошибку"
              >
                <X />
              </Button>
            </div>
          )}
          {data.journalError && (
            <p className="alert error" role="alert">
              Дневник: {data.journalError}
            </p>
          )}
          {notice && (
            <div
              className="text-success bg-success-foreground mb-4 flex items-center gap-3 rounded-md px-4 py-3 text-sm break-words [&>svg]:size-4.5 [&>svg]:shrink-0"
              role="status"
            >
              <Check />
              {notice}
              <Button
                variant="outline"
                className="icon-button"
                onClick={() => setNotice('')}
                aria-label="Скрыть уведомление"
              >
                <X />
              </Button>
            </div>
          )}
          {!workspaceView && revision?.status === 'accepted' && (
            <div className="text-success bg-success-foreground mb-5 flex items-center gap-3 rounded-md p-4 text-sm [&>svg]:size-6 [&>svg]:shrink-0 [&_span]:block [&_code]:ml-auto">
              <CircleCheck />
              <div>
                <strong>
                  Ревизия {revision.number} принята {stamp(revision.acceptedAt)}
                </strong>
                <span>Снимок сохранён. Изменения начнут новый цикл и сохранят эту историю.</span>
              </div>
              <code>{revision.snapshot?.sha.slice(0, 8)}</code>
            </div>
          )}
          {!workspaceView && (
            <section
              className="bg-card mb-6 flex flex-wrap items-center gap-8 rounded-md border px-5 py-4 max-[1180px]:gap-4 max-[760px]:mb-4 max-[760px]:p-3 [&>div]:flex [&>div]:items-center [&>div]:gap-2 [&>div]:max-[760px]:flex-auto [&>div>span]:text-muted-foreground [&>div>span]:text-sm [&>div>svg]:text-muted-foreground [&>div>svg]:size-4.5 [&_strong]:text-md [&_strong>span]:text-muted-foreground [&_strong>span]:font-normal"
              aria-label="Прогресс доски"
            >
              <div>
                <CircleCheck />
                <strong>
                  {done}
                  <span> / {liveTasks.length}</span>
                </strong>
                <span>результатов принято</span>
              </div>
              <div>
                <Loader2 className={inWork ? 'animate-spin' : ''} />
                <strong>{inWork}</strong>
                <span>в работе</span>
              </div>
              {failedCount > 0 && (
                <div>
                  <X />
                  <strong>{failedCount}</strong>
                  <span>со сбоем</span>
                </div>
              )}
              <div>
                <Play />
                <strong>{ready}</strong>
                <span>готово к запуску</span>
              </div>
              <div>
                <Clock />
                <strong>{blocked}</strong>
                <span>ждут зависимостей</span>
              </div>
              <div className="ml-auto max-[760px]:ml-0 max-[760px]:w-full [&_button]:max-[760px]:w-full">
                <Button
                  variant="outline"
                  className={data.paused ? 'primary' : ''}
                  disabled={busy || (data.paused && !data.ready.length)}
                  onClick={() =>
                    void act(
                      () => api('scheduler', { start: data.paused }),
                      data.paused
                        ? 'Очередь всех досок запущена'
                        : 'Новые задачи приостановлены; текущие продолжаются',
                      false,
                    )
                  }
                >
                  {data.paused ? <Play /> : <Pause />}
                  {data.paused ? 'Запустить очередь' : 'Пауза очереди'}
                </Button>
              </div>
              {liveTasks.length > 0 && (
                <div
                  className="bg-muted h-1.5 w-full basis-full overflow-hidden rounded-full"
                  role="progressbar"
                  aria-label="Принято результатов"
                  aria-valuemin={0}
                  aria-valuemax={liveTasks.length}
                  aria-valuenow={done}
                >
                  <div
                    className="bg-success h-full"
                    style={{ width: `${(done / liveTasks.length) * 100}%` }}
                  />
                </div>
              )}
            </section>
          )}
          <LiveWork
            state={data}
            stopReason={stopReason(data)}
            onOpenTask={(id, taskId) => {
              if (id && id !== boardId) {
                setBoardId(id);
                setRevisionNumber(null);
              }
              setQuery('');
              setSelected(taskId);
              if (workspaceView || tab === 'progress') setTab('graph');
            }}
            onStart={
              workspaceView
                ? () =>
                    void act(
                      () => api('scheduler', { start: true }),
                      'Очередь всех досок запущена',
                      false,
                    )
                : undefined
            }
          />
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div
              className="flex flex-wrap gap-1 max-[760px]:w-full max-[760px]:justify-between max-[760px]:gap-0"
              role="tablist"
              aria-label="Представление доски"
            >
              {[
                { key: 'overview', label: 'Обзор', icon: <Eye /> },
                { key: 'product', label: 'Карта продукта', icon: <LayoutGrid /> },
                { key: 'progress', label: 'Ход работ', icon: <Activity /> },
                { key: 'kanban', label: 'Колонки', icon: <SquareKanban /> },
                { key: 'graph', label: 'Граф', icon: <GitBranch /> },
                { key: 'workspace', label: 'Общий граф', icon: <Workflow /> },
                { key: 'changesets', label: 'Изменения', icon: <FileCheck /> },
                { key: 'list', label: 'Список', icon: <List /> },
                { key: 'history', label: 'Ревизии', icon: <History /> },
                { key: 'contracts', label: 'Контракты', icon: <FileCheck /> },
              ].map((t) => (
                <Button
                  variant="outline"
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                >
                  {t.icon}
                  {t.label}
                </Button>
              ))}
            </div>
            {!workspaceView && (
              <>
                <label className="max-w-60 max-[760px]:w-full max-[760px]:max-w-none">
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
                {cancelledCount > 0 && (
                  <label className="text-muted-foreground flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
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
                      checked={showAccepted}
                      onChange={(e) => setShowAccepted(e.target.checked)}
                    />
                    Показать принятые доски ({data.acceptedBoards})
                  </label>
                )}
                <label className="max-w-60 max-[760px]:w-full max-[760px]:max-w-none">
                  <span className="sr-only">Поиск задач</span>
                  <Input
                    placeholder="Найти задачу…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </>
            )}
          </div>
          <div
            className={cn(
              'grid items-start gap-4',
              tab === 'changesets' || workspaceView || tab === 'progress'
                ? 'grid-cols-[minmax(0,1fr)]'
                : 'grid-cols-[minmax(0,1fr)_var(--inspector-width)] max-[1180px]:grid-cols-[minmax(0,1fr)]',
            )}
          >
            <section
              className="bg-card min-w-0 overflow-hidden rounded-lg border shadow-sm"
              aria-label="Рабочая область"
            >
              <Suspense fallback={<p role="status">Загружаем представление…</p>}>
                {tab === 'progress' && data && (
                  <div className="p-4">
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
                  <div className="min-w-0 p-4">
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
                    className="grid min-h-(--canvas-height) auto-cols-[minmax(10.5rem,1fr)] grid-flow-col gap-3 overflow-x-auto p-3"
                    aria-label="Колонки задач"
                  >
                    {kanbanColumns.map((column) => {
                      const cards = filtered.filter((t) => column.statuses.includes(t.status));
                      return (
                        <section
                          key={column.key}
                          aria-label={column.label}
                          className="bg-muted/40 flex min-w-0 flex-col gap-2 rounded-md p-2"
                        >
                          <header className="px-1 pt-1">
                            <h2 className="m-0 flex items-baseline justify-between gap-2 text-sm">
                              {column.label}
                              <span className="text-muted-foreground text-xs">{cards.length}</span>
                            </h2>
                            <small className="text-muted-foreground">{column.hint}</small>
                          </header>
                          {cards.map((t) => (
                            <Button
                              variant="outline"
                              key={t.id}
                              className={cn(
                                'bg-card h-auto w-full min-w-0 flex-col items-start gap-1 overflow-hidden p-3 text-left font-normal whitespace-normal',
                                selected === t.id && 'border-primary bg-accent',
                              )}
                              aria-current={selected === t.id ? 'true' : undefined}
                              onClick={() => setSelected(t.id)}
                            >
                              <span className="text-muted-foreground text-xs" title={t.id}>
                                {shortId(t.id)} · {roleLabel(t.role)}
                              </span>
                              <strong className="text-sm">{t.title}</strong>
                              <TaskLive
                                task={t}
                                runs={data.runs}
                                maxAttempts={data.config.maxAttempts}
                              />
                              <StatusBadge value={status(t)}>{taskStatusName(t)}</StatusBadge>
                            </Button>
                          ))}
                        </section>
                      );
                    })}
                  </div>
                )}
                {(tab === 'graph' || tab === 'workspace') &&
                  (filtered.length ? (
                    <>
                      <div className="text-muted-foreground flex justify-between border-b px-4 py-3 text-xs [&>span:first-child]:max-[760px]:max-w-[27ch]">
                        <span>Зависимость ведёт от условия к результату</span>
                        <span>{graph.edges.length} связей</span>
                      </div>
                      <div
                        className="bg-background h-(--canvas-height) max-[760px]:h-[26rem]"
                        ref={canvasRef}
                      >
                        <GraphPanel
                          onInit={(instance) => {
                            flowRef.current = (options) => instance.fitView(options);
                          }}
                          key={`${boardId}-${revision?.number}-${filtered.map((t) => t.id).join()}`}
                          nodes={graph.nodes}
                          edges={graph.edges}
                          nodesDraggable={false}
                          nodesConnectable={false}
                          edgesFocusable={false}
                          deleteKeyCode={null}
                          onNodeClick={(_, n) => setSelected(n.id)}
                          fitView
                          fitViewOptions={{ padding: 0.12, minZoom: 0.65, maxZoom: 1 }}
                          minZoom={0.3}
                        />
                      </div>
                    </>
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
                  <div className="">
                    {filtered.length ? (
                      filtered.map((t) => (
                        <Button
                          variant="outline"
                          className={cn(
                            'flex h-auto w-full items-center justify-start gap-3 rounded-none border-0 border-b p-4 text-left font-normal whitespace-normal last:border-b-0 max-[760px]:flex-wrap max-[760px]:gap-2',
                            selected === t.id && 'bg-accent',
                          )}
                          key={t.id}
                          onClick={() => setSelected(t.id)}
                        >
                          <span className="text-muted-foreground min-w-8 text-xs" title={t.id}>
                            {shortId(t.id)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <strong>{t.title}</strong>
                            <small>
                              {t.repositoryId} · {roleLabel(t.role)}
                              {t.dependsOn.length
                                ? ` · после: ${t.dependsOn
                                    .map(
                                      (d) =>
                                        data.tasks.find((x) => x.id === d)?.title ?? shortId(d),
                                    )
                                    .join('; ')}`
                                : ''}
                            </small>
                            <TaskLive
                              task={t}
                              runs={data.runs}
                              maxAttempts={data.config.maxAttempts}
                            />
                          </div>
                          <StatusBadge value={status(t)}>{taskStatusName(t)}</StatusBadge>
                          <ChevronRight />
                        </Button>
                      ))
                    ) : (
                      <p className="text-muted-foreground flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center [&>svg]:size-8 [&_h2]:text-md [&_h2]:text-foreground [&_h2]:m-0 [&_p]:m-0">
                        Нет задач для отображения.
                      </p>
                    )}
                  </div>
                )}
                {tab === 'changesets' && (
                  <div className="min-h-(--canvas-height) p-6 [&>h2]:text-md [&>p]:text-muted-foreground [&>p]:max-w-[65ch] [&>p]:text-sm">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <h2>Изменения workspace</h2>
                      <Button variant="outline" onClick={() => setModal('changeset')}>
                        <Plus />
                        Новый ChangeSet
                      </Button>
                    </div>
                    <p>
                      Одна возможность продукта, несколько репозиториев. Приёмка фиксирует
                      проверенную комбинацию SHA.
                    </p>
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
                        <article key={c.id} id={'changeset-' + c.id} tabIndex={-1}>
                          <div>
                            <strong>
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
                          {v?.error && <p className="alert error">{v.error}</p>}
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
                              {delivery.error && <p className="alert error">{delivery.error}</p>}
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
                  <div className="min-h-(--canvas-height) p-6 [&>h2]:text-md [&>p]:text-muted-foreground [&>p]:max-w-[65ch] [&>p]:text-sm">
                    <h2>История результата</h2>
                    <p>
                      Принятые снимки неизменяемы. Каждая корректировка имеет свой план и
                      доказательства.
                    </p>
                    {[...(board?.revisions ?? [])].reverse().map((r) => (
                      <article key={r.number}>
                        <div>
                          <span className="text-primary bg-accent rounded-sm p-2">r{r.number}</span>
                          <div>
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
                          onClick={() => {
                            setRevisionNumber(r.number);
                            setTab('graph');
                          }}
                        >
                          Открыть ревизию {r.number}
                          <ArrowUpRight />
                        </Button>
                      </article>
                    ))}
                  </div>
                )}
                {tab === 'contracts' && (
                  <div className="min-h-(--canvas-height) p-6 [&>h2]:text-md [&>p]:text-muted-foreground [&>p]:max-w-[65ch] [&>p]:text-sm">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <h2>Утверждённые контракты</h2>
                      <Button variant="outline" onClick={() => setModal('contract')}>
                        <Plus />
                        Контракт
                      </Button>
                    </div>
                    <p>
                      Новая версия создаётся отдельным контрактом. Задачи закрепляют его содержимое
                      при утверждении.
                    </p>
                    {data.contracts.map((c) => (
                      <article key={c.id}>
                        <div>
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
            {tab !== 'changesets' && !workspaceView && (
              <aside
                className="bg-card max-h-[calc(var(--canvas-height)+var(--space-10))] overflow-auto rounded-lg border p-5 text-sm max-[1180px]:max-h-none"
                aria-label="Детали задачи"
              >
                {task ? (
                  <>
                    <div className="text-muted-foreground mb-4 flex items-center justify-between gap-2 text-xs [&>span:first-child]:min-w-0 [&>span:first-child]:break-words">
                      <span>{task.id}</span>
                      <StatusBadge value={status(task)}>{taskStatusName(task)}</StatusBadge>
                    </div>
                    <h2>{task.title}</h2>
                    <p>
                      Репозиторий: <code>{task.repositoryId}</code>
                    </p>
                    {task.assignee && (
                      <p>
                        Ответственный: <strong>{task.assignee}</strong>
                      </p>
                    )}
                    {task.sharedCompletion && (
                      <div>
                        <p>
                          Результат принят из Git: <code>{task.resultSha?.slice(0, 12)}</code>.
                          Проверки выполнены участником команды; локальная попытка не запускалась.
                        </p>
                        <details>
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
                    <p className="text-muted-foreground break-words whitespace-pre-wrap">
                      {task.description}
                    </p>
                    {!!task.progress?.reasons.length && (
                      <section
                        className="bg-secondary my-4 rounded-md p-3 text-sm break-words [&>h3]:mt-0 [&_ul]:mb-0 [&_ul]:pl-4 [&_li+li]:mt-2"
                        aria-label="Что нужно для продолжения"
                      >
                        <h3>Что нужно для продолжения</h3>
                        <ul>
                          {task.progress.reasons.map((reason) => (
                            <li key={reason}>{waitingReasons[reason] ?? reason}</li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {task.progress?.eligible && (
                      <p className="bg-secondary my-4 rounded-md p-3 text-sm break-words [&>h3]:mt-0 [&_ul]:mb-0 [&_ul]:pl-4 [&_li+li]:mt-2">
                        Задача доступна для выдачи исполнителю.
                      </p>
                    )}
                    <dl>
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
                        </dd>
                      </div>
                      <div>
                        <dt>Попытки</dt>
                        <dd>{task.attempt}</dd>
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
                    {task.supersedes && (
                      <p className="bg-accent text-primary rounded-sm p-2">
                        Корректирует <strong>{task.supersedes}</strong>
                      </p>
                    )}
                    <h3>Критерии приёмки</h3>
                    <ul className="m-0 list-none p-0 [&_svg]:size-3.5">
                      {task.acceptance.map((a, i) => (
                        <li key={i}>
                          <span
                            className={cn(
                              'flex size-5 shrink-0 items-center justify-center rounded-full border text-xs',
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
                    <h3>Зависимости</h3>
                    {task.dependsOn.length ? (
                      <div className="grid gap-2">
                        {task.dependsOn.map((id) => {
                          const d = data.tasks.find((t) => t.id === id);
                          return (
                            <Button
                              variant="outline"
                              key={id}
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
                                className={d?.status === 'done' ? 'text-success' : 'text-warning'}
                              >
                                {d?.status === 'done' ? <Check /> : <Clock />}
                              </span>
                              <span>
                                {id}
                                <small>{d?.title}</small>
                              </span>
                              <ChevronRight />
                            </Button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm">Можно начать независимо.</p>
                    )}
                    {task.contracts.length > 0 && (
                      <>
                        <h3>Контракты</h3>
                        <p className="text-muted-foreground text-sm">
                          {task.contracts.join(', ')}
                          {task.approvedDigest
                            ? ' · версии закреплены'
                            : ' · закрепятся при утверждении'}
                        </p>
                      </>
                    )}
                    <h3>Проверки и доказательства</h3>
                    {full?.runs.items[0]?.evidence.length ? (
                      <div className="grid gap-2">
                        {full.runs.items[0].evidence.map((e) => (
                          <Button
                            variant="outline"
                            key={e.id}
                            onClick={() =>
                              void act(
                                async () => {
                                  const result = await api(`evidence/${e.id}`);
                                  setLog({
                                    title: `${e.gate} / ${e.phase}`,
                                    content: result.content,
                                  });
                                },
                                'Артефакт загружен',
                                false,
                              )
                            }
                          >
                            <span className={e.passed ? 'text-success' : 'text-destructive'}>
                              {e.passed ? <Check /> : <X />}
                            </span>
                            <span>
                              {e.kind === 'review' ? 'Независимое ревью' : e.gate}
                              <small>
                                {e.phase === 'integration' ? 'После интеграции' : 'Кандидат'} ·{' '}
                                {e.sha.slice(0, 7)}
                                {e.kind === 'review' &&
                                  ` · ${e.inspection?.mode ?? 'команды не зафиксированы'}`}
                              </small>
                            </span>
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        {task.sharedCompletion
                          ? 'Свидетельство участника доступно выше. Логи хранятся в исходном контуре выполнения.'
                          : 'Появятся после запуска. Отсутствие отчёта не считается успехом.'}
                      </p>
                    )}
                    {task.resultSha && (
                      <p className="text-success mt-4">
                        Принятый коммит <code>{task.resultSha.slice(0, 12)}</code>
                      </p>
                    )}
                    {task.failure && (
                      <p className="bg-destructive-foreground text-destructive rounded-sm p-3 break-words [overflow-wrap:anywhere]">
                        {task.failure}
                      </p>
                    )}
                    <div className="mt-6 flex flex-wrap gap-2 border-t pt-4">
                      {task.status === 'draft' && editable && (
                        <>
                          <Button variant="outline" onClick={() => setModal('edit')}>
                            Редактировать
                          </Button>
                          <Button
                            variant="outline"
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
                      {!['done', 'cancelled'].includes(task.status) && (
                        <Button
                          variant="outline"
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
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-muted-foreground flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center [&>svg]:size-8 [&_h2]:text-md [&_h2]:text-foreground [&_h2]:m-0 [&_p]:m-0">
                    <FileCheck />
                    <p>Выберите задачу, чтобы увидеть зависимости и результаты проверок.</p>
                  </div>
                )}
              </aside>
            )}
          </div>
          <footer className="text-muted-foreground mt-4 flex justify-between gap-4 text-xs [&>span:first-child]:flex [&>span:first-child]:items-center [&>span:first-child]:gap-2">
            <span>
              <span className="dot active" /> SQLite · состояние сохранено локально
            </span>
            <span>
              {data.config.completionMode === 'remote'
                ? 'Приёмка ChangeSet = локальные проверки + merge + CI'
                : 'Приёмка = тесты + ревью + проверенная интеграция'}
            </span>
          </footer>
        </div>
      </main>
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
