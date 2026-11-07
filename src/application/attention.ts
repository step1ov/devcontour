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
import { queuePause, explainStop, stopInputsOf } from 'devcontour-harness';
import { digest, specDigest } from '../core/service.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { CheckCorpus } from '../core/check-store.ts';
import { executionOf } from '../harness/execution.ts';
import { ContractChanges } from '../runner/contract-change.ts';
import { boardTasks, planApproved, unapprovedTasks } from '../runner/lead-outlook.ts';
import { boardStep, handoffRedactor, harnessOf, hostContext } from './handoff.ts';
import { pendingAcceptances, previewProblems, stoppedWorkflows } from './overview.ts';
import { budgetBlocks, budgetHint } from './context.ts';
import { inputHolds } from './input.ts';
import { DiscussionService } from './discussion.ts';
import { taskOwner } from '../core/sync-state.ts';
import { baseWaitOf, queueStopOf, quietAttempts, quietOperations } from './queue-stop.ts';
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
const changesOf = (ctx: AttentionContext): ProductChange[] => ctx.state.preparation?.changes ?? [];

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
/* Движок: после setup                                                 */
/* ------------------------------------------------------------------ */

/** Общие чтения движка одного снимка: считаются один раз на чтение. */
interface EngineReads {
  h: DevContour;
  harness: ReturnType<typeof harnessOf>;
  holds: Map<string, string>;
  jobs: ReturnType<LeadWorkflow['view']>;
  boardByTask: Map<string, string>;
}
const engineCache = new WeakMap<AttentionContext, EngineReads>();
function engineOf(ctx: AttentionContext): EngineReads {
  let reads = engineCache.get(ctx);
  if (!reads) {
    const h = ctx.h!;
    reads = {
      h,
      harness: harnessOf(h),
      holds: inputHolds(h),
      jobs: new LeadWorkflow(h).view(),
      boardByTask: boardsOf(ctx.state),
    };
    engineCache.set(ctx, reads);
  }
  return reads;
}
const taskTitle = (ctx: AttentionContext, id: string) =>
  ctx.state.tasks.find((t) => t.id === id)?.title ?? id;
const unclaimed = (ctx: AttentionContext, ids: readonly string[]) =>
  ids.filter((id) => !ctx.claimed.has(id));
const handoff: AttentionAction = {
  id: 'handoff',
  kind: 'handoff',
  command: 'session_handoff (devcontour handoff --workspace …)',
};

/**
 * S13. Операция изменения контракта упала или устарела: её удержанные
 * задачи ждут ведущего. Появление — операция и момент перехода в этот
 * статус (возобновлённая и снова упавшая операция — новое появление).
 */
const contractChangeSource: AttentionSourceRule = {
  id: 'contract-change',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    return new ContractChanges(h, ctx.root ?? '')
      .list()
      .filter((op) => op.status === 'failed' || op.status === 'stale')
      .map((op): Candidate => {
        const entered = op.history.findLast((e) => e.event === op.status)?.at ?? op.startedAt;
        const held = [
          ...new Set([
            ...op.held,
            ...ctx.state.tasks.filter((t) => t.hold?.operation === op.id).map((t) => t.id),
          ]),
        ].filter((id) => ctx.state.tasks.some((t) => t.id === id && open(t)));
        return {
          sourceKey: `contract-change:${op.id}`,
          occurrenceId: `${op.id}@${entered}`,
          sourceVersion: String(op.version ?? 0),
          source: 'contract-change',
          category: 'technical',
          actor: 'lead',
          title:
            op.status === 'failed'
              ? `Изменение контракта ${op.key} остановлено`
              : `Изменение контракта ${op.key} устарело`,
          reason: ctx.redact(op.error ?? 'Причина не записана'),
          since: entered,
          subject: { kind: 'operation', id: op.id, href: hrefs.contracts() },
          actions: [handoff],
          covered: unclaimed(ctx, held),
        };
      });
  },
};

/**
 * S11. Бюджет исчерпан или не определён и держит готовые задачи. Расход
 * монотонен: при том же пределе исчерпанный бюджет снимает только новая
 * конфигурация, поэтому появление — предел и `onUnknown`.
 */
