// Центр внимания: одна проекция актуальных решений для оператора и ведущего
// агента. Карточка — следствие факта исходной сущности (вопроса, ревизии,
// попытки, обращения, паузы…), а не своя запись со статусом: она есть, пока
// исходное правило говорит «нужно действие», и исчезает, когда исходная
// сущность решена. Чтение ничего не пишет и моделей не вызывает; хранятся
// только локальные отметки оператора «прочитано» и «увидел».
//
// Идентичность карточки: `sourceKey` — предмет (вопрос, этап, задача…),
// `occurrenceId` — это появление предмета, выведенное из первичного факта
// (id вопроса, номер ревизии, id попытки, момент паузы…). Опрос и heartbeat
// не меняют ни появление, ни версию. Повторное появление после решения —
// новый факт источника, поэтому новое появление и снова «не прочитано».
// Источник без такого факта называет ограничение у своего правила.
import { digest } from '../core/service.ts';
import type { DevContour } from '../core/service.ts';
import type { Store } from '../core/store.ts';
import type { DevContourState, Task } from '../core/model.ts';
import { DomainError } from '../core/model.ts';
import { descendants } from '../core/graph.ts';
import { assertStageUpstream } from '../core/preparation.ts';
import type { ProductChange } from '../core/preparation-model.ts';
import {
  ATTENTION_LIMITS,
  attentionInputs,
  categoryRank,
  type AttentionAction,
  type AttentionActor,
  type AttentionCategory,
  type AttentionItem,
  type AttentionListInput,
  type AttentionMark,
  type AttentionSource,
  type AttentionSubjectKind,
} from '../core/attention-model.ts';
import {
  leadPresence,
  quickPrerequisites,
  quickView,
  type CachedFacts,
  type QuickPrerequisites,
} from './quick-view.ts';

/** Пространство локальных отметок оператора: не исполняемое состояние, не Git sync. */
export const ATTENTION_NAMESPACE = 'attention';

/** Короткий digest для версий и появлений: только сравнение на равенство. */
const d = (value: unknown) => digest(value).slice(0, 32);
const clip = (text: string, n: number) => (text.length > n ? text.slice(0, n - 1) + '…' : text);
const one = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Ссылки панели: вид задаётся параметрами адреса. */
export const hrefs = {
  preparation: (changeId?: string) => (changeId ? `/?change=${encodeURIComponent(changeId)}` : '/'),
  task: (taskId: string) => `/?task=${encodeURIComponent(taskId)}`,
  board: (boardId: string) => `/?tab=graph&board=${encodeURIComponent(boardId)}`,
  changesets: () => '/?tab=changesets',
  contracts: () => '/?tab=contracts',
  overview: () => '/',
};

/** Карточка до отметок и влияния: что источник знает о предмете. */
export interface Candidate {
  sourceKey: string;
  occurrenceId: string;
  sourceVersion: string;
  source: AttentionSource;
  category: AttentionCategory;
  actor: AttentionActor;
  title: string;
  reason: string;
  since: string;
  updatedAt?: string;
  subject: { kind: AttentionSubjectKind; id: string; href: string };
  evidence?: AttentionItem['evidence'];
  actions?: AttentionAction[];
  /** Задачи, которые карточка покрывает прямо; влияние — они и их ждущие. */
  covered?: string[];
  /** Доски предмета без задач (план, workflow). */
  boards?: string[];
  /** Сведения для исполнения действия: доменные CAS-поля показанной версии. */
  basis?: Record<string, unknown>;
}

/** Контекст одного чтения: один снимок хранилища, одно `now`. */
export interface AttentionContext {
  store: Store;
  h: DevContour | undefined;
  state: Readonly<DevContourState>;
  root: string | undefined;
  now: number;
  quick: Map<string, QuickPrerequisites>;
  redact: (text: string) => string;
  /** Задачи, уже покрытые карточкой более ранного источника: id задачи → sourceKey. */
  claimed: Map<string, string>;
  /** Карточки по sourceKey: поздний источник сворачивает свои в раннюю. */
  cards: Map<string, Candidate>;
}

export interface AttentionSourceRule {
  id: AttentionSource;
  /** Нужен подключённый движок (после setup). */
  engine?: boolean;
  collect(ctx: AttentionContext): Candidate[];
}

/* ------------------------------------------------------------------ */
/* Подготовка: работает до setup и после него на той же базе           */
/* ------------------------------------------------------------------ */

