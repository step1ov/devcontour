import type { AuditEvent, DevContourState } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import type { ProductChange } from '../core/preparation-model.ts';
import { Preparation } from '../core/preparation.ts';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import { boardPhase, type BoardPhase } from '../core/work-status.ts';
import { readyTasks } from '../core/graph.ts';
import { repositories } from '../core/repositories.ts';
import type { AttentionItem } from '../core/attention-model.ts';
import type { AttentionView } from './attention.ts';
import { inputHolds } from './input.ts';
import { queueStopOf, quietAttempts } from './queue-stop.ts';
import { hrefs } from './panel-links.ts';
import { leadPresence } from './quick-view.ts';
import { harnessVersion } from '../harness/index.ts';
import { configApplyKeys, reconfigureSlotBusy } from '../runner/reconfigure.ts';
import type { ProductView } from '../core/product-map.ts';

/**
 * Главная панели (`GET /api/home`): по плитке на раздел — продукт,
 * архитектура, дизайн, разработка — с открытыми вопросами раздела. Только
 * чтение, без моделей и без нового разбора документа: замороженный снимок
 * версии (`Store.view`) и уже посчитанный центр внимания той же версии.
 * Размер ограничен пределами списков `HOME_LIMITS`, а не длиной истории.
 */

export const HOME_LIMITS = {
  /** Вопросов раздела в ответе; остальные — в центре внимания (`more`). */
  questions: 3,
  facts: 6,
  boards: 3,
  jobs: 3,
  runningNow: 6,
  releases: 8,
  failingGates: 5,
  failureKinds: 8,
  /** Интервалов графика нагрузки: сутки по 15 минут. */
  loadBuckets: 96,
  title: 160,
  startupError: 300,
  /** Жёсткий предел тела ответа (тест). */
  bytes: 64 * 1024,
} as const;

export const homeSections = ['product', 'architecture', 'design', 'development'] as const;
export type HomeSection = (typeof homeSections)[number];

/** Раздел этапа подготовки: этапы дизайна — один раздел. */
const sectionOfStage: Record<string, HomeSection> = {
  product: 'product',
  architecture: 'architecture',
  references: 'design',
  concept: 'design',
  design: 'design',
  development: 'development',
};
const prepSources = new Set<AttentionItem['source']>([
  'prep-question',
  'prep-answer-pending',
  'prep-stage',
  'prep-rework',
]);

/**
 * Раздел карточки центра внимания. Единственная точка классификации: когда
 * карточка несёт свой раздел (`section`), берётся он. До того — временное
 * правило: карточки подготовки — по этапу своей ссылки, остальные
 * (вопросы исполнителей и все источники движка) — разработка.
 */
export function sectionOf(card: AttentionItem): HomeSection {
  const own = (card as AttentionItem & { section?: unknown }).section;
  if (typeof own === 'string' && (homeSections as readonly string[]).includes(own))
    return own as HomeSection;
  if (prepSources.has(card.source)) {
    const stage = new URL(card.subject.href, 'http://home.invalid').searchParams.get('stage');
    return sectionOfStage[stage ?? ''] ?? 'product';
  }
  return 'development';
}

/** Вид вопроса раздела по источнику карточки; не вопрос — undefined. */
function questionKind(card: AttentionItem): HomeQuestion['kind'] | undefined {
  if (card.actor !== 'operator') return undefined;
  switch (card.source) {
    case 'prep-question':
      return 'prep-question';
    case 'input':
      return 'input';
    case 'stand-in':
      return 'stand-in';
    case 'discussion-needs-answer':
      return 'discussion';
    default:
      return undefined;
  }
}

export interface HomeQuestion {
  id: string;
  kind: 'prep-question' | 'owner-decision' | 'input' | 'stand-in' | 'discussion';
  title: string;
  since: string;
  href: string;
  /** Вариант, который рекомендует ведущий (подпись варианта). */
  recommended?: string;
}
export interface SectionQuestions {
  open: number;
  unread: number;
  /** Ответы оператора, которые ведущий ещё не превратил в решение. */
  answeredPendingLead: number;
  items: HomeQuestion[];
  more: boolean;
}
type StageState =
  'absent' | 'draft' | 'in-review' | 'changes-requested' | 'approved' | 'stale' | 'not-applicable';
export interface HomeFact {
  label: string;
  value: number | string;
}
export interface PreparationSection {
  state: StageState;
  revision?: number;
  approvedAt?: string;
  decidedBy?: 'operator';
  facts: HomeFact[];
  questions: SectionQuestions;
  href: string;
  design?: { steps: { key: 'references' | 'concept' | 'design'; state: StageState }[] };
}
export type DevelopmentState =
  'not-allowed' | 'setting-up' | 'running' | 'idle' | 'paused' | 'blocked';