const budgetSource: AttentionSourceRule = {
  id: 'budget',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    const blocks = budgetBlocks(h, ctx.state);
    if (!blocks.size) return [];
    const overview = executionOf(h).engine.budgets();
    if (!overview) return [];
    return overview.budgets.flatMap((b): Candidate[] => {
      if ((b.state !== 'exceeded' && b.state !== 'undetermined') || !b.reason) return [];
      const covered = unclaimed(
        ctx,
        [...blocks].filter(([, reason]) => reason === b.reason).map(([id]) => id),
      );
      if (!covered.length) return [];
      const scope = `${b.scope.kind}:${b.scope.id ?? '*'}`;
      return [
        {
          sourceKey: `budget:${scope}`,
          occurrenceId: d({ limit: b.limit, onUnknown: overview.onUnknown }),
          sourceVersion: d({ state: b.state, limit: b.limit, onUnknown: overview.onUnknown }),
          source: 'budget',
          category: 'budget',
          actor: 'operator',
          title:
            b.state === 'exceeded' ? 'Бюджет исчерпан: задачи не выдаются' : 'Бюджет не определён',
          reason: `${b.reason}. ${budgetHint(b.reason)}`,
          since:
            ctx.state.tasks
              .filter((t) => covered.includes(t.id))
              .map((t) => t.budgetBlock?.at)
              .filter((x): x is string => !!x)
              .sort()[0] ??
            ctx.state.pausedAt ??
            new Date(0).toISOString(),
          subject: { kind: 'budget', id: scope, href: hrefs.overview() },
          covered,
        },
      ];
    });
  },
};

/** Классы отказа, которые чинит доступ: учётная запись или среда. */
const accessFailures = new Set(['provider-auth', 'environment']);

/**
 * S12. Выдача на паузе, и снимет её человек или ведущий (`queuePause`), пока
 * есть открытая работа. Появление — момент паузы. Отказ провайдера по
 * задачам сворачивается сюда: одна учётная запись чинит их все.
 */
const queueSource: AttentionSourceRule = {
  id: 'queue',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    const s = ctx.state;
    if (!s.paused || s.pauseReason === 'base-check' || !s.tasks.some(open)) return [];
    const pause = queuePause({
      paused: s.paused,
      ...(s.pauseReason ? { pauseReason: s.pauseReason } : {}),
      ...(s.pauseFailures ? { pauseFailures: s.pauseFailures } : {}),
    });
    if (!pause || (pause.actor !== 'user' && pause.actor !== 'lead')) return [];
    const view = queueStopOf(h, s, h.store.latestEvents(['scheduler.error'], 50));
    const access = (s.pauseFailures ?? []).some((f) => accessFailures.has(f));
    const operator = pause.actor === 'user';
    return [
      {
        sourceKey: 'queue',
        occurrenceId: s.pausedAt ?? 'initial',
        sourceVersion: d({
          reason: s.pauseReason ?? null,
          failures: s.pauseFailures ?? [],
          waits: (s.waits ?? []).map((w) => w.kind),
        }),
        source: 'queue',
        category: access ? 'access' : operator ? 'decision' : 'technical',
        actor: operator ? 'operator' : 'lead',
        title: access
          ? 'Выдача остановлена: нужен доступ'
          : s.pauseReason === 'operator'
            ? 'Выдача задач остановлена оператором'
            : 'Выдача задач на паузе',
        reason: ctx.redact([view.stopReason, view.action].filter(Boolean).join('. ')),
        since: s.pausedAt ?? new Date(0).toISOString(),
        subject: { kind: 'queue', id: 'queue', href: hrefs.overview() },
        actions: operator
          ? [{ id: 'resume', kind: 'domain', label: 'Запустить очередь', input: 'confirm' }]
          : [handoff],
        covered: [],
      },
    ];
  },
};

/**
 * S14. Ожидание проверки базы, которое снимет человек или ведущий, и
 * ожидание блокировки контекста. Появление — момент ожидания.
 */