const stages = ['product', 'architecture', 'references', 'concept', 'design'] as const;
const stageTitles: Record<(typeof stages)[number], string> = {
  product: 'продуктовую часть',
  architecture: 'архитектуру и стек',
  references: 'референсы',
  concept: 'концепт',
  design: 'дизайн',
};
const changesOf = (ctx: AttentionContext): ProductChange[] =>
  (ctx.state.preparation?.changes ?? []);

/**
 * S1. Открытый вопрос ведущего оператору. Появление — id вопроса: вопрос
 * неизменяем, переспрос — новый вопрос. Решение — ответ или снятие вопроса.
 */
const prepQuestion: AttentionSourceRule = {
  id: 'prep-question',
  collect: (ctx) =>
    changesOf(ctx).flatMap((c) =>
      c.questions
        .filter((q) => q.status === 'open')
        .map((q): Candidate => ({
          sourceKey: `prep:q:${c.id}:${q.id}`,
          occurrenceId: q.id,
          sourceVersion: d({ text: q.text, why: q.why, options: q.options }),
          source: 'prep-question',
          category: 'question',
          actor: 'operator',
          title: `Вопрос ведущего агента по «${c.title}»`,
          reason: one(q.text) + (q.why ? ` — ${one(q.why)}` : ''),
          since: q.createdAt,
          subject: { kind: 'change', id: c.id, href: hrefs.preparation(c.id) },
          actions: [
            {
              id: 'answer',
              kind: 'domain',
              label: 'Ответить',
              input: q.options.length ? 'text+option' : 'text',
            },
          ],
          basis: { changeId: c.id, questionId: q.id, options: q.options },
        })),
    ),
};

/**
 * S2. Ответ оператора, который ведущий ещё не превратил в решение.
 * Появление — момент ответа; если решение по вопросу было записано и затем
 * снято, — момент снятия (решение — факт источника, его снятие — новый).
 */
const prepAnswerPending: AttentionSourceRule = {
  id: 'prep-answer-pending',
  collect: (ctx) =>
    changesOf(ctx).flatMap((c) =>
      c.questions.flatMap((q): Candidate[] => {
        if (q.status !== 'answered' || !q.answer) return [];
        const records = c.decisions.filter((r) => r.questionId === q.id);
        if (records.some((r) => !r.withdrawn)) return [];
        const withdrawn = records
          .map((r) => r.withdrawn!.at)
          .sort()
          .at(-1);
        return [
          {
            sourceKey: `prep:qa:${c.id}:${q.id}`,
            occurrenceId: withdrawn ? `w:${withdrawn}` : `a:${q.answer.at}`,
            sourceVersion: d(q.answer.text),
            source: 'prep-answer-pending',
            category: 'technical',
            actor: 'lead',
            title: `Ответ оператора ждёт решения ведущего по «${c.title}»`,
            reason: `Вопрос: ${one(q.text)} Ответ: ${one(q.answer.text)}`,
            since: withdrawn ?? q.answer.at,
            subject: { kind: 'change', id: c.id, href: hrefs.preparation(c.id) },
          },
        ];
      }),
    ),
};

/** Предыдущий этап утверждён и редакция относится к нему (правило `decide`). */
function upstreamRefusal(c: ProductChange, stage: (typeof stages)[number]) {
  try {
    assertStageUpstream(c, stage);
    return undefined;
  } catch (error) {
    if (error instanceof DomainError) return error.message;
    throw error;
  }
}

/**
 * S3. Редакция этапа ждёт согласования оператора. Появление — номер
 * редакции; новая редакция — новое появление. Если согласование отклонят
 * (редакция относится к прежнему предыдущему этапу), действие ведущего.
 */
const prepStage: AttentionSourceRule = {
  id: 'prep-stage',
  collect: (ctx) =>
    changesOf(ctx).flatMap((c) =>
      stages.flatMap((stage): Candidate[] => {
        const r = c[stage].at(-1);
        if (r?.status !== 'in-review') return [];
        const upstream =
          'productDigest' in r
            ? r.productDigest
            : 'architectureDigest' in r
              ? r.architectureDigest
              : 'referencesDigest' in r
                ? r.referencesDigest
                : 'conceptDigest' in r
                  ? r.conceptDigest
                  : null;
        const refusal = upstreamRefusal(c, stage);
        const base = {
          sourceKey: `prep:stage:${c.id}:${stage}`,
          occurrenceId: `r${r.number}`,
          sourceVersion: d({ digest: r.digest, upstream, refusal: refusal ?? null }),
          source: 'prep-stage' as const,
          category: 'decision' as const,
          since: r.createdAt,
          subject: { kind: 'change' as const, id: c.id, href: hrefs.preparation(c.id) },
        };
        if (refusal)
          return [
            {
              ...base,
              actor: 'lead',
              category: 'technical',
              title: `Редакция «${stageTitles[stage]}» относится к прежней постановке`,
              reason: `${refusal}: ведущий отправляет новую редакцию`,
            },
          ];
        return [
          {
            ...base,
            actor: 'operator',
            title: `Утвердите ${stageTitles[stage]} «${c.title}»`,
            reason: one(r.reason),
            actions: [
              { id: 'approve', kind: 'domain', label: 'Утвердить', input: 'confirm' },
              {
                id: 'request-changes',
                kind: 'domain',
                label: 'Вернуть на доработку',
                input: 'text',
              },
            ],
            basis: { changeId: c.id, stage, expectedDigest: r.digest },
          },
        ];
      }),
    ),
};

