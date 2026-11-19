import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Ban,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CirclePause,
  CirclePlay,
  Hourglass,
  Lock,
  PencilLine,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { DevelopmentSection, HomeHarness, HomeProgress } from '../application/home.ts';
import type { HomeView, PreparationSection, SectionQuestions } from '../application/home.ts';
import { boardPhaseLabels } from '../core/work-status.ts';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { cn, humanError, plural } from '@/lib/utils.ts';
import { AttentionCount, useAttentionScreen } from './AttentionProvider.tsx';
import { navigate } from './navigation.ts';
import { useNow } from './now.ts';
import { COST_ESTIMATE_RU } from '../core/usage.ts';
import {
  GateTrendChart,
  HourlyChart,
  LoadChart,
  OverallProgress,
  Ring,
  SpendChart,
} from './HomeCharts.tsx';

// Главная панели: по плитке на раздел (продукт, архитектура, дизайн,
// разработка) с открытыми вопросами, что идёт и кто ждёт, ход работ и
// исполнение. Только чтение: значения считает сервер (`GET /api/home`),
// плитка ведёт в раздел ссылкой. Опрос — пока вкладка видна, с меткой
// ответа: без изменений сервер отвечает коротким «unchanged».

export const HOME_POLL_MS = 3000;

type Home = HomeView & { etag: string };
type StageState = PreparationSection['state'];
type BadgeVariant = 'secondary' | 'warning' | 'destructive' | 'success' | 'ready' | 'waiting';

const stageNames: Record<StageState, string> = {
  absent: 'Не начато',
  draft: 'Агент прорабатывает',
  'in-review': 'Ждёт вашего решения',
  'changes-requested': 'Нужна доработка',
  approved: 'Утверждено',
  stale: 'Устарело',
  'not-applicable': 'Не применяется',
};
const stageTone: Record<StageState, BadgeVariant> = {
  absent: 'waiting',
  draft: 'secondary',
  'in-review': 'warning',
  'changes-requested': 'destructive',
  approved: 'success',
  stale: 'warning',
  'not-applicable': 'secondary',
};
const devNames: Record<DevelopmentSection['state'], string> = {
  'not-allowed': 'Не разрешена',
  'setting-up': 'Настройка контура',
  running: 'Идёт работа',
  idle: 'Простаивает',
  paused: 'На паузе',
  blocked: 'Заблокирована',
};
const devTone: Record<DevelopmentSection['state'], BadgeVariant> = {
  'not-allowed': 'waiting',
  'setting-up': 'ready',
  running: 'ready',
  idle: 'secondary',
  paused: 'warning',
  blocked: 'destructive',
};
const stageIcons: Record<StageState, LucideIcon> = {
  absent: CircleDashed,
  draft: PencilLine,
  'in-review': Hourglass,
  'changes-requested': CircleAlert,
  approved: CircleCheck,
  stale: TriangleAlert,
  'not-applicable': CircleMinus,
};
const devIcons: Record<DevelopmentSection['state'], LucideIcon> = {
  'not-allowed': Lock,
  'setting-up': Wrench,
  running: CirclePlay,
  idle: Circle,
  paused: CirclePause,
  blocked: Ban,
};
/** Цвет дуги кольца по тону метки: тот же смысл, что у метки рядом. */
const ringTone: Record<BadgeVariant, string> = {
  success: 'var(--status-done)',
  warning: 'var(--status-attention)',
  destructive: 'var(--status-failed)',
  ready: 'var(--status-active)',
  secondary: 'var(--data-accent)',
  waiting: 'var(--data-accent)',
};
const stepNames = { references: 'Референсы', concept: 'Концепт', design: 'Макет' } as const;
const shellNames: Record<HomeView['shell'], string> = {
  bootstrap: 'Начало',
  preparation: 'Подготовка',
  development: 'Разработка',
};
const changeSetNames = {
  accepted: 'принят',
  verifying: 'идёт проверка',
  failed: 'проверка не прошла',
  open: 'в работе',
} as const;
const budgetNames: Record<NonNullable<HomeHarness['budget']>['state'], string> = {
  within: 'в пределах',
  exceeded: 'исчерпан',
  undetermined: 'не определён',
};