const waitSource: AttentionSourceRule = {
  id: 'wait',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    const s = ctx.state;
    return (s.waits ?? []).flatMap((w): Candidate[] => {
      const base = {
        sourceKey: `wait:${w.kind}`,
        occurrenceId: w.at,
        source: 'wait' as const,
        since: w.at,
        subject: { kind: 'queue' as const, id: w.kind, href: hrefs.overview() },
      };
      if (w.kind === 'context-lock')
        return [
          {
            ...base,
            sourceVersion: d({ detail: w.detail }),
            category: 'technical',
            actor: 'lead',
            title: 'Выдача ждёт блокировки контекста',
            reason: w.detail,
            actions: [handoff],
          },
        ];
      const wait = baseWaitOf(h, s);
      if (!wait?.needsOperator) return [];
      const failed = wait.detail.startsWith('Проверка базы не пройдена');
      return [
        {
          ...base,
          sourceVersion: d({ detail: wait.detail, needsOperator: wait.needsOperator, failed }),
          category: failed ? 'technical' : 'decision',
          actor: failed ? 'lead' : 'operator',
          title: failed
            ? 'Проверка перенесённой базы не пройдена'
            : 'Перенос базы ждёт подтверждения',
          reason: wait.detail,
          actions: failed
            ? [handoff]
            : [
                {
                  id: 'resume',
                  kind: 'domain',
                  label: 'Подтвердить и запустить',
                  input: 'confirm',
                },
              ],
        },
      ];
    });
  },
};

/** Действия диагноза, которые не требуют человека или ведущего здесь. */
const quietActions = new Set([
  'none',
  'wait',
  'resume-queue',
  'raise-budget',
  'review-plan',
  'answer-input',
  'apply-input',
]);
const workTitles: Record<string, (title: string) => string> = {
  'diagnose-failure': (t) => `Задача «${t}» не прошла`,
  retry: (t) => `Задачу «${t}» нужно повторить`,
  'reset-attempts': (t) => `Попытки задачи «${t}» исчерпаны`,
  'replan-dependents': (t) => `Отменённая задача «${t}» держит зависимые`,
  'recovery-decision': (t) => `Разбор свойства задачи «${t}»`,
  'user-decision': (t) => `Нужно решение по задаче «${t}»`,
  'fix-environment': (t) => `Окружение не дало выполнить «${t}»`,
  'fix-access': (t) => `Нужен доступ для задачи «${t}»`,
};
const accessActions = new Set(['fix-access', 'fix-environment']);

/**
 * S10. Остановка задачи по диагнозу harness (`stopInputsOf` → `explainStop`):
 * класс отказа, план восстановления, исчерпанные попытки, отменённые корни.
 * Работа, которую контур повторит сам, карточки не даёт. Появление —
 * попытка (`runId`): тот же отказ в новой попытке — новое появление.
 */