/** S4. Оператор вернул редакцию на доработку: новая редакция — за ведущим. */
const prepRework: AttentionSourceRule = {
  id: 'prep-rework',
  collect: (ctx) =>
    changesOf(ctx).flatMap((c) =>
      stages.flatMap((stage): Candidate[] => {
        const r = c[stage].at(-1);
        if (r?.status !== 'changes-requested') return [];
        return [
          {
            sourceKey: `prep:rework:${c.id}:${stage}`,
            occurrenceId: `r${r.number}`,
            sourceVersion: d(r.decision?.comment ?? ''),
            source: 'prep-rework',
            category: 'technical',
            actor: 'lead',
            title: `Оператор вернул ${stageTitles[stage]} «${c.title}» на доработку`,
            reason: one(r.decision?.comment || r.reason),
            since: r.decision?.at ?? r.createdAt,
            subject: { kind: 'change', id: c.id, href: hrefs.preparation(c.id) },
          },
        ];
      }),
    ),
};

/**
 * S5. Быстрый маршрут: подключение репозитория или подготовка setup стоят.
 * Шаги — `quickView` (то же правило, что панель быстрого изменения).
 *
 * Появление привязано к фактам источника, которые меняет каждое новое
 * появление: подключение — к поручению и HEAD репозитория, подготовка — к
 * предложению setup и HEAD. Версия — причина (коды блокеров, отказ плана,
 * пути конфликтов). Ограничение: факты Git не имеют журнала, поэтому та же
 * причина, вернувшаяся при том же HEAD и том же предложении (например,
 * `git stash` и `git stash pop`), остаётся прежним появлением.
 */
const quickSource: AttentionSourceRule = {
  id: 'quick',
  collect: (ctx) => {
    const active = ctx.state.preparation?.activeChangeId;
    const change = changesOf(ctx).find((c) => c.id === active);
    const prerequisites = change && ctx.quick.get(change.id);
    if (!change?.intake || change.expanded || !prerequisites || !ctx.root) return [];
    const { steps } = quickView({
      store: ctx.store,
      h: ctx.h,
      root: ctx.root,
      state: ctx.state,
      change,
      prerequisites,
      now: ctx.now,
    });
    const head = prerequisites.facts?.facts.git.baseSha ?? null;
    const out: Candidate[] = [];
    for (const step of steps) {
      if (step.state !== 'blocked') continue;
      if (step.id === 'connection') {
        const cause = prerequisites.factsError
          ? ['facts-error', prerequisites.factsError]
          : (prerequisites.facts?.diagnostics ?? [])
              .filter((x) => x.severity === 'blocker')
              .map((x) => `${x.code}:${x.path ?? ''}`)
              .sort();
        out.push({
          sourceKey: `quick:${change.id}:connection`,
          occurrenceId: 'q-' + d({ intake: change.intake.requestKey, head }).slice(0, 16),
          sourceVersion: d(cause),
          source: 'quick',
          category: 'access',
          actor: 'operator',
          title: 'Репозиторий быстрого изменения не готов к подключению',
          reason: one(step.detail),
          since: change.intake.createdAt,
          subject: { kind: 'change', id: change.id, href: hrefs.preparation(change.id) },
        });
      }
      if (step.id === 'preparation') {
        const plan = prerequisites.plan;
        const cause = plan?.refusal
          ? ['refusal', plan.refusal]
          : (plan?.files ?? [])
              .filter((f) => f.action === 'conflict')
              .map((f) => f.path)
              .sort();
        const proposal = change.setup?.at(-1);
        out.push({
          sourceKey: `quick:${change.id}:preparation`,
          occurrenceId: 'q-' + d({ proposal: plan?.proposal ?? null, head }).slice(0, 16),
          sourceVersion: d(cause),
          source: 'quick',
          category: 'technical',
          actor: 'lead',
          title: 'Setup быстрого изменения не применить',
          reason: one(step.detail),
          since: proposal?.createdAt ?? change.intake.createdAt,
          subject: { kind: 'change', id: change.id, href: hrefs.preparation(change.id) },
        });
      }
    }
    return out;
  },
};

