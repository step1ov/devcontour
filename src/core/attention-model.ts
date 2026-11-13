import { z } from 'zod';

// Центр внимания — проекция фактов, а не своя машина статусов: карточка
// существует, пока исходная сущность требует действия, и исчезает, когда
// исходная сущность решена. Хранятся только локальные отметки оператора
// «прочитано» и «увидел» (не «решено»).

/** Категории в порядке очереди: блокировки доступа и бюджета, вопросы, решения, техника. */
export const attentionCategories = [
  'access',
  'budget',
  'question',
  'decision',
  'technical',
] as const;
export type AttentionCategory = (typeof attentionCategories)[number];
export const categoryRank = Object.fromEntries(attentionCategories.map((c, i) => [c, i])) as Record<
  AttentionCategory,
  number
>;

export const attentionActors = ['operator', 'lead'] as const;
export type AttentionActor = (typeof attentionActors)[number];

/** Источники карточек: одно существующее правило на источник. */
export const attentionSources = [
  'prep-question',
  'prep-answer-pending',
  'prep-stage',
  'prep-rework',
  'quick',
  'plan',
  'discussion-request',
  'discussion-needs-answer',
  'stand-in',
  'board',
  'work',
  'budget',
  'queue',
  'contract-change',
  'wait',
  'input',
  'changeset',
  'preview',
  'corpus',
  'stall',
] as const;
export type AttentionSource = (typeof attentionSources)[number];

export const ATTENTION_LIMITS = {
  title: 160,
  reason: 300,
  sourceKey: 200,
  occurrence: 200,
  taskIds: 20,
  evidence: 5,
  active: 200,
  history: 100,
  marksPerCall: 100,
  markRows: 2000,
  /** До скольких строк удаляет запись, перешедшая предел. */
  markRowsLow: 1900,
  /** Сколько последних появлений предмета хранит строка отметок (текущее и прежние). */
  markOccurrences: 5,
  /** Отметки исчезнувших карточек живут столько, затем удаляются при записи отметок. */
  markRetentionMs: 30 * 24 * 60 * 60_000,
  agentLimit: 50,
  prompt: 2000,
  choices: 10,
  choiceLabel: 200,
  choiceHint: 300,
} as const;

export const sourceKeyPattern = /^[a-z-]+(:[A-Za-z0-9:._#@-]+)?$/;
const sourceKey = z.string().max(ATTENTION_LIMITS.sourceKey).regex(sourceKeyPattern);
const occurrenceId = z.string().min(1).max(ATTENTION_LIMITS.occurrence);
const version = z.string().min(1).max(200);

export type AttentionSubjectKind =
  | 'change'
  | 'task'
  | 'board'
  | 'changeset'
  | 'request'
  | 'queue'
  | 'budget'
  | 'preview'
  | 'suite'
  | 'operation'
  | 'run';

export type AttentionAction =
  | {
      id: string;
      kind: 'domain';
      label: string;
      input?: 'text' | 'text+option' | 'confirm';
      /** Полный текст вопроса (до 2000 знаков, под маской); `reason` — выдержка. */
      prompt?: string;
      /** Варианты ответа (до 10): `id` уходит в `input.optionId`. */
      choices?: { id: string; label: string; hint?: string; recommended?: boolean }[];
      /** Раунд отклонённого ревью, который подтверждает действие (`input.confirmRejectedRound`). */
      round?: number;
      /**
       * Вопрос затрагивает зарегистрированный контракт (`affects: contract`):
       * форма ответа поясняет порядок — изменение контракта, затем ответ (F38).
       */
      contract?: true;
    }
  | { id: 'open'; kind: 'navigate'; href: string }
  | { id: 'handoff'; kind: 'handoff'; command: string };

export interface AttentionItem {
  id: string;
  sourceKey: string;
  occurrenceId: string;
  sourceVersion: string;
  source: AttentionSource;
  category: AttentionCategory;
  actor: AttentionActor;
  title: string;
  reason: string;
  impact: { tasks: number; waiting: number; boards: string[]; taskIds: string[] };
  since: string;
  updatedAt?: string;
  subject: { kind: AttentionSubjectKind; id: string; href: string };
  evidence: {
    kind: 'attempt' | 'evidence' | 'review' | 'event' | 'artifact' | 'message';
    id: string;
    href?: string;
  }[];
  actions: AttentionAction[];
  state: { read: boolean; acknowledged: boolean; unread: boolean };
}

/** Запись истории: карточка, решённая исходной сущностью, со временем решения. */
export type AttentionHistoryItem = Omit<AttentionItem, 'actions'> & {
  actions: [];
  resolvedAt: string | null;
};

/** Отметка одного появления предмета. */
const occurrenceMark = z.strictObject({
  occurrenceId,
  readVersion: version.optional(),
  readAt: z.iso.datetime().optional(),
  ackVersion: version.optional(),
  ackAt: z.iso.datetime().optional(),
  /** Снимок для подписи истории после исчезновения предмета. */
  title: z.string().max(ATTENTION_LIMITS.title).optional(),
  category: z.enum(attentionCategories).optional(),
});
export type OccurrenceMark = z.infer<typeof occurrenceMark>;

/**
 * Локальная отметка оператора по ключу источника (одна строка на ключ).
 * Поля верхнего уровня — последнее отмеченное появление; `earlier` —
 * прежние появления, новые первыми, всего с текущим не больше
 * `markOccurrences`. Строки без `earlier` (до хранения нескольких
 * появлений) читаются как строки с одним появлением.
 */
export const attentionMark = occurrenceMark.extend({
  v: z.literal(1),
  earlier: z
    .array(occurrenceMark)
    .max(ATTENTION_LIMITS.markOccurrences - 1)
    .optional(),
});
export type AttentionMark = z.infer<typeof attentionMark>;

const actor = z.enum(attentionActors);
const category = z.enum(attentionCategories);

export const attentionInputs = {
  list: z.strictObject({
    view: z.enum(['active', 'history']).default('active'),
    actor: actor.optional(),
    category: category.optional(),
    component: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,80}$/)
      .optional(),
  }),
  marks: z.strictObject({
    marks: z
      .array(
        z.strictObject({
          sourceKey,
          occurrenceId,
          version,
          kind: z.enum(['read', 'ack']),
        }),
      )
      .min(1)
      .max(ATTENTION_LIMITS.marksPerCall),
  }),
  act: z.strictObject({
    sourceKey,
    occurrenceId,
    expectedVersion: version,
    action: z.string().regex(/^[a-z][a-z-]{0,40}$/),
    input: z
      .strictObject({
        text: z
          .string()
          .max(16 * 1024)
          .optional(),
        optionId: z.string().max(40).optional(),
        comment: z.string().max(3000).optional(),
        kind: z.enum(['clarification', 'requirement-change']).optional(),
        /** Раунд отклонённого ревью, который оператор видел и подтверждает (правило D03). */
        confirmRejectedRound: z.number().int().positive().optional(),
      })
      .optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,80}$/)
      .optional(),
  }),
  agent: z.strictObject({
    actor: actor.default('lead'),
    category: category.optional(),
    limit: z.number().int().min(1).max(ATTENTION_LIMITS.agentLimit).default(20),
  }),
};
export type AttentionListInput = z.input<typeof attentionInputs.list>;
export type AttentionMarkInput = z.input<typeof attentionInputs.marks>;
export type AttentionActInput = z.input<typeof attentionInputs.act>;