const workSource: AttentionSourceRule = {
  id: 'work',
  engine: true,
  collect: (ctx) => {
    const { h, harness, holds } = engineOf(ctx);
    // Диагноз считается только для задач, которые могут остановиться сами:
    // упавших, отменённых, готовых с исчерпанными попытками или с эпизодом
    // восстановления. Остальные идут, ждут или ещё не утверждены — их
    // диагноз карточки не даёт, а расчёт по всем задачам дорог.
    const candidates = ctx.state.tasks.filter(
      (t) =>
        t.status === 'failed' ||
        t.status === 'cancelled' ||
        !!t.recovery ||
        (t.status === 'ready' && !t.activeRunId && t.attempt >= h.config.maxAttempts),
    );
    const inputs = candidates.flatMap((t) =>
      stopInputsOf(harness.source, {
        maxAttempts: h.config.maxAttempts,
        repairBudget: h.config.repairBudget,
        workId: t.id,
      }),
    );
    const queue = ctx.cards.get('queue');
    const out: Candidate[] = [];
    for (const input of inputs) {
      if (input.kind !== 'work') continue;
      const w = input.work;
      if (ctx.claimed.has(w.id) || holds.has(w.id) || w.hold) continue;
      // Зависимая, которая ждёт предпосылок, — влияние их карточки, не своя.
      if (w.waitingOn?.length) continue;
      const dx = explainStop(input);
      if (dx.actor !== 'lead' && dx.actor !== 'user') continue;
      if (quietActions.has(dx.action)) continue;
      // Отказ провайдера при паузе выдачи — одна карточка доступа на все задачи.
      if (dx.cause === 'provider-auth' && queue) {
        queue.covered = [...(queue.covered ?? []), w.id];
        ctx.claimed.set(w.id, queue.sourceKey);
        continue;
      }
      const title = taskTitle(ctx, w.id);
      const operator = dx.actor === 'user';
      out.push({
        sourceKey: `work:${w.id}`,
        occurrenceId:
          dx.runId ??
          input.runId ??
          (w.status === 'cancelled' ? `cancelled:a${w.attempt}` : `a${w.attempt}`),
        sourceVersion: d({
          cause: dx.cause,
          action: dx.action,
          actor: dx.actor,
          kind: w.failureKind ?? null,
          phase: dx.phase,
        }),
        source: 'work',
        category:
          accessActions.has(dx.action) || accessFailures.has(dx.cause)
            ? 'access'
            : operator && dx.action === 'user-decision'
              ? 'decision'
              : 'technical',
        actor: operator ? 'operator' : 'lead',
        title: (workTitles[dx.action] ?? ((t: string) => `Задача «${t}» остановлена`))(title),
        reason: ctx.redact(dx.message),
        since:
          ctx.state.runs.find((r) => r.id === (dx.runId ?? input.runId))?.finishedAt ??
          ctx.state.runs.findLast((r) => r.taskId === w.id)?.finishedAt ??
          ctx.state.tasks.find((t) => t.id === w.id)?.createdAt ??
          new Date(0).toISOString(),
        subject: { kind: 'task', id: w.id, href: hrefs.task(w.id) },
        evidence: dx.evidence.slice(0, ATTENTION_LIMITS.evidence).map((e) => ({
          kind: 'evidence' as const,
          id: String((e as { id?: string }).id ?? (e as { ref?: string }).ref ?? dx.runId ?? w.id),
        })),
        actions: [handoff],
        covered: [w.id],
      });
    }
    return out;
  },
};

/** Последняя отметка утверждения задач доски: решение — факт источника. */
const approvedAnchor = (tasks: readonly Task[]) =>
  tasks
    .map((t) => t.approvedAt)
    .filter((x): x is string => !!x)
    .sort()
    .at(-1) ?? 'none';

/**
 * S9. Решение по заданию ведущего на доске (агентский режим): цикл
 * остановится, задание упало и повтор поможет, вход задания не построить,
 * план не согласован. Шаг — `boardStep` пакета передачи. Если задание стоит
 * на задаче, у которой уже есть карточка задачи, отдельной карточки нет.
 * Упавшие задания ChangeSet — `stoppedWorkflows` сводки.
 */