export interface DevelopmentSection {
  state: DevelopmentState;
  blocker?: string;
  boards: {
    live: number;
    closed: number;
    accepted: number;
    byPhase: Partial<Record<BoardPhase, number>>;
    top: { id: string; title: string; phase: BoardPhase; href: string }[];
  };
  jobs: {
    running: number;
    waiting: number;
    failed: number;
    top: {
      kind: WorkflowJob['kind'];
      id: string;
      title: string;
      stage: number;
      status: WorkflowJob['status'];
      href: string;
    }[];
  };
  queue: {
    paused: boolean;
    reason?: string;
    hint?: string;
    ready: number;
    blocked: number;
    waitingInput: number;
    drafts: number;
    quiet: number;
  };
  runningNow: {
    taskId: string;
    title: string;
    roleTitle?: string;
    phase: string;
    model?: string;
    attempt: number;
    startedAt: string;
    href: string;
  }[];
  runningTotal: number;
  waitsOn: {
    operator: { active: number; unread: number };
    lead: { active: number; unread: number };
    topWaiting?: { id: string; title: string; waiting: number; href: string };
  };
  questions: SectionQuestions;
  href: string;
}
export interface HomeView {
  generatedAt: string;
  revision: number;
  shell: 'bootstrap' | 'preparation' | 'development';
  /**
   * Подготовка ведётся в панели. Без неё (разработка без подготовки) плитки
   * продукта и архитектуры ведут на карту продукта и контракты.
   */
  preparation: boolean;
  engineConnected: boolean;
  startupError?: string;
  change?: { id: string; key: string; title: string; phase: string };
  sections: {
    product: PreparationSection;
    architecture: PreparationSection;
    design: PreparationSection;
    development: DevelopmentSection;
  };
  progress?: HomeProgress;
  harness?: HomeHarness;
  /** Экран внимания этой оболочки (кто действует — `&who=`). */
  links: { attention: string };
  attention: {
    active: number;
    unread: number;
    /** Карточки по разделам (`sectionOf`): сумма равна `active`. */
    bySection: Record<HomeSection, { operator: number; lead: number; unread: number }>;
    /** Центр внимания перечислил не все карточки: разделы считают перечисленные. */
    truncated?: number;
  };
}

/** Ход работ: релизы, задачи, ChangeSet и покрытие (медленный ярус). */
export interface HomeProgress {
  releases: {
    id: string;
    title: string;
    tasks: number;
    done: number;
    failed: number;
    criteria: number;
    readiness: 'unplanned' | 'in-progress' | 'failed' | 'done';
  }[];
  releasesTotal: number;
  tasks: { total: number; done: number; remaining: number; failed: number; cancelled: number };
  changeSets: {
    total: number;
    accepted: number;
    verifying: number;
    failed: number;
    latest?: {
      id: string;
      title: string;
      status: 'accepted' | 'verifying' | 'failed' | 'open';
      href: string;
    };
  };
  /** Карта продукта: расчёт медленного яруса, не старше `asOf` + 30 с. */
  coverage?:
    | {
        available: true;
        releaseId: string;
        complete: boolean;
        accepted: boolean;
        issueCount: number;
        unconfirmed: number;
        deferred: number;
        asOf: string;
        href: string;
      }
    | { available: false; reason: string; asOf: string; href: string };
  href: string;
}
export type BudgetState = 'within' | 'exceeded' | 'undetermined';
/** Исполнение: попытки, проверки, сбои, бюджет и здоровье сервера. */
export interface HomeHarness {
  version: string;
  concurrency: number;
  active: number;
  attempts24h: { total: number; failed: number; byKind: Record<string, number> };
  /** Проверки попыток за 24 ч (медленный ярус); у отказавших — первые пять. */
  gates?: {
    failing: { gate: string; failed: number; passed: number }[];
    total: number;
    asOf: string;
  };
  /** Нагрузка агентов за сутки (медленный ярус). */
  load?: HomeLoad;
  failures: { tasks: number; recoveries: number; quiet: number };
  budget?: {
    state: BudgetState;
    /** Область, которая держит работу (или общая): workspace, доска, задача. */
    scope: string;
    limitUsd?: number;
    limitMs?: number;
    spentMs?: number;
    spentUsd: number;
    unknownCalls: number;
    complete: boolean;
    exceeded: number;
    total: number;
    reason?: string;
    asOf: string;
  };
  usage?: { calls: number; knownCostUsd: number; unknownCalls: number; asOf: string };
  health: {
    journalError?: string;
    configDrift?: string;
    configPending?: string;
    loopStalls1h: number;
    clockJumps1h: number;
    lead: { present: boolean; lastActivityAt: string | null };
  };
  href: string;
  budgetHref: string;
}
/** Исход попытки на графике нагрузки. */
export type LoadOutcome = 'running' | 'succeeded' | 'failed' | 'interrupted';
/**
 * Нагрузка агентов за сутки: по интервалу `bucketMs` — пик одновременно
 * идущих попыток и их исходы в момент пика; по часу — начатые попытки и
 * сбои среди них. Размер постоянный: не больше `HOME_LIMITS.loadBuckets`
 * интервалов, сколько бы попыток ни было.
 */
export interface HomeLoad {
  from: string;
  to: string;
  bucketMs: number;
  /** Пик в интервале по исходам: [идёт, принята, сбой, прервана]. */
  peaks: [number, number, number, number][];
  /** Начатые попытки по часам: [всего, со сбоем]. */
  hourly: [number, number][];
  /** Попыток, идущих в момент расчёта (`asOf`). */
  current: number;
  asOf: string;
}
/** Медленный ярус главной: считается не чаще раза в 30 с (`minAgeMs`). */
export interface HomeSlow {
  asOf: string;
  load: HomeLoad;
  coverage?: HomeProgress['coverage'];
  gates: NonNullable<HomeHarness['gates']>;
  budget?: HomeHarness['budget'];
  usage?: HomeHarness['usage'];
  /**
   * Разрывы цикла за час — точным подсчётом по времени журнала (без окна
   * последних записей), поэтому в медленном ярусе.
   */
  gaps?: { loopStalls1h: number; clockJumps1h: number };
}

