import type { AuditEvent, DevContourState } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import type { ProductChange } from '../core/preparation-model.ts';
import { Preparation } from '../core/preparation.ts';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import { closureOf, parkedBoards, parkedHold, type BoardPark } from '../core/board-hold.ts';
import { boardPhase, heldBaseOf, type BoardPhase } from '../core/work-status.ts';
import { readyTasks } from '../core/graph.ts';
import { repositories } from '../core/repositories.ts';
import {
  attentionSections,
  type AttentionItem,
  type AttentionSection,
} from '../core/attention-model.ts';
import {
  maskUrlCredentials,
  questionSummary,
  recommendedOf,
  type QuestionSummarySection,
} from '../core/owner-questions.ts';
import type { AttentionView } from './attention.ts';
import { inputHolds } from './input.ts';
import { queueStopOf, quietAttempts } from './queue-stop.ts';
import { hrefs } from './panel-links.ts';
import { leadPresence } from './quick-view.ts';
import { harnessVersion } from '../harness/index.ts';
import { configApplyKeys, reconfigureSlotBusy } from '../runner/reconfigure.ts';
import type { ProductView } from '../core/product-map.ts';
import { knownCost, type UsageRecord } from '../core/usage.ts';

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
  /** Областей бюджета строками плитки «Исполнение». */
  budgetScopes: 4,
  /** Релизов карты для подсчёта готовых (в ответ не входят). */
  mapReleaseIds: 200,
  /** Дней графика расхода. */
  spendDays: 7,
  title: 160,
  startupError: 300,
  /** Жёсткий предел тела ответа (тест). */
  bytes: 64 * 1024,
} as const;

export const homeSections = attentionSections;
export type HomeSection = AttentionSection;

/**
 * Раздел карточки центра внимания — её собственный (`section`): вопросы и
 * ответы подготовки — раздел вопроса, этапы — по этапу, быстрый маршрут —
 * продукт, источники движка и вопросы исполнителей — разработка. Главная
 * своих правил классификации не держит.
 */