const packNotNeeded = new Error('attention: workflow_start step is not shown');
const boardSource: AttentionSourceRule = {
  id: 'board',
  engine: true,
  collect: (ctx) => {
    const { h, harness, jobs } = engineOf(ctx);
    const out: Candidate[] = [];
    if (h.config.approvalMode === 'agent') {
      const { store } = executionOf(h);
      store.read((v) => {
        const state = store.stateOf(v);
        // Пакет нужен шагу только для `workflow_start` (идёт ли попытка без
        // задания), а такой шаг центр внимания не показывает: вместо сборки
        // всего пакета шаг прерывается и пропускается.
        const host = hostContext(h, harness, v, state, () => {
          throw packNotNeeded;
        });
        for (const board of state.boards) {
          const revision = board.revisions.at(-1);
          if (!revision) continue;
          const tasks = state.tasks.filter((t) => revision.taskIds.includes(t.id));
          if (!tasks.some(open)) continue;
          let step: ReturnType<typeof boardStep>;
          try {
            step = boardStep(board.id, host);
          } catch (error) {
            if (error === packNotNeeded) continue;
            throw error;
          }
          if (!step || !['decide', 'fix-input', 'workflow_retry'].includes(step.action)) continue;
          const stopped = step.loop && 'taskId' in step.loop ? step.loop.taskId : undefined;
          const work = stopped ? ctx.cards.get(`work:${stopped}`) : undefined;
          if (work) {
            // Свёртка: задание стоит на задаче, у которой уже есть карточка.
            work.boards = [...new Set([...(work.boards ?? []), board.id])];
            continue;
          }
          const occurrenceId =
            step.decision === 'plan'
              ? `plan:r${revision.number}:${approvedAnchor(tasks)}`
              : step.job
                ? `job:${step.job.key}:${step.job.attempts}`
                : `input:r${revision.number}:${d(step.detail).slice(0, 12)}`;
          const drafts = step.plan?.drafts ?? [];
          out.push({
            sourceKey: `board:${board.id}`,
            occurrenceId,
            sourceVersion: d({
              action: step.action,
              decision: step.decision ?? null,
              loop: step.loop ?? null,
              drafts,
              blocked: step.plan?.blocked.map((b) => b.id) ?? [],
            }),
            source: 'board',
            category: 'technical',
            actor: 'lead',
            title:
              step.decision === 'plan'
                ? `План доски «${board.title}» не согласован`
                : step.action === 'fix-input'
                  ? `Задание доски «${board.title}» не построить`
                  : step.action === 'workflow_retry'
                    ? `Задание доски «${board.title}» упало`
                    : `Задание доски «${board.title}» требует решения`,
            reason: ctx.redact(step.detail),
            since: step.job
              ? (jobs.find((j) => j.key === step.job!.key)?.history.at(-1)?.at ??
                revision.createdAt)
              : revision.createdAt,
            subject: { kind: 'board', id: board.id, href: hrefs.board(board.id) },
            actions: [handoff],
            covered: unclaimed(ctx, drafts),
            boards: [board.id],
          });
        }
      });
    }
    for (const w of stoppedWorkflows(ctx.state as DevContourState, jobs))
      if (w.kind === 'changeset')
        out.push({
          sourceKey: `workflow:changeset:${w.id}`,
          occurrenceId: `${w.key}:${w.attempts}`,
          sourceVersion: d(w.error ?? ''),
          source: 'board',
          category: 'technical',
          actor: 'lead',
          title: 'Автоматическое восстановление ChangeSet остановлено',
          reason: ctx.redact(w.error ?? ''),
          since: w.history.at(-1)?.at ?? w.startedAt,
          subject: { kind: 'changeset', id: w.id, href: hrefs.changesets() },
          actions: [handoff],
        });
    return out;
  },
};

/**
 * S6. План доски не согласован в режиме `approvalMode: operator`: решение
 * оператора. Действие — утверждение с CAS ревью (`expected`): правка задачи
 * между показом и решением отклоняется самим `approve`. Появление — ревизия
 * и последнее утверждение её задач (новый черновик после утверждения —
 * новое появление).
 */