/** Источники в порядке владения корнями: ранний источник забирает задачу первым. */
export const preparationSources: AttentionSourceRule[] = [
  prepQuestion,
  prepAnswerPending,
  prepStage,
  prepRework,
  quickSource,
];

/* ------------------------------------------------------------------ */
/* Сборка: влияние, отметки, порядок                                   */
/* ------------------------------------------------------------------ */

const open = (t: Pick<Task, 'status'>) => t.status !== 'done' && t.status !== 'cancelled';

function boardsOf(state: Readonly<DevContourState>) {
  const byTask = new Map<string, string>();
  for (const b of state.boards)
    for (const r of b.revisions) for (const id of r.taskIds) byTask.set(id, b.id);
  return byTask;
}

/** Состояние отметок карточки: прочитано и «увидел» — по появлению и версии. */
export function markState(mark: AttentionMark | undefined, occurrenceId: string, version: string) {
  const same = mark?.occurrenceId === occurrenceId;
  const read = same && mark.readVersion === version;
  const acknowledged = same && mark.ackVersion === version;
  return { read, acknowledged, unread: !read };
}

/** Влияние карточки: покрытые задачи и открытые задачи, которые их ждут. */
function impactOf(
  c: Candidate,
  state: Readonly<DevContourState>,
  boardByTask: Map<string, string>,
): AttentionItem['impact'] {
  const covered = [...new Set(c.covered ?? [])];
  const coveredSet = new Set(covered);
  const waiting = covered.length
    ? descendants(state.tasks, covered).filter((id) => {
        if (coveredSet.has(id)) return false;
        const t = state.tasks.find((x) => x.id === id);
        return !!t && open(t);
      }).length
    : 0;
  const boards = [
    ...new Set([
      ...(c.boards ?? []),
      ...covered.map((id) => boardByTask.get(id)).filter((b): b is string => !!b),
    ]),
  ];
  return {
    tasks: covered.length,
    waiting,
    boards,
    taskIds: covered.slice(0, ATTENTION_LIMITS.taskIds),
  };
}

export function toItem(
  c: Candidate,
  state: Readonly<DevContourState>,
  boardByTask: Map<string, string>,
  marks: Record<string, AttentionMark>,
): AttentionItem {
  return {
    id: `${c.sourceKey}#${c.occurrenceId}`,
    sourceKey: c.sourceKey,
    occurrenceId: c.occurrenceId,
    sourceVersion: c.sourceVersion,
    source: c.source,
    category: c.category,
    actor: c.actor,
    title: clip(one(c.title), ATTENTION_LIMITS.title),
    reason: clip(one(c.reason), ATTENTION_LIMITS.reason),
    impact: impactOf(c, state, boardByTask),
    since: c.since,
    ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
    subject: c.subject,
    evidence: (c.evidence ?? []).slice(0, ATTENTION_LIMITS.evidence),
    actions: [
      ...(c.actor === 'operator' ? (c.actions ?? []) : []),
      { id: 'open', kind: 'navigate', href: c.subject.href },
    ],
    state: markState(marks[c.sourceKey], c.occurrenceId, c.sourceVersion),
  };
}

