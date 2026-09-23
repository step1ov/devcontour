import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronRight,
  CircleDashed,
  CircleDot,
  History,
  Loader2,
  MessageCircleQuestion,
  Scale,
  Send,
} from 'lucide-react';
import type { Preparation } from '../core/preparation.ts';
import type { PreparationQuestion, PreparationRecord } from '../core/preparation-model.ts';
import { ProductBriefView } from './ProductBrief.tsx';
import { ArchitectureBriefView } from './ArchitectureBrief.tsx';
import { DesignBriefView } from './DesignBrief.tsx';
import { ReferencesBriefView } from './ReferencesBrief.tsx';
import { ConceptBriefView } from './ConceptBrief.tsx';
import { StageBoundary } from './StageBoundary.tsx';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.tsx';
import { Input } from '@/ui/input.tsx';
import { Label } from '@/ui/label.tsx';
import { Separator } from '@/ui/separator.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { cn } from '@/lib/utils.ts';

const Development = lazy(() => import('./App.tsx').then((m) => ({ default: m.App })));
type Worker = {
  runId: string;
  taskId: string;
  title: string;
  role?: string;
  phase?: string;
  runtime?: string;
  model?: string;
  startedAt: string;
};
type View = ReturnType<Preparation['status']> & {
  setup?: {
    repositories: string[];
    profile: string | null;
    gates: string[];
    workspaceGates: string[];
  };
  workers?: Worker[];
  engineConnected?: boolean;
  startupError?: string;
  workspace?: { mode: 'embedded' | 'separate'; path: string };
};
type Stage = 'product' | 'architecture' | 'references' | 'concept' | 'design' | 'development';
const stages: Stage[] = [
  'product',
  'architecture',
  'references',
  'concept',
  'design',
  'development',
];
const approvalTitles: Record<Exclude<Stage, 'development'>, string> = {
  product: 'Утвердить продуктовую постановку',
  architecture: 'Утвердить архитектуру и стек',
  references: 'Утвердить референсы',
  concept: 'Утвердить концепт и эскизы',
  design: 'Утвердить макет и дизайн-систему',
};
// Design is one stage of the project with three decisions inside it. The
// stepper shows the stage; the sub-navigation shows where inside it we are.
const designSteps = ['references', 'concept', 'design'] as const;
type DesignStep = (typeof designSteps)[number];
const designStepNames: Record<DesignStep, string> = {
  references: 'Референсы',
  concept: 'Концепт и эскизы',
  design: 'Макет и дизайн-система',
};
const topStages = ['product', 'architecture', 'design', 'development'] as const;
const topStageNames = ['Продукт', 'Архитектура и стек', 'Дизайн', 'Разработка'];
const isDesignStep = (stage: Stage): stage is DesignStep =>
  (designSteps as readonly string[]).includes(stage);