/** «N мин назад» по общим часам панели. */
function ago(at: string | null | undefined, now: number) {
  if (!at) return 'неизвестно';
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}
const minutes = (ms: number) => `${Math.round(ms / 60_000)} мин`;
const asOfText = (at: string) =>
  `на ${new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;

/** Ссылка панели: переход без перезагрузки (запись истории и `popstate`). */
function PanelLink({
  href,
  children,
  className,
  ...rest
}: {
  href: string;
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <a
      href={href}
      className={cn('text-info underline-offset-2 hover:underline', className)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Плитка: секция с заголовком второго уровня и одной ссылкой «Открыть …». */
function Tile({
  title,
  badge,
  open,
  className,
  children,
}: {
  title: string;
  badge?: ReactNode;
  open?: { href: string; label: string };
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'bg-card text-card-foreground flex min-w-0 flex-col gap-3 rounded-md border p-4 text-sm [overflow-wrap:anywhere]',
        className,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-md m-0 leading-tight font-semibold">
          {title}
        </h2>
        {badge}
      </header>
      <div className="grid min-w-0 flex-1 content-start gap-3">{children}</div>
      {open && (
        <p className="m-0">
          <PanelLink href={open.href} className="font-medium">
            {open.label} →
          </PanelLink>
        </p>
      )}
    </section>
  );
}

/**
 * Пустая плитка в одну строку: раздел без работы (подготовка не ведётся,
 * дизайн не применяется, этап ещё не начат) не занимает место плитки.
 */
function CompactTile({
  title,
  badge,
  text,
  facts,
  open,
}: {
  title: string;
  badge?: ReactNode;
  text: string;
  facts: { label: string; value: number | string }[];
  open?: { href: string; label: string };
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="bg-card text-card-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-4 py-2.5 text-sm [overflow-wrap:anywhere]"
    >
      <h2 id={id} className="m-0 text-sm leading-tight font-semibold">
        {title}
      </h2>
      {badge}
      <span className="text-muted-foreground min-w-0">{text}</span>
      {facts.map((f) => (
        <span key={f.label} className="tabular">
          <span className="text-muted-foreground">{f.label} </span>
          <span className="font-medium">{f.value}</span>
        </span>
      ))}
      {open && (
        <PanelLink href={open.href} className="ml-auto font-medium">
          {open.label} →
        </PanelLink>
      )}
    </section>
  );
}

/** Метка состояния со значком: значок дублирует подпись, а не заменяет её. */
function StateBadge({
  variant,
  icon: Icon,
  children,
}: {
  variant: BadgeVariant;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <Badge variant={variant}>
      <Icon className="size-3.5" aria-hidden="true" strokeWidth={2.25} />
      {children}
    </Badge>
  );
}

/** Кольцо и главная строка плитки: доля и что она значит. */
function Headline({
  ring,
  children,
}: {
  ring?: { done: number; total: number; label: string; tone: string };
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-start gap-3">
      {ring && <Ring {...ring} />}
      <div className="grid min-w-0 gap-0.5">{children}</div>
    </div>
  );
}

/** Число крупно, подпись мелко: счётчики плиток без строк текста. */
function Stats({
  items,
  label,
}: {
  items: { label: string; value: number | string; tone?: 'warning' | 'destructive' }[];
  label?: string;
}) {
  if (!items.length) return null;
  return (
    <dl
      className="m-0 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-3 gap-y-2"
      aria-label={label}
    >
      {items.map((f) => (
        <div key={f.label} className="mb-0 flex min-w-0 flex-col-reverse justify-end gap-0.5">
          <dt className="text-muted-foreground text-xs leading-tight">{f.label}</dt>
          <dd
            className={cn(
              'tabular m-0 text-left text-lg leading-tight font-semibold',
              f.tone === 'warning' && 'text-warning',
              f.tone === 'destructive' && 'text-destructive',
            )}
          >
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Facts({ items }: { items: { label: string; value: number | string }[] }) {
  if (!items.length) return null;
  return (
    <dl className="m-0 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((f) => (
        <div key={f.label} className="mb-0 flex min-w-0 items-baseline justify-start gap-1.5">
          <dt className="text-muted-foreground">{f.label}</dt>
          <dd className="tabular m-0 text-left font-medium">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Вопросы раздела: число, новые, первые вопросы со ссылкой и «ещё». */
function Questions({
  questions,
  attentionHref,
  limit,
}: {
  questions: SectionQuestions;
  attentionHref: string;
  limit: number;
}) {
  // След изменения числа при опросе: кольцо, которое гасит reduced-motion.
  const seen = useRef(questions.open);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (seen.current !== questions.open) setFlash((n) => n + 1);
    seen.current = questions.open;
  }, [questions.open]);
  const items = questions.items.slice(0, limit);
  const hidden = questions.open - items.length;
  return (
    <div className="grid min-w-0 gap-1.5">
      <p
        key={flash}
        className="m-0 rounded-sm"
        {...(flash ? { 'data-changed': '' } : {})}
        style={{ ['--flash' as string]: 'var(--status-waiting)' }}
      >
        <span className="text-muted-foreground">Вопросы: </span>
        <span className="font-medium">{questions.open}</span>
        {questions.unread > 0 && (
          <span className="text-muted-foreground">
            {' '}
            ({questions.unread} {plural(questions.unread, 'новый', 'новых', 'новых')})
          </span>
        )}
      </p>
      {items.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0">
          {items.map((q) => (
            <li key={q.id} className="min-w-0">
              <PanelLink href={q.href} className="line-clamp-2">
                {q.title}
              </PanelLink>
              {q.recommended && (
                <span className="text-muted-foreground block text-xs">
                  Рекомендует ведущий: {q.recommended}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {(hidden > 0 || questions.more) && (
        <p className="m-0">
          <PanelLink href={attentionHref} className="text-muted-foreground">
            {hidden > 0 ? `ещё ${hidden} — в центре внимания` : 'Все вопросы — в центре внимания'}
          </PanelLink>
        </p>
      )}
      {questions.answeredPendingLead > 0 && (
        <p className="text-muted-foreground m-0">
          Ответов ждут ведущего: {questions.answeredPendingLead}
        </p>
      )}
    </div>
  );
}

function StageBadge({ section }: { section: PreparationSection }) {
  return (
    <StateBadge variant={stageTone[section.state]} icon={stageIcons[section.state]}>
      {stageNames[section.state]}
      {section.revision !== undefined && section.state !== 'not-applicable'
        ? ` · v${section.revision}`
        : ''}
    </StateBadge>
  );
}

function PreparationTile({
  title,
  open,
  section,
  empty,
  attentionHref,
  limit,
  className,
  tracked = true,
  ring,
  children,
}: {
  title: string;
  /** Доля этапа кольцом: релизы, шаги, утверждённая редакция. */
  ring?: { done: number; total: number; label: string };
  /** Этапы ведутся в панели; без подготовки — без метки состояния этапа. */
  tracked?: boolean;
  /** Подпись ссылки «Открыть …»; без неё ссылки нет. */
  open?: string;
  section: PreparationSection;
  empty: string;
  attentionHref: string;
  limit: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Tile
      title={title}
      badge={tracked ? <StageBadge section={section} /> : undefined}
      open={open ? { href: section.href, label: open } : undefined}
      className={className}
    >
      {ring && (
        <Headline ring={{ ...ring, tone: ringTone[stageTone[section.state]] }}>
          <span className="font-medium">
            {ring.label}: {ring.done} из {ring.total}
          </span>
          {section.approvedAt && (
            <span className="text-muted-foreground text-xs">
              Утверждено {new Date(section.approvedAt).toLocaleString('ru-RU')}
            </span>
          )}
        </Headline>
      )}
      {section.state === 'absent' && <p className="text-muted-foreground m-0">{empty}</p>}
      <Facts items={section.facts} />
      {children}
      {!ring && section.approvedAt && (
        <p className="text-muted-foreground m-0 text-xs">
          Утверждено {new Date(section.approvedAt).toLocaleString('ru-RU')}
        </p>
      )}
      <Questions questions={section.questions} attentionHref={attentionHref} limit={limit} />
    </Tile>
  );
}

function DevelopmentTile({
  dev,
  engine,
  progress,
  attentionHref,
  limit,
  className,
}: {
  dev: DevelopmentSection;
  engine: boolean;
  progress?: HomeProgress;
  attentionHref: string;
  limit: number;
  className?: string;
}) {
  const live = progress ? progress.tasks.total - progress.tasks.cancelled : 0;
  const q = dev.queue;
  const stats: Parameters<typeof Stats>[0]['items'] = [
    { label: 'живых досок', value: dev.boards.live },
    { label: 'досок принято', value: dev.boards.accepted },
    { label: 'заданий идёт / ждёт', value: `${dev.jobs.running} / ${dev.jobs.waiting}` },
    ...(dev.jobs.failed
      ? [{ label: 'заданий остановлено', value: dev.jobs.failed, tone: 'destructive' as const }]
      : []),
    { label: q.paused ? 'готово, очередь стоит' : 'готово к выдаче', value: q.ready },
    ...(q.waitingInput
      ? [{ label: 'ждут ответа', value: q.waitingInput, tone: 'warning' as const }]
      : []),
  ];
  // Остальное о очереди — одной строкой под счётчиками.
  const more = [
    q.blocked ? `ждут зависимостей ${q.blocked}` : '',
    q.drafts ? `черновиков ${q.drafts}` : '',
    q.quiet ? `без движения ${q.quiet}` : '',
    dev.boards.closed ? `досок закрыто ${dev.boards.closed}` : '',
  ].filter(Boolean);
  return (
    <Tile
      title="Разработка"
      badge={
        <StateBadge variant={devTone[dev.state]} icon={devIcons[dev.state]}>
          {devNames[dev.state]}
        </StateBadge>
      }
      open={{ href: dev.href, label: engine ? 'Открыть доски' : 'Открыть этап' }}
      className={className}
    >
      <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3 xl:gap-6">
        <div className="grid min-w-0 content-start gap-2">
          {engine && live > 0 ? (
            <Headline
              ring={{
                done: progress!.tasks.done,
                total: live,
                label: 'Задач выполнено',
                tone: 'var(--status-done)',
              }}
            >
              <span className="font-medium">
                Задач выполнено: {progress!.tasks.done} из {live}
              </span>
              {dev.blocker && <span>{dev.blocker}</span>}
            </Headline>
          ) : (
            dev.blocker && <p className="m-0">{dev.blocker}</p>
          )}
          {q.hint && <p className="text-muted-foreground m-0 text-xs">{q.hint}</p>}
        </div>
        {engine && (
          <div className="grid min-w-0 content-start gap-2">
            <Stats items={stats} label="Доски, задания и очередь" />
            {more.length > 0 && (
              <p className="text-muted-foreground m-0 text-xs">{more.join(' · ')}</p>
            )}
          </div>
        )}
        <div className="grid min-w-0 content-start gap-3">
          {engine && dev.boards.top.length > 0 && (
            <ul className="m-0 grid list-none gap-1 p-0" aria-label="Живые доски">
              {dev.boards.top.map((b) => (
                <li key={b.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <PanelLink href={b.href} className="min-w-0 truncate">
                    {b.title}
                  </PanelLink>
                  <span className="text-muted-foreground text-xs">{boardPhaseLabels[b.phase]}</span>
                </li>
              ))}
            </ul>
          )}
          <Questions questions={dev.questions} attentionHref={attentionHref} limit={limit} />
        </div>
      </div>
    </Tile>
  );
}

function NowTile({
  dev,
  attentionHref,
  className,
}: {
  dev: DevelopmentSection;
  attentionHref: string;
  className?: string;
}) {
  const now = useNow(dev.runningNow.length > 0);
  const who = (w: 'operator' | 'lead') =>
    attentionHref + (attentionHref.includes('?') ? '&' : '?') + 'who=' + w;
  return (
    <Tile title="Сейчас идёт / кто ждёт" className={className}>
      {dev.runningNow.length ? (
        <ul className="m-0 grid list-none gap-1.5 p-0" aria-label="Идущие попытки">
          {dev.runningNow.map((r) => (
            <li key={r.taskId + r.attempt} className="min-w-0">
              <PanelLink href={r.href}>{r.title}</PanelLink>
              <span className="text-muted-foreground block text-xs">
                {[
                  r.roleTitle,
                  r.phase,
                  r.model,
                  `попытка ${r.attempt}`,
                  `начата ${ago(r.startedAt, now)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
          {dev.runningTotal > dev.runningNow.length && (
            <li className="text-muted-foreground">
              и ещё {dev.runningTotal - dev.runningNow.length}
            </li>
          )}
        </ul>
      ) : (
        <p className="text-muted-foreground m-0">Сейчас никто не работает над задачами.</p>
      )}
      <ul className="m-0 flex list-none flex-wrap gap-x-8 gap-y-2 p-0" aria-label="Кто ждёт">
        {(
          [
            ['operator', 'Ждут вас', dev.waitsOn.operator],
            ['lead', 'Ждут ведущего', dev.waitsOn.lead],
          ] as const
        ).map(([key, label, w]) => (
          <li key={key}>
            <PanelLink href={who(key)} className="grid">
              <span
                className={cn(
                  'tabular text-lg leading-tight font-semibold',
                  key === 'operator' && w.active > 0 && 'text-warning',
                )}
              >
                {w.active}
              </span>
              <span className="text-xs">
                {label}
                {w.unread ? ` (новых ${w.unread})` : ''}
              </span>
            </PanelLink>
          </li>
        ))}
      </ul>
      {dev.waitsOn.topWaiting && (
        <p className="m-0">
          <span className="text-muted-foreground">Больше всего работы держит: </span>
          <PanelLink href={dev.waitsOn.topWaiting.href}>«{dev.waitsOn.topWaiting.title}»</PanelLink>
          <span className="text-muted-foreground">
            {' '}
            (ждут {dev.waitsOn.topWaiting.waiting}{' '}
            {plural(dev.waitsOn.topWaiting.waiting, 'задача', 'задачи', 'задач')})
          </span>
        </p>
      )}
    </Tile>
  );
}