const planSource: AttentionSourceRule = {
  id: 'plan',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    if (h.config.approvalMode !== 'operator') return [];
    const s = ctx.state as DevContourState;
    return s.boards.flatMap((board): Candidate[] => {
      const found = boardTasks(s, board.id);
      if (!found || found.revision.status !== 'active') return [];
      if (planApproved(h, found.revision, found.tasks)) return [];
      const why = unapprovedTasks(h, s, found.tasks);
      const held = new Set([...why.blocked.map((b) => b.id), ...why.unverified]);
      const approvable = [...why.drafts.filter((id) => !held.has(id)), ...why.stale];
      if (!approvable.length && !why.drafts.length) return [];
      const byId = new Map(found.tasks.map((t) => [t.id, t]));
      const shown = Object.fromEntries(approvable.map((id) => [id, specDigest(byId.get(id)!)]));
      const blocked = why.blocked.map((b) => `${b.id} — ${b.reason}`);
      const base = {
        sourceKey: `plan:${board.id}`,
        occurrenceId: `r${found.revision.number}:${approvedAnchor(found.tasks)}`,
        sourceVersion: d({
          taskIds: found.revision.taskIds,
          drafts: why.drafts.map((id) => [id, specDigest(byId.get(id)!)]),
          stale: why.stale,
          blocked: why.blocked.map((b) => b.id),
          unverified: why.unverified,
        }),
        source: 'plan' as const,
        since: found.revision.createdAt,
        subject: { kind: 'board' as const, id: board.id, href: hrefs.board(board.id) },
        covered: unclaimed(ctx, why.drafts),
        boards: [board.id],
      };
      if (!approvable.length)
        return [
          {
            ...base,
            category: 'technical',
            actor: 'lead',
            title: `Черновики доски «${board.title}» не готовы к утверждению`,
            reason: blocked.join('; ') || `Неразобранные находки: ${why.unverified.join(', ')}`,
            actions: [handoff],
          },
        ];
      return [
        {
          ...base,
          category: 'decision',
          actor: 'operator',
          title: `Утвердите план доски «${board.title}»`,
          reason:
            `Черновиков: ${why.drafts.length}` +
            (why.stale.length ? `, утверждённых при другой политике: ${why.stale.length}` : '') +
            (blocked.length ? `. Не пройдут утверждение: ${blocked.join('; ')}` : ''),
          actions: [{ id: 'approve', kind: 'domain', label: 'Утвердить план', input: 'confirm' }],
          basis: {
            boardId: board.id,
            approvable,
            expected: {
              revision: found.revision.number,
              taskIds: found.revision.taskIds,
              tasks: shown,
              reason: found.revision.reason,
            },
          },
        },
      ];
    });
  },
};

/**
 * S16. Проверенное изменение ждёт приёмки (`pendingAcceptances` сводки).
 * Появление — текущая совместная проверка.
 */
const changesetSource: AttentionSourceRule = {
  id: 'changeset',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    return pendingAcceptances(h, ctx.state as DevContourState).map(
      ({ changeSet: c, verification: v, onPreview }): Candidate => {
        const deploy = !onPreview && !!h.config.preview;
        return {
          sourceKey: `changeset:${c.id}`,
          occurrenceId: v.id,
          sourceVersion: d({ manifest: v.manifestDigest, onPreview, deploy }),
          source: 'changeset',
          category: 'decision',
          actor: 'operator',
          title: `Примите «${c.title}»`,
          reason: onPreview
            ? 'Изменение прошло совместную проверку и работает в preview: попробуйте и примите.'
            : deploy
              ? 'Изменение прошло совместную проверку. Можно выложить его в preview и попробовать до приёмки.'
              : 'Изменение прошло совместную проверку.',
          since: v.finishedAt ?? v.startedAt,
          subject: { kind: 'changeset', id: c.id, href: hrefs.changesets() },
          evidence: [{ kind: 'evidence', id: v.id }],
          actions: [
            ...(deploy
              ? [
                  {
                    id: 'deploy-preview',
                    kind: 'domain' as const,
                    label: 'Выложить в preview',
                    input: 'confirm' as const,
                  },
                ]
              : []),
            { id: 'accept', kind: 'domain', label: 'Принять', input: 'confirm' },
          ],
          basis: { changeSetId: c.id, verificationId: v.id },
        };
      },
    );
  },
};

/**
 * S17. Неисправность preview (`previewProblems` сводки): нет Docker —
 * доступ оператора; сбой выкладки или потерянная версия — ведущий.
 * Появление — запись выкладки.
 */
