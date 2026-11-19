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
  engineConnected: boolean;
  startupError?: string;
  change?: { id: string; key: string; title: string; phase: string };
  sections: {
    product: PreparationSection;
    architecture: PreparationSection;
    design: PreparationSection;
    development: DevelopmentSection;
  };
  attention: {
    active: number;
    unread: number;
    /** Карточки по разделам (`sectionOf`): сумма равна `active`. */
    bySection: Record<HomeSection, { operator: number; lead: number; unread: number }>;
    /** Центр внимания перечислил не все карточки: разделы считают перечисленные. */
    truncated?: number;
  };
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
  /** События `scheduler.error` для причины остановки очереди. */
  events?: AuditEvent[];
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
  change ? hrefs.preparation(change.id, stage) : `/?stage=${stage}`;

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
  } else if (active.length || shownJobs.some((j) => j.status === 'running')) devState = 'running';
  else if (queue?.paused) {
    devState = queue.failed ? 'blocked' : 'paused';
    blocker = queue.stopReason;
  } else if (!ready && failedTasks) {
    // Очередь идёт, но выдавать нечего: работу держат упавшие задачи.
    devState = 'blocked';
    blocker = `Задачи с ошибкой: ${failedTasks}; зависимые от них не выдаются`;
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
        ...(role ? { roleTitle: role } : {}),
        phase: r.phase,
        ...(r.model ? { model: r.model } : {}),
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
        ? hrefs.preparation(prep.current?.id, 'development').replace(/^\/$/, '/?stage=development')
        : (prep.enabled ? '/?view=boards&tab=kanban' : '/?tab=kanban') +
          (live[0] ? `&board=${encodeURIComponent(live[0].board.id)}` : ''),
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
  const sections = {
    ...preparationSections(change, fresh, bySection, h ? state.contracts.length : undefined),
    development: development(ctx, prep, bySection.development),
  };
  // Центр внимания перечислил не все карточки: вопросы разделов неполны, и
  // каждый раздел зовёт в центр внимания («ещё»).
  if (attention.truncated)
    for (const section of Object.values(sections)) section.questions.more = true;
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
    sections,
    attention: {
      active: attention.counts.active,
      unread: attention.counts.unread,
      bySection: counts,
      ...(attention.truncated ? { truncated: attention.truncated.count } : {}),
    },
  };
}