export interface HomeContext {
  /** Замороженный снимок версии (`Store.view`). */
  state: Readonly<DevContourState>;
  h: DevContour | undefined;
  /** Активный центр внимания без фильтра той же версии данных. */
  attention: AttentionView;
  revision: number;
  now: number;
  startupError?: string;
  /**
   * Недавние события: `scheduler.error` для причины остановки очереди,
   * `server.loop-stalled` и `server.clock-jump` — для здоровья сервера.
   */
  events?: AuditEvent[];
  /** Медленный ярус (покрытие, проверки, бюджет, расход), посчитанный отдельно. */
  slow?: HomeSlow;
  /** Состояние процесса вне базы: сбой журнала, расхождение config.json, применение. */
  process?: { journalError?: string; configDrift?: string };
  /** Отметка обращения ведущего (`leadActivityMark`). */
  leadMark?: string | null;
}

const clip = (text: string, max: number = HOME_LIMITS.title) =>
  text.length > max ? text.slice(0, max - 1) + '…' : text;

/** Вопросы раздела: число, непрочитанные, первые `HOME_LIMITS.questions`. */
function questionsOf(cards: AttentionItem[]): SectionQuestions {
  const asked = cards.flatMap((card) => {
    const kind = questionKind(card);
    return kind ? [{ card, kind }] : [];
  });
  const items = asked.slice(0, HOME_LIMITS.questions).map(({ card, kind }): HomeQuestion => {
    const recommended = card.actions
      .flatMap((a) => (a.kind === 'domain' ? (a.choices ?? []) : []))
      .find((c) => c.recommended)?.label;
    return {
      id: card.id,
      kind,
      // Заголовок вопроса ведущего общий («Вопрос ведущего агента по …»):
      // плитке нужен сам вопрос.
      title: clip(kind === 'prep-question' && card.reason ? card.reason : card.title),
      since: card.since,
      href: card.subject.href,
      ...(recommended ? { recommended: clip(recommended) } : {}),
    };
  });
  return {
    open: asked.length,
    unread: asked.filter(({ card }) => card.state.unread).length,
    answeredPendingLead: cards.filter((c) => c.source === 'prep-answer-pending').length,
    items,
    more: asked.length > items.length,
  };
}

type Revision = {
  number: number;
  status: 'draft' | 'in-review' | 'approved' | 'changes-requested';
  decision?: { actor: 'operator'; at: string };
};
/** Состояние этапа по последней редакции и её актуальности. */
function stageState(revisions: readonly Revision[] | undefined, fresh = true): StageState {
  const latest = revisions?.at(-1);
  if (!latest) return 'absent';
  if (latest.status !== 'approved') return latest.status;
  return fresh ? 'approved' : 'stale';
}
function stageFields(revisions: readonly Revision[] | undefined, fresh = true) {
  const latest = revisions?.at(-1);
  const approved = revisions?.findLast((r) => r.status === 'approved');
  return {
    state: stageState(revisions, fresh),
    ...(latest ? { revision: latest.number } : {}),
    ...(approved?.decision
      ? { approvedAt: approved.decision.at, decidedBy: approved.decision.actor }
      : {}),
  };
}
const stageHref = (change: ProductChange | undefined, stage: string) =>
  hrefs.preparation(change?.id, stage);

function preparationSections(
  change: ProductChange | undefined,
  fresh: { architecture: boolean; references: boolean; concept: boolean; design: boolean },
  bySection: Record<HomeSection, AttentionItem[]>,
  contracts: number | undefined,
) {
  const product = change?.product.at(-1)?.content;
  const architecture = change?.architecture.at(-1)?.content;
  const references = change?.references?.at(-1);
  const concept = change?.concept?.at(-1)?.content;
  const design = change?.design?.at(-1)?.content;
  // Отказ от дизайна действует, пока референсы относятся к текущей
  // архитектуре: устаревший отказ — снова вопрос, а не «не применяется».
  const notApplicable =
    references?.status === 'approved' && !references.content.applicable && fresh.references;
  const steps = (['references', 'concept', 'design'] as const).map((key) => ({
    key,
    state:
      key !== 'references' && notApplicable
        ? ('not-applicable' as const)
        : stageState(change?.[key], fresh[key]),
  }));
  const pending = steps.find((s) => s.state !== 'approved' && s.state !== 'not-applicable');
  // Дизайн — первый неутверждённый шаг (без референсов — «нет»).
  const designState: StageState = notApplicable ? 'not-applicable' : (pending?.state ?? 'approved');
  const diagrams = architecture
    ? [architecture.c1, architecture.c2, architecture.c3.length ? architecture.c3 : undefined]
        .map((d, i) => (d ? `C${i + 1}` : ''))
        .filter(Boolean)
        .join(' ')
    : '';
  return {
    product: {
      ...stageFields(change?.product),
      facts: product
        ? [
            { label: 'Фичи', value: product.features.length },
            { label: 'Релизы', value: product.releases.length },
            { label: 'Персоны', value: product.personas.length },
            { label: 'Каналы', value: product.channels.length },
            { label: 'Исключения', value: product.exclusions.length },
          ]
        : [],
      questions: questionsOf(bySection.product),
      href: stageHref(change, 'product'),
    },
    architecture: {
      ...stageFields(change?.architecture, fresh.architecture),
      facts: [
        ...(architecture
          ? [
              { label: 'Стек', value: architecture.stack.length },
              { label: 'Решения', value: architecture.decisions.length },
              { label: 'Риски', value: architecture.risks.length },
              ...(diagrams ? [{ label: 'Диаграммы', value: diagrams }] : []),
            ]
          : []),
        // Контракты движка — тоже архитектура (до setup их нет).
        ...(contracts !== undefined ? [{ label: 'Контракты', value: contracts }] : []),
      ].slice(0, HOME_LIMITS.facts),
      questions: questionsOf(bySection.architecture),
      href: stageHref(change, 'architecture'),
    },
    design: {
      ...stageFields(change?.design, fresh.design),
      state: designState,
      facts: [
        ...(references ? [{ label: 'Референсы', value: references.content.items.length }] : []),
        ...(concept ? [{ label: 'Эскизы', value: concept.sketches.length }] : []),
        ...(design
          ? [
              { label: 'Токены', value: design.tokens.length },
              { label: 'Палитра', value: design.palette.length },
            ]
          : []),
      ],
      questions: questionsOf(bySection.design),
      href: stageHref(change, pending?.key ?? 'design'),
      design: { steps },
    },
  } satisfies Record<'product' | 'architecture' | 'design', PreparationSection>;
}

