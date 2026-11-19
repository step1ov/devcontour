import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  DevelopmentSection,
  HomeHarness,
  HomeProgress,
  HomeView,
  PreparationSection,
  SectionQuestions,
} from '../application/home.ts';
import { boardPhaseLabels } from '../core/work-status.ts';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { cn, humanError, plural } from '@/lib/utils.ts';
import { AttentionCount, useAttentionScreen } from './AttentionProvider.tsx';
import { Bar } from '@/ui/progress-bar.tsx';
import { navigate } from './navigation.ts';
import { useNow } from './now.ts';
import { HourlyChart, LoadChart, OverallProgress } from './HomeCharts.tsx';

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
const stepNames = { references: 'Референсы', concept: 'Концепт', design: 'Макет' } as const;
const shellNames: Record<HomeView['shell'], string> = {
  bootstrap: 'Начало',
  preparation: 'Подготовка',
  development: 'Разработка',
};
const readinessNames: Record<HomeProgress['releases'][number]['readiness'], string> = {
  unplanned: 'не запланирован',
  'in-progress': 'в работе',
  failed: 'есть сбой',
  done: 'готов',
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

function Facts({ items }: { items: { label: string; value: number | string }[] }) {
  if (!items.length) return null;
  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-3 gap-y-1">
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
    <Badge variant={stageTone[section.state]}>
      {stageNames[section.state]}
      {section.revision !== undefined && section.state !== 'not-applicable'
        ? ` · v${section.revision}`
        : ''}
    </Badge>
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
  children,
}: {
  title: string;
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
      {section.state === 'absent' && <p className="text-muted-foreground m-0">{empty}</p>}
      <Facts items={section.facts} />
      {children}
      {section.approvedAt && (
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
  attentionHref,
  limit,
  className,
}: {
  dev: DevelopmentSection;
  engine: boolean;
  attentionHref: string;
  limit: number;
  className?: string;
}) {
  return (
    <Tile
      title="Разработка"
      badge={<Badge variant={devTone[dev.state]}>{devNames[dev.state]}</Badge>}
      open={{ href: dev.href, label: engine ? 'Открыть доски' : 'Открыть этап' }}
      className={className}
    >
      {dev.blocker && <p className="m-0">{dev.blocker}</p>}
      {engine && (
        <>
          <dl className="m-0 grid gap-1">
            <div className="mb-0 flex flex-wrap justify-start gap-x-1.5 gap-y-0">
              <dt className="text-muted-foreground">Доски:</dt>
              <dd className="m-0 text-left">
                живых {dev.boards.live}, принято {dev.boards.accepted}
                {dev.boards.closed ? `, закрыто ${dev.boards.closed}` : ''}
              </dd>
            </div>
            <div className="mb-0 flex flex-wrap justify-start gap-x-1.5 gap-y-0">
              <dt className="text-muted-foreground">Задания ведущего:</dt>
              <dd className="m-0 text-left">
                идут {dev.jobs.running}, ждут {dev.jobs.waiting}
                {dev.jobs.failed ? `, остановлено ${dev.jobs.failed}` : ''}
              </dd>
            </div>
            <div className="mb-0 flex flex-wrap justify-start gap-x-1.5 gap-y-0">
              <dt className="text-muted-foreground">Очередь:</dt>
              <dd className="m-0 text-left">
                {dev.queue.paused ? 'на паузе' : 'выдаёт'}, готово {dev.queue.ready}
                {dev.queue.blocked ? `, ждут зависимостей ${dev.queue.blocked}` : ''}
                {dev.queue.waitingInput ? `, ждут ответа ${dev.queue.waitingInput}` : ''}
                {dev.queue.drafts ? `, черновиков ${dev.queue.drafts}` : ''}
                {dev.queue.quiet ? `, без движения ${dev.queue.quiet}` : ''}
              </dd>
            </div>
          </dl>
          {dev.queue.hint && <p className="text-muted-foreground m-0">{dev.queue.hint}</p>}
          {dev.boards.top.length > 0 && (
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
        </>
      )}
      <Questions questions={dev.questions} attentionHref={attentionHref} limit={limit} />
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
      <ul className="m-0 grid list-none gap-1 p-0" aria-label="Кто ждёт">
        <li>
          <PanelLink href={who('operator')}>
            Ждут вас: {dev.waitsOn.operator.active}
            {dev.waitsOn.operator.unread ? ` (новых ${dev.waitsOn.operator.unread})` : ''}
          </PanelLink>
        </li>
        <li>
          <PanelLink href={who('lead')}>
            Ждут ведущего: {dev.waitsOn.lead.active}
            {dev.waitsOn.lead.unread ? ` (новых ${dev.waitsOn.lead.unread})` : ''}
          </PanelLink>
        </li>
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
      {progress.releases.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0" aria-label="Релизы">
          {progress.releases.map((r) => (
            <li key={r.id} className="grid min-w-0 gap-0.5">
              <Bar done={r.done} total={r.tasks} label={`${r.id} ${r.title}`} />
              <span className="text-muted-foreground text-xs">
                {readinessNames[r.readiness]} · критериев {r.criteria}
                {r.failed ? ` · со сбоем ${r.failed}` : ''}
              </span>
            </li>
          ))}
          {progress.releasesTotal > progress.releases.length && (
            <li className="text-muted-foreground">
              и ещё релизов: {progress.releasesTotal - progress.releases.length}
            </li>
          )}
        </ul>
      )}
      <dl className="m-0 grid gap-1">
        <div className="mb-0 flex flex-wrap justify-start gap-x-1.5 gap-y-0">
          <dt className="text-muted-foreground">Задачи:</dt>
          <dd className="m-0 text-left">
            выполнено {tasks.done} из {tasks.total - tasks.cancelled}, осталось {tasks.remaining}
            {tasks.failed ? `, со сбоем ${tasks.failed}` : ''}
            {tasks.cancelled ? `, отменено ${tasks.cancelled}` : ''}
          </dd>
        </div>
        <div className="mb-0 flex flex-wrap justify-start gap-x-1.5 gap-y-0">
          <dt className="text-muted-foreground">ChangeSet:</dt>
          <dd className="m-0 text-left">
            принято {changeSets.accepted} из {changeSets.total}
            {changeSets.verifying ? `, на проверке ${changeSets.verifying}` : ''}
            {changeSets.failed ? `, не прошли ${changeSets.failed}` : ''}
          </dd>
        </div>
      </dl>
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
        <dl className="m-0 grid content-start gap-1">
          <div className="mb-0 flex flex-wrap justify-start gap-x-1.5 gap-y-0">
            <dt className="text-muted-foreground">Слоты:</dt>
            <dd className="m-0 text-left">
              занято {h.active} из {h.concurrency}
            </dd>
          </div>
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
            <p className={cn('m-0', budget.state !== 'within' && 'text-destructive')}>
              <span className={budget.state === 'within' ? 'text-muted-foreground' : undefined}>
                Бюджет {budget.scope}:{' '}
              </span>
              <PanelLink
                href={h.budgetHref}
                className={budget.state !== 'within' ? 'text-current underline' : undefined}
              >
                {budgetNames[budget.state]}
              </PanelLink>
              , оценка ${budget.spentUsd.toFixed(2)}
              {budget.limitUsd !== undefined ? ` из $${budget.limitUsd.toFixed(2)}` : ''}
              {budget.unknownCalls ? `; стоимость неизвестна у ${budget.unknownCalls} вызовов` : ''}
              {budget.limitMs !== undefined
                ? `; время ${minutes(budget.spentMs ?? 0)} из ${minutes(budget.limitMs)}`
                : ''}
              {budget.exceeded > 1 ? `; исчерпано бюджетов: ${budget.exceeded}` : ''}
              {budget.state !== 'within' && budget.reason && (
                <span className="block">{budget.reason}</span>
              )}
            </p>
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
  const untracked = 'Подготовка не ведётся в панели.';
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
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12">
              <PreparationTile
                title="Продукт"
                open={tracked ? 'Открыть продукт' : 'Открыть карту продукта'}
                section={s.product}
                empty={
                  tracked
                    ? 'Опишите продукт: создайте изменение и поручите агенту постановку.'
                    : untracked
                }
                attentionHref={attentionHref}
                limit={limit}
                tracked={tracked}
                className="max-sm:order-2 lg:col-span-3"
              />
              <PreparationTile
                title="Архитектура"
                open={tracked ? 'Открыть архитектуру' : 'Открыть контракты'}
                section={s.architecture}
                empty={tracked ? 'Архитектура и стек — после утверждённой постановки.' : untracked}
                attentionHref={attentionHref}
                limit={limit}
                tracked={tracked}
                className="max-sm:order-3 lg:col-span-3"
              />
              <PreparationTile
                title="Дизайн"
                open={tracked ? 'Открыть дизайн' : undefined}
                section={s.design}
                empty={tracked ? 'Референсы, концепт и макет — после архитектуры.' : untracked}
                attentionHref={attentionHref}
                limit={limit}
                tracked={tracked}
                className="max-sm:order-4 lg:col-span-3"
              >
                {tracked && s.design.design && s.design.state !== 'not-applicable' && (
                  <ol
                    className="m-0 flex list-none flex-wrap gap-1.5 p-0"
                    aria-label="Шаги дизайна"
                  >
                    {s.design.design.steps.map((step) => (
                      <li key={step.key}>
                        <Badge variant={stageTone[step.state]}>
                          {stepNames[step.key]}: {stageNames[step.state].toLowerCase()}
                        </Badge>
                      </li>
                    ))}
                  </ol>
                )}
              </PreparationTile>
              <DevelopmentTile
                dev={s.development}
                engine={home.engineConnected}
                attentionHref={attentionHref}
                limit={limit}
                className="max-sm:order-1 lg:col-span-3"
              />
              <NowTile
                dev={s.development}
                attentionHref={attentionHref}
                className="max-sm:order-5 sm:col-span-1 lg:col-span-6"
              />
              <ProgressTile
                progress={home.progress}
                engine={home.engineConnected}
                className="max-sm:order-6 sm:col-span-1 lg:col-span-6"
              />
              {home.harness?.load && (
                <Tile
                  title="Нагрузка"
                  badge={
                    <span className="text-muted-foreground text-xs">
                      {asOfText(home.harness.load.asOf)}
                    </span>
                  }
                  className="max-sm:order-7 sm:col-span-2 lg:col-span-12"
                >
                  <div className="grid min-w-0 gap-6 md:grid-cols-2">
                    <LoadChart load={home.harness.load} concurrency={home.harness.concurrency} />
                    <HourlyChart load={home.harness.load} />
                  </div>
                </Tile>
              )}
              <HarnessTile
                harness={home.harness}
                startupError={home.startupError}
                className="max-sm:order-8 sm:col-span-2 lg:col-span-12"
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