/** Детерминированный порядок: категория, влияние, давность, id. Без `now`. */
export function compareItems(a: AttentionItem, b: AttentionItem) {
  return (
    categoryRank[a.category] - categoryRank[b.category] ||
    b.impact.tasks + b.impact.waiting - (a.impact.tasks + a.impact.waiting) ||
    (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export interface AttentionOptions {
  /** Корень workspace: факты быстрого маршрута. */
  root?: string;
  /** Общий кэш фактов репозитория (панель передаёт свой). */
  cachedFacts?: CachedFacts;
  now?: () => number;
  /** Дополнительные источники (тесты структурной защиты чтения). */
  sources?: AttentionSourceRule[];
}

export interface AttentionView {
  revision: number;
  generatedAt: string;
  engineConnected: boolean;
  lead: { present: boolean; lastActivityAt: string | null };
  counts: {
    active: number;
    /** Непрочитанные карточки оператора: значок панели. */
    unread: number;
    byActor: Record<AttentionActor, { active: number; unread: number }>;
  };
  items: AttentionItem[];
  truncated?: { count: number };
}

/**
 * Центр внимания над хранилищем подготовки (до setup) или движка (после):
 * один и тот же файл базы, поэтому ключи и отметки совпадают.
 */
export class AttentionService {
  constructor(
    readonly store: Store,
    readonly h: DevContour | undefined,
    readonly options: AttentionOptions = {},
  ) {}

  private get sources(): AttentionSourceRule[] {
    return [...preparationSources, ...(this.options.sources ?? [])];
  }

  /** Асинхронные предпосылки до снимка: факты Git быстрого маршрута (только чтение). */
  async prerequisites(): Promise<Map<string, QuickPrerequisites>> {
    const quick = new Map<string, QuickPrerequisites>();
    const root = this.options.root;
    if (!root || !this.options.cachedFacts) return quick;
    const state = this.store.read();
    const change = state.preparation?.changes.find(
      (c) => c.id === state.preparation?.activeChangeId,
    );
    if (!change?.intake || change.expanded) return quick;
    quick.set(
      change.id,
      await quickPrerequisites({
        h: this.h,
        root,
        state,
        change,
        cachedFacts: this.options.cachedFacts,
      }),
    );
    return quick;
  }

  /** Контекст чтения внутри открытого снимка. */
  context(quick: Map<string, QuickPrerequisites>, now: number): AttentionContext {
    return {
      store: this.store,
      h: this.h,
      state: this.store.read(),
      root: this.options.root,
      now,
      quick,
      redact: (text) => text,
      claimed: new Map(),
      cards: new Map(),
    };
  }

  /** Карточки-кандидаты в порядке источников, внутри снимка. */
  candidates(ctx: AttentionContext): Candidate[] {
    const out: Candidate[] = [];
    for (const source of this.sources) {
      if (source.engine && !ctx.h) continue;
      for (const c of source.collect(ctx)) {
        // Один предмет — одна карточка: повтор ключа (свёртка) не дублирует.
        if (ctx.cards.has(c.sourceKey)) continue;
        ctx.cards.set(c.sourceKey, c);
        for (const id of c.covered ?? [])
          if (!ctx.claimed.has(id)) ctx.claimed.set(id, c.sourceKey);
        out.push(c);
      }
    }
    return out;
  }

  /** Отметки оператора по ключам источников. */
  marks(): Record<string, AttentionMark> {
    return this.store.localRecords<AttentionMark>(ATTENTION_NAMESPACE, undefined);
  }

  /**
   * Активный список. GET: ничего не пишет — снимок хранилища открыт только
   * на чтение, и запись внутри него упала бы, а не закоммитилась.
   */
  async active(raw: AttentionListInput = {}): Promise<AttentionView> {
    const filter = attentionInputs.list.parse(raw);
    const quick = await this.prerequisites();
    const now = (this.options.now ?? Date.now)();
    return this.store.snapshot(() => {
      const ctx = this.context(quick, now);
      const boardByTask = boardsOf(ctx.state);
      const marks = this.marks();
      const all = this.candidates(ctx)
        .map((c) => toItem(c, ctx.state, boardByTask, marks))
        .sort(compareItems);
      const filtered = all.filter(
        (i) =>
          (!filter.actor || i.actor === filter.actor) &&
          (!filter.category || i.category === filter.category) &&
          (!filter.component || this.inComponent(ctx, i, filter.component)),
      );
      const items = filtered.slice(0, ATTENTION_LIMITS.active);
      const count = (actor: AttentionActor) => {
        const own = filtered.filter((i) => i.actor === actor);
        return { active: own.length, unread: own.filter((i) => i.state.unread).length };
      };
      const byActor = { operator: count('operator'), lead: count('lead') };
      return {
        revision: this.store.revision(),
        generatedAt: new Date(now).toISOString(),
        engineConnected: Boolean(this.h),
        lead: this.lead(ctx),
        counts: { active: filtered.length, unread: byActor.operator.unread, byActor },
        items,
        ...(filtered.length > items.length
          ? { truncated: { count: filtered.length - items.length } }
          : {}),
      };
    });
  }

  /** Присутствие ведущего по журналу активного изменения (правило быстрого маршрута). */
  private lead(ctx: AttentionContext) {
    const change = changesOf(ctx).find((c) => c.id === ctx.state.preparation?.activeChangeId);
    return change
      ? leadPresence(change, ctx.state, ctx.now)
      : { present: false, lastActivityAt: null };
  }

  /** Карточка относится к компоненту: задачи компонента или его доски. */
  private inComponent(ctx: AttentionContext, item: AttentionItem, component: string) {
    const ids = new Set(item.impact.taskIds);
    return ctx.state.tasks.some((t) => ids.has(t.id) && t.repositoryId === component);
  }
}