// The stage, the selected change and the development view live in the URL, so a
// reload keeps the reader where they were and a link points at what they meant.
function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const stage = params.get('stage');
  return {
    change: params.get('change') ?? '',
    tab: (stages.includes(stage as Stage) ? stage : 'product') as Stage,
    boards: params.get('view') === 'boards',
  };
}
function writeLocation(state: { change: string; tab: Stage; boards: boolean }) {
  const params = new URLSearchParams();
  if (state.change) params.set('change', state.change);
  if (state.tab !== 'product') params.set('stage', state.tab);
  if (state.boards) params.set('view', 'boards');
  const search = params.toString();
  const next = window.location.pathname + (search ? '?' + search : '');
  if (next !== window.location.pathname + window.location.search)
    window.history.pushState(null, '', next);
}
type RevisionStatus = 'draft' | 'in-review' | 'approved' | 'changes-requested';
const names: Record<RevisionStatus, string> = {
  draft: 'Агент прорабатывает',
  'in-review': 'Ожидает вашего решения',
  approved: 'Утверждено',
  'changes-requested': 'Нужна доработка',
};
const tone: Record<RevisionStatus, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  draft: 'secondary',
  'in-review': 'warning',
  approved: 'success',
  'changes-requested': 'destructive',
};
async function request<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(
    '/api/' + path,
    value === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
          body: JSON.stringify(value),
        },
  );
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Не удалось получить состояние');
  return data;
}
function ago(at: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  if (seconds < 60) return seconds + ' с назад';
  if (seconds < 3600) return Math.round(seconds / 60) + ' мин назад';
  if (seconds < 86400) return Math.round(seconds / 3600) + ' ч назад';
  return new Date(at).toLocaleDateString('ru-RU');
}
function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('border-b py-4', className)}>
      <h3 className="text-md mb-3 font-semibold">{title}</h3>
      {children}
    </section>
  );
}
// A section the reader opens when it matters. An empty one starts folded, and
// one that fills up unfolds itself until the reader decides otherwise.
function Foldable({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? count > 0;
  return (
    <section className="border-b py-4">
      <h3>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 gap-2"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setChoice(!open)}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn('transition-transform', open && 'rotate-90')}
          />
          <span className="text-md font-semibold">
            {title} ({count})
          </span>
        </Button>
      </h3>
      <div id={id} hidden={!open} className="mt-3">
        {children}
      </div>
    </section>
  );
}

// The lead agent reads a brief for minutes at a time. Without this the panel
// looked idle and the operator could not tell the session was alive.
function AgentWork({
  activity,
  latest,
}: {
  activity: { at: string; stage: string; note: string }[];
  latest?: { at: string; note: string };
}) {
  const [open, setOpen] = useState(false);
  const recent = latest && Date.now() - new Date(latest.at).getTime() < 5 * 60 * 1000;
  return (
    <Card className="mb-6">
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <CardTitle className="flex items-center gap-2">
          {recent ? (
            <Loader2 className="text-primary size-4 animate-spin" aria-hidden="true" />
          ) : (
            <CircleDot className="text-muted-foreground size-4" aria-hidden="true" />
          )}
          Работа агента
        </CardTitle>
        {activity.length > 1 && (
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            <History aria-hidden="true" />
            {open ? 'Свернуть' : 'Вся история (' + activity.length + ')'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {latest ? (
          <p role="status" className="max-w-[78ch] break-words whitespace-pre-wrap">
            {latest.note} <span className="text-muted-foreground text-sm">· {ago(latest.at)}</span>
          </p>
        ) : (
          <p className="text-muted-foreground" role="status">
            Агент ещё не сообщал о работе над этим изменением.
          </p>
        )}
        {open && (
          <ol className="mt-4 grid gap-2 border-t pt-4">
            {activity.map((item, i) => (
              <li key={i} className="text-sm">
                <span className="text-muted-foreground tabular-nums">
                  {new Date(item.at).toLocaleTimeString('ru-RU')}
                </span>{' '}
                {item.note}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// Open questions used to be a throwaway array inside a draft. They are now
// durable and the operator answers them here rather than in chat.
function Questions({
  stage,
  questions,
  busy,
  onAnswer,
}: {
  stage: Exclude<Stage, 'development'>;
  questions: PreparationQuestion[];
  busy: boolean;
  onAnswer: (questionId: string, text: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const mine = questions.filter((q) => q.stage === stage && q.status !== 'withdrawn');
  const open = mine.filter((q) => q.status === 'open');
  return (
    <Foldable id={'questions-' + stage} title="Открытые вопросы" count={open.length}>
      <p className="text-muted-foreground mb-4 max-w-[78ch]">
        Агент не отвечает на них сам. Пока есть неотвеченные вопросы этапа, версию нельзя отправить
        на утверждение.
      </p>
      {!mine.length && <p className="text-muted-foreground">Вопросов по этому этапу не было.</p>}
      <ul className="grid gap-4">
        {mine.map((q) => (
          <li key={q.id}>
            <Card>
              <CardHeader className="gap-2 pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <CardTitle className="flex items-start gap-2">
                    <MessageCircleQuestion
                      className="text-primary mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="max-w-[70ch] break-words whitespace-pre-wrap">{q.text}</span>
                  </CardTitle>
                  <Badge variant={q.status === 'answered' ? 'success' : 'warning'}>
                    {q.status === 'answered' ? 'Отвечено' : 'Ждёт ответа'}
                  </Badge>
                </div>
                {q.why && <p className="text-muted-foreground text-sm">На что влияет: {q.why}</p>}
                {q.options.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {q.options.map((option, i) => (
                      <Badge key={i} variant="outline">
                        {option}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardHeader>
              <CardContent className="pt-0">
                {q.answer ? (
                  <div className="border-primary bg-secondary border-l-[3px] p-3">
                    <strong className="text-sm">Ваш ответ · {ago(q.answer.at)}</strong>
                    <p className="mt-1 max-w-[70ch] break-words whitespace-pre-wrap">
                      {q.answer.text}
                    </p>
                  </div>
                ) : (
                  <form
                    className="grid gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      onAnswer(q.id, drafts[q.id] ?? '');
                    }}
                  >
                    <Label htmlFor={'answer-' + q.id}>Ваш ответ</Label>
                    <Textarea
                      id={'answer-' + q.id}
                      rows={2}
                      maxLength={3000}
                      value={drafts[q.id] ?? ''}
                      onChange={(e) => setDrafts({ ...drafts, [q.id]: e.target.value })}
                    />
                    <div>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={busy || (drafts[q.id] ?? '').trim().length < 1}
                      >
                        Ответить
                      </Button>
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </Foldable>
  );
}
// A stage with nothing in it is either untouched or waiting on the operator.
// Saying which, and pointing at the step that holds it, is the difference
// between an empty tab and a tab that explains itself.
function Waiting({
  previous,
  blocked,
  working,
  onGo,
}: {
  previous?: { status: string };
  blocked: string;
  working: string;
  onGo: () => void;
}) {
  const pending = previous?.status === 'in-review';
  return (
    <Alert className="max-w-[78ch] border-dashed">
      <AlertDescription className="grid gap-3">
        <span>{previous?.status === 'approved' ? working : blocked}</span>
        {pending && (
          <span>
            <Button variant="outline" size="sm" onClick={onGo}>
              Перейти к решению
            </Button>
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}
const roleNames: Record<string, string> = {
  architect: 'Архитектор',
  backend: 'Разработчик бэкенда',
  frontend: 'Разработчик интерфейса',
  qa: 'Тестировщик',
};
const phaseNames: Record<string, string> = {
  running: 'пишет код',
  verifying: 'гоняет проверки',
  reviewing: 'на ревью',
  integrating: 'интегрирует',
};
// Setting a contour up is a sequence with a result, so it gets a progress bar
// of its own: before the first task exists it is the only work happening.
function SetupProgress({ setup, tasks }: { setup: View['setup']; tasks: number }) {
  const steps = [
    { id: 'repo', label: 'Репозиторий подключён', done: (setup?.repositories.length ?? 0) > 0 },
    { id: 'profile', label: 'Профиль проверок закреплён', done: Boolean(setup?.profile) },
    { id: 'gates', label: 'Проверки компонента настроены', done: (setup?.gates.length ?? 0) > 0 },
    {
      id: 'joint',
      label: 'Сквозная проверка релиза настроена',
      done: (setup?.workspaceGates.length ?? 0) > 0,
    },
    { id: 'tasks', label: 'Задачи собраны в доску', done: tasks > 0 },
  ];
  const done = steps.filter((s) => s.done).length;
  const percent = Math.round((done / steps.length) * 100);
  return (
    <div className="mt-4 grid gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <strong className="text-sm">Настройка контура</strong>
        <span className="text-muted-foreground font-mono text-sm">
          {done} / {steps.length} · {percent}%
        </span>
      </div>
      <div
        className="bg-secondary h-2 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Настройка контура"
      >
        <div className="bg-primary h-full rounded-full" style={{ width: percent + '%' }} />
      </div>
      <ul className="grid gap-1 text-sm">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2">
            {step.done ? (
              <Check className="text-primary size-4 shrink-0" aria-hidden="true" />
            ) : (
              <CircleDashed className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            )}
            <span className={step.done ? '' : 'text-muted-foreground'}>{step.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
function Workers({ workers }: { workers: Worker[] }) {
  return (
    <div className="mt-6 grid gap-3">
      <strong className="text-sm">Заняты сейчас ({workers.length})</strong>
      {workers.length ? (
        <ul className="grid gap-2">
          {workers.map((w) => (
            <li key={w.runId} className="flex flex-wrap items-center gap-3 border-b pb-2 text-sm">
              <Loader2 className="text-primary size-4 shrink-0 animate-spin" aria-hidden="true" />
              <strong>{w.role ? (roleNames[w.role] ?? w.role) : 'Исполнитель'}</strong>
              <span className="text-muted-foreground">
                {w.phase ? (phaseNames[w.phase] ?? w.phase) : 'работает'}
              </span>
              <span className="min-w-0 flex-1">{w.title}</span>
              <code className="text-muted-foreground font-mono text-xs">
                {w.model ?? w.runtime}
              </code>
              <span className="text-muted-foreground text-xs">{ago(w.startedAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          Никто не занят задачей. Здесь появятся исполнитель, этап, модель и время работы.
        </p>
      )}
    </div>
  );
}
function Decisions({
  stage,
  decisions,
  questions,
}: {
  stage: Exclude<Stage, 'development'>;
  decisions: PreparationRecord[];
  questions: PreparationQuestion[];
}) {
  const mine = decisions.filter((d) => d.stage === stage);
  // Withdrawn decisions stay visible but are not counted as standing ones,
  // so the count answers "what holds now", not "what was ever written down".
  const standing = mine.filter((d) => !d.withdrawn).length;
  return (
    <Foldable id={'decisions-' + stage} title="Принятые решения" count={standing}>
      {!mine.length && (
        <p className="text-muted-foreground">
          Решения появятся здесь, когда агент зафиксирует их с обоснованием.
        </p>
      )}
      <ul className="grid gap-3">
        {mine.map((d) => (
          <li
            key={d.id}
            className={
              d.withdrawn
                ? 'bg-secondary border-muted-foreground/40 border-l-[3px] p-3 opacity-70'
                : 'bg-secondary border-primary border-l-[3px] p-3'
            }
          >
            <strong className="flex items-start gap-2">
              <Scale
                className={
                  d.withdrawn ? 'mt-0.5 size-4 shrink-0' : 'text-primary mt-0.5 size-4 shrink-0'
                }
                aria-hidden="true"
              />
              <span
                className={
                  d.withdrawn
                    ? 'max-w-[70ch] break-words whitespace-pre-wrap line-through'
                    : 'max-w-[70ch] break-words whitespace-pre-wrap'
                }
              >
                {d.statement}
              </span>
            </strong>
            <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm break-words whitespace-pre-wrap">
              {d.rationale}
            </p>
            {d.questionId && (
              <p className="text-muted-foreground mt-1 text-sm">
                По вопросу: {questions.find((q) => q.id === d.questionId)?.text ?? d.questionId}
              </p>
            )}
            {d.withdrawn && (
              <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm break-words whitespace-pre-wrap">
                Отозвано {ago(d.withdrawn.at)}: {d.withdrawn.reason}
              </p>
            )}
            <p className="text-muted-foreground mt-1 text-xs">{ago(d.createdAt)}</p>
          </li>
        ))}
      </ul>
    </Foldable>
  );
}
export function PreparationPanel() {
  const [view, setView] = useState<View>();
  const [selected, setSelected] = useState(() => readLocation().change);
  const [tab, setTab] = useState<Stage>(() => readLocation().tab);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [tasks, showTasks] = useState(() => readLocation().boards);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    writeLocation({ change: selected, tab, boards: tasks });
  }, [selected, tab, tasks]);
  useEffect(() => {
    const restore = () => {
      const state = readLocation();
      setSelected(state.change);
      setTab(state.tab);
      showTasks(state.boards);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const reload = useCallback(async () => {
    setView(
      await request<View>(
        'preparation' + (selected ? '?change=' + encodeURIComponent(selected) : ''),
      ),
    );
  }, [selected]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await request<View>(
          'preparation' + (selected ? '?change=' + encodeURIComponent(selected) : ''),
        );
        if (!disposed) setView(next);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [selected]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await reload();
      setComment('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (view && !view.enabled)
    return (
      <Suspense fallback={<p role="status">Загрузка панели…</p>}>
        <Development />
      </Suspense>
    );
  if (!view?.enabled)
    return (
      <main className="mx-auto max-w-[100rem] p-8">
        <h1 className="text-xl">DevContour</h1>
        {error ? <p role="alert">{error}</p> : <p role="status">Подключение к workspace…</p>}
      </main>
    );
  const c = view.current,
    p = c?.product,
    a = c?.architecture,
    refs = c?.references,
    con = c?.concept,
    d = c?.design;
  const revisions = { product: p, architecture: a, references: refs, concept: con, design: d };
  const current = tab === 'development' ? undefined : revisions[tab];
  const architectureCurrent = p?.status === 'approved' && a?.productDigest === p.digest;
  const referencesCurrent = a?.status === 'approved' && refs?.architectureDigest === a.digest;
  const conceptCurrent = refs?.status === 'approved' && con?.referencesDigest === refs.digest;
  const designCurrent = con?.status === 'approved' && d?.conceptDigest === con.digest;
  // How far the design stage has got: used by the stepper and the sub-nav.
  const designApproved = [
    referencesCurrent && refs?.status === 'approved',
    conceptCurrent && con?.status === 'approved',
    designCurrent && d?.status === 'approved',
  ].filter(Boolean).length;
  const stageCurrent = {
    product: true,
    architecture: architectureCurrent,
    references: referencesCurrent,
    concept: conceptCurrent,
    design: designCurrent,
    development: false,
  }[tab];
  const decide = (decision: 'approve' | 'request-changes') =>
    run(async () => {
      if (!c || !current || tab === 'development') return;
      await request('preparation/decision', {
        changeId: c.id,
        stage: tab,
        expectedDigest: current.digest,
        decision,
        comment,
      });
    });
  if (tasks && view.engineConnected)
    return (
      <>
        <div className="flex items-center gap-4 p-3">
          <Button variant="outline" size="sm" onClick={() => showTasks(false)}>
            ← Продукт и архитектура
          </Button>
          <span>{c?.title}</span>
        </div>
        <Suspense fallback={<p role="status">Загрузка разработки…</p>}>
          <Development />
        </Suspense>
      </>
    );
  return (
    <main className="mx-auto max-w-[100rem] p-4 sm:p-8">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-6">
        <div>
          <span className="text-primary mb-3 block font-semibold">DevContour</span>
          <h1 className="text-xl leading-tight font-semibold">От запроса к разработке</h1>
          <p className="text-muted-foreground mt-3 max-w-[70ch]">
            Сначала определяем продукт, затем согласуем устройство системы и запускаем исполнение.
          </p>
        </div>
        <div className="grid gap-1 text-sm">
          <span className="text-success whitespace-nowrap">Панель подключена</span>
          {view.workspace && (
            <>
              <strong>
                {view.workspace.mode === 'embedded' ? 'Внутри репозитория' : 'Отдельный workspace'}
              </strong>
              <code className="font-mono text-xs break-all">{view.workspace.path}</code>
            </>
          )}
        </div>
      </header>
      <div className="grid gap-8 lg:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]">
        <aside>
          <h2 className="text-md mb-3 font-semibold">Изменения продукта</h2>
          <nav aria-label="Изменения продукта" className="grid gap-3">
            {view.changes.map((change) => (
              <Button
                key={change.id}
                variant="outline"
                aria-current={change.id === c?.id ? 'page' : undefined}
                className={cn(
                  'h-auto justify-start py-2 text-left whitespace-normal',
                  change.id === c?.id && 'border-primary bg-accent',
                )}
                onClick={() => {
                  setSelected(change.id);
                  setTab('product');
                  setComment('');
                }}
              >
                <span className="grid gap-1">
                  <span>{change.title}</span>
                  {change.open > 0 && (
                    <span className="text-warning text-xs">
                      {change.open} вопрос(ов) ждут ответа
                    </span>
                  )}
                </span>
              </Button>
            ))}
          </nav>
          <form
            className="mt-8 grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const next = await request<View>('agent', {
                  operation: 'preparation_create',
                  input: { title },
                });
                if (next.enabled) {
                  setSelected(next.activeChangeId ?? '');
                  setTab('product');
                }
                setTitle('');
              });
            }}
          >
            <Label htmlFor="change-title">Новое изменение</Label>
            <Input
              id="change-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              minLength={3}
              maxLength={180}
              placeholder="Например, модерация чата"
              required
            />
            <Button disabled={busy} type="submit">
              Создать изменение
            </Button>
          </form>
        </aside>
        <article className="min-w-0">
          {error && (
            <Alert variant="destructive" role="alert" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {view.startupError && (
            <Alert variant="destructive" role="alert" className="mb-4">
              <AlertDescription>
                Не удалось подключить разработку: {view.startupError}
              </AlertDescription>
            </Alert>
          )}
          <ol
            className="mb-8 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4"
            aria-label="Этапы изменения"
          >
            {topStages.map((step, i) => {
              const active = step === 'design' ? isDesignStep(tab) : tab === step;
              return (
                <li key={step}>
                  <Button
                    variant="outline"
                    aria-current={active ? 'step' : undefined}
                    className={cn(
                      'grid h-full w-full justify-items-start gap-1 p-4 text-left whitespace-normal',
                      active && 'border-primary bg-accent',
                    )}
                    onClick={() => {
                      // Entering design lands on the first step still open.
                      setTab(
                        step === 'design'
                          ? !referencesCurrent || refs?.status !== 'approved'
                            ? 'references'
                            : !conceptCurrent || con?.status !== 'approved'
                              ? 'concept'
                              : 'design'
                          : step,
                      );
                      setComment('');
                    }}
                  >
                    <span className="text-primary text-lg">{i + 1}</span>
                    <strong>{topStageNames[i]}</strong>
                    <small className="text-muted-foreground">
                      {step === 'product'
                        ? p
                          ? names[p.status]
                          : 'Нужна постановка'
                        : step === 'architecture'
                          ? p?.status !== 'approved'
                            ? 'После согласования продукта'
                            : architectureCurrent && a
                              ? names[a.status]
                              : 'Нужна актуальная архитектура'
                          : step === 'design'
                            ? a?.status !== 'approved'
                              ? 'После согласования архитектуры'
                              : designApproved === 3
                                ? 'Утверждено'
                                : 'Шаг ' + (designApproved + 1) + ' из 3'
                            : view.developmentReady
                              ? 'Разрешена'
                              : 'Ожидает согласований'}
                    </small>
                  </Button>
                </li>
              );
            })}
          </ol>
          {c ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <h2 className="text-lg font-semibold">{c.title}</h2>
                {view.activeChangeId !== c.id && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void run(() =>
                        request('agent', {
                          operation: 'preparation_activate',
                          input: { changeId: c.id },
                        }),
                      );
                    }}
                  >
                    Выбрать для новых задач
                  </Button>
                )}
              </div>
              <Separator className="my-4" />
              <AgentWork activity={c.activity} latest={view.agentActivity ?? c.activity[0]} />
              {tab === 'development' ? (
                <Section
                  title={
                    view.developmentReady
                      ? 'Постановка и архитектура утверждены'
                      : 'Разработка ещё не разрешена'
                  }
                >
                  <p className="max-w-[78ch]">
                    {view.developmentReady
                      ? view.engineConnected
                        ? 'Агент может декомпозировать работу и запустить технический workflow. Тесты, независимое ревью и приёмка остаются обязательными.'
                        : 'Агент готовит репозитории, профили и настоящие проверки. Панель подключит технический workflow автоматически.'
                      : view.blocker}
                  </p>
                  <SetupProgress setup={view.setup} tasks={view.delivery.total} />
                  <p className="mt-4">
                    Принято задач: {view.delivery.done} из {view.delivery.total}. Сбоев:{' '}
                    {view.delivery.failed}.
                  </p>
                  <Workers workers={view.workers ?? []} />
                  {view.delivery.boards.length > 0 && (
                    <ul className="mt-2 grid gap-2">
                      {view.delivery.boards.map((b) => (
                        <li key={b.id}>{b.title}</li>
                      ))}
                    </ul>
                  )}
                  {view.engineConnected && (
                    <Button className="mt-4" onClick={() => showTasks(true)}>
                      Открыть доски разработки
                    </Button>
                  )}
                  <p className="text-muted-foreground mt-3">
                    Готовность задач не означает публикацию или продуктовую приёмку релиза.
                  </p>
                </Section>
              ) : (
                <>
                  {isDesignStep(tab) && (
                    <nav
                      aria-label="Шаги дизайна"
                      className="mb-4 flex flex-wrap gap-2 border-b pb-4"
                    >
                      {designSteps.map((step, i) => {
                        const revision = { references: refs, concept: con, design: d }[step];
                        const reached = designApproved >= i;
                        return (
                          <Button
                            key={step}
                            variant="outline"
                            size="sm"
                            aria-current={tab === step ? 'step' : undefined}
                            className={cn(
                              'h-auto gap-2 py-2',
                              tab === step && 'border-primary bg-accent',
                              !reached && 'opacity-60',
                            )}
                            onClick={() => {
                              setTab(step);
                              setComment('');
                            }}
                          >
                            <span className="text-primary">{i + 1}</span>
                            <span>{designStepNames[step]}</span>
                            <Badge variant={revision ? tone[revision.status] : 'secondary'}>
                              {revision ? names[revision.status] : 'Не начат'}
                            </Badge>
                          </Button>
                        );
                      })}
                    </nav>
                  )}
                  {current && (
                    <div className="flex flex-wrap items-center gap-3 border-b pb-4">
                      <strong>Версия {current.number}</strong>
                      <Badge variant={tone[current.status]}>{names[current.status]}</Badge>
                      <span className="text-muted-foreground">{current.reason}</span>
                      {current.status === 'draft' && (
                        <Button
                          size="sm"
                          className="ml-auto"
                          disabled={busy}
                          onClick={() => {
                            void run(() =>
                              request('agent', {
                                operation: 'preparation_submit',
                                input: {
                                  changeId: c.id,
                                  stage: tab,
                                  expectedDigest: current.digest,
                                },
                              }),
                            );
                          }}
                        >
                          <Send aria-hidden="true" />
                          Отправить на утверждение
                        </Button>
                      )}
                    </div>
                  )}
                  {current?.status === 'draft' && c.history.length > 1 && (
                    <Alert variant="info" className="mt-4">
                      <AlertDescription>
                        Правка создала новую версию. Она снова черновик: отправьте её на
                        утверждение, когда закончите.
                      </AlertDescription>
                    </Alert>
                  )}
                  {!stageCurrent && current && tab !== 'product' && (
                    <Alert variant="warning" className="mt-4">
                      <AlertDescription>
                        Эта версия относится к прежнему предыдущему этапу. Агент должен подготовить
                        новую.
                      </AlertDescription>
                    </Alert>
                  )}
                  <StageBoundary stage={tab}>
                    {tab === 'product' ? (
                      p ? (
                        <ProductBriefView
                          content={p.content}
                          readiness={c.features}
                          releaseReadiness={c.releases}
                          busy={busy}
                          onSave={(next, reason) =>
                            void run(() =>
                              request('agent', {
                                operation: 'preparation_product',
                                input: {
                                  changeId: c.id,
                                  expectedDigest: p.digest,
                                  reason,
                                  content: next,
                                },
                              }),
                            )
                          }
                        />
                      ) : (
                        <Alert className="max-w-[78ch] border-dashed">
                          <AlertDescription>
                            Поручите ведущему агенту изучить ТЗ и заполнить постановку. Здесь
                            появятся сценарии, границы и критерии приёмки. Проект и стек пока не
                            нужны.
                          </AlertDescription>
                        </Alert>
                      )
                    ) : tab === 'architecture' ? (
                      a ? (
                        <ArchitectureBriefView
                          content={a.content}
                          busy={busy}
                          onSave={(next, reason) =>
                            void run(() =>
                              request('agent', {
                                operation: 'preparation_architecture',
                                input: {
                                  changeId: c.id,
                                  expectedDigest: a.digest,
                                  reason,
                                  content: next,
                                },
                              }),
                            )
                          }
                        />
                      ) : (
                        <Alert className="max-w-[78ch] border-dashed">
                          <AlertDescription>
                            {p?.status === 'approved'
                              ? 'Агент готовит архитектуру, сравнение стеков и диаграммы C1/C2.'
                              : 'Архитектура будет прорабатываться после вашего утверждения продуктовой части.'}
                          </AlertDescription>
                        </Alert>
                      )
                    ) : tab === 'references' ? (
                      refs ? (
                        <ReferencesBriefView
                          content={refs.content}
                          busy={busy}
                          onSave={(next, reason) =>
                            void run(() =>
                              request('agent', {
                                operation: 'preparation_references',
                                input: {
                                  changeId: c.id,
                                  expectedDigest: refs.digest,
                                  reason,
                                  content: next,
                                },
                              }),
                            )
                          }
                        />
                      ) : (
                        <Waiting
                          previous={a}
                          working="Агент ищет референсы и описывает, что берёт из каждого. Вы принимаете или отклоняете каждый."
                          blocked="Референсы собираются после вашего утверждения архитектуры — она ждёт вашего решения."
                          onGo={() => setTab('architecture')}
                        />
                      )
                    ) : tab === 'concept' ? (
                      con ? (
                        <ConceptBriefView
                          content={con.content}
                          busy={busy}
                          onSave={(next, reason) =>
                            void run(() =>
                              request('agent', {
                                operation: 'preparation_concept',
                                input: {
                                  changeId: c.id,
                                  expectedDigest: con.digest,
                                  reason,
                                  content: next,
                                },
                              }),
                            )
                          }
                        />
                      ) : (
                        <Waiting
                          previous={refs}
                          working="Агент формулирует концепцию и готовит эскизы, между которыми вы выберете."
                          blocked="Концепт нельзя сохранить, пока не утверждены референсы — они ждут вашего решения."
                          onGo={() => setTab('references')}
                        />
                      )
                    ) : d ? (
                      <DesignBriefView
                        content={d.content}
                        channels={p?.content.channels ?? []}
                        busy={busy}
                        onSave={(next, reason) =>
                          void run(() =>
                            request('agent', {
                              operation: 'preparation_design',
                              input: {
                                changeId: c.id,
                                expectedDigest: d.digest,
                                reason,
                                content: next,
                              },
                            }),
                          )
                        }
                      />
                    ) : (
                      <Waiting
                        previous={con}
                        working="Агент собирает палитру, токены, guidelines и разбор по каналам."
                        blocked="Дизайн-система готовится после вашего утверждения концепта — он ждёт вашего решения."
                        onGo={() => setTab('concept')}
                      />
                    )}
                  </StageBoundary>
                  {current?.decision && (
                    <div className="bg-secondary border-primary mt-6 border-l-[3px] p-4">
                      <strong>
                        Решение пользователя ·{' '}
                        {new Date(current.decision.at).toLocaleString('ru-RU')}
                      </strong>
                      <p className="mt-2 break-words whitespace-pre-wrap">
                        {current.decision.comment || 'Версия утверждена без замечаний.'}
                      </p>
                    </div>
                  )}
                  {current?.status === 'in-review' &&
                    (tab === 'product' || architectureCurrent) && (
                      <form
                        className="border-primary bg-accent mt-8 rounded-md border p-6"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void decide('approve');
                        }}
                      >
                        <h3 className="text-md mb-2 font-semibold">{approvalTitles[tab]}</h3>
                        <p className="max-w-[78ch]">
                          {tab === 'design'
                            ? 'После утверждения агент сможет настроить проект и начать разработку по этой версии.'
                            : 'После утверждения откроется следующий этап. Разработка останется заблокированной.'}
                        </p>
                        <Label htmlFor="decision-comment" className="mt-4 block">
                          Комментарий к решению
                        </Label>
                        <Textarea
                          id="decision-comment"
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                          maxLength={3000}
                          rows={3}
                          className="my-3"
                        />
                        <div className="flex flex-wrap gap-3">
                          <Button type="submit" disabled={busy}>
                            Утвердить версию {current.number}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={busy || comment.trim().length < 3}
                            onClick={() => {
                              void decide('request-changes');
                            }}
                          >
                            Вернуть на доработку
                          </Button>
                        </div>
                      </form>
                    )}
                  <Questions
                    stage={tab}
                    questions={c.questions}
                    busy={busy}
                    onAnswer={(questionId, text) =>
                      void run(() =>
                        request('preparation/answer', { changeId: c.id, questionId, text }),
                      )
                    }
                  />
                  <Decisions stage={tab} decisions={c.decisions} questions={c.questions} />
                </>
              )}
              <div className="my-8">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryOpen(!historyOpen)}
                >
                  <History aria-hidden="true" />
                  История версий и решений ({c.history.length})
                </Button>
                {historyOpen && (
                  <ol className="mt-3 grid gap-3">
                    {c.history.map((r) => (
                      <li key={r.stage + r.number} className="border-b py-3">
                        <strong>
                          {r.stage === 'product' ? 'Продукт' : 'Архитектура'} · v{r.number} ·{' '}
                          {names[r.status]}
                        </strong>
                        <p className="mt-1 break-words whitespace-pre-wrap">{r.reason}</p>
                        {r.decision && (
                          <p className="text-muted-foreground mt-1">
                            Пользователь: {r.decision.comment || 'Утверждено без замечаний'}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          ) : (
            <Alert className="max-w-[78ch] border-dashed">
              <AlertTitle>Workspace открыт</AlertTitle>
              <AlertDescription>
                Создайте первое изменение или поручите это агенту. Проработка продукта уже будет
                видна на этой странице.
              </AlertDescription>
            </Alert>
          )}
        </article>
      </div>
    </main>
  );
}