export const sectionOf = (card: AttentionItem): HomeSection => card.section;

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
  /** Ответы оператора, которые ведущий ещё не превратил в решение (сводка вопросов). */
  answeredPendingLead: number;
  /** Черновики, которые держат вопросы владельцу раздела (сводка вопросов). */
  blockedTasks: number;
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
    /**
     * Отложенные доски (`board_park`, F90): в счёте живых, но их черновик —
     * не работа, которая ждёт решения; в списке — после остальных.
     */
    parked: number;
    top: {
      id: string;
      title: string;
      phase: BoardPhase;
      href: string;
      /** Доска отложена: причина и срок отметки, как в `host.parked`. */
      parked?: { reason: string; until?: string; by: BoardPark['by'] };
    }[];
  };
  jobs: {
    running: number;
    waiting: number;
    /** Упавшие задания, которые держат работу: без закрытых и отложенных. */
    failed: number;
    /**
     * Упавшие задания, остановка которых уже не шаг (F90): закрыто
     * (`workflow_close`) или доска отложена — как в `host.next`.
     */
    closed: number;
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
    /**
     * Карточки по разделам — `counts.bySection` центра внимания: оператора,
     * ведущего и непрочитанные карточки оператора; сумма operator и lead
     * равна `active`, в том числе при усечённом списке.
     */
    bySection: Record<HomeSection, { operator: number; lead: number; unread: number }>;
    /** Центр внимания перечислил не все карточки: списки вопросов разделов неполны. */
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
    /**
     * Единица хода: задачи утверждённой постановки или фичи карты продукта
     * (без подготовки в панели). `measured: false` — карта считает только
     * текущий релиз: у остальных известна лишь приёмка.
     */
    unit?: 'tasks' | 'features';
    measured?: false;
  }[];
  releasesTotal: number;
  /**
   * Готовых релизов среди всех (не только показанных); у карты продукта
   * релизы за пределом списка не считаются готовыми.
   */
  releasesDone: number;
  /** Откуда релизы: утверждённая постановка или карта продукта (медленный ярус). */
  releasesFrom?: 'preparation' | 'product-map';
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
        /** Релизы карты; фичи посчитаны только у текущего (`releaseId`). */
        /**
         * Релизы карты. У текущего (`releaseId`): фичи в объёме, доказанные и
         * начатые; его приёмка — `accepted` покрытия, а не прежний ChangeSet.
         */
        releases?: {
          id: string;
          title: string;
          features?: number;
          done?: number;
          started?: number;
        }[];
        releasesTotal?: number;
        asOf: string;
        href: string;
      }
    | { available: false; reason: string; asOf: string; href: string };
  href: string;
}
export type BudgetState = 'within' | 'exceeded' | 'undetermined';
export interface BudgetScope {
  state: BudgetState;
  scope: string;
  /** Подпись области для человека: «workspace», «задачи «…»», «доски «…»». */
  label?: string;
  limitUsd?: number;
  limitMs?: number;
  spentMs?: number;
  spentUsd: number;
  unknownCalls: number;
  reason?: string;
}
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
  /** Записи проверок по часам за сутки (медленный ярус). */
  gateTrend?: HomeGateTrend;
  /** Расход по дням за неделю против предела workspace (медленный ярус). */
  spend?: HomeSpend;
  failures: { tasks: number; recoveries: number; quiet: number };
  budget?: {
    state: BudgetState;
    /** Область, которая держит работу (или общая): workspace, доска, задача. */
    scope: string;
    label?: string;
    limitUsd?: number;
    limitMs?: number;
    spentMs?: number;
    spentUsd: number;
    unknownCalls: number;
    complete: boolean;
    exceeded: number;
    total: number;
    reason?: string;
    /**
     * Строка на область бюджета: держащие работу — первыми, до
     * `HOME_LIMITS.budgetScopes`; `reason` — сырой текст расчёта для
     * «подробнее».
     */
    scopes: BudgetScope[];
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
/**
 * Записи проверок по часам за сутки `[now − 24 ч, now)`: [прошло, отказ,
 * взято из кандидата]. 24 интервала, сколько бы записей ни было.
 */
export interface HomeGateTrend {
  from: string;
  to: string;
  hourly: [number, number, number][];
  asOf: string;
}
/**
 * Расход вызовов моделей по дням (полночь по часам сервера), последние
 * `HOME_LIMITS.spendDays` дней. Сумма — известная оценка (сообщённая
 * провайдером и по тарифу); вызовы с неизвестной стоимостью посчитаны
 * отдельно: при них сумма — нижняя граница.
 */
export interface HomeSpend {
  /** `start` — момент начала дня, `date` — его календарная дата (YYYY-MM-DD) на сервере. */
  days: { start: string; date: string; usd: number; calls: number; unknown: number }[];
  /** Известная оценка до первого дня окна. */
  beforeUsd: number;
  /** Вызовы с неизвестной стоимостью до окна. */
  beforeUnknown: number;
  /** Денежный предел workspace; другого предела у суммы по всем вызовам нет. */
  limitUsd?: number;
  asOf: string;
}
/** Медленный ярус главной: считается не чаще раза в 30 с (`minAgeMs`). */
export interface HomeSlow {
  asOf: string;
  load: HomeLoad;
  gateTrend: HomeGateTrend;
  spend?: HomeSpend;
  coverage?: HomeProgress['coverage'];
  gates: NonNullable<HomeHarness['gates']>;
  budget?: HomeHarness['budget'];
  usage?: HomeHarness['usage'];
  /**
   * Разрывы цикла за час — точным подсчётом по времени журнала (без окна
   * последних записей), поэтому в медленном ярусе.
   */
  gaps?: { loopStalls1h: number; clockJumps1h: number };
  /**
   * Все релизы карты (до `HOME_LIMITS.mapReleaseIds`) и текущий — для числа
   * готовых. Только сервер: в ответ не входит.
   */
  mapReleases?: { ids: string[]; current: string };
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
  /** Маска текстов центра внимания (`AttentionService.redactor`). */
  redact?: (text: string) => string;
}

/** Вопросы владельцу этого снимка: счётчики сводки и вопрос по id карточки. */
interface OwnerQuestions {
  summary: Record<HomeSection, QuestionSummarySection>;
  recommended: (card: AttentionItem) => string | undefined;
}

const clip = (text: string, max: number = HOME_LIMITS.title) =>
  text.length > max ? text.slice(0, max - 1) + '…' : text;

/**
 * Вопросы раздела: число, непрочитанные, первые `HOME_LIMITS.questions`.
 * Ответы без решения ведущего, удержанные черновики и рекомендованный вариант
 * вопроса владельцу — по той же сводке, что `GET /api/questions/summary`.
 */
function questionsOf(
  cards: AttentionItem[],
  owner: OwnerQuestions,
  section: HomeSection,
): SectionQuestions {
  const asked = cards.flatMap((card) => {
    const kind = questionKind(card);
    return kind ? [{ card, kind }] : [];
  });
  const items = asked.slice(0, HOME_LIMITS.questions).map(({ card, kind }): HomeQuestion => {
    const recommended =
      kind === 'prep-question'
        ? owner.recommended(card)
        : card.actions
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
    answeredPendingLead: owner.summary[section].answeredPendingLead,
    blockedTasks: owner.summary[section].blockedTasks,
    items,
    more: asked.length > items.length,
  };
}

/** Вопросы владельцу снимка: сводка без записей и рекомендации по вопросу карточки. */
function ownerQuestions(
  state: Readonly<DevContourState>,
  redact: (text: string) => string,
): OwnerQuestions {
  const questions = new Map(
    (state.preparation?.changes ?? []).flatMap((c) =>
      (c.questions ?? []).map((q) => [`${c.id}:${q.id}`, q] as const),
    ),
  );
  return {
    summary: questionSummary(state, hrefs.preparation, redact, 0),
    recommended: (card) => {
      const q = questions.get(`${card.subject.id}:${card.occurrenceId}`);
      return q ? recommendedOf(q, redact) : undefined;
    },
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
  owner: OwnerQuestions,
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
      questions: questionsOf(bySection.product, owner, 'product'),
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
      questions: questionsOf(bySection.architecture, owner, 'architecture'),
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
      questions: questionsOf(bySection.design, owner, 'design'),
      href: stageHref(change, pending?.key ?? 'design'),
      design: { steps },
    },
  } satisfies Record<'product' | 'architecture' | 'design', PreparationSection>;
}

/**
 * Имена операций и команд ведущего: в текстах оператора о состоянии их нет.
 * Команда CLI — `devcontour` с подкомандой или флагом (`devcontour queue`,
 * `devcontour --workspace …`), операции — `queue_set`, `workflow_*`,
 * `session_handoff`, JSON-аргументы — фигурные скобки.
 */
export const LEAD_COMMAND =
  /queue_set|workflow_[a-z]+|session_handoff|--by host|\bdevcontour\s+(?:-{1,2}[a-z]|[a-z][a-z-]*)|[{}]/;

/** Что знает главная об остановке очереди, кроме вида `queueStopView`. */
export interface QueueFacts {
  approvalMode?: 'agent' | 'operator';
  /** Есть задание ведущего, которое продвинет цикл `serve` (queued/running). */
  workflowActive: boolean;
}

/**
 * Остановка очереди словами оператора: причина без имён операций и что
 * делать ему — кнопкой панели или ничего, если очередь снимет тот, кто
 * её действительно снимет (цикл ведущего, операция изменения контракта).
 * Те же правила, что у `queueStopView`; подсказки ведущему остаются в его
 * ответах (`queueStopView().action`, `session_handoff`).
 */
export function operatorQueue(
  queue: { reason?: string; stopReason?: string; failed?: true; by?: 'lead' },
  state: Pick<DevContourState, 'pauseFailures' | 'waits' | 'paused'>,
  facts: QueueFacts,
): { reason: string; hint: string } {
  const agent = (facts.approvalMode ?? 'agent') === 'agent';
  // Сам продолжит выдачу только цикл ведущего в режиме агента.
  const byLead = agent && facts.workflowActive;
  const start = 'запустите очередь кнопкой «Запустить очередь» в панели разработки';
  const attention = 'что сделать — в «Нужно действие»';
  // Кто продолжит после устранения причины.
  const resume = byLead
    ? 'ведущий агент продолжит выдачу сам'
    : agent
      ? `ведущий агент запустит очередь, когда вернётся к работе; сейчас — ${start}`
      : start;
  const own = (fallback: string) =>
    queue.stopReason && !LEAD_COMMAND.test(queue.stopReason) ? queue.stopReason : fallback;
  const sentence = (text: string) => text[0].toUpperCase() + text.slice(1) + '.';
  const wait = state.waits?.find((w) => w.kind === 'base-check')?.detail;
  const held = Boolean(heldBaseOf(state));
  const checkFailed = Boolean(wait?.startsWith('Проверка базы не пройдена'));
  if (queue.reason === 'reconfigure')
    return {
      reason: 'Применяется новая конфигурация после изменения контракта',
      hint: 'Ничего не требуется: пауза снимется сама.',
    };
  // Отказ провайдера — его устраняет человек, затем выдачу продолжают.
  if (state.pauseFailures?.includes('provider-auth'))
    return {
      reason: own('Провайдер моделей отказал: нет кредитов, исчерпан лимит или CLI не авторизован'),
      hint:
        'Авторизуйте CLI исполнителя, пополните баланс или дождитесь сброса лимита; затем ' +
        (wait ? 'проверьте базу gates и ' : '') +
        resume +
        '.',
    };
  if (wait || queue.reason === 'base-check') {
    if (held)
      return {
        reason: own('Перенос базы ждёт вашего подтверждения'),
        hint: `Подтвердите перенос базы: ${attention}.`,
      };
    if (checkFailed)
      return {
        reason: own('Проверка базы не пройдена'),
        hint: `Базу нужно исправить до запуска очереди: ${attention}.`,
      };
    // Ожидание под паузой человека или сбоем — снимает не цикл ведущего.
    const underPause = queue.reason === 'operator' || queue.failed;
    return {
      reason: own('Выдача ждёт проверки базы gates'),
      hint:
        byLead && !underPause && queue.reason === 'base-check'
          ? 'Ведущий агент проверит базу и продолжит выдачу сам.'
          : `Проверьте базу gates и запустите очередь: ${attention}.`,
    };
  }
  if (queue.failed)
    return {
      reason: own('Выдача остановлена сбоем'),
      hint: `Нужно устранить причину остановки: ${attention}.`,
    };
  switch (queue.reason) {
    case 'operator':
      if (queue.by === 'lead')
        return {
          reason: 'Выдачу остановил ведущий агент',
          hint: agent
            ? `Свою паузу ведущий агент снимает сам; запустить раньше — ${start}.`
            : sentence(start),
        };
      return {
        reason: 'Выдача остановлена вами',
        hint: `Когда будете готовы — ${start}; ведущий агент вашу паузу не снимает.`,
      };
    case 'shutdown':
      return { reason: 'Очередь на паузе после остановки сервера', hint: sentence(resume) };
    case 'not-started':
      return { reason: 'Очередь ещё не запущена', hint: sentence(resume) };
    default:
      return {
        reason: own('Выдача остановлена'),
        hint: `Нужно устранить причину остановки: ${attention}.`,
      };
  }
}

const LIVE_PHASES: readonly BoardPhase[] = ['running', 'failed', 'acceptance', 'queued', 'draft'];

function development(
  ctx: HomeContext,
  prep: ReturnType<typeof Preparation.statusOf>,
  cards: AttentionItem[],
  owner: OwnerQuestions,
): DevelopmentSection {
  const { state, h, attention } = ctx;
  const redact = ctx.redact ?? maskUrlCredentials;
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
  // Действующие отметки «отложена» (F90) — те же, что прячут шаги доски в
  // `host.next` и карточки центра внимания (`parkedHold`).
  const parked = new Map(
    h
      ? parkedBoards(h, ctx.now)
          .filter((p) => parkedHold(h, state, p.boardId))
          .map((p) => [p.boardId, p] as const)
      : [],
  );
  const live = phases
    .filter((p) => LIVE_PHASES.includes(p.phase))
    .map((p, i) => ({ ...p, i }))
    // Идущие и упавшие — первыми, затем новые; отложенные — в конце.
    .sort(
      (a, b) =>
        Number(parked.has(a.board.id)) - Number(parked.has(b.board.id)) ||
        LIVE_PHASES.indexOf(a.phase) - LIVE_PHASES.indexOf(b.phase) ||
        b.i - a.i,
    );
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
  // Упавшее задание, остановка которого уже не шаг `host.next` (F90):
  // закрытое `workflow_close` или задание отложенной доски.
  const settled = (j: WorkflowJob) =>
    j.kind === 'board' && (parked.has(j.id) || Boolean(h && closureOf(h, state, j.id, j)));
  const failedLatest = [...latest.values()].filter((j) => j.status === 'failed' && !accepted(j));
  const closedJobs = failedLatest.filter(settled);
  const current = [...latest.values()].filter(
    (j) => j.status !== 'failed' || (!accepted(j) && !closedJobs.includes(j)),
  );
  const rank = (s: WorkflowJob['status']) =>
    s === 'running' ? 0 : s === 'queued' ? 1 : s === 'failed' ? 2 : 3;
  const shownJobs = current
    .filter((j) => rank(j.status) < 3)
    .sort((a, b) => rank(a.status) - rank(b.status) || b.startedAt.localeCompare(a.startedAt))
    .slice(0, HOME_LIMITS.jobs);

  const holds = h ? inputHolds(h) : new Map<string, string>();
  const queue = h ? queueStopOf(h, state, ctx.events ?? []) : undefined;
  // Тексты остановки очереди обращаются к ведущему (`queue_set`,
  // `workflow_start`): оператору главная говорит своими словами.
  const plainQueue =
    h && queue?.paused
      ? operatorQueue(queue, state, {
          approvalMode: h.config.approvalMode,
          workflowActive: jobs.some((j) => j.status === 'queued' || j.status === 'running'),
        })
      : undefined;
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
  const parkedTasks = new Set(
    state.boards.filter((b) => parked.has(b.id)).flatMap((b) => b.revisions.at(-1)?.taskIds ?? []),
  );
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
    blocker = plainQueue?.reason;
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
      parked: live.filter((p) => parked.has(p.board.id)).length,
      top: live.slice(0, HOME_LIMITS.boards).map(({ board, phase }) => {
        const park = parked.get(board.id);
        return {
          id: board.id,
          title: clip(board.title),
          phase,
          href: hrefs.board(board.id),
          ...(park
            ? {
                parked: {
                  reason: clip(redact(park.reason)),
                  ...(park.until ? { until: park.until } : {}),
                  by: park.by,
                },
              }
            : {}),
        };
      }),
    },
    jobs: {
      running: current.filter((j) => j.status === 'running').length,
      waiting: current.filter((j) => j.status === 'queued').length,
      failed: current.filter((j) => j.status === 'failed').length,
      closed: closedJobs.length,
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
      ...(plainQueue ? { reason: clip(plainQueue.reason, HOME_LIMITS.startupError) } : {}),
      ...(plainQueue ? { hint: clip(plainQueue.hint, HOME_LIMITS.startupError) } : {}),
      ready,
      blocked: Math.max(0, open - ready),
      waitingInput: holds.size,
      // Черновик отложенной доски ждёт снятия отметки, а не решения (F90).
      drafts: state.tasks.filter((t) => t.status === 'draft' && !parkedTasks.has(t.id)).length,
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
    questions: questionsOf(cards, owner, 'development'),
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
  const prepared = releases
    .slice(0, HOME_LIMITS.releases)
    .map((r): HomeProgress['releases'][number] => ({
      id: clip(r.id),
      title: clip(titles.get(r.id) ?? r.id),
      tasks: r.tasks,
      done: r.done,
      failed: r.failed,
      criteria: r.criteria,
      readiness: r.readiness,
    }));
  // Без релизов постановки — релизы карты продукта (медленный ярус).
  const coverage = ctx.slow?.coverage;
  const mapped =
    !prepared.length && coverage?.available && coverage.releases?.length
      ? mapReleases(coverage.releases, coverage.accepted, state)
      : [];
  return {
    releases: prepared.length ? prepared : mapped,
    releasesDone: prepared.length
      ? releases.filter((r) => r.readiness === 'done').length
      : mapped.length
        ? mapDone(ctx.slow?.mapReleases, coverage?.available ? coverage.accepted : false, state)
        : 0,
    releasesTotal: prepared.length
      ? releases.length
      : mapped.length
        ? (coverage?.available && coverage.releasesTotal) || mapped.length
        : 0,
    ...(prepared.length
      ? { releasesFrom: 'preparation' as const }
      : mapped.length
        ? { releasesFrom: 'product-map' as const }
        : {}),
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

/**
 * Релизы карты продукта для хода работ: у текущего — фичи в объёме и
 * доказанные (`verified`, `accepted`), у остальных — только приёмка по
 * ChangeSet релиза.
 */
function mapReleases(
  releases: NonNullable<Extract<HomeProgress['coverage'], { available: true }>['releases']>,
  currentAccepted: boolean,
  state: Readonly<DevContourState>,
): HomeProgress['releases'] {
  // Прежняя приёмка ChangeSet — только для релизов, которые карта не считает:
  // у текущего приёмку проверяет карта (она устаревает при смене объёма).
  const accepted = new Set(
    state.changeSets.flatMap((c) => (c.acceptance && c.releaseId ? [c.releaseId] : [])),
  );
  return releases.map((r) => {
    const base = { id: r.id, title: r.title, failed: 0, criteria: 0, unit: 'features' as const };
    if (r.features === undefined)
      return {
        ...base,
        tasks: 0,
        done: 0,
        readiness: accepted.has(r.id) ? ('done' as const) : ('unplanned' as const),
        measured: false as const,
      };
    const done = r.done ?? 0;
    return {
      ...base,
      tasks: r.features,
      done,
      // Готов — только принятый по карте: доказанные фичи без приёмки (покрытие
      // неполно, приёмка снята) — ещё в работе.
      readiness: currentAccepted
        ? ('done' as const)
        : done > 0 || (r.started ?? 0) > 0
          ? ('in-progress' as const)
          : ('unplanned' as const),
    };
  });
}

/** Принятые релизы карты среди всех, а не только показанных. */
function mapDone(
  all: HomeSlow['mapReleases'],
  currentAccepted: boolean,
  state: Readonly<DevContourState>,
) {
  if (!all) return 0;
  const accepted = new Set(
    state.changeSets.flatMap((c) => (c.acceptance && c.releaseId ? [c.releaseId] : [])),
  );
  return all.ids.filter((id) => (id === all.current ? currentAccepted : accepted.has(id))).length;
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
    ...(ctx.slow
      ? {
          gates: ctx.slow.gates,
          load: ctx.slow.load,
          gateTrend: ctx.slow.gateTrend,
          ...(ctx.slow.spend ? { spend: ctx.slow.spend } : {}),
        }
      : {}),
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

/**
 * Записи проверок по часам за сутки до `now` (медленный ярус): прошедшие,
 * отказавшие и взятые из кандидата. Окно и часы — те же, что у попыток по
 * часам (`loadOf`); неприменимый gate — не запись проверки.
 */
export function gateTrendOf(
  runs: DevContourState['runs'],
  now: number,
): Omit<HomeGateTrend, 'asOf'> {
  const from = now - DAY_MS;
  const hourly: HomeGateTrend['hourly'] = Array.from({ length: 24 }, () => [0, 0, 0]);
  for (const run of runs) {
    if (run.finishedAt && Date.parse(run.finishedAt) < from) continue;
    for (const e of run.evidence) {
      if (e.kind !== 'test') continue;
      const t = Date.parse(e.createdAt);
      if (!inDay(t, now)) continue;
      const hour = Math.floor((t - from) / HOUR_MS);
      hourly[hour][e.reusedEvidence ? 2 : e.passed ? 0 : 1]++;
    }
  }
  return { from: new Date(from).toISOString(), to: new Date(now).toISOString(), hourly };
}

/** Полночь дня `at` по часам сервера, `shift` дней спустя. */
/**
 * Начало дня `at` + `shift` дней по часам сервера. День сдвигается до
 * обнуления часов: при переводе часов в полночь (день начинается в 01:00)
 * каждый день получает своё начало, а не час соседнего.
 */
const midnight = (at: number, shift = 0) => {
  const d = new Date(at);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + shift);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Календарная дата дня по часам сервера: подпись не зависит от пояса браузера. */
const localDate = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Расход по дням за `HOME_LIMITS.spendDays` дней до `now` (медленный ярус),
 * один проход по записям вызовов. День вызова — по его началу; запись с
 * началом позже `now` (часы переведены) — в последнем дне. Сумма — известная
 * оценка (как `usageTotals().knownCostUsd`), неизвестные — числом вызовов.
 */
export function spendOf(
  records: readonly UsageRecord[],
  now: number,
  limitUsd?: number,
): Omit<HomeSpend, 'asOf'> {
  const n = HOME_LIMITS.spendDays;
  const starts = Array.from({ length: n }, (_, i) => midnight(now, i - n + 1));
  const days = starts.map((start) => ({
    start: new Date(start).toISOString(),
    date: localDate(start),
    usd: 0,
    calls: 0,
    unknown: 0,
  }));
  let beforeUsd = 0;
  let beforeUnknown = 0;
  for (const r of records) {
    const t = Date.parse(r.startedAt);
    const usd = r.costSource !== 'unknown' ? (r.costUsd ?? 0) : 0;
    const unknown = knownCost(r) ? 0 : 1;
    if (!Number.isFinite(t) || t < starts[0]) {
      beforeUsd += usd;
      beforeUnknown += unknown;
      continue;
    }
    let i = n - 1;
    while (i > 0 && t < starts[i]) i--;
    days[i].usd += usd;
    days[i].calls++;
    days[i].unknown += unknown;
  }
  // Копейки суммы — после сложения: длинная история не копит ошибку округления.
  for (const d of days) d.usd = Math.round(d.usd * 1e4) / 1e4;
  return {
    days,
    beforeUsd: Math.round(beforeUsd * 1e4) / 1e4,
    beforeUnknown,
    ...(limitUsd !== undefined ? { limitUsd } : {}),
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
export function budgetOf(
  overview: Budgets | undefined,
  asOf: string,
  /** Название задачи или доски по id: подпись строки вместо UUID. */
  nameOf?: (kind: 'task' | 'board', id: string) => string | undefined,
): HomeSlow['budget'] {
  if (!overview?.budgets.length) return undefined;
  const rank = (s: BudgetState) => (s === 'exceeded' ? 0 : s === 'undetermined' ? 1 : 2);
  const sorted = overview.budgets.toSorted(
    (x, y) =>
      rank(x.state) - rank(y.state) ||
      Number(y.scope.kind === 'workspace') - Number(x.scope.kind === 'workspace'),
  );
  const b = sorted[0];
  const labelOf = (x: Budgets['budgets'][number]) => {
    if (x.scope.kind === 'workspace' || !x.scope.id) return undefined;
    const name = nameOf?.(x.scope.kind, x.scope.id);
    const kind = x.scope.kind === 'task' ? 'задачи' : 'доски';
    return clip(`${kind} «${name ? clip(name, 60) : x.scope.id}»`);
  };
  const line = (x: Budgets['budgets'][number]): BudgetScope => ({
    state: x.state,
    ...(labelOf(x) ? { label: labelOf(x)! } : {}),
    scope: clip(
      x.scope.kind === 'workspace' ? 'workspace' : `${x.scope.kind} ${x.scope.id ?? ''}`.trim(),
    ),
    ...(x.limit.usd !== undefined ? { limitUsd: x.limit.usd } : {}),
    // Предел по времени: бюджет только по времени иначе читался бы как «$0».
    ...(x.limit.timeMs !== undefined ? { limitMs: x.limit.timeMs } : {}),
    ...(x.durationMs !== undefined ? { spentMs: x.durationMs } : {}),
    spentUsd: x.reportedUsd + x.estimatedUsd,
    unknownCalls: x.unknownCalls,
    ...(x.reason ? { reason: clip(russianCounts(x.reason), HOME_LIMITS.startupError) } : {}),
  });
  const first = line(b);
  return {
    ...first,
    complete: b.unknownCalls === 0 && b.unfinishedCalls === 0,
    exceeded: overview.budgets.filter((x) => x.state === 'exceeded').length,
    total: overview.budgets.length,
    scopes: sorted.slice(0, HOME_LIMITS.budgetScopes).map(line),
    asOf,
  };
}

/**
 * Склонение чисел в текстах расчёта бюджета («у 1 попыток» → «у 1 попытки»):
 * текст приходит из движка исполнения с формой множественного числа.
 */
export function russianCounts(text: string) {
  const forms = (n: number) =>
    n % 10 === 1 && n % 100 !== 11
      ? 0
      : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
        ? 1
        : 2;
  const words: [RegExp, [string, string, string]][] = [
    [/у (\d+) (?:попыток|попытки|попытка)(?![а-яё])/g, ['попытки', 'попыток', 'попыток']],
    [/у (\d+) (?:вызовов|вызова|вызов)(?![а-яё])/g, ['вызова', 'вызовов', 'вызовов']],
  ];
  return words.reduce(
    (t, [re, f]) => t.replace(re, (_, n: string) => `у ${n} ${f[forms(Number(n))]}`),
    text,
  );
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
    ...(view.releases?.length
      ? {
          releases: view.releases.slice(0, HOME_LIMITS.releases).map((r) => {
            if (r.id !== view.releaseId) return { id: clip(r.id), title: clip(r.title) };
            // В объёме — фичи релиза без отложенных решением и неприменимых.
            const scoped = (view.features ?? []).filter(
              (f) => f.status !== 'deferred' && f.status !== 'not-applicable',
            );
            return {
              id: clip(r.id),
              title: clip(r.title),
              features: scoped.length,
              done: scoped.filter((f) => f.status === 'verified' || f.status === 'accepted').length,
              // Начата — есть работа хоть по одному каналу или сценарию:
              // `unplanned` значит лишь, что у части фичи ещё нет задач.
              started: scoped.filter(
                (f) =>
                  f.status !== 'unplanned' ||
                  (f.channels ?? []).some((c) => c.covered || c.planned) ||
                  (f.checks ?? []).some((c) => c.passed),
              ).length,
            };
          }),
          releasesTotal: view.releases.length,
        }
      : {}),
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
  /** Записи вызовов моделей для расхода по дням. */
  usageRecords?: readonly UsageRecord[];
  /** События разрывов цикла не старше часа (`Store.eventsSince`). */
  gapEvents?: readonly AuditEvent[];
}): HomeSlow {
  const asOf = new Date(input.now).toISOString();
  const coverage = coverageOf(input.product, asOf, input.preparation);
  const titles = new Map<string, string>([
    ...input.state.tasks.map((t) => [`task:${t.id}`, t.title] as const),
    ...input.state.boards.map((b) => [`board:${b.id}`, b.title] as const),
  ]);
  const budget = budgetOf(input.budgets, asOf, (kind, id) => titles.get(`${kind}:${id}`));
  const map =
    input.product && !('error' in input.product) && input.product.available
      ? input.product
      : undefined;
  const limitUsd = input.budgets?.budgets.find((b) => b.scope.kind === 'workspace')?.limit.usd;
  return {
    asOf,
    load: { ...loadOf(input.state.runs, input.now), asOf },
    gateTrend: { ...gateTrendOf(input.state.runs, input.now), asOf },
    ...(map?.releases?.length
      ? {
          mapReleases: {
            ids: map.releases.slice(0, HOME_LIMITS.mapReleaseIds).map((r) => r.id),
            current: map.releaseId,
          },
        }
      : {}),
    ...(input.usageRecords
      ? { spend: { ...spendOf(input.usageRecords, input.now, limitUsd), asOf } }
      : {}),
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
  const owner = ownerQuestions(state, ctx.redact ?? maskUrlCredentials);
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
    owner,
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
    development: development(ctx, prep, bySection.development, owner),
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
      bySection: attention.counts.bySection,
      ...(attention.truncated ? { truncated: attention.truncated.count } : {}),
    },
  };
}