const previewSource: AttentionSourceRule = {
  id: 'preview',
  engine: true,
  collect: (ctx) => {
    const { failure, lost } = previewProblems(ctx.state);
    const out: Candidate[] = [];
    if (failure) {
      const docker = failure.failure === 'docker-unavailable';
      out.push({
        sourceKey: docker ? 'preview:docker' : 'preview:failed',
        occurrenceId: failure.id,
        sourceVersion: d({
          status: failure.status,
          failure: failure.failure ?? null,
          rolledBack: !!failure.rolledBack,
        }),
        source: 'preview',
        category: docker ? 'access' : 'technical',
        actor: docker ? 'operator' : 'lead',
        title: docker ? 'Нужен Docker для preview' : 'Preview не выложен',
        reason: docker
          ? 'Preview собирается и запускается в Docker. Запустите Docker и повторите выкладку.'
          : ctx.redact(
              (failure.rolledBack ? 'Возвращена прежняя версия. ' : '') +
                (failure.error ?? 'Причина не записана'),
            ),
        since: failure.finishedAt ?? failure.startedAt,
        subject: { kind: 'preview', id: failure.id, href: hrefs.changesets() },
        ...(docker ? {} : { actions: [handoff] }),
      });
    }
    if (lost)
      out.push({
        sourceKey: 'preview:lost',
        occurrenceId: lost.id,
        sourceVersion: d({ status: lost.status, lost: lost.lost ?? null }),
        source: 'preview',
        category: 'technical',
        actor: 'lead',
        title: 'Версия в preview не отвечает',
        reason: ctx.redact(lost.lost ?? ''),
        since: lost.checkedAt ?? lost.healthyAt ?? lost.startedAt,
        subject: { kind: 'preview', id: lost.id, href: hrefs.changesets() },
        actions: [handoff],
      });
    return out;
  },
};

/** S18. Новая версия корпуса проверок ждёт подтверждения оператора. */
const corpusSource: AttentionSourceRule = {
  id: 'corpus',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    return new CheckCorpus(h).all().flatMap((suite) =>
      suite.pending
        .filter((p) => p.status === 'waiting' && p.awaitingOperator)
        .map((p): Candidate => ({
          sourceKey: `corpus:${suite.id}:${p.id}`,
          occurrenceId: p.id,
          sourceVersion: p.digest ?? `v${p.version}`,
          source: 'corpus',
          category: 'decision',
          actor: 'operator',
          title: 'Принятие версии корпуса проверок ждёт подтверждения',
          reason: one(p.reason),
          since: (p as { at?: string }).at ?? new Date(0).toISOString(),
          subject: { kind: 'suite', id: suite.id, href: hrefs.contracts() },
          actions: [{ id: 'approve', kind: 'domain', label: 'Подтвердить', input: 'confirm' }],
          covered: unclaimed(ctx, p.tasks),
          basis: { suiteId: suite.id, pendingId: p.id },
        })),
    );
  },
};

/**
 * S19. Зависшая попытка или проверка, когда обход зависаний только сообщает
 * (`stallSweep.action: report`): нужен человек. Версия — состояние живости,
 * никогда не время простоя. Появление — попытка и последнее движение
 * (движение и новое зависание — новое появление).
 */
const stallSource: AttentionSourceRule = {
  id: 'stall',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    const s = ctx.state as DevContourState;
    const runs = quietAttempts(s, ctx.now)
      .filter((a) => a.attention)
      .map((a): Candidate => ({
        sourceKey: `stall:${a.runId}`,
        occurrenceId: `${a.runId}@${a.lastMovementAt}`,
        sourceVersion: a.state,
        source: 'stall',
        category: 'access',
        actor: 'operator',
        title: `Попытка задачи «${a.title}» не двигается`,
        reason: `${a.text}. ${a.next}`,
        since: a.since,
        subject: { kind: 'run', id: a.runId, href: hrefs.task(a.taskId) },
        covered: unclaimed(ctx, [a.taskId]),
      }));
    const operations = quietOperations(h, s, ctx.now, 'panel')
      .filter((o) => o.attention)
      .map((o): Candidate => ({
        sourceKey: `stall-op:${o.kind}:${o.id}`,
        occurrenceId: `${o.id}@${o.lastMovementAt}`,
        sourceVersion: o.state,
        source: 'stall',
        category: 'access',
        actor: 'operator',
        title: `${o.title}: проверка не двигается`,
        reason: `${o.text}. ${o.next}`,
        since: o.since,
        subject: { kind: 'operation', id: o.id, href: hrefs.overview() },
      }));
    return [...runs, ...operations];
  },
};

/** Предел записей очереди обращений, которые читает одно чтение центра. */
const DISCUSSION_ITEMS = 500;

/**
 * S7. Обращение к ведущему из обсуждения задачи ждёт обработки (очередь
 * `discussion_inbox`). Предмет — цепочка исправлений обращения (первое
 * сообщение); появление — последняя обработка любой версии цепочки, а без
 * неё — само обращение. Исправление необработанного обращения — версия;
 * ответ оператора на «нужен ответ» или исправление после него — новое
 * появление.
 */