const LIVE_PHASES: readonly BoardPhase[] = ['running', 'failed', 'acceptance', 'queued', 'draft'];

function development(
  ctx: HomeContext,
  prep: ReturnType<typeof Preparation.statusOf>,
  cards: AttentionItem[],
): DevelopmentSection {
  const { state, h, attention } = ctx;
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const phases = state.boards.map((b) => {
    const own = [...new Set(b.revisions.flatMap((r) => r.taskIds))].flatMap((id) => {
      const t = byId.get(id);
      return t ? [t] : [];
    });
    return { board: b, phase: boardPhase(b, own) };
  });
  const byPhase: Partial<Record<BoardPhase, number>> = {};
  for (const { phase } of phases) byPhase[phase] = (byPhase[phase] ?? 0) + 1;
  const live = phases
    .filter((p) => LIVE_PHASES.includes(p.phase))
    .map((p, i) => ({ ...p, i }))
    // Идущие и упавшие — первыми, затем новые.
    .sort((a, b) => LIVE_PHASES.indexOf(a.phase) - LIVE_PHASES.indexOf(b.phase) || b.i - a.i);
  const boardTitle = new Map(state.boards.map((b) => [b.id, b.title]));
  const changeSetTitle = new Map(state.changeSets.map((c) => [c.id, c.title]));

  // Заданиям плитки нужны предмет, стадия и статус: список без вида задания
  // (ожиданий и свежести входа), который втрое дороже на большой истории.
  const workflow = h && new LeadWorkflow(h);
  const jobs = workflow
    ? [undefined, ...repositories(h.config).map((r) => r.id)].flatMap((owner) =>
        workflow.list(owner),
      )
    : [];
  // Задание предмета — последнее по времени: прежние упавшие уже сменены.
  const latest = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) {
    const key = `${j.kind}:${j.id}`;
    const seen = latest.get(key);
    if (!seen || seen.startedAt <= j.startedAt) latest.set(key, j);
  }
  // Упавшее задание принятой доски или принятого ChangeSet уже не держит
  // работу: его предмет закрыт другим путём (вручную).
  const accepted = (j: WorkflowJob) =>
    j.kind === 'board'
      ? state.boards.find((b) => b.id === j.id)?.revisions.at(-1)?.status === 'accepted'
      : Boolean(state.changeSets.find((c) => c.id === j.id)?.acceptance);
  const current = [...latest.values()].filter((j) => j.status !== 'failed' || !accepted(j));
  const rank = (s: WorkflowJob['status']) =>
    s === 'running' ? 0 : s === 'queued' ? 1 : s === 'failed' ? 2 : 3;
  const shownJobs = current
    .filter((j) => rank(j.status) < 3)
    .sort((a, b) => rank(a.status) - rank(b.status) || b.startedAt.localeCompare(a.startedAt))
    .slice(0, HOME_LIMITS.jobs);

  const holds = h ? inputHolds(h) : new Map<string, string>();
  const queue = h ? queueStopOf(h, state, ctx.events ?? []) : undefined;
  const ready = h ? readyTasks(state, holds).length : 0;
  const active = state.runs.filter((r) => r.status === 'active');
  const roleTitle = (taskId: string) => {
    const task = byId.get(taskId);
    if (!task || !h) return undefined;
    return (
      h.config.repositories.find((x) => x.id === task.repositoryId)?.roles?.[task.role]?.title ??
      h.config.roles[task.role]?.title
    );
  };
  const topWaiting = attention.items
    .filter((i) => i.impact.waiting > 0)
    .sort((a, b) => b.impact.waiting - a.impact.waiting)[0];
  const open = state.tasks.filter((t) => t.status === 'ready' && !t.activeRunId).length;
  const failedTasks = state.tasks.filter((t) => t.status === 'failed').length;
  const failedJobs = current.filter((j) => j.status === 'failed');
  const verifying = state.changeSets.some((c) =>
    c.verifications.some((v) => v.status === 'active'),
  );

  let devState: DevelopmentState;
  let blocker: string | undefined;
  if (!h) {
    // Изменения независимы: setup разрешён, если готово хоть одно.
    devState = prep.enabled && prep.readyChanges.length ? 'setting-up' : 'not-allowed';
    blocker =
      devState === 'setting-up'
        ? (ctx.startupError ?? 'Настройка контура: движок разработки ещё не подключён')
        : prep.enabled
          ? prep.blocker || undefined
          : 'Подготовка не начата: опишите продукт';
  } else if (active.length || verifying || shownJobs.some((j) => j.status === 'running'))
    // Совместная проверка ChangeSet идёт без попыток задач, задание стоит queued.
    devState = 'running';
  else if (queue?.paused) {
    devState = queue.failed ? 'blocked' : 'paused';
    blocker = queue.stopReason;
  } else if (!ready && failedTasks) {
    // Очередь идёт, но выдавать нечего: работу держат упавшие задачи.
    devState = 'blocked';
    blocker = `Задачи с ошибкой: ${failedTasks}; зависимые от них не выдаются`;
  } else if (!ready && failedJobs.length && !current.some((j) => j.status === 'queued')) {
    // Задание ведущего остановлено окончательно, а предмет не принят.
    devState = 'blocked';
    blocker = `Задания ведущего остановлены: ${failedJobs.length}`;
  } else devState = 'idle';

  return {
    state: devState,
    ...(blocker ? { blocker: clip(blocker, HOME_LIMITS.startupError) } : {}),
    boards: {
      live: live.length,
      closed: (byPhase.closed ?? 0) + (byPhase.empty ?? 0),
      accepted: byPhase.accepted ?? 0,
      byPhase,
      top: live.slice(0, HOME_LIMITS.boards).map(({ board, phase }) => ({
        id: board.id,
        title: clip(board.title),
        phase,
        href: hrefs.board(board.id),
      })),
    },
    jobs: {
      running: current.filter((j) => j.status === 'running').length,
      waiting: current.filter((j) => j.status === 'queued').length,
      failed: current.filter((j) => j.status === 'failed').length,
      top: shownJobs.map((j) => ({
        kind: j.kind,
        id: j.id,
        title: clip((j.kind === 'board' ? boardTitle.get(j.id) : changeSetTitle.get(j.id)) ?? j.id),
        stage: j.stage,
        status: j.status,
        href: j.kind === 'board' ? hrefs.board(j.id) : hrefs.changeset(j.id),
      })),
    },
    queue: {
      paused: queue?.paused ?? state.paused,
      ...(queue?.stopReason ? { reason: clip(queue.stopReason, HOME_LIMITS.startupError) } : {}),
      ...(queue?.action ? { hint: clip(queue.action, HOME_LIMITS.startupError) } : {}),
      ready,
      blocked: Math.max(0, open - ready),
      waitingInput: holds.size,
      drafts: state.tasks.filter((t) => t.status === 'draft').length,
      quiet: quietAttempts(state, ctx.now).length,
    },
    runningNow: active.slice(0, HOME_LIMITS.runningNow).map((r) => {
      const role = roleTitle(r.taskId);
      return {
        taskId: r.taskId,
        title: clip(byId.get(r.taskId)?.title ?? r.taskId),
        ...(role ? { roleTitle: clip(role) } : {}),
        phase: r.phase,
        ...(r.model ? { model: clip(r.model) } : {}),
        attempt: r.attempt,
        startedAt: r.startedAt,
        href: hrefs.task(r.taskId),
      };
    }),
    runningTotal: active.length,
    waitsOn: {
      operator: attention.counts.byActor.operator,
      lead: attention.counts.byActor.lead,
      ...(topWaiting
        ? {
            topWaiting: {
              id: topWaiting.id,
              title: clip(topWaiting.title),
              waiting: topWaiting.impact.waiting,
              href: topWaiting.subject.href,
            },
          }
        : {}),
    },
    questions: questionsOf(cards),
    // Разработка внутри оболочки подготовки — с view=boards; без подготовки —
    // своя оболочка панели. Доска — первая показанная.
    // До подключения движка досок нет: ссылка — этап «Разработка» подготовки.
    href:
      !h && prep.enabled
        ? hrefs.preparation(prep.current?.id, 'development')
        : (prep.enabled ? '/?view=boards&tab=kanban' : '/?tab=kanban') +
          (live[0] ? `&board=${encodeURIComponent(live[0].board.id)}` : ''),
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Экран панели разработки в обеих оболочках (с подготовкой — `view=boards`). */
const devHref = (preparation: boolean, tab: string) =>
  (preparation ? '/?view=boards&tab=' : '/?tab=') + tab;

/** Ход работ по снимку версии; покрытие — из медленного яруса. */
function progressOf(
  ctx: HomeContext,
  prep: ReturnType<typeof Preparation.statusOf>,
  change: ProductChange | undefined,
): HomeProgress | undefined {
  const { state, h } = ctx;
  const releases = prep.enabled && prep.current ? prep.current.releases : [];
  if (!h && !releases.length) return undefined;
  const planned =
    change?.product.findLast((r) => r.status === 'approved') ?? change?.product.at(-1);
  const titles = new Map((planned?.content.releases ?? []).map((r) => [r.id, r.title]));
  const tasks = state.tasks;
  const done = tasks.filter((t) => t.status === 'done').length;
  const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
  const statusOf = (c: DevContourState['changeSets'][number]) =>
    c.acceptance
      ? ('accepted' as const)
      : c.verifications.some((v) => v.status === 'active')
        ? ('verifying' as const)
        : c.verifications.at(-1)?.status === 'failed'
          ? ('failed' as const)
          : ('open' as const);
  const sets = state.changeSets.map((c) => ({ c, status: statusOf(c) }));
  // Порядок массива после sync — по ключам, не по времени: последний — по createdAt.
  const latest = sets.reduce<(typeof sets)[number] | undefined>(
    (best, x) =>
      !best ||
      x.c.createdAt > best.c.createdAt ||
      (x.c.createdAt === best.c.createdAt && x.c.id > best.c.id)
        ? x
        : best,
    undefined,
  );
  const preparation = prep.enabled;
  return {
    releases: releases.slice(0, HOME_LIMITS.releases).map((r) => ({
      id: clip(r.id),
      title: clip(titles.get(r.id) ?? r.id),
      tasks: r.tasks,
      done: r.done,
      failed: r.failed,
      criteria: r.criteria,
      readiness: r.readiness,
    })),
    releasesTotal: releases.length,
    tasks: {
      total: tasks.length,
      done,
      remaining: tasks.length - done - cancelled,
      failed: tasks.filter((t) => t.status === 'failed').length,
      cancelled,
    },
    changeSets: {
      total: sets.length,
      accepted: sets.filter((x) => x.status === 'accepted').length,
      verifying: sets.filter((x) => x.status === 'verifying').length,
      failed: sets.filter((x) => x.status === 'failed').length,
      ...(latest
        ? {
            latest: {
              id: latest.c.id,
              title: clip(latest.c.title),
              status: latest.status,
              href: hrefs.changeset(latest.c.id),
            },
          }
        : {}),
    },
    ...(ctx.slow?.coverage ? { coverage: ctx.slow.coverage } : {}),
    href: devHref(preparation, 'progress'),
  };
}

/** Число событий типа за последний час (окно — недавний журнал). */
const lastHour = (events: readonly AuditEvent[], type: string, now: number) =>
  events.filter((e) => e.type === type && now - Date.parse(e.at) < HOUR_MS).length;

/** Момент в окне суток `[now − 24 ч, now)` — одно правило для всех рядов главной. */
const inDay = (at: number, now: number) => at >= now - DAY_MS && at < now;

/** Попытки за сутки по классу отказа: первые `failureKinds` классов, остальные — `other`. */
export function attemptsOf(runs: DevContourState['runs'], now: number) {
  const recent = runs.filter((r) => inDay(Date.parse(r.startedAt), now));
  const failed = recent.filter((r) => r.status === 'failed' || r.status === 'expired');
  const counts = new Map<string, number>();
  for (const r of failed) {
    const kind = r.failureKind ?? 'unknown';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const byKind = Object.fromEntries(sorted.slice(0, HOME_LIMITS.failureKinds));
  const rest = sorted.slice(HOME_LIMITS.failureKinds).reduce((sum, [, n]) => sum + n, 0);
  if (rest) byKind.other = (byKind.other ?? 0) + rest;
  return { total: recent.length, failed: failed.length, byKind };
}

function harnessOf(
  ctx: HomeContext,
  change: ProductChange | undefined,
  preparation: boolean,
  version: string,
): HomeHarness | undefined {
  const { state, h, now } = ctx;
  if (!h) return undefined;
  const events = ctx.events ?? [];
  const proc = ctx.process ?? {};
  // Применение конфигурации идёт (слот занят): то же правило, что у панели.
  const request = state.reconfigure;
  const keys = request && configApplyKeys(request.operation);
  const configPending =
    request && reconfigureSlotBusy(request)
      ? keys
        ? `Применяется config.json: ${keys.join(', ')}`
        : 'Применяется конфигурация после изменения контракта'
      : undefined;
  return {
    version,
    concurrency: h.config.concurrency,
    active: state.runs.filter((r) => r.status === 'active').length,
    attempts24h: attemptsOf(state.runs, now),
    ...(ctx.slow ? { gates: ctx.slow.gates, load: ctx.slow.load } : {}),
    failures: {
      tasks: state.tasks.filter((t) => t.status === 'failed').length,
      recoveries: state.tasks.filter(
        (t) => t.recovery && t.status !== 'done' && t.status !== 'cancelled',
      ).length,
      quiet: quietAttempts(state, now).length,
    },
    ...(ctx.slow?.budget ? { budget: ctx.slow.budget } : {}),
    ...(ctx.slow?.usage ? { usage: ctx.slow.usage } : {}),
    health: {
      ...(proc.journalError
        ? { journalError: clip(proc.journalError, HOME_LIMITS.startupError) }
        : {}),
      ...(proc.configDrift
        ? { configDrift: clip(proc.configDrift, HOME_LIMITS.startupError) }
        : {}),
      ...(configPending ? { configPending } : {}),
      ...(ctx.slow?.gaps ?? {
        loopStalls1h: lastHour(events, 'server.loop-stalled', now),
        clockJumps1h: lastHour(events, 'server.clock-jump', now),
      }),
      lead: leadPresence(change, state, now, ctx.leadMark ?? null),
    },
    href: devHref(preparation, 'settings'),
    budgetHref: devHref(preparation, 'overview'),
  };
}

const LOAD_BUCKET_MS = 15 * 60 * 1000;
const outcomeOf = (r: DevContourState['runs'][number]): number =>
  r.status === 'active'
    ? 0
    : r.status === 'succeeded'
      ? 1
      : r.status === 'failed' || r.status === 'expired'
        ? 2
        : 3;

/**
 * Нагрузка агентов за сутки до `now` (медленный ярус). Интервал попытки —
 * от начала до конца; идущая или без записанного конца (оборванная) — до
 * `now` либо до срока аренды, что раньше. Пик интервала — наибольшее число
 * одновременно идущих попыток в его начале или в момент начала любой из
 * них внутри интервала; исходы — у попыток, шедших в этот момент.
 */
export function loadOf(runs: DevContourState['runs'], now: number): Omit<HomeLoad, 'asOf'> {
  const buckets = HOME_LIMITS.loadBuckets;
  // Окно — ровно сутки до now: интервалы отсчитаны от now, последний
  // кончается в момент расчёта.
  const to = now;
  const from = to - buckets * LOAD_BUCKET_MS;
  const spans = runs.flatMap((r) => {
    const start = Date.parse(r.startedAt);
    if (!Number.isFinite(start) || start > now) return [];
    const finished = r.finishedAt ? Date.parse(r.finishedAt) : NaN;
    // Без записанного конца — до срока аренды (и у «идущей» попытки упавшего
    // controller); `until` — настоящий конец, `end` — он же, но не дальше now.
    const lease = r.leaseUntil > 0 ? r.leaseUntil : r.status === 'active' ? Infinity : start;
    const until = Number.isFinite(finished) ? finished : lease;
    const end = Math.min(now, until);
    return [{ start, end, until, outcome: outcomeOf(r) }];
  });
  const peaks: HomeLoad['peaks'] = [];
  for (let b = 0; b < buckets; b++) {
    const lo = from + b * LOAD_BUCKET_MS;
    const hi = lo + LOAD_BUCKET_MS;
    let best: [number, number, number, number] = [0, 0, 0, 0];
    let bestTotal = 0;
    if (lo < now) {
      const here = spans.filter((x) => x.start < hi && x.end > lo);
      const moments = [lo, ...here.map((x) => x.start).filter((t) => t > lo && t < hi)];
      for (const t of moments) {
        const split: [number, number, number, number] = [0, 0, 0, 0];
        for (const x of here) if (x.start <= t && x.end > t) split[x.outcome]++;
        const total = split[0] + split[1] + split[2] + split[3];
        if (total > bestTotal) {
          bestTotal = total;
          best = split;
        }
      }
    }
    peaks.push(best);
  }
  const hourly: HomeLoad['hourly'] = Array.from({ length: 24 }, () => [0, 0]);
  for (const r of runs) {
    const start = Date.parse(r.startedAt);
    if (!inDay(start, now)) continue;
    const hour = Math.floor((start - from) / (4 * LOAD_BUCKET_MS));
    hourly[hour][0]++;
    if (r.status === 'failed' || r.status === 'expired') hourly[hour][1]++;
  }
  // Идут в момент now: начаты не позже и кончатся (истечёт аренда) позже.
  const current = [0, 0, 0, 0] as [number, number, number, number];
  for (const x of spans) if (x.start <= now && x.until > now) current[x.outcome]++;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucketMs: LOAD_BUCKET_MS,
    peaks,
    hourly,
    // Идут в момент расчёта: не пик последнего интервала.
    current: current[0],
  };
}

/** Проверки попыток за сутки по gate: отказавшие первыми (медленный ярус). */
export function gatesOf(runs: DevContourState['runs'], now: number) {
  const rows = new Map<string, { gate: string; failed: number; passed: number }>();
  for (const run of runs) {
    // Попытка, кончившаяся раньше суток назад, свежих записей не несёт.
    if (run.finishedAt && Date.parse(run.finishedAt) < now - DAY_MS) continue;
    for (const e of run.evidence) {
      // Окно — по времени записи проверки, а не начала попытки.
      if (!inDay(Date.parse(e.createdAt), now)) continue;
      // Взятая из кандидата запись — не запуск; неприменимый gate — не результат.
      if (e.kind !== 'test' || e.reusedEvidence) continue;
      const row = rows.get(e.gate) ?? { gate: clip(e.gate), failed: 0, passed: 0 };
      row[e.passed ? 'passed' : 'failed'] += 1;
      rows.set(e.gate, row);
    }
  }
  return {
    failing: [...rows.values()]
      .filter((r) => r.failed > 0)
      .sort((a, b) => b.failed - a.failed || a.gate.localeCompare(b.gate))
      .slice(0, HOME_LIMITS.failingGates),
    total: rows.size,
  };
}

type Budgets = {
  budgets: {
    scope: { kind: 'task' | 'board' | 'workspace'; id?: string };
    state: BudgetState;
    limit: { usd?: number; timeMs?: number };
    reportedUsd: number;
    estimatedUsd: number;
    unknownCalls: number;
    unfinishedCalls: number;
    durationMs?: number;
    reason?: string;
  }[];
};
/** Бюджет плитки: исчерпанный или неопределённый — первым, иначе общий. */
export function budgetOf(overview: Budgets | undefined, asOf: string): HomeSlow['budget'] {
  if (!overview?.budgets.length) return undefined;
  const rank = (s: BudgetState) => (s === 'exceeded' ? 0 : s === 'undetermined' ? 1 : 2);
  const [b] = overview.budgets.toSorted(
    (x, y) =>
      rank(x.state) - rank(y.state) ||
      Number(y.scope.kind === 'workspace') - Number(x.scope.kind === 'workspace'),
  );
  return {
    state: b.state,
    scope: clip(
      b.scope.kind === 'workspace' ? 'workspace' : `${b.scope.kind} ${b.scope.id ?? ''}`.trim(),
    ),
    ...(b.limit.usd !== undefined ? { limitUsd: b.limit.usd } : {}),
    // Предел по времени: бюджет только по времени иначе читался бы как «$0».
    ...(b.limit.timeMs !== undefined ? { limitMs: b.limit.timeMs } : {}),
    ...(b.durationMs !== undefined ? { spentMs: b.durationMs } : {}),
    spentUsd: b.reportedUsd + b.estimatedUsd,
    unknownCalls: b.unknownCalls,
    complete: b.unknownCalls === 0 && b.unfinishedCalls === 0,
    exceeded: overview.budgets.filter((x) => x.state === 'exceeded').length,
    total: overview.budgets.length,
    ...(b.reason ? { reason: clip(b.reason, HOME_LIMITS.startupError) } : {}),
    asOf,
  };
}

/** Покрытие релиза по карте продукта (`IntentService.productView`). */
export function coverageOf(
  view: ProductView | { error: string } | undefined,
  asOf: string,
  preparation: boolean,
): HomeSlow['coverage'] {
  if (!view) return undefined;
  const href = devHref(preparation, 'product');
  if ('error' in view)
    return { available: false, reason: clip(view.error, HOME_LIMITS.startupError), asOf, href };
  if (!view.available)
    return { available: false, reason: clip(view.reason, HOME_LIMITS.startupError), asOf, href };
  return {
    available: true,
    releaseId: clip(view.releaseId),
    complete: view.coverageComplete,
    accepted: view.releaseAccepted,
    issueCount: view.issues.length,
    unconfirmed: view.unconfirmedScenarios.length,
    deferred: view.deferredScenarios.length,
    asOf,
    href,
  };
}

/**
 * Медленный ярус главной над снимком версии: проверки за сутки, бюджет,
 * расход и покрытие карты продукта. Карта, бюджет и расход посчитаны
 * вызывающим (они читают Git, записи расхода и движок исполнения).
 */
export function homeSlowView(input: {
  state: Readonly<DevContourState>;
  now: number;
  preparation: boolean;
  product?: ProductView | { error: string };
  budgets?: Budgets;
  usage?: { calls: number; knownCostUsd: number; unknownCalls: number };
  /** События разрывов цикла не старше часа (`Store.eventsSince`). */
  gapEvents?: readonly AuditEvent[];
}): HomeSlow {
  const asOf = new Date(input.now).toISOString();
  const coverage = coverageOf(input.product, asOf, input.preparation);
  const budget = budgetOf(input.budgets, asOf);
  return {
    asOf,
    load: { ...loadOf(input.state.runs, input.now), asOf },
    ...(coverage ? { coverage } : {}),
    gates: { ...gatesOf(input.state.runs, input.now), asOf },
    ...(budget ? { budget } : {}),
    ...(input.gapEvents
      ? {
          gaps: {
            loopStalls1h: lastHour(input.gapEvents, 'server.loop-stalled', input.now),
            clockJumps1h: lastHour(input.gapEvents, 'server.clock-jump', input.now),
          },
        }
      : {}),
    ...(input.usage
      ? {
          usage: {
            calls: input.usage.calls,
            knownCostUsd: input.usage.knownCostUsd,
            unknownCalls: input.usage.unknownCalls,
            asOf,
          },
        }
      : {}),
  };
}

/** Главная по снимку версии и центру внимания той же версии. */
export function homeView(ctx: HomeContext): HomeView {
  const { state, h, attention } = ctx;
  const prep = Preparation.statusOf(state, undefined, { content: false });
  const change = prep.enabled
    ? state.preparation?.changes.find((c) => c.id === prep.current?.id)
    : undefined;
  const bySection = Object.fromEntries(
    homeSections.map((s) => [s, [] as AttentionItem[]]),
  ) as Record<HomeSection, AttentionItem[]>;
  for (const card of attention.items) bySection[sectionOf(card)].push(card);
  const counts = Object.fromEntries(
    homeSections.map((s) => [
      s,
      {
        operator: bySection[s].filter((c) => c.actor === 'operator').length,
        lead: bySection[s].filter((c) => c.actor === 'lead').length,
        unread: bySection[s].filter((c) => c.state.unread).length,
      },
    ]),
  ) as HomeView['attention']['bySection'];
  const fresh =
    prep.enabled && prep.current
      ? prep.current.binding.fresh
      : { architecture: false, references: false, concept: false, design: false };
  const shell: HomeView['shell'] = h ? 'development' : change ? 'preparation' : 'bootstrap';
  const prepared = preparationSections(
    change,
    fresh,
    bySection,
    h ? state.contracts.length : undefined,
  );
  // Без подготовки в панели этапов нет: продукт — карта продукта, архитектура —
  // контракты движка, дизайн — обзор.
  if (h && !prep.enabled) {
    prepared.product.href = devHref(false, 'product');
    prepared.architecture.href = hrefs.contracts().replace('view=boards&', '');
    prepared.design.href = devHref(false, 'overview');
  }
  const sections = {
    ...prepared,
    development: development(ctx, prep, bySection.development),
  };
  // Центр внимания перечислил не все карточки: вопросы разделов неполны, и
  // каждый раздел зовёт в центр внимания («ещё»).
  if (attention.truncated)
    for (const section of Object.values(sections)) section.questions.more = true;
  const progress = progressOf(ctx, prep, change);
  const harness = harnessOf(ctx, change, prep.enabled, harnessVersion);
  return {
    generatedAt: new Date(ctx.now).toISOString(),
    revision: ctx.revision,
    shell,
    engineConnected: Boolean(h),
    ...(ctx.startupError ? { startupError: clip(ctx.startupError, HOME_LIMITS.startupError) } : {}),
    ...(change && prep.enabled
      ? {
          change: {
            id: change.id,
            key: change.key,
            title: clip(change.title),
            phase: prep.phase,
          },
        }
      : {}),
    preparation: prep.enabled,
    sections,
    ...(progress ? { progress } : {}),
    ...(harness ? { harness } : {}),
    links: { attention: prep.enabled ? '/?view=attention' : '/?tab=attention' },
    attention: {
      active: attention.counts.active,
      unread: attention.counts.unread,
      bySection: counts,
      ...(attention.truncated ? { truncated: attention.truncated.count } : {}),
    },
  };
}