function ProgressTile({
  progress,
  engine,
  className,
}: {
  progress?: HomeProgress;
  engine: boolean;
  className?: string;
}) {
  if (!progress)
    return (
      <Tile title="Ход работ" className={className}>
        <p className="text-muted-foreground m-0">
          Хода работ ещё нет: релизы и задачи появятся после утверждённой постановки и плана.
        </p>
      </Tile>
    );
  const { tasks, changeSets, coverage } = progress;
  return (
    <Tile
      title="Ход работ"
      open={engine ? { href: progress.href, label: 'Открыть ход работ' } : undefined}
      className={className}
    >
      {/* Релизы — полосами общего хода работ над плитками. */}
      <Stats
        label="Задачи и ChangeSet"
        items={[
          { label: 'задач выполнено', value: `${tasks.done}/${tasks.total - tasks.cancelled}` },
          { label: 'задач осталось', value: tasks.remaining },
          ...(tasks.failed
            ? [{ label: 'задач со сбоем', value: tasks.failed, tone: 'destructive' as const }]
            : []),
          ...(tasks.cancelled ? [{ label: 'задач отменено', value: tasks.cancelled }] : []),
          { label: 'ChangeSet принято', value: `${changeSets.accepted}/${changeSets.total}` },
          ...(changeSets.verifying
            ? [{ label: 'ChangeSet на проверке', value: changeSets.verifying }]
            : []),
          ...(changeSets.failed
            ? [
                {
                  label: 'ChangeSet не прошли',
                  value: changeSets.failed,
                  tone: 'destructive' as const,
                },
              ]
            : []),
        ]}
      />
      {changeSets.latest && (
        <p className="m-0">
          <span className="text-muted-foreground">Последний: </span>
          <PanelLink href={changeSets.latest.href}>«{changeSets.latest.title}»</PanelLink>
          <span className="text-muted-foreground">
            {' '}
            — {changeSetNames[changeSets.latest.status]}
          </span>
        </p>
      )}
      {coverage &&
        (coverage.available ? (
          <p className="m-0">
            <span className="text-muted-foreground">Покрытие {coverage.releaseId}: </span>
            <PanelLink href={coverage.href}>
              {coverage.accepted
                ? 'релиз принят'
                : coverage.complete
                  ? 'полное'
                  : `неполное, замечаний ${coverage.issueCount}`}
            </PanelLink>
            {coverage.unconfirmed > 0 && `, сценариев без подтверждения ${coverage.unconfirmed}`}
            {coverage.deferred > 0 && `, отложено ${coverage.deferred}`}
            <span className="text-muted-foreground"> ({asOfText(coverage.asOf)})</span>
          </p>
        ) : (
          <p className="text-muted-foreground m-0">
            Карта продукта: {coverage.reason} ({asOfText(coverage.asOf)})
          </p>
        ))}
    </Tile>
  );
}

