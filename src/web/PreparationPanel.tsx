import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  Boxes,
  CircleDot,
  History,
  Loader2,
  MessageCircleQuestion,
  Milestone,
  MonitorSmartphone,
  Scale,
  User,
} from 'lucide-react';
import type { Preparation } from '../core/preparation.ts';
import type {
  ProductBrief,
  ProductFeature,
  ProductPersona,
  ProductChannel,
  ProductRelease,
  ArchitectureBrief,
  PreparationQuestion,
  PreparationRecord,
} from '../core/preparation-model.ts';
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
const C4 = lazy(() => import('./C4Panel.tsx'));
type View = ReturnType<Preparation['status']> & {
  engineConnected?: boolean;
  startupError?: string;
  workspace?: { mode: 'embedded' | 'separate'; path: string };
};
type Stage = 'product' | 'architecture' | 'development';
type Readiness = {
  id: string;
  tasks: number;
  done: number;
  failed: number;
  readiness: 'unplanned' | 'in-progress' | 'failed' | 'done';
};
type FeatureView = ProductFeature & Readiness;
type ReleaseReadiness = Readiness & { features: number; criteria: number };
const names = {
  draft: 'Агент прорабатывает',
  'in-review': 'Ожидает вашего решения',
  approved: 'Утверждено',
  'changes-requested': 'Нужна доработка',
};
const tone = {
  draft: 'secondary',
  'in-review': 'warning',
  approved: 'success',
  'changes-requested': 'destructive',
} as const;
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
function TextList({ title, items }: { title: string; items: string[] }) {
  return (
    <Section title={title}>
      {items.length ? (
        <ul className="grid gap-2">
          {items.map((item, i) => (
            <li key={i} className="max-w-[78ch] break-words whitespace-pre-wrap">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">Не указано</p>
      )}
    </Section>
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
  stage: 'product' | 'architecture';
  questions: PreparationQuestion[];
  busy: boolean;
  onAnswer: (questionId: string, text: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const mine = questions.filter((q) => q.stage === stage && q.status !== 'withdrawn');
  if (!mine.length) return null;
  const open = mine.filter((q) => q.status === 'open');
  return (
    <Section title={'Открытые вопросы (' + open.length + ')'}>
      <p className="text-muted-foreground mb-4 max-w-[78ch]">
        Агент не отвечает на них сам. Пока есть неотвеченные вопросы этапа, версию нельзя отправить
        на утверждение.
      </p>
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
    </Section>
  );
}
function Decisions({
  stage,
  decisions,
  questions,
}: {
  stage: 'product' | 'architecture';
  decisions: PreparationRecord[];
  questions: PreparationQuestion[];
}) {
  const mine = decisions.filter((d) => d.stage === stage);
  if (!mine.length) return null;
  return (
    <Section title={'Принятые решения (' + mine.length + ')'}>
      <ul className="grid gap-3">
        {mine.map((d) => (
          <li key={d.id} className="bg-secondary border-primary border-l-[3px] p-3">
            <strong className="flex items-start gap-2">
              <Scale className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="max-w-[70ch] break-words whitespace-pre-wrap">{d.statement}</span>
            </strong>
            <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm break-words whitespace-pre-wrap">
              {d.rationale}
            </p>
            {d.questionId && (
              <p className="text-muted-foreground mt-1 text-sm">
                По вопросу: {questions.find((q) => q.id === d.questionId)?.text ?? d.questionId}
              </p>
            )}
            <p className="text-muted-foreground mt-1 text-xs">{ago(d.createdAt)}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
const readinessNames = {
  unplanned: 'Нет задач',
  'in-progress': 'В работе',
  failed: 'Есть сбой',
  done: 'Задачи выполнены',
} as const;
const readinessTone = {
  unplanned: 'secondary',
  'in-progress': 'ready',
  failed: 'destructive',
  done: 'success',
} as const;

// The operator reads the product feature by feature. Each scenario names the
// persona living it, and each criterion names the release it belongs to.
function Feature({
  feature,
  personas,
  releases,
  channels,
}: {
  feature: FeatureView;
  personas: ProductPersona[];
  releases: ProductRelease[];
  channels: ProductChannel[];
}) {
  const who = (id?: string) => (id ? (personas.find((x) => x.id === id)?.name ?? id) : '');
  const when = (id: string) => releases.find((x) => x.id === id)?.title ?? id;
  return (
    <Card>
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="flex items-start gap-2">
            <Boxes className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="max-w-[70ch] break-words">{feature.title}</span>
          </CardTitle>
          <Badge variant={readinessTone[feature.readiness]}>
            {readinessNames[feature.readiness]}
            {feature.tasks > 0 && ' · ' + feature.done + '/' + feature.tasks}
          </Badge>
        </div>
        <p className="max-w-[78ch] break-words whitespace-pre-wrap">{feature.outcome}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm">Каналы:</span>
          {feature.channels.map((id) => (
            <Badge key={id} variant="secondary">
              <MonitorSmartphone aria-hidden="true" className="size-3" />
              {channels.find((c) => c.id === id)?.title ?? id}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 pt-0">
        <div>
          <h4 className="mb-2 text-sm font-semibold">Сценарии</h4>
          <ul className="grid gap-2">
            {feature.scenarios.map((s, i) => (
              <li key={i} className="max-w-[74ch] break-words whitespace-pre-wrap">
                {s.personaId && (
                  <Badge variant="outline" className="mr-2">
                    <User aria-hidden="true" className="size-3" />
                    {who(s.personaId)}
                  </Badge>
                )}
                {s.text}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold">Как примем</h4>
          <ul className="grid gap-2">
            {feature.acceptance.map((a, i) => (
              <li key={i} className="max-w-[74ch] break-words whitespace-pre-wrap">
                <Badge variant="ready" className="mr-2">
                  {when(a.releaseId)}
                </Badge>
                {a.text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted-foreground text-xs">
          ID фичи: <code className="font-mono">{feature.id}</code>
        </p>
      </CardContent>
    </Card>
  );
}
function Personas({ personas }: { personas: ProductPersona[] }) {
  if (!personas.length) return null;
  return (
    <Section title={'Персоны (' + personas.length + ')'}>
      <p className="text-muted-foreground mb-4 max-w-[78ch]">
        Цели и боли персоны — основание, на котором агент разрешает неоднозначности так же, как
        решил бы этот человек.
      </p>
      <ul className="grid gap-4 md:grid-cols-2">
        {personas.map((persona) => (
          <li key={persona.id}>
            <Card className="h-full">
              <CardHeader className="gap-1 pb-3">
                <CardTitle className="flex items-center gap-2">
                  <User className="text-primary size-4 shrink-0" aria-hidden="true" />
                  {persona.name}
                </CardTitle>
                <p className="text-muted-foreground text-sm">{persona.role}</p>
              </CardHeader>
              <CardContent className="grid gap-3 pt-0 text-sm">
                <div>
                  <h4 className="mb-1 font-semibold">Цели</h4>
                  <ul className="grid list-disc gap-1 pl-5">
                    {persona.goals.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="mb-1 font-semibold">Боли</h4>
                  <ul className="grid list-disc gap-1 pl-5">
                    {persona.pains.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}
function Channels({
  channels,
  features,
}: {
  channels: ProductChannel[];
  features: ProductFeature[];
}) {
  return (
    <Section title={'Каналы (' + channels.length + ')'}>
      <p className="text-muted-foreground mb-4 max-w-[78ch]">
        Где продукт встречается с человеком. Каждая фича называет каналы, которые её реализуют.
      </p>
      <ul className="grid gap-3 md:grid-cols-2">
        {channels.map((c) => {
          const count = features.filter((f) => f.channels.includes(c.id)).length;
          return (
            <li key={c.id}>
              <Card className="h-full">
                <CardHeader className="gap-1 pb-4">
                  <CardTitle className="flex items-start gap-2">
                    <MonitorSmartphone
                      className="text-primary mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="max-w-[60ch] break-words">{c.title}</span>
                  </CardTitle>
                  <p className="max-w-[70ch] break-words whitespace-pre-wrap">{c.purpose}</p>
                  <p className="text-muted-foreground text-sm">Фич в канале: {count}</p>
                </CardHeader>
              </Card>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
function Releases({
  releases,
  readiness,
}: {
  releases: ProductRelease[];
  readiness: ReleaseReadiness[];
}) {
  return (
    <Section title={'Релизы (' + releases.length + ')'}>
      <p className="text-muted-foreground mb-4 max-w-[78ch]">
        Граница объёма: что должно существовать первым и что может подождать. Порядок сверху вниз.
      </p>
      <ol className="grid gap-3">
        {releases.map((r, i) => {
          const state = readiness.find((x) => x.id === r.id);
          return (
            <li key={r.id}>
              <Card>
                <CardHeader className="gap-1 pb-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <CardTitle className="flex items-start gap-2">
                      <Milestone
                        className="text-primary mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="max-w-[70ch] break-words">
                        {r.version} · {r.title}
                      </span>
                    </CardTitle>
                    {state && (
                      <Badge variant={readinessTone[state.readiness]}>
                        {readinessNames[state.readiness]}
                        {state.tasks > 0 && ' · ' + state.done + '/' + state.tasks}
                      </Badge>
                    )}
                  </div>
                  <p className="max-w-[78ch] break-words whitespace-pre-wrap">{r.goal}</p>
                  {state && (
                    <p className="text-muted-foreground text-sm">
                      Фич: {state.features} · критериев: {state.criteria}
                    </p>
                  )}
                </CardHeader>
              </Card>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
function Product({
  content: p,
  readiness,
  releaseReadiness,
}: {
  content: ProductBrief;
  readiness: Readiness[];
  releaseReadiness: ReleaseReadiness[];
}) {
  const blank: Readiness = { id: '', tasks: 0, done: 0, failed: 0, readiness: 'unplanned' };
  const features: FeatureView[] = p.features.map((f) => ({
    ...f,
    ...(readiness.find((r) => r.id === f.id) ?? blank),
    id: f.id,
  }));
  const personas = p.personas;
  const releases = p.releases;
  const done = features.filter((f) => f.readiness === 'done').length;
  const planned = features.filter((f) => f.tasks > 0).length;
  // Features surface in the order their earliest release does.
  const first = (f: FeatureView) =>
    Math.min(
      ...f.acceptance.map((a) => {
        const index = releases.findIndex((r) => r.id === a.releaseId);
        return index < 0 ? releases.length : index;
      }),
    );
  return (
    <>
      <Section title="Проблема и ожидаемый результат">
        <p className="max-w-[78ch] break-words whitespace-pre-wrap">
          {p.problem || 'Агент ещё уточняет проблему'}
        </p>
        <p className="mt-2 max-w-[78ch] break-words whitespace-pre-wrap">{p.outcome}</p>
      </Section>
      <Personas personas={personas} />
      <Channels channels={p.channels} features={p.features} />
      <Releases releases={releases} readiness={releaseReadiness} />
      <Section title={'Фичи продукта (' + features.length + ')'}>
        {planned > 0 && (
          <p className="text-muted-foreground mb-4">
            Задачи заведены для {planned} из {features.length}; полностью выполнены {done}.
            Готовность считается по задачам и не заменяет приёмку релиза.
          </p>
        )}
        <ul className="grid gap-4">
          {[...features]
            .sort((a, b) => first(a) - first(b))
            .map((f) => (
              <li key={f.id}>
                <Feature
                  feature={f}
                  personas={personas}
                  releases={releases}
                  channels={p.channels}
                />
              </li>
            ))}
        </ul>
      </Section>
      <TextList title="За пределами изменения" items={p.exclusions} />
      <TextList title="Материалы и референсы" items={p.references} />
      {p.questions.length > 0 && <TextList title="Вопросы этой версии" items={p.questions} />}
    </>
  );
}
function Architecture({ content: a }: { content: ArchitectureBrief }) {
  const systemName = a.c1?.nodes.find((n) => n.id === a.c1?.systemId)?.name ?? 'Система';
  return (
    <>
      <Section title="Архитектурное решение">
        <p className="max-w-[78ch] break-words whitespace-pre-wrap">{a.summary}</p>
      </Section>
      <Section title="Стек и обоснование">
        {/* A horizontally scrolling region needs its own tab stop (WCAG 2.1.1). */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Стек и обоснование">
          <table className="w-full min-w-(--product-table-width) border-collapse">
            <thead>
              <tr>
                {['Область', 'Выбор', 'Почему', 'Альтернативы'].map((h) => (
                  <th key={h} className="border-b p-3 text-left align-top font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.stack.map((s, i) => (
                <tr key={i}>
                  <td className="border-b p-3 align-top">{s.area}</td>
                  <td className="border-b p-3 align-top">{s.choice}</td>
                  <td className="border-b p-3 align-top">{s.rationale}</td>
                  <td className="border-b p-3 align-top">{s.alternatives}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Suspense fallback={<p role="status">Загрузка диаграмм…</p>}>
        {a.c1 && <C4 diagram={a.c1} level={1} systemName={systemName} />}
        {a.c2 && <C4 diagram={a.c2} level={2} systemName={systemName} />}
      </Suspense>
      <TextList title="Решения и границы ответственности" items={a.decisions} />
      <TextList title="Риски и компромиссы" items={a.risks} />
      <Section title="Стратегия тестирования">
        <p className="max-w-[78ch] break-words whitespace-pre-wrap">{a.testStrategy}</p>
      </Section>
      {a.questions.length > 0 && <TextList title="Вопросы этой версии" items={a.questions} />}
    </>
  );
}
export function PreparationPanel() {
  const [view, setView] = useState<View>();
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<Stage>('product');
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [tasks, showTasks] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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
    a = c?.architecture;
  const current = tab === 'product' ? p : a;
  const architectureCurrent = p?.status === 'approved' && a?.productDigest === p.digest;
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
            className="mb-8 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3"
            aria-label="Этапы изменения"
          >
            {(['product', 'architecture', 'development'] as const).map((step, i) => (
              <li key={step}>
                <Button
                  variant="outline"
                  aria-current={tab === step ? 'step' : undefined}
                  className={cn(
                    'grid h-full w-full justify-items-start gap-1 p-4 text-left whitespace-normal',
                    tab === step && 'border-primary bg-accent',
                  )}
                  onClick={() => {
                    setTab(step);
                    setComment('');
                  }}
                >
                  <span className="text-primary text-lg">{i + 1}</span>
                  <strong>{['Продукт', 'Архитектура и стек', 'Разработка'][i]}</strong>
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
                        : view.developmentReady
                          ? 'Разрешена'
                          : 'Ожидает согласований'}
                  </small>
                </Button>
              </li>
            ))}
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
                  <p className="mt-2">
                    Принято задач: {view.delivery.done} из {view.delivery.total}. Сбоев:{' '}
                    {view.delivery.failed}.
                  </p>
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
                  {current && (
                    <div className="flex flex-wrap items-center gap-3 border-b pb-4">
                      <strong>Версия {current.number}</strong>
                      <Badge variant={tone[current.status]}>{names[current.status]}</Badge>
                      <span className="text-muted-foreground">{current.reason}</span>
                    </div>
                  )}
                  {tab === 'architecture' && !architectureCurrent && a && (
                    <Alert variant="warning" className="mt-4">
                      <AlertDescription>
                        Эта архитектура относится к прежней постановке. Агент должен подготовить
                        новую версию.
                      </AlertDescription>
                    </Alert>
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
                  {tab === 'product' ? (
                    p ? (
                      <Product
                        content={p.content}
                        readiness={c.features}
                        releaseReadiness={c.releases}
                      />
                    ) : (
                      <Alert className="max-w-[78ch] border-dashed">
                        <AlertDescription>
                          Поручите ведущему агенту изучить ТЗ и заполнить постановку. Здесь появятся
                          сценарии, границы и критерии приёмки. Проект и стек пока не нужны.
                        </AlertDescription>
                      </Alert>
                    )
                  ) : a ? (
                    <Architecture content={a.content} />
                  ) : (
                    <Alert className="max-w-[78ch] border-dashed">
                      <AlertDescription>
                        {p?.status === 'approved'
                          ? 'Агент готовит архитектуру, сравнение стеков и диаграммы C1/C2.'
                          : 'Архитектура будет прорабатываться после вашего утверждения продуктовой части.'}
                      </AlertDescription>
                    </Alert>
                  )}
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
                        <h3 className="text-md mb-2 font-semibold">
                          {tab === 'product'
                            ? 'Утвердить продуктовую постановку'
                            : 'Утвердить архитектуру и стек'}
                        </h3>
                        <p className="max-w-[78ch]">
                          {tab === 'product'
                            ? 'После утверждения агент сможет приступить к архитектуре. Разработка останется заблокированной.'
                            : 'После утверждения агент сможет настроить проект и начать разработку по этой версии.'}
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
