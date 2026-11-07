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
import { checkJsonBytes, queuePause, explainStop, stopInputsOf } from 'devcontour-harness';
import { randomUUID } from 'node:crypto';
import { SERVER_STOPPING, digest, specDigest } from '../core/service.ts';
import { repositories } from '../core/repositories.ts';
import { Workspace } from '../core/workspace.ts';
import { IntentService } from '../runner/intent.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { CheckCorpus } from '../core/check-store.ts';
import { executionOf } from '../harness/execution.ts';
import { ContractChanges } from '../runner/contract-change.ts';
import { boardTasks, planApproved, unapprovedTasks } from '../runner/lead-outlook.ts';
import { boardStep, handoffRedactor, harnessOf, hostContext } from './handoff.ts';
import { pendingAcceptances, previewProblems, stoppedWorkflows } from './overview.ts';
import { budgetBlocks, budgetHint } from './context.ts';
import { InputService, inputHolds } from './input.ts';
import { inputReviewRounds } from '../harness/input-host.ts';
import { DiscussionService } from './discussion.ts';
import { taskOwner } from '../core/sync-state.ts';
import { baseWaitOf, queueStopOf, quietAttempts, quietOperations } from './queue-stop.ts';
import type { DevContour } from '../core/service.ts';
import type { Store } from '../core/store.ts';
import type { DevContourState, Task } from '../core/model.ts';
import { DomainError } from '../core/model.ts';
import { descendants } from '../core/graph.ts';
import { Preparation, assertStageUpstream } from '../core/preparation.ts';
import type { ProductChange } from '../core/preparation-model.ts';
import {
  ATTENTION_LIMITS,
  attentionInputs,
  attentionMark,
  categoryRank,
  type AttentionAction,
  type AttentionActor,
  type AttentionCategory,
  type AttentionHistoryItem,
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

/** Бюджет списка `attention_list` в ответе агентского API (предел ответа 64 KiB). */
const AGENT_LIST_BYTES = 56_000;

/** Пространство локальных отметок оператора: не исполняемое состояние, не Git sync. */
export const ATTENTION_NAMESPACE = 'attention';

/** Короткий digest для версий и появлений: только сравнение на равенство. */
const d = (value: unknown) => digest(value).slice(0, 32);
const clip = (text: string, n: number) => (text.length > n ? text.slice(0, n - 1) + '…' : text);
const one = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Ссылки панели: вид задаётся параметрами адреса. */
export const hrefs = {
  /** Изменение подготовки; этап и якорь ведут к его вопросам. */
  preparation: (changeId?: string, stage?: string, anchor?: string) =>
    (changeId
      ? `/?change=${encodeURIComponent(changeId)}` +
        (stage ? `&stage=${encodeURIComponent(stage)}` : '')
      : '/') + (anchor ? `#${anchor}` : ''),
  // Панель разработки внутри оболочки подготовки показывается с view=boards;
  // без подготовки параметр безвреден.
  task: (taskId: string) => `/?view=boards&tab=list&task=${encodeURIComponent(taskId)}`,
  /** Сообщение обсуждения задачи (якорь `dm-<id>`). */
  message: (taskId: string, messageId: string) =>
    `/?view=boards&tab=list&task=${encodeURIComponent(taskId)}#dm-${messageId}`,
  board: (boardId: string) => `/?view=boards&tab=graph&board=${encodeURIComponent(boardId)}`,
  changesets: () => '/?view=boards&tab=changesets',
  contracts: () => '/?view=boards&tab=contracts',
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
  /**
   * Решённые появления по долговечному факту решения источника (история).
   * Источник без такого факта истории не даёт.
   */
  history?(ctx: AttentionContext): Resolved[];
}
/** Решённое появление: карточка, какой она была, и момент решения. */
export type Resolved = Candidate & { resolvedAt: string | null };

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
          subject: {
            kind: 'change',
            id: c.id,
            href: hrefs.preparation(c.id, q.stage, `questions-${q.stage}`),
          },
          actions: [
            {
              id: 'answer',
              kind: 'domain',
              label: 'Ответить',
              input: q.options.length ? 'text+option' : 'text',
              prompt: q.text + (q.why ? `\n\n${q.why}` : ''),
              ...(q.options.length
                ? { choices: q.options.map((label, i) => ({ id: String(i), label })) }
                : {}),
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
            actions: [preparationHandoff(ctx)],
            since: withdrawn ?? q.answer.at,
            subject: {
              kind: 'change',
              id: c.id,
              href: hrefs.preparation(c.id, q.stage, `questions-${q.stage}`),
            },
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
          subject: { kind: 'change' as const, id: c.id, href: hrefs.preparation(c.id, stage) },
        };
        if (refusal)
          return [
            {
              ...base,
              actor: 'lead',
              category: 'technical',
              title: `Редакция «${stageTitles[stage]}» относится к прежней постановке`,
              reason: `${refusal}: ведущий отправляет новую редакцию`,
              actions: [preparationHandoff(ctx)],
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
            actions: [preparationHandoff(ctx)],
            since: r.decision?.at ?? r.createdAt,
            subject: { kind: 'change', id: c.id, href: hrefs.preparation(c.id, stage) },
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
          actions: [preparationHandoff(ctx)],
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
/** Каталог workspace для команд передачи: из параметров сервиса или конфигурации. */
function workspaceOf(ctx: AttentionContext) {
  return ctx.root ?? ctx.h?.config.workspaceRoot ?? '<workspace>';
}
/** Передача ведущему после setup: пакет новой сессии (MCP или CLI). */
function handoffOf(ctx: AttentionContext): AttentionAction {
  return {
    id: 'handoff',
    kind: 'handoff',
    command: `session_handoff (MCP) или devcontour session-handoff --workspace ${workspaceOf(ctx)}`,
  };
}
/** Передача ведущему по подготовке: состояние этапов, вопросов и решений. */
function preparationHandoff(ctx: AttentionContext): AttentionAction {
  return {
    id: 'handoff',
    kind: 'handoff',
    command: `preparation_status (MCP) или devcontour agent --file request.json --workspace ${workspaceOf(ctx)} с {"operation": "preparation_status"}`,
  };
}

/** Состояния вопроса исполнителя, в которых кто-то должен действовать. */
const inputActionable = new Set([
  'awaiting-answer',
  'answer-saved',
  'review-rejected',
  'stale',
  'context-review',
  'ready-to-apply',
]);

/**
 * S15. Вопрос исполнителя (`InputService.list`: состояние и кто действует).
 * Предмет и появление — запрос: новая попытка задаёт новый запрос. Раунд
 * ревью ответа версию запроса не меняет, поэтому состояние и раунд — в
 * версии. Блокирующий вопрос забирает задачу первым: отказ ожидания ответа
 * не становится карточкой задачи.
 */
const inputSource: AttentionSourceRule = {
  id: 'input',
  engine: true,
  collect: (ctx) => {
    const { h } = engineOf(ctx);
    const { engine } = executionOf(h);
    const operatorMode = h.config.approvalMode === 'operator';
    return new InputService(h, ctx.root)
      .list()
      .requests.filter((r) => inputActionable.has(r.state))
      .map((r): Candidate => {
        const operator = r.actor === 'operator';
        const title = taskTitle(ctx, r.taskId);
        let question = '';
        let options: { id: string; label: string; consequence: string | null }[] = [];
        let recommended: string | null = null;
        try {
          const asked = engine.inputRequest(r.requestId).question;
          question = asked.question;
          options = asked.options;
          recommended = asked.recommended;
        } catch {
          /* Запрос не найден: карточка остаётся по сводке. */
        }
        // Оператор отвечает на ожидающий вопрос и исправляет ответ, который
        // отклонило ревью (как в карточке задачи).
        const answer = operator && (r.state === 'awaiting-answer' || r.state === 'review-rejected');
        // Отклонённое ревью (D03 `review-rejected`): в режиме operator ответ
        // применяют только подтверждением показанного раунда — то же правило
        // `InputService.apply`, что у панели; его находки — в карточке.
        const rejected = r.state === 'review-rejected';
        const apply =
          operator &&
          operatorMode &&
          (r.state === 'ready-to-apply' || (rejected && !r.problems?.length));
        let findings = '';
        if (rejected)
          engine.read((v) => {
            const last = inputReviewRounds(v, r.requestId).at(-1);
            findings = last ? last.summary : '';
          });
        return {
          sourceKey: `input:${r.requestId}`,
          occurrenceId: r.requestId,
          sourceVersion: `${r.version}:${r.state}:${r.round ?? 0}`,
          source: 'input',
          category: operator ? 'question' : 'technical',
          actor: operator ? 'operator' : 'lead',
          title: !r.blocking
            ? `Решение исполнителя по задаче «${title}» ждёт ведущего`
            : answer
              ? `Исполнитель спрашивает по задаче «${title}»`
              : apply
                ? `Ответ по задаче «${title}» готов к применению`
                : `Вопрос исполнителя по задаче «${title}»: ${r.state}`,
          reason: ctx.redact(
            (rejected ? `Ревью отклонило ответ (раунд ${r.round}): ${findings} — ` : '') +
              (question ? `${question} — ${r.next}` : r.next),
          ),
          since: r.createdAt,
          subject: { kind: 'request', id: r.requestId, href: hrefs.task(r.taskId) + '#input' },
          actions: [
            ...(answer
              ? [
                  {
                    id: 'answer',
                    kind: 'domain' as const,
                    label: 'Ответить',
                    input: 'text+option' as const,
                    ...(question ? { prompt: question } : {}),
                    ...(options.length
                      ? {
                          choices: options.map((o) => ({
                            id: o.id,
                            label: o.label,
                            ...(o.consequence ? { hint: o.consequence } : {}),
                            ...(o.id === recommended ? { recommended: true } : {}),
                          })),
                        }
                      : {}),
                  },
                ]
              : []),
            ...(apply
              ? [
                  {
                    id: 'apply',
                    kind: 'domain' as const,
                    label: rejected
                      ? `Применить вопреки ревью (раунд ${r.round})`
                      : 'Применить ответ',
                    input: 'confirm' as const,
                    ...(rejected && r.round !== undefined
                      ? { round: r.round, prompt: findings }
                      : {}),
                  },
                ]
              : []),
            ...(operator ? [] : [handoffOf(ctx)]),
          ],
          covered: r.blocking ? unclaimed(ctx, [r.taskId]) : [],
          basis: {
            options: options.map((o) => ({ id: o.id, label: o.label })),
            taskId: r.taskId,
            requestId: r.requestId,
            expectedVersion: r.version,
            ...(rejected && r.round !== undefined ? { rejectedRound: r.round } : {}),
          },
        };
      });
  },
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
          actions: [handoffOf(ctx)],
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
          // Предел исчерпан снова после решения: снятие и возврат предела идут
          // через применение конфигурации, его момент и есть новый факт.
          occurrenceId: d({
            limit: b.limit,
            onUnknown: overview.onUnknown,
            applied: ctx.state.appliedConfig?.at ?? null,
          }),
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
          : [handoffOf(ctx)],
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
            actions: [handoffOf(ctx)],
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
            ? [handoffOf(ctx)]
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
 * Якорь появления отменённого корня — самая ранняя открытая задача, прямо
 * ждущая его (создание или утверждение): новая ждущая рядом с прежними
 * появление не меняет, а после решения (ждущих не осталось) новая ждущая —
 * новое появление. Сдвигается, только если ранняя ждущая сама ушла, пока
 * другие ещё ждут.
 */
function dependentsAnchor(ctx: AttentionContext, id: string) {
  return (
    ctx.state.tasks
      .filter((t) => t.dependsOn.includes(id) && t.status !== 'done' && t.status !== 'cancelled')
      .map((t) => t.approvedAt ?? t.createdAt ?? '')
      .sort()[0] ?? 'none'
  );
}
/**
 * Диагноз остановки задач-кандидатов (harness `stopInputsOf`) — единственное
 * место вызова: переход на пакетный вызов harness по набору поручений —
 * замена здесь. Пока — по одному вызову на поручение: полный вызов по всему
 * виду на сотнях задач стоит секунды (обход ждущих транзитивен).
 */
export function diagnose(
  source: ReturnType<typeof harnessOf>['source'],
  h: DevContour,
  workIds: readonly string[],
) {
  const options = { maxAttempts: h.config.maxAttempts, repairBudget: h.config.repairBudget };
  return workIds.flatMap((workId) => stopInputsOf(source, { ...options, workId }));
}

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
    const awaited = new Set(
      ctx.state.tasks
        .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
        .flatMap((t) => t.dependsOn),
    );
    const candidates = ctx.state.tasks.filter(
      (t) =>
        t.status === 'failed' ||
        // Отменённая — решение, только пока её прямо ждут открытые задачи.
        (t.status === 'cancelled' && awaited.has(t.id)) ||
        (!!t.recovery && t.status !== 'done' && t.status !== 'cancelled') ||
        (t.status === 'ready' && !t.activeRunId && t.attempt >= h.config.maxAttempts),
    );
    const inputs = diagnose(
      harness.source,
      h,
      candidates.map((t) => t.id),
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
        // Отменённый корень решается, когда его перестают ждать, и возникает
        // снова, когда появляется новая ждущая задача: появление — последняя
        // ждущая (её создание или утверждение), а не прежняя попытка.
        occurrenceId:
          w.status === 'cancelled'
            ? `cancelled:${dependentsAnchor(ctx, w.id)}`
            : (dx.runId ?? input.runId ?? `a${w.attempt}`),
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
        actions: [handoffOf(ctx)],
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
            actions: [handoffOf(ctx)],
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
          actions: [handoffOf(ctx)],
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
            actions: [handoffOf(ctx)],
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
        ...(docker ? {} : { actions: [handoffOf(ctx)] }),
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
        actions: [handoffOf(ctx)],
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
          subject: { kind: 'task', id: entry.taskId, href: hrefs.message(entry.taskId, entry.id) },
          evidence: [
            { kind: 'message', id: entry.id, href: hrefs.message(entry.taskId, entry.id) },
          ],
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
        sourceVersion: `${row.dispositionId}:${row.version}`,
        source: 'discussion-needs-answer',
        category: 'question',
        actor: 'operator',
        title: `Ведущий просит ответа по задаче «${taskTitle(ctx, row.request.taskId)}»`,
        reason: ctx.redact(disposition?.text ?? row.request.text),
        since: row.at,
        subject: {
          kind: 'task',
          id: row.request.taskId,
          href: hrefs.message(row.request.taskId, row.dispositionId),
        },
        evidence: [
          {
            kind: 'message',
            id: row.request.id,
            href: hrefs.message(row.request.taskId, row.request.id),
          },
          {
            kind: 'message',
            id: row.dispositionId,
            href: hrefs.message(row.request.taskId, row.dispositionId),
          },
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
 * Источники движка в порядке владения корнями: вопрос исполнителя,
 * удержание операцией, бюджет,
 * пауза (свёртка отказов провайдера), ожидания, задача, доска, план.
 */
export const engineSources: AttentionSourceRule[] = [
  inputSource,
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
/* Действия с карточек: существующие доменные операции                 */
/* ------------------------------------------------------------------ */

/** Зависимости действий, которые есть только у работающего сервера. */
export interface AttentionActDeps {
  /** Такт очереди после её запуска (`/api/scheduler`). */
  tick?: () => Promise<unknown>;
  /** Выкладка preview (`PreviewRunner.deploy`), идёт минутами. */
  deploy?: (changeSetId: string) => Promise<unknown>;
  /** Сервер останавливается: запуск очереди отклоняется. */
  stopping?: () => boolean;
}
interface ActOutcome {
  result?: unknown;
  /** Продолжение после транзакции: такт очереди, начало выкладки. */
  after?: () => Promise<unknown>;
}
export interface ActContext {
  ctx: AttentionContext;
  item: Candidate;
  input: {
    text?: string;
    optionId?: string;
    comment?: string;
    kind?: 'clarification' | 'requirement-change';
    confirmRejectedRound?: number;
  };
  key: string | undefined;
  deps: AttentionActDeps;
  root: string | undefined;
}
const basisOf = <T>(item: Candidate) => item.basis as T;
const textOf = (input: ActContext['input']) => {
  const text = (input.text ?? input.comment ?? '').trim();
  if (!text) throw new DomainError('Введите текст', 400);
  return text;
};
/** Запуск очереди с карточки — тот же путь, что `/api/scheduler {start: true}`. */
const resume = ({ ctx, deps }: ActContext): ActOutcome => {
  if (deps.stopping?.()) throw new DomainError(SERVER_STOPPING, 409);
  const result = ctx.h!.pause(false);
  return {
    result,
    ...(deps.tick ? { after: async () => (await deps.tick!(), result) } : {}),
  };
};

/**
 * Действия, доменная операция которых сама сверяет показанное основание
 * (digest редакции, поля ревью плана, версия треда или запроса, id ожидания):
 * они исполняются после проверки карточки, вне её транзакции, с полями
 * проверенной версии — расхождение между проверкой и операцией отклонит
 * сама операция. Остальные (запуск очереди, приёмка ChangeSet) проверяют
 * карточку и исполняются в одной транзакции.
 */
const ownCas = new Set([
  'prep-question/answer',
  'prep-stage/approve',
  'prep-stage/request-changes',
  'plan/approve',
  'discussion-needs-answer/answer',
  'input/answer',
  'input/apply',
  'corpus/approve',
  'changeset/deploy-preview',
]);

/** Источник по ключу карточки: перепроверка одной карточки без всей проекции. */
export function sourceOfKey(key: string): AttentionSource | undefined {
  const prefixes: [string, AttentionSource][] = [
    ['prep:qa:', 'prep-answer-pending'],
    ['prep:q:', 'prep-question'],
    ['prep:stage:', 'prep-stage'],
    ['prep:rework:', 'prep-rework'],
    ['quick:', 'quick'],
    ['plan:', 'plan'],
    ['discussion:cr:', 'discussion-request'],
    ['discussion:na:', 'discussion-needs-answer'],
    ['board:', 'board'],
    ['workflow:', 'board'],
    ['work:', 'work'],
    ['budget:', 'budget'],
    ['contract-change:', 'contract-change'],
    ['wait:', 'wait'],
    ['input:', 'input'],
    ['changeset:', 'changeset'],
    ['preview:', 'preview'],
    ['corpus:', 'corpus'],
    ['stall-op:', 'stall'],
    ['stall:', 'stall'],
  ];
  if (key === 'queue') return 'queue';
  return prefixes.find(([prefix]) => key.startsWith(prefix))?.[1];
}

const actionHandlers: Record<string, (a: ActContext) => ActOutcome> = {
  'prep-question/answer': ({ ctx, item, input }) => {
    const b = basisOf<{ changeId: string; questionId: string; options: string[] }>(item);
    const option = input.optionId !== undefined ? b.options[Number(input.optionId)] : undefined;
    const text = input.text?.trim() || option;
    if (!text) throw new DomainError('Введите ответ или выберите вариант', 400);
    new Preparation(ctx.store, 'operator').answer({
      changeId: b.changeId,
      questionId: b.questionId,
      text,
    });
    return { result: { changeId: b.changeId, questionId: b.questionId } };
  },
  'prep-stage/approve': ({ ctx, item, input }) => {
    const b = basisOf<{ changeId: string; stage: string; expectedDigest: string }>(item);
    new Preparation(ctx.store, 'operator').decide({
      ...b,
      decision: 'approve',
      comment: (input.comment ?? input.text ?? '').trim(),
    });
    return { result: { ...b, decision: 'approve' } };
  },
  'prep-stage/request-changes': ({ ctx, item, input }) => {
    const b = basisOf<{ changeId: string; stage: string; expectedDigest: string }>(item);
    new Preparation(ctx.store, 'operator').decide({
      ...b,
      decision: 'request-changes',
      comment: textOf(input),
    });
    return { result: { ...b, decision: 'request-changes' } };
  },
  'plan/approve': ({ ctx, item }) => {
    const b = basisOf<{
      boardId: string;
      approvable: string[];
      expected: {
        revision: number;
        taskIds: string[];
        tasks: Record<string, string>;
        reason: string;
      };
    }>(item);
    return {
      result: ctx.h!.approve(b.boardId, b.approvable, { actor: 'operator' }, b.expected),
    };
  },
  'discussion-needs-answer/answer': ({ ctx, item, input, key }) => {
    const b = basisOf<{ taskId: string; dispositionId: string; threadVersion: number }>(item);
    const posted = new DiscussionService(ctx.h!).post(
      {
        taskId: b.taskId,
        kind: 'note',
        text: textOf(input),
        replyTo: b.dispositionId,
        expectedVersion: b.threadVersion,
        idempotencyKey: key ?? 'attention-' + randomUUID(),
      },
      'operator',
    );
    return { result: { messageId: posted.message.id, version: posted.version } };
  },
  'queue/resume': resume,
  'wait/resume': resume,
  'input/answer': ({ ctx, item, input, key, root }) => {
    const b = basisOf<{
      taskId: string;
      requestId: string;
      expectedVersion: number;
      options?: { id: string; label: string }[];
    }>(item);
    // Выбранный вариант без текста — ответ этим вариантом (как у вопроса
    // подготовки): правило D03 хранит текст ответа, им становится вариант.
    const option = b.options?.find((o) => o.id === input.optionId)?.label;
    const text = input.text?.trim() || option;
    if (!text) throw new DomainError('Введите ответ или выберите вариант', 400);
    return {
      result: new InputService(ctx.h!, root).answerInTask(b.taskId, b.requestId, {
        text,
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        expectedVersion: b.expectedVersion,
        ...(key ? { idempotencyKey: key } : {}),
      }),
    };
  },
  'input/apply': ({ ctx, item, input, root }) => {
    const b = basisOf<{ taskId: string; requestId: string; expectedVersion: number }>(item);
    // Правило D03 одно для панели и центра: отклонённый раунд применяется
    // только с подтверждением именно этого раунда, сверка — в транзакции
    // применения (`InputService.apply`).
    return {
      result: new InputService(ctx.h!, root).applyInTask(b.taskId, b.requestId, {
        expectedVersion: b.expectedVersion,
        ...(input.confirmRejectedRound !== undefined
          ? { confirmRejectedRound: input.confirmRejectedRound }
          : {}),
      }),
    };
  },
  'changeset/accept': ({ ctx, item }) => {
    const b = basisOf<{ changeSetId: string }>(item);
    return {
      result: new Workspace(ctx.h!, new IntentService(ctx.h!)).accept(b.changeSetId, {
        actor: 'operator',
      }),
    };
  },
  'changeset/deploy-preview': ({ item, deps }) => {
    const b = basisOf<{ changeSetId: string }>(item);
    if (!deps.deploy) throw new DomainError('Выкладка preview доступна в работающей панели', 409);
    return {
      after: () => {
        // Выкладка идёт минутами: итог записывает PreviewRunner, ответ — «начата».
        void deps.deploy!(b.changeSetId).catch(() => {
          /* Failure is persisted by PreviewRunner. */
        });
        return Promise.resolve({ status: 'started', changeSetId: b.changeSetId });
      },
    };
  },
  'corpus/approve': ({ ctx, item }) => {
    const b = basisOf<{ suiteId: string; pendingId: string }>(item);
    return { result: new CheckCorpus(ctx.h!).approveAdoption(b.suiteId, b.pendingId).pending };
  },
};

/* ------------------------------------------------------------------ */
/* История: решённые появления по фактам решения источников            */
/* ------------------------------------------------------------------ */

/** S1: ответ на вопрос (снятый вопрос времени снятия не хранит). */
prepQuestion.history = (ctx) =>
  changesOf(ctx).flatMap((c) =>
    c.questions
      .filter((q) => q.status !== 'open')
      .map((q): Resolved => ({
        sourceKey: `prep:q:${c.id}:${q.id}`,
        occurrenceId: q.id,
        sourceVersion: d({ text: q.text, why: q.why, options: q.options }),
        source: 'prep-question',
        category: 'question',
        actor: 'operator',
        title: `Вопрос ведущего агента по «${c.title}»`,
        reason: one(q.text),
        since: q.createdAt,
        subject: {
          kind: 'change',
          id: c.id,
          href: hrefs.preparation(c.id, q.stage, `questions-${q.stage}`),
        },
        resolvedAt: q.answer?.at ?? null,
      })),
  );

/** S2: решение ведущего по ответу оператора. */
prepAnswerPending.history = (ctx) =>
  changesOf(ctx).flatMap((c) =>
    c.questions.flatMap((q): Resolved[] => {
      if (q.status !== 'answered' || !q.answer) return [];
      const record = c.decisions.find((r) => r.questionId === q.id && !r.withdrawn);
      if (!record) return [];
      const withdrawn = c.decisions
        .filter((r) => r.questionId === q.id && r.withdrawn && r.withdrawn.at < record.createdAt)
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
          reason: one(record.statement),
          since: withdrawn ?? q.answer.at,
          subject: { kind: 'change', id: c.id, href: hrefs.preparation(c.id) },
          resolvedAt: record.createdAt,
        },
      ];
    }),
  );

/** S3/S4: решение оператора по редакции или новая редакция после неё. */
const stageHistory = (ctx: AttentionContext): Resolved[] =>
  changesOf(ctx).flatMap((c) =>
    stages.flatMap((stage) =>
      c[stage].flatMap((r, i, all): Resolved[] => {
        const next = all[i + 1];
        const out: Resolved[] = [];
        const subject = { kind: 'change' as const, id: c.id, href: hrefs.preparation(c.id, stage) };
        // Согласование: редакция была на ревью и решена или вытеснена новой.
        if (r.decision || (next && r.status === 'in-review'))
          out.push({
            sourceKey: `prep:stage:${c.id}:${stage}`,
            occurrenceId: `r${r.number}`,
            sourceVersion: d({ digest: r.digest }),
            source: 'prep-stage',
            category: 'decision',
            actor: 'operator',
            title: `Утвердите ${stageTitles[stage]} «${c.title}»`,
            reason: one(r.decision?.comment || r.reason),
            since: r.createdAt,
            subject,
            resolvedAt: r.decision?.at ?? next?.createdAt ?? null,
          });
        // Доработка: возвращённая редакция и новая редакция после неё.
        if (r.status === 'changes-requested' && next)
          out.push({
            sourceKey: `prep:rework:${c.id}:${stage}`,
            occurrenceId: `r${r.number}`,
            sourceVersion: d(r.decision?.comment ?? ''),
            source: 'prep-rework',
            category: 'technical',
            actor: 'lead',
            title: `Оператор вернул ${stageTitles[stage]} «${c.title}» на доработку`,
            reason: one(r.decision?.comment || r.reason),
            since: r.decision?.at ?? r.createdAt,
            subject,
            resolvedAt: next.createdAt,
          });
        return out;
      }),
    ),
  );
prepStage.history = stageHistory;

/** Сколько последних попыток читает история задач. */
const HISTORY_RUNS = 50;

/**
 * S10: упавшая попытка задачи, после которой началась новая попытка, или
 * задача принята. Момент решения — начало следующей попытки или конец
 * принявшей.
 */
workSource.history = (ctx) => {
  const runs = ctx.state.runs.slice(-HISTORY_RUNS);
  const marks = ctx.store.localRecords<AttentionMark>(ATTENTION_NAMESPACE, undefined);
  // Отмена — запись журнала (`task.cancelled`), у поручения своего времени нет.
  const cancelledAt = new Map<string, string>();
  for (const e of ctx.store.latestEvents(['task.cancelled'], 500)) {
    const taskId = (e.data as { taskId?: string } | null)?.taskId;
    if (taskId && !cancelledAt.has(taskId)) cancelledAt.set(taskId, e.at);
  }
  return runs.flatMap((run): Resolved[] => {
    if (run.status !== 'failed') return [];
    const task = ctx.state.tasks.find((t) => t.id === run.taskId);
    if (!task) return [];
    const next = ctx.state.runs.find((r) => r.taskId === run.taskId && r.attempt > run.attempt);
    const accepted =
      task.status === 'done'
        ? ctx.state.runs.findLast((r) => r.taskId === task.id && r.status === 'succeeded')
        : undefined;
    // Задача, отменённая корректировкой после сбоя без новой попытки: сбой
    // решён отменой.
    const cancelled = !next && task.status === 'cancelled' ? cancelledAt.get(task.id) : undefined;
    const resolvedAt = next?.startedAt ?? accepted?.finishedAt ?? cancelled;
    if (!resolvedAt) return [];
    // В историю — только сбои, которые были карточками: отмеченные
    // оператором или последний сбой перед решением задачи (принятием или
    // отменой). Сбой, который контур сам повторил, карточкой не был.
    const mark = marks[`work:${task.id}`];
    const marked = mark?.occurrenceId === run.id;
    const last =
      ctx.state.runs.findLast((r) => r.taskId === task.id && r.status === 'failed')?.id === run.id;
    if (!marked && !(last && (accepted || cancelled))) return [];
    return [
      {
        sourceKey: `work:${task.id}`,
        occurrenceId: run.id,
        sourceVersion: d({ kind: run.failureKind ?? null }),
        source: 'work',
        category: (marked && mark.category) || 'technical',
        actor: marked && mark.category === 'access' ? 'operator' : 'lead',
        title: (marked && mark.title) || `Задача «${task.title}» не прошла`,
        reason: run.error ?? 'Причина не записана',
        since: run.finishedAt ?? run.startedAt,
        subject: { kind: 'task', id: task.id, href: hrefs.task(task.id) },
        resolvedAt,
      },
    ];
  });
};

/** S13: операция, которая падала или устаревала, завершена, заменена или снята. */
contractChangeSource.history = (ctx) =>
  new ContractChanges(engineOf(ctx).h, ctx.root ?? '')
    .list()
    .filter((op) => ['completed', 'superseded', 'abandoned'].includes(op.status) && op.finishedAt)
    .flatMap((op): Resolved[] => {
      const stop = op.history.findLast((e) => e.event === 'failed' || e.event === 'stale');
      if (!stop) return [];
      return [
        {
          sourceKey: `contract-change:${op.id}`,
          occurrenceId: `${op.id}@${stop.at}`,
          sourceVersion: String(op.version ?? 0),
          source: 'contract-change',
          category: 'technical',
          actor: 'lead',
          title: `Изменение контракта ${op.key}: ${op.status}`,
          reason: ctx.redact(op.error ?? stop.detail ?? ''),
          since: stop.at,
          subject: { kind: 'operation', id: op.id, href: hrefs.contracts() },
          resolvedAt: op.finishedAt!,
        },
      ];
    });

/** S16: приёмка изменения по проверке. */
changesetSource.history = (ctx) =>
  ctx.state.changeSets.flatMap((c): Resolved[] =>
    c.acceptance
      ? [
          {
            sourceKey: `changeset:${c.id}`,
            occurrenceId: c.acceptance.verificationId,
            sourceVersion: c.acceptance.digest,
            source: 'changeset',
            category: 'decision',
            actor: 'operator',
            title: `Примите «${c.title}»`,
            reason: 'Изменение принято.',
            since:
              c.verifications.find((v) => v.id === c.acceptance!.verificationId)?.finishedAt ??
              c.acceptance.at,
            subject: { kind: 'changeset', id: c.id, href: hrefs.changesets() },
            resolvedAt: c.acceptance.at,
          },
        ]
      : [],
  );

/**
 * S6: утверждение плана оператором. Каждое утверждение задач ревизии решает
 * появление, якорь которого — предыдущее утверждение (как у активной
 * карточки). Восстанавливается по задачам самой ревизии: перенесённые из
 * прежней ревизии задачи в якорь не входят.
 */
planSource.history = (ctx) =>
  ctx.state.boards.flatMap((board) =>
    board.revisions.flatMap((r): Resolved[] => {
      const tasks = ctx.state.tasks.filter(
        (t) => r.taskIds.includes(t.id) && t.approval?.actor === 'operator' && t.approvedAt,
      );
      const times = [...new Set(tasks.map((t) => t.approvedAt!))].sort();
      return times.map((at, i) => ({
        sourceKey: `plan:${board.id}`,
        occurrenceId: `r${r.number}:${times[i - 1] ?? 'none'}`,
        sourceVersion: d({ revision: r.number, approvedAt: at }),
        source: 'plan',
        category: 'decision',
        actor: 'operator',
        title: `Утвердите план доски «${board.title}»`,
        reason: `Утверждено задач: ${tasks.filter((t) => t.approvedAt === at).length}`,
        since: times[i - 1] ?? r.createdAt,
        subject: { kind: 'board', id: board.id, href: hrefs.board(board.id) },
        boards: [board.id],
        resolvedAt: at,
      }));
    }),
  );

/** Сколько обработок обращений читает история. */
const HISTORY_DISPOSITIONS = 200;

/**
 * S7 и S8 по обработкам обращений. S7: обработка решает появление очереди
 * ведущего (предыдущая обработка цепочки или само обращение). S8: «нужен
 * ответ» решается ответом оператора или исправлением обращения.
 */
function discussionHistory(ctx: AttentionContext, which: 'request' | 'answer'): Resolved[] {
  const { h } = engineOf(ctx);
  const service = new DiscussionService(h);
  const rows = service.dispositions(HISTORY_DISPOSITIONS);
  const roots = new Map<string, string>();
  const rootOf = (owner: string | undefined, id: string) => {
    if (!roots.has(id)) roots.set(id, service.chain(owner, id)?.rootId ?? id);
    return roots.get(id)!;
  };
  const byRoot = new Map<string, typeof rows>();
  for (const row of rows) {
    const root = rootOf(row.owner, row.disposition.replyTo ?? row.disposition.id);
    byRoot.set(root, [...(byRoot.get(root) ?? []), row]);
  }
  const out: Resolved[] = [];
  for (const [root, chain] of byRoot) {
    const ordered = [...chain].sort((a, b) => a.disposition.seq - b.disposition.seq);
    ordered.forEach((row, i) => {
      const d0 = row.disposition;
      const subject = {
        kind: 'task' as const,
        id: d0.taskId,
        href: hrefs.message(d0.taskId, d0.id),
      };
      const outcome = d0.disposition?.outcome ?? 'accepted';
      if (which === 'request')
        out.push({
          sourceKey: `discussion:cr:${root}`,
          occurrenceId: ordered[i - 1]?.disposition.id ?? root,
          sourceVersion: d({ disposition: d0.id }),
          source: 'discussion-request',
          category: 'technical',
          actor: 'lead',
          title: `Обращение к ведущему по задаче «${taskTitle(ctx, d0.taskId)}»: ${outcome}`,
          reason: ctx.redact(d0.text),
          since: ordered[i - 1]?.disposition.createdAt ?? d0.createdAt,
          subject,
          evidence: [{ kind: 'message', id: d0.id }],
          resolvedAt: d0.createdAt,
        });
      else if (outcome === 'needs-answer') {
        const resolvedAt = [row.answeredAt, row.correctedAt]
          .filter((x): x is string => !!x)
          .sort()[0];
        if (resolvedAt)
          out.push({
            sourceKey: `discussion:na:${root}`,
            occurrenceId: d0.id,
            sourceVersion: d0.id,
            source: 'discussion-needs-answer',
            category: 'question',
            actor: 'operator',
            title: `Ведущий просит ответа по задаче «${taskTitle(ctx, d0.taskId)}»`,
            reason: ctx.redact(d0.text),
            since: d0.createdAt,
            subject,
            evidence: [{ kind: 'message', id: d0.id }],
            resolvedAt,
          });
      }
    });
  }
  return out;
}
discussionRequestSource.history = (ctx) => discussionHistory(ctx, 'request');
discussionNeedsAnswerSource.history = (ctx) => discussionHistory(ctx, 'answer');

/**
 * S15: вопрос исполнителя, который больше не ждёт действия: снят, заменён
 * или доставлен (момент закрытия или доставки). У применённого, но ещё не
 * доставленного ответа момента применения в записи нет — `resolvedAt: null`.
 */
inputSource.history = (ctx) => {
  const { h } = engineOf(ctx);
  const { engine } = executionOf(h);
  return new InputService(h, ctx.root)
    .list()
    .requests.filter((r) => !inputActionable.has(r.state))
    .map((r): Resolved => {
      let at: string | null = null;
      try {
        const request = engine.inputRequest(r.requestId);
        at = request.closed?.at ?? request.delivered?.at ?? null;
      } catch {
        /* Запрос не найден: время решения неизвестно. */
      }
      return {
        sourceKey: `input:${r.requestId}`,
        occurrenceId: r.requestId,
        sourceVersion: `${r.version}:${r.state}`,
        source: 'input',
        category: 'question',
        actor: 'operator',
        title: `Вопрос исполнителя по задаче «${taskTitle(ctx, r.taskId)}»: ${r.state}`,
        reason: r.state,
        since: r.createdAt,
        subject: { kind: 'request', id: r.requestId, href: hrefs.task(r.taskId) + '#input' },
        resolvedAt: at,
      };
    });
};

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

/** Учётные данные в URL (`scheme://user:secret@host`) — маска до показа. */
export const maskUrlCredentials = (text: string) =>
  text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[REDACTED]@');

/** Полный вопрос и варианты действия — под маской и в пределах договора. */
function boundedAction(
  a: Extract<AttentionAction, { kind: 'domain' }>,
  redact: (text: string) => string,
): AttentionAction {
  const L = ATTENTION_LIMITS;
  return {
    ...a,
    ...(a.prompt !== undefined ? { prompt: clip(redact(a.prompt), L.prompt) } : {}),
    ...(a.choices
      ? {
          choices: a.choices.slice(0, L.choices).map((c) => ({
            ...c,
            label: clip(redact(c.label), L.choiceLabel),
            ...(c.hint !== undefined ? { hint: clip(redact(c.hint), L.choiceHint) } : {}),
          })),
        }
      : {}),
  };
}

/** Время последней отметки строки. */
const lastMark = (m: AttentionMark) =>
  [m.readAt, m.ackAt]
    .filter((x): x is string => !!x)
    .sort()
    .at(-1) ?? '';

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
  /** Маска секретов: заголовок и причина любого источника проходят её здесь. */
  redact: (text: string) => string = maskUrlCredentials,
): AttentionItem {
  return {
    id: `${c.sourceKey}#${c.occurrenceId}`,
    sourceKey: c.sourceKey,
    occurrenceId: c.occurrenceId,
    sourceVersion: c.sourceVersion,
    source: c.source,
    category: c.category,
    actor: c.actor,
    title: clip(one(redact(c.title)), ATTENTION_LIMITS.title),
    reason: clip(one(redact(c.reason)), ATTENTION_LIMITS.reason),
    impact: impactOf(c, state, boardByTask),
    since: c.since,
    ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
    subject: c.subject,
    evidence: (c.evidence ?? []).slice(0, ATTENTION_LIMITS.evidence),
    actions: [
      // Доменные действия — только у карточек оператора; передача контекста
      // ведущему — у карточек ведущего.
      ...(c.actions ?? [])
        .filter((a) => a.kind !== 'domain' || c.actor === 'operator')
        .map((a) => (a.kind === 'domain' ? boundedAction(a, redact) : a)),
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
  /**
   * Точка между проверкой карточки и доменной операцией со своей сверкой
   * (тесты: расхождение в этом промежутке отклоняет сама операция).
   */
  afterCheck?: (a: ActContext) => ActContext;
}

export interface AttentionHistoryView {
  revision: number;
  generatedAt: string;
  engineConnected: boolean;
  items: AttentionHistoryItem[];
  truncated?: { count: number };
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
      redact: this.redactor(),
      claimed: new Map(),
      cards: new Map(),
    };
  }

  /**
   * Маска текстов карточек: учётные данные в URL — всегда (до setup тоже:
   * вопросы и причины пишет ведущий агент, ошибки Git повторяют адрес
   * репозитория), известные секреты конфигурации — маской пакета передачи.
   */
  private redactor(): (text: string) => string {
    if (!this.h) return maskUrlCredentials;
    const known = handoffRedactor(this.h.config, executionOf(this.h).engine.policy);
    return (text) => maskUrlCredentials(known(text));
  }

  /** Карточки-кандидаты в порядке источников, внутри снимка. */
  candidates(ctx: AttentionContext, only?: Set<AttentionSource>): Candidate[] {
    const out: Candidate[] = [];
    for (const source of this.sources) {
      if (source.engine && !ctx.h) continue;
      if (only && !only.has(source.id)) continue;
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
   * Отметки «прочитано» и «увидел» показанной версии. Пишет только локальные
   * записи пространства `attention`: ни задача, ни вопрос, ни согласование,
   * ни очередь от отметки не меняются (увидел — не значит решил). Отметка
   * исчезнувшего появления не хранится (`ignored`). Отметка старой версии
   * не затирает отметку текущей. Событий журнала нет: вторая вкладка видит
   * отметку по ревизии данных.
   */
  async mark(raw: unknown) {
    const { marks } = attentionInputs.marks.parse(raw);
    const now = (this.options.now ?? Date.now)();
    const at = new Date(now).toISOString();
    const needed = new Set(
      marks.map((m) => sourceOfKey(m.sourceKey)).filter((x): x is AttentionSource => !!x),
    );
    const quick = needed.has('quick')
      ? await this.prerequisites()
      : new Map<string, QuickPrerequisites>();
    // Появления сверяются в снимке чтения, без блокировки записи: отметки
    // инертны, и худшая гонка — отметка только что решённого появления,
    // которую `markState` не применит к новому.
    const present = this.store.snapshot(
      () =>
        new Map(
          this.candidates(this.context(quick, now), needed).map((c) => [
            c.sourceKey,
            {
              occurrenceId: c.occurrenceId,
              sourceVersion: c.sourceVersion,
              title: c.title,
              category: c.category,
            },
          ]),
        ),
    );
    const redact = this.redactor();
    // Под блокировкой — только строки отметок.
    return this.store.atomic(() => {
      const stored = this.marks();
      const marked: { sourceKey: string; occurrenceId: string }[] = [];
      const ignored: { sourceKey: string; occurrenceId: string }[] = [];
      for (const m of marks) {
        const item = present.get(m.sourceKey);
        if (!item || item.occurrenceId !== m.occurrenceId) {
          ignored.push({ sourceKey: m.sourceKey, occurrenceId: m.occurrenceId });
          continue;
        }
        const previous = stored[m.sourceKey];
        const row: AttentionMark =
          previous?.occurrenceId === m.occurrenceId
            ? { ...previous }
            : { v: 1, occurrenceId: m.occurrenceId };
        // Отметка старой версии не отменяет отметку текущей.
        const keeps = (version: string | undefined) =>
          version === item.sourceVersion && m.version !== item.sourceVersion;
        if (!keeps(row.readVersion)) {
          row.readVersion = m.version;
          row.readAt = at;
        }
        if (m.kind === 'ack' && !keeps(row.ackVersion)) {
          row.ackVersion = m.version;
          row.ackAt = at;
        }
        row.title = clip(one(redact(item.title)), ATTENTION_LIMITS.title);
        row.category = item.category;
        this.store.saveLocal(ATTENTION_NAMESPACE, undefined, m.sourceKey, attentionMark.parse(row));
        stored[m.sourceKey] = row;
        marked.push({ sourceKey: m.sourceKey, occurrenceId: m.occurrenceId });
      }
      this.prune(stored, new Set(marked.map((m) => m.sourceKey)), now);
      return { marked, ignored };
    });
  }

  /**
   * Действие с карточки. Пересчитывается только источник карточки: появление
   * и версия сверяются с показанными (иначе 409 `attention-stale` с текущей
   * карточкой или `attention-resolved`). Операция, которая сама сверяет
   * основание (`ownCas`), исполняется после проверки с полями проверенной
   * версии: расхождение между проверкой и операцией отклоняет она сама, и
   * Git (карты INTENT утверждения плана) не читается под блокировкой
   * записи. Остальные проверяют карточку и исполняются одной транзакцией.
   * Повтор с тем же ключом идемпотентности возвращает прежнюю запись.
   */
  async act(raw: unknown, deps: AttentionActDeps = {}) {
    const v = attentionInputs.act.parse(raw);
    const source = sourceOfKey(v.sourceKey);
    // Действие, которого у источника нет, отклоняется до любого пересчёта.
    if (!source || !actionHandlers[`${source}/${v.action}`])
      throw new DomainError(`Действие ${v.action} не предлагается этой карточкой`, 400, {
        code: 'attention-action',
      });
    const now = (this.options.now ?? Date.now)();
    const quick =
      source === 'quick' ? await this.prerequisites() : new Map<string, QuickPrerequisites>();
    const only = new Set<AttentionSource>(source ? [source] : []);
    const replayed = this.store.snapshot(() => this.replayOf(v));
    if (replayed) return { result: { replayed: true, message: replayed }, resolved: true as const };
    const check = (): ActContext => {
      const ctx = this.context(quick, now);
      const item = this.candidates(ctx, only).find((c) => c.sourceKey === v.sourceKey);
      if (!item) {
        // Решённое появление — из истории своего источника, если она есть.
        const rule = this.sources.find((r) => r.id === source && r.history && (!r.engine || ctx.h));
        const resolved = rule?.history!(ctx).find(
          (r) => r.sourceKey === v.sourceKey && r.occurrenceId === v.occurrenceId,
        );
        throw new DomainError('Карточка уже решена исходной сущностью', 409, {
          code: 'attention-resolved',
          ...(resolved ? { history: this.historyItem(ctx, resolved, this.marks()) } : {}),
        });
      }
      if (item.occurrenceId !== v.occurrenceId || item.sourceVersion !== v.expectedVersion)
        throw new DomainError('Карточка изменилась: решение принято по прежней версии', 409, {
          code: 'attention-stale',
        });
      const action = (item.actor === 'operator' ? (item.actions ?? []) : []).find(
        (a) => a.kind === 'domain' && a.id === v.action,
      );
      if (!action || !actionHandlers[`${item.source}/${v.action}`])
        throw new DomainError(`Действие ${v.action} не предлагается этой карточкой`, 400, {
          code: 'attention-action',
        });
      return {
        ctx,
        item,
        input: v.input ?? {},
        key: v.idempotencyKey,
        deps,
        root: this.options.root,
      };
    };
    const run = (a: ActContext) => actionHandlers[`${a.item.source}/${v.action}`](a);
    const afterCheck = this.options.afterCheck ?? ((a: ActContext) => a);
    // Карточка ответа — как в GET: влияние зависит от захватов и свёрток
    // других источников, поэтому проекция полная. Вне транзакции действия и
    // один раз на ответ.
    const shown = () =>
      this.store.snapshot(() => {
        const ctx = this.context(quick, now);
        const item = this.candidates(ctx).find((c) => c.sourceKey === v.sourceKey);
        return item
          ? toItem(item, ctx.state, boardsOf(ctx.state), this.marks(), ctx.redact)
          : undefined;
      });
    let outcome: ActOutcome;
    try {
      outcome = ownCas.has(`${source}/${v.action}`)
        ? run(afterCheck(this.store.snapshot(check)))
        : this.store.atomic(() => run(check()));
    } catch (error) {
      if (error instanceof DomainError && error.details?.code === 'attention-stale') {
        const item = shown();
        throw new DomainError(error.message, 409, {
          code: 'attention-stale',
          ...(item ? { item } : {}),
        });
      }
      throw error;
    }
    const result = outcome.after ? await outcome.after() : outcome.result;
    const current = shown();
    return current ? { result, item: current } : { result, resolved: true as const };
  }

  /**
   * Прежняя запись под ключом идемпотентности текстового действия (ответ в
   * обсуждении или на вопрос исполнителя): повтор после обрыва связи — не
   * ошибка и не второе сообщение.
   */
  private replayOf(v: { sourceKey: string; idempotencyKey?: string }) {
    const h = this.h;
    if (!h || !v.idempotencyKey) return undefined;
    const owners = [undefined, ...repositories(h.config).map((r) => r.id)];
    let taskId: string | undefined;
    if (v.sourceKey.startsWith('input:'))
      try {
        taskId = executionOf(h).engine.inputRequest(v.sourceKey.slice('input:'.length)).workId;
      } catch {
        return undefined;
      }
    else if (v.sourceKey.startsWith('discussion:na:')) {
      const root = v.sourceKey.slice('discussion:na:'.length);
      for (const owner of owners) {
        const row = h.store.discussionById(owner, root) as { taskId?: string } | undefined;
        if (row?.taskId) {
          taskId = row.taskId;
          break;
        }
      }
    }
    const task = taskId ? h.store.read().tasks.find((t) => t.id === taskId) : undefined;
    if (!task) return undefined;
    return h.store.discussionByKey(taskOwner(task), task.id, 'operator', v.idempotencyKey) as
      Record<string, unknown> | undefined;
  }

  /**
   * Удаление по возрасту и пределу строк (решение 9), без пересчёта
   * источников: отметка старше 30 дней удаляется, даже если её карточка всё
   * ещё активна (тогда она снова не прочитана). `keep` — только что
   * отмеченные ключи.
   */
  private prune(stored: Record<string, AttentionMark>, keep: Set<string>, now: number) {
    const last = lastMark;
    const cutoff = new Date(now - ATTENTION_LIMITS.markRetentionMs).toISOString();
    const keys = Object.keys(stored);
    const removed = new Set(keys.filter((key) => !keep.has(key) && last(stored[key]) < cutoff));
    const left = keys.filter((key) => !removed.has(key));
    if (left.length > ATTENTION_LIMITS.markRows)
      left
        .filter((key) => !keep.has(key))
        .sort((a, b) => (last(stored[a]) < last(stored[b]) ? -1 : 1))
        .slice(0, left.length - ATTENTION_LIMITS.markRows)
        .forEach((key) => removed.add(key));
    for (const key of removed) this.store.deleteLocal(ATTENTION_NAMESPACE, undefined, key);
  }

  /** Запись истории: карточка решённого появления с отметкой и временем решения. */
  private historyItem(
    ctx: AttentionContext,
    r: Resolved,
    marks: Record<string, AttentionMark>,
    boardByTask = boardsOf(ctx.state),
  ): AttentionHistoryItem {
    // Версия решённого появления восстановлена по фактам: отметка
    // относится к появлению, какой бы версии она ни была.
    const mark = marks[r.sourceKey];
    const same = mark?.occurrenceId === r.occurrenceId;
    const read = same && !!mark.readVersion;
    return {
      ...toItem(r, ctx.state, boardByTask, marks, ctx.redact),
      actions: [],
      state: { read, acknowledged: same && !!mark.ackVersion, unread: !read },
      resolvedAt: r.resolvedAt,
    };
  }

  /**
   * История: решённые появления по долговечным фактам решения источников,
   * новые первыми, не больше 100. Действий у записей истории нет. Чтение,
   * как и активный список, ничего не пишет.
   */
  history(raw: AttentionListInput = {}): AttentionHistoryView {
    const filter = attentionInputs.list.parse(raw);
    const now = (this.options.now ?? Date.now)();
    return this.store.snapshot(() => {
      const ctx = this.context(new Map(), now);
      const boardByTask = boardsOf(ctx.state);
      const marks = this.marks();
      const all = this.sources
        .filter((source) => source.history && (!source.engine || ctx.h))
        .flatMap((source) => source.history!(ctx))
        .filter(
          (r) =>
            (!filter.actor || r.actor === filter.actor) &&
            (!filter.category || r.category === filter.category),
        )
        .sort(
          (a, b) =>
            (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '') ||
            (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0),
        );
      const items = all
        .slice(0, ATTENTION_LIMITS.history)
        .map((r) => this.historyItem(ctx, r, marks, boardByTask));
      return {
        revision: this.store.revision(),
        generatedAt: new Date(now).toISOString(),
        engineConnected: Boolean(this.h),
        items,
        ...(all.length > items.length ? { truncated: { count: all.length - items.length } } : {}),
      };
    });
  }

  /**
   * Активный список. GET: ничего не пишет — снимок хранилища открыт только
   * на чтение, и запись внутри него упала бы, а не закоммитилась.
   */
  async active(raw: AttentionListInput = {}): Promise<AttentionView> {
    return this.view(raw, await this.prerequisites());
  }

  /**
   * Список ведущего агента (`attention_list`): те же правила источников, что
   * у панели, без отметок оператора (они его локальное состояние). Операция
   * синхронная и не запускает Git: шаги быстрого маршрута ведущий видит в
   * `preparation_status` и панели быстрого изменения.
   */
  agentList(raw: unknown = {}) {
    const input = attentionInputs.agent.parse(raw);
    const view = this.view(
      { actor: input.actor, ...(input.category ? { category: input.category } : {}) },
      new Map(),
    );
    const items = view.items.slice(0, input.limit).map(({ state, ...item }) => (void state, item));
    // Ответ агентского API — до 64 KiB: список режется с конца, отрезанное
    // названо в `truncated`, а не отказом 413.
    while (items.length > 1 && !checkJsonBytes(items, AGENT_LIST_BYTES).within) items.pop();
    return {
      items,
      counts: {
        active: view.counts.active,
        byActor: {
          operator: { active: view.counts.byActor.operator.active },
          lead: { active: view.counts.byActor.lead.active },
        },
      },
      lead: view.lead,
      ...(view.counts.active > items.length
        ? { truncated: { count: view.counts.active - items.length } }
        : {}),
    };
  }

  /** Активный список по уже полученным асинхронным фактам — один снимок. */
  view(raw: AttentionListInput, quick: Map<string, QuickPrerequisites>): AttentionView {
    const filter = attentionInputs.list.parse(raw);
    const now = (this.options.now ?? Date.now)();
    return this.store.snapshot(() => {
      const ctx = this.context(quick, now);
      const boardByTask = boardsOf(ctx.state);
      const marks = this.marks();
      const all = this.candidates(ctx)
        .map((c) => toItem(c, ctx.state, boardByTask, marks, ctx.redact))
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