const kindNames: Record<string, string> = {
  budget: 'бюджет',
  environment: 'окружение',
  stalled: 'зависание',
  review: 'ревью',
  gate: 'проверки',
  gates: 'проверки',
  timeout: 'время',
  runtime: 'runtime',
  unknown: 'без класса',
  other: 'прочие',
};

const money = (v: number) => '~$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
const limitText = (v: number) => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
const callsText = (n: number) => `${n} ${plural(n, 'вызова', 'вызовов', 'вызовов')}`;

/**
 * Бюджеты строкой на область: состояние, оценка из предела, время и вызовы с
 * неизвестной стоимостью. Красный — только исчерпанный, янтарный — не
 * определённый; точные суммы и текст расчёта — в «подробнее».
 */
function BudgetLines({
  budget,
  href,
}: {
  budget: NonNullable<HomeHarness['budget']>;
  href: string;
}) {
  const scopes = budget.scopes?.length ? budget.scopes : [budget];
  const hidden = budget.total - scopes.length;
  return (
    <div className="grid min-w-0 gap-1">
      <ul className="m-0 grid list-none gap-1 p-0" aria-label="Бюджеты">
        {scopes.map((b) => (
          <li
            key={b.scope}
            className={cn(
              b.state === 'exceeded' && 'text-destructive',
              b.state === 'undetermined' && 'text-warning',
            )}
          >
            <span className={b.state === 'within' ? 'text-muted-foreground' : undefined}>
              Бюджет {b.scope}:{' '}
            </span>
            <PanelLink
              href={href}
              className={b.state !== 'within' ? 'text-current underline' : undefined}
            >
              {budgetNames[b.state]}
            </PanelLink>
            {' · '}
            {money(b.spentUsd)}
            {b.limitUsd !== undefined
              ? ` из ${limitText(b.limitUsd)} (${Math.round((b.spentUsd / b.limitUsd) * 100)} %)`
              : ''}
            {b.limitMs !== undefined
              ? `; время ${minutes(b.spentMs ?? 0)} из ${minutes(b.limitMs)}`
              : ''}
            {b.unknownCalls
              ? `; у ${callsText(b.unknownCalls)} стоимость неизвестна — сумма занижена`
              : ''}
          </li>
        ))}
        {hidden > 0 && <li className="text-muted-foreground">и ещё бюджетов: {hidden}</li>}
      </ul>
      <details className="text-muted-foreground text-xs">
        <summary className="cursor-pointer">подробнее</summary>
        <ul className="m-0 mt-1 grid list-none gap-1 p-0">
          {scopes.map((b) => (
            <li key={b.scope}>
              {b.scope}: оценка ${b.spentUsd.toFixed(4)}
              {b.spentMs !== undefined ? `, время ${Math.round(b.spentMs / 1000)} с` : ''}
              {b.reason ? `. ${b.reason}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function HarnessTile({
  harness,
  startupError,
  className,
}: {
  harness?: HomeHarness;
  startupError?: string;
  className?: string;
}) {
  const now = useNow(Boolean(harness?.health.lead.lastActivityAt));
  if (!harness)
    return (
      <Tile
        title="Исполнение"
        badge={<Badge variant="waiting">Не подключено</Badge>}
        className={className}
      >
        <p className="text-muted-foreground m-0">
          {startupError
            ? 'Движок разработки не подключился: причина — выше.'
            : 'Движок разработки подключится после setup: попыток, проверок и бюджета ещё нет.'}
        </p>
      </Tile>
    );
  const h = harness;
  const kinds = Object.entries(h.attempts24h.byKind);
  const budget = h.budget;
  return (
    <Tile
      title="Исполнение"
      badge={<span className="text-muted-foreground text-xs">devcontour-harness {h.version}</span>}
      open={{ href: h.href, label: 'Открыть настройки' }}
      className={className}
    >
      <div className="grid min-w-0 gap-3 md:grid-cols-3">
        <div className="grid min-w-0 content-start gap-2">
          <Headline
            ring={{
              done: h.active,
              total: h.concurrency,
              label: 'Слотов занято',
              tone: 'var(--status-active)',
            }}
          >
            <span>
              <span className="text-muted-foreground">Слоты: </span>занято {h.active} из{' '}
              {h.concurrency}
            </span>
          </Headline>
          <dl className="m-0 grid content-start gap-1">
            <div className="mb-0 flex flex-wrap justify-start gap-x-1.5 gap-y-0">
              <dt className="text-muted-foreground">Попытки за 24 ч:</dt>
              <dd className="m-0 text-left">
                {h.attempts24h.total ? (
                  <>
                    {h.attempts24h.total}, со сбоем {h.attempts24h.failed}
                    {kinds.length > 0 &&
                      ' (' + kinds.map(([k, n]) => `${kindNames[k] ?? k} ${n}`).join(', ') + ')'}
                  </>
                ) : (
                  'попыток ещё не было'
                )}
              </dd>
            </div>
            <div className="mb-0 flex flex-wrap justify-start gap-x-1.5 gap-y-0">
              <dt className="text-muted-foreground">Сбои:</dt>
              <dd className="m-0 text-left">
                задач {h.failures.tasks}, разборов свойств {h.failures.recoveries}, без движения{' '}
                {h.failures.quiet}
              </dd>
            </div>
          </dl>
        </div>
        <div className="grid content-start gap-1">
          {h.gates ? (
            h.gates.failing.length ? (
              <>
                <p className="m-0">
                  <span className="text-muted-foreground">Проверки с отказами за 24 ч </span>(
                  {asOfText(h.gates.asOf)}):
                </p>
                <ul className="m-0 grid list-none gap-0.5 p-0" aria-label="Проверки с отказами">
                  {h.gates.failing.map((g) => (
                    <li key={g.gate} className="text-destructive min-w-0">
                      <code className="font-mono">{g.gate}</code>: отказов {g.failed}, прошло{' '}
                      {g.passed}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="m-0">
                <span className="text-muted-foreground">Проверки за 24 ч: </span>
                {h.gates.total ? `отказов нет (gates ${h.gates.total})` : 'не запускались'}
              </p>
            )
          ) : null}
          {budget ? (
            <BudgetLines budget={budget} href={h.budgetHref} />
          ) : (
            <p className="text-muted-foreground m-0">Бюджеты не заданы.</p>
          )}
          {h.usage && (
            <p className="text-muted-foreground m-0">
              Вызовов моделей: {h.usage.calls}, известная оценка ${h.usage.knownCostUsd.toFixed(2)}{' '}
              ({asOfText(h.usage.asOf)})
            </p>
          )}
        </div>
        <ul className="m-0 grid list-none content-start gap-1 p-0" aria-label="Здоровье сервера">
          <li className={h.health.journalError ? 'text-destructive' : undefined}>
            Журнал: {h.health.journalError ? `сбой — ${h.health.journalError}` : 'в порядке'}
          </li>
          <li className={h.health.configDrift ? 'text-warning' : undefined}>
            Конфигурация:{' '}
            {h.health.configDrift
              ? `config.json не применён — ${h.health.configDrift}`
              : (h.health.configPending ?? 'применена')}
          </li>
          <li className={h.health.loopStalls1h ? 'text-warning' : undefined}>
            Задержки цикла сервера за час: {h.health.loopStalls1h}
            {h.health.clockJumps1h ? `, скачков часов ${h.health.clockJumps1h}` : ''}
          </li>
          <li>
            Ведущий:{' '}
            {h.health.lead.present
              ? `на связи, ${ago(h.health.lead.lastActivityAt, now)}`
              : h.health.lead.lastActivityAt
                ? `не на связи, последний раз ${ago(h.health.lead.lastActivityAt, now)}`
                : 'следов обращений нет'}
          </li>
        </ul>
      </div>
    </Tile>
  );
}

/** Классы ширины плитки разделов в ряду из 12 колонок по числу полных плиток. */
const spans: Record<number, string> = {
  1: 'lg:col-span-12',
  2: 'lg:col-span-6',
  3: 'lg:col-span-4',
  4: 'lg:col-span-3',
};

/**
 * Плитки разделов. Раздел без работы — строкой под рядом полных плиток;
 * полные делят ряд поровну и тянутся до общей высоты. На узком экране
 * разработка — первой.
 */
function SectionTiles({
  home,
  tracked,
  attentionHref,
  limit,
}: {
  home: Home;
  tracked: boolean;
  attentionHref: string;
  limit: number;
}) {
  const s = home.sections;
  const untracked = 'Подготовка не ведётся в панели.';
  const releases = home.progress?.releases ?? [];
  const steps = (s.design.design?.steps ?? []).filter((x) => x.state !== 'not-applicable');
  const approved = (state: StageState) => (state === 'approved' ? 1 : 0);
  const tiles = [
    {
      key: 'product',
      title: 'Продукт',
      section: s.product,
      open: tracked ? 'Открыть продукт' : 'Открыть карту продукта',
      empty: tracked
        ? 'Опишите продукт: создайте изменение и поручите агенту постановку.'
        : untracked,
      // Постановка — точка входа: пустой она остаётся плиткой с призывом.
      keep: tracked,
      ring: !tracked
        ? undefined
        : releases.length && home.progress && s.product.state !== 'absent'
          ? {
              done: home.progress.releasesDone,
              total: home.progress.releasesTotal,
              label: 'Релизов готово',
            }
          : s.product.state !== 'absent'
            ? { done: approved(s.product.state), total: 1, label: 'Утверждено этапов' }
            : undefined,
    },
    {
      key: 'architecture',
      title: 'Архитектура',
      section: s.architecture,
      open: tracked ? 'Открыть архитектуру' : 'Открыть контракты',
      empty: tracked ? 'Архитектура и стек — после утверждённой постановки.' : untracked,
      keep: false,
      ring:
        tracked && s.architecture.state !== 'absent'
          ? { done: approved(s.architecture.state), total: 1, label: 'Утверждено этапов' }
          : undefined,
    },
    {
      key: 'design',
      title: 'Дизайн',
      section: s.design,
      open: tracked ? 'Открыть дизайн' : undefined,
      empty: tracked ? 'Референсы, концепт и макет — после архитектуры.' : untracked,
      keep: false,
      ring:
        tracked && s.design.state !== 'absent' && steps.length
          ? {
              done: steps.filter((x) => x.state === 'approved').length,
              total: steps.length,
              label: 'Шагов дизайна утверждено',
            }
          : undefined,
    },
  ] as const;
  const compact = (t: (typeof tiles)[number]) =>
    t.section.questions.open === 0 &&
    !t.section.questions.more &&
    // Ответы без решения ведущего и удержанные черновики — работа раздела.
    t.section.questions.answeredPendingLead === 0 &&
    t.section.questions.blockedTasks === 0 &&
    (t.section.state === 'not-applicable' || (t.section.state === 'absent' && !t.keep));
  const full = tiles.filter((t) => !compact(t));
  const rest = tiles.filter(compact);
  const span = spans[full.length];
  return (
    <>
      {/* Разработка — первой и во всю ширину: её счётчики и списки — в колонки. */}
      <DevelopmentTile
        dev={s.development}
        engine={home.engineConnected}
        progress={home.progress}
        attentionHref={attentionHref}
        limit={limit}
      />
      {full.length > 0 && (
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12">
          {full.map((t, i) => (
            <PreparationTile
              key={t.key}
              title={t.title}
              open={t.open}
              section={t.section}
              empty={t.empty}
              attentionHref={attentionHref}
              limit={limit}
              tracked={tracked}
              ring={t.ring}
              className={cn(
                span,
                full.length % 2 === 1 && i === full.length - 1 && 'sm:col-span-2',
              )}
            >
              {t.key === 'design' && tracked && s.design.design && (
                <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Шаги дизайна">
                  {s.design.design.steps.map((step) => (
                    <li key={step.key}>
                      <StateBadge variant={stageTone[step.state]} icon={stageIcons[step.state]}>
                        {stepNames[step.key]}: {stageNames[step.state].toLowerCase()}
                      </StateBadge>
                    </li>
                  ))}
                </ol>
              )}
            </PreparationTile>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className="grid min-w-0 gap-2">
          {rest.map((t) => (
            <CompactTile
              key={t.key}
              title={t.title}
              badge={tracked ? <StageBadge section={t.section} /> : undefined}
              text={
                t.section.state === 'not-applicable' ? 'Дизайн к продукту не применяется.' : t.empty
              }
              facts={t.section.facts}
              open={t.open ? { href: t.section.href, label: t.open } : undefined}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Одна строка для живой области: изменилось число вопросов разделов. */
const questionLine = (home: Home) => {
  const s = home.sections;
  const total =
    s.product.questions.open +
    s.architecture.questions.open +
    s.design.questions.open +
    s.development.questions.open;
  return `Открытых вопросов: ${total}`;
};

export function Home() {
  const [home, setHome] = useState<Home>();
  const [error, setError] = useState('');
  const [announce, setAnnounce] = useState('');
  const etag = useRef<string | undefined>(undefined);
  const announced = useRef('');
  const narrow = useNarrow();
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(
        '/api/home' + (etag.current ? '?etag=' + encodeURIComponent(etag.current) : ''),
        { signal },
      );
      const value = (await response.json().catch(() => undefined)) as
        | (Home & { unchanged?: undefined; error?: string })
        | { unchanged: true; etag: string; error?: string }
        | undefined;
      if (!response.ok || !value)
        throw new Error(value?.error ?? `сервер ответил ${response.status}`);
      if (!value.unchanged) {
        etag.current = value.etag;
        setHome(value);
        // Живая область — только о смене числа вопросов, не о каждом опросе.
        const line = questionLine(value);
        if (announced.current && announced.current !== line) setAnnounce(line);
        announced.current = line;
      }
      setError('');
    } catch (e) {
      if (!signal?.aborted) setError(humanError(e instanceof Error ? e.message : String(e)));
    }
  }, []);
  // Опрос, пока вкладка видна: скрытая не опрашивает и догоняет при показе.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer || document.hidden) return;
      void load(controller.signal);
      timer = setInterval(() => void load(controller.signal), HOME_POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const visibility = () => (document.hidden ? stop() : start());
    if (document.hidden) void load(controller.signal);
    start();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      controller.abort();
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [load]);
  useAttentionScreen(() => home?.links.attention ?? '/?view=attention');
  useEffect(() => {
    const before = document.title;
    document.title = 'DevContour · Главная';
    return () => {
      document.title = before;
    };
  }, []);

  const limit = narrow ? 2 : 3;
  // Разработка без подготовки: этапов нет, плитки называют это прямо.
  const tracked = !home || home.preparation || !home.engineConnected;
  const attentionHref = home?.links.attention ?? '/?view=attention';
  const s = home?.sections;
  return (
    <main className="bg-frame min-h-dvh">
      <div className="mx-auto grid max-w-[100rem] gap-4 p-4 sm:p-6">
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-foreground font-semibold">DevContour</span>
            <h1 className="m-0 text-xl leading-tight font-semibold">Главная</h1>
            {home && (
              <Badge variant="secondary">
                {shellNames[home.shell]}
                {home.change ? ` · ${home.change.title}` : ''}
              </Badge>
            )}
          </div>
          <nav aria-label="Разделы панели" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <a href="/" aria-current="page" className="text-foreground font-semibold no-underline">
              Главная
            </a>
            {home && (home.shell !== 'development' || home.change) && (
              <PanelLink href={home.sections.product.href}>Подготовка</PanelLink>
            )}
            {home && <PanelLink href={home.sections.development.href}>Разработка</PanelLink>}
            <PanelLink href={attentionHref} className="inline-flex items-center gap-1.5">
              Нужно действие
              <AttentionCount />
            </PanelLink>
          </nav>
        </header>
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>
        {home?.startupError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              Движок разработки не подключился: {home.startupError}
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>
                {home ? 'Главная не обновилась: ' : 'Не удалось прочитать главную: '}
                {error}
              </span>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!home || !s ? (
          !error && (
            <p role="status" aria-busy="true">
              Загрузка главной…
            </p>
          )
        ) : (
          <>
            {home.attention.active > 0 && (
              <p className="m-0 text-sm">
                <PanelLink href={attentionHref} className="font-medium">
                  В центре внимания карточек: {home.attention.active}
                  {home.attention.unread ? `, новых ${home.attention.unread}` : ''}
                </PanelLink>
              </p>
            )}
            {home.progress && <OverallProgress progress={home.progress} />}
            <SectionTiles
              home={home}
              tracked={tracked}
              attentionHref={attentionHref}
              limit={limit}
            />
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12">
              <NowTile
                dev={s.development}
                attentionHref={attentionHref}
                className="sm:col-span-1 lg:col-span-6"
              />
              <ProgressTile
                progress={home.progress}
                engine={home.engineConnected}
                className="sm:col-span-1 lg:col-span-6"
              />
              {home.harness?.load && (
                <Tile
                  title="Динамика"
                  badge={
                    <span className="text-muted-foreground text-xs">
                      {asOfText(home.harness.load.asOf)}
                    </span>
                  }
                  className="sm:col-span-2 lg:col-span-12"
                >
                  <div className="grid min-w-0 gap-6 md:grid-cols-2 xl:grid-cols-4">
                    <LoadChart load={home.harness.load} concurrency={home.harness.concurrency} />
                    <HourlyChart load={home.harness.load} />
                    {home.harness.gateTrend && <GateTrendChart trend={home.harness.gateTrend} />}
                    {home.harness.spend && (
                      <SpendChart spend={home.harness.spend} estimate={COST_ESTIMATE_RU} />
                    )}
                  </div>
                </Tile>
              )}
              <HarnessTile
                harness={home.harness}
                startupError={home.startupError}
                className="sm:col-span-2 lg:col-span-12"
              />
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/** Узкий экран (< 640 px): вопросов на плитке меньше. */
function useNarrow() {
  const query = '(max-width: 639px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setNarrow(list.matches);
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, []);
  return narrow;
}