const discussionRequestSource: AttentionSourceRule = {
  id: 'discussion-request',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    const service = new DiscussionService(h);
    const out: Candidate[] = [];
    let cursor: string | undefined;
    do {
      const page = service.inbox({ limit: 50, ...(cursor ? { cursor } : {}) }, 1_000_000, {
        redact: ctx.redact,
      });
      for (const entry of page.requests) {
        if (out.length >= DISCUSSION_ITEMS) break;
        const task = ctx.state.tasks.find((t) => t.id === entry.taskId);
        const chain = task ? service.chain(taskOwner(task), entry.id) : undefined;
        const root = chain?.rootId ?? entry.id;
        out.push({
          sourceKey: `discussion:cr:${root}`,
          occurrenceId: chain?.dispositionId ?? root,
          sourceVersion: d({ latestId: entry.id, answerId: entry.reopened?.answerId ?? null }),
          source: 'discussion-request',
          category: 'technical',
          actor: 'lead',
          title: entry.reopened
            ? `Оператор ответил на вопрос ведущего по задаче «${taskTitle(ctx, entry.taskId)}»`
            : `Обращение к ведущему по задаче «${taskTitle(ctx, entry.taskId)}»`,
          reason: entry.excerpt,
          since: entry.createdAt,
          subject: { kind: 'task', id: entry.taskId, href: hrefs.task(entry.taskId) },
          evidence: [{ kind: 'message', id: entry.id }],
          actions: [
            {
              id: 'handoff',
              kind: 'handoff',
              command: 'discussion_inbox, then discussion_resolve',
            },
          ],
        });
      }
      cursor = out.length < DISCUSSION_ITEMS ? page.nextCursor : undefined;
    } while (cursor);
    return out;
  },
};

/**
 * S8. Ведущий ответил на обращение «нужен ответ»: ответ оператора. Появление
 * и версия — обработка; ответ оператора или исправление обращения снимает.
 */
const discussionNeedsAnswerSource: AttentionSourceRule = {
  id: 'discussion-needs-answer',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    const service = new DiscussionService(h);
    return service.awaitingOperator(DISCUSSION_ITEMS).map((row): Candidate => {
      const root = service.chain(row.owner, row.request.id)?.rootId ?? row.request.id;
      const disposition = h.store.discussionById(row.owner, row.dispositionId) as
        { text?: string } | undefined;
      return {
        sourceKey: `discussion:na:${root}`,
        occurrenceId: row.dispositionId,
        sourceVersion: row.dispositionId,
        source: 'discussion-needs-answer',
        category: 'question',
        actor: 'operator',
        title: `Ведущий просит ответа по задаче «${taskTitle(ctx, row.request.taskId)}»`,
        reason: ctx.redact(disposition?.text ?? row.request.text),
        since: row.at,
        subject: {
          kind: 'task',
          id: row.request.taskId,
          href: hrefs.task(row.request.taskId),
        },
        evidence: [
          { kind: 'message', id: row.request.id },
          { kind: 'message', id: row.dispositionId },
        ],
        actions: [{ id: 'answer', kind: 'domain', label: 'Ответить', input: 'text' }],
        basis: {
          taskId: row.request.taskId,
          dispositionId: row.dispositionId,
          threadVersion: row.version,
        },
      };
    });
  },
};

/**
 * Источники движка в порядке владения корнями: удержание операцией, бюджет,
 * пауза (свёртка отказов провайдера), ожидания, задача, доска, план.
 */
export const engineSources: AttentionSourceRule[] = [
  contractChangeSource,
  budgetSource,
  queueSource,
  waitSource,
  workSource,
  boardSource,
  planSource,
  discussionNeedsAnswerSource,
  discussionRequestSource,
  changesetSource,
  previewSource,
  corpusSource,
  stallSource,
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
    return [...preparationSources, ...engineSources, ...(this.options.sources ?? [])];
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
      redact: this.h
        ? handoffRedactor(this.h.config, executionOf(this.h).engine.policy)
        : (text) => text,
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
