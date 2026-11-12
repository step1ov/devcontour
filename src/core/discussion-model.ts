import { z } from 'zod';

// Обсуждение задачи — локальная история владельца задачи, не часть
// исполняемого состояния: заметка не меняет постановку, digest, очередь,
// попытки и расход. История неизменяема: правка — новая запись с supersedes,
// обработка обращения — запись disposition в ответ на него.

/** Предел текста сообщения в байтах UTF-8: превышение — явная ошибка, без обрезания. */
export const DISCUSSION_TEXT_BYTES = 16 * 1024;
/** Записей на странице и байтов страницы для панели. */
export const DISCUSSION_PAGE_ITEMS = 50;
export const DISCUSSION_PAGE_BYTES = 256 * 1024;
/** Предел вопроса и влияния решения за владельца в байтах UTF-8. */
export const STAND_IN_FIELD_BYTES = 2 * 1024;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const messageId = z.string().regex(/^DM-[0-9a-f-]{36}$/);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const inputRequestId = z.string().regex(/^IR-[a-f0-9]{24}$/);
/** Управляющие символы, кроме перевода строки, возврата каретки и табуляции. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/**
 * Текст на входе хранится как есть, без обрезания пробелов. Управляющие
 * символы отклоняются: в JSON каждый — шесть байт, и запись в 16 KiB текста
 * перестала бы помещаться в страницу агентского API. Без них JSON-вид
 * текста не больше вдвое длиннее UTF-8, и одна запись всегда меньше страницы.
 */
const text = z
  .string()
  .refine((t) => t.trim().length > 0, 'Сообщение пустое')
  .refine((t) => !CONTROL.test(t), 'Сообщение содержит управляющие символы')
  .refine(
    (t) => Buffer.byteLength(t, 'utf8') <= DISCUSSION_TEXT_BYTES,
    `Сообщение больше ${DISCUSSION_TEXT_BYTES} байт UTF-8`,
  );
/** Вопрос и влияние решения за владельца: короткий текст, без управляющих символов. */
const standInText = z
  .string()
  .refine((t) => t.trim().length > 0, 'Текст пустой')
  .refine((t) => !CONTROL.test(t), 'Текст содержит управляющие символы')
  .refine((t) => Buffer.byteLength(t, 'utf8') <= STAND_IN_FIELD_BYTES, 'Текст длиннее 2 KiB UTF-8');
/** Сохранённый текст читается без входных проверок: запись не должна блокировать чтение. */
const storedText = z.string().min(1);

/** Текст длиннее предела — явный отказ 413 до разбора схемы. */
export function textTooLong(raw: unknown): boolean {
  const value = (raw as { text?: unknown; reason?: unknown } | null) ?? {};
  return [value.text, value.reason].some(
    (t) => typeof t === 'string' && Buffer.byteLength(t, 'utf8') > DISCUSSION_TEXT_BYTES,
  );
}

/**
 * Начало текста, JSON-вид которого не больше `maxBytes`: граница — по
 * кодовым точкам, суррогатная пара не разрывается.
 */
export function clipText(value: string, maxBytes: number) {
  let used = 0;
  let end = 0;
  for (const point of value) {
    const size = Buffer.byteLength(JSON.stringify(point)) - 2;
    if (used + size > maxBytes) return { excerpt: value.slice(0, end), truncated: true };
    used += size;
    end += point.length;
  }
  return { excerpt: value, truncated: false };
}

export const dispositionOutcome = z.enum(['accepted', 'rejected', 'needs-answer']);
export const discussionMessage = z.strictObject({
  id: messageId,
  seq: z.number().int().positive(),
  taskId: id,
  /** Тред v1 — сама задача. */
  threadId: id,
  author: z.enum(['operator', 'lead', 'runtime']),
  kind: z.enum(['note', 'change-request', 'answer', 'disposition', 'stand-in']),
  text: storedText,
  createdAt: z.iso.datetime(),
  replyTo: messageId.optional(),
  supersedes: messageId.optional(),
  /** Основание: постановка задачи и последняя попытка на момент записи. */
  basis: z.strictObject({ specDigest: z.string(), runId: z.string().optional() }),
  idempotencyKey,
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  disposition: z
    .strictObject({
      outcome: dispositionOutcome,
      refs: z.strictObject({
        boardId: id.optional(),
        revision: z.number().int().positive().optional(),
        taskIds: z.array(id).max(20).optional(),
      }),
    })
    .optional(),
  /**
   * Ответ на вопрос исполнителя (`kind: answer`). Принятый ответ — ссылка на
   * версию ответа в запросе harness: канонический текст хранится там один
   * раз, а `read()` подставляет его. Поздний ответ (запрос уже снят или
   * заменён) — история обсуждения со своим текстом, `accepted: false`: задачу
   * он не возобновляет.
   */
  input: z
    .union([
      z.strictObject({
        requestId: inputRequestId,
        revision: z.number().int().positive(),
        answerDigest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      z.strictObject({
        requestId: inputRequestId,
        accepted: z.literal(false),
        lifecycle: z.string().min(1).max(40),
      }),
    ])
    .optional(),
  /**
   * Только у `kind: stand-in` — решение, которое ведущий принял за владельца
   * без его ответа: какой вопрос владельца закрыт допущением и на что оно
   * влияет. `text` — само решение и основание.
   */
  standIn: z.strictObject({ question: storedText, impact: storedText }).optional(),
  /**
   * Решение владельца по решению за него (ответ на последнюю версию
   * `stand-in`, только оператор): `confirmed` — заметка, `reversed` —
   * обращение к ведущему, которое он обрабатывает как любое обращение.
   */
  ruling: z.enum(['confirmed', 'reversed']).optional(),
});
export type DiscussionMessage = z.infer<typeof discussionMessage>;

const write = {
  idempotencyKey,
  /** Версия треда (последний seq), которую видел автор; 0 — пустой тред. */
  expectedVersion: z.number().int().min(0),
};
export const discussionInputs = {
  discussion_read: z.strictObject({
    taskId: id,
    cursor: z
      .string()
      .regex(/^\d{1,15}$/)
      .optional(),
    /** Страница перед этим seq (чтение назад). */
    before: z
      .string()
      .regex(/^\d{1,15}$/)
      .optional(),
    /** Последняя страница треда. */
    latest: z.boolean().optional(),
    limit: z.number().int().min(1).max(DISCUSSION_PAGE_ITEMS).default(20),
  }),
  discussion_post: z.strictObject({
    taskId: id,
    kind: z.enum(['note', 'change-request', 'answer', 'stand-in']),
    text,
    /**
     * Только у `kind: stand-in` (пишет ведущий): вопрос владельца, который
     * закрыт допущением, и влияние решения. Владелец подтверждает или
     * отменяет его в панели или CLI.
     */
    standIn: z.strictObject({ question: standInText, impact: standInText }).optional(),
    /**
     * Только у `kind: answer` — ответ на вопрос исполнителя: запрос, версия
     * запроса, которую видел автор (она, а не версия треда, — CAS ответа),
     * вариант и вид ответа.
     */
    input: z
      .strictObject({
        requestId: inputRequestId,
        expectedVersion: z.number().int().positive(),
        optionId: z.string().max(40).optional(),
        kind: z.enum(['clarification', 'requirement-change']).optional(),
      })
      .optional(),
    replyTo: messageId.optional(),
    supersedes: messageId.optional(),
    ...write,
  }),
  discussion_resolve: z.strictObject({
    requestId: messageId,
    outcome: dispositionOutcome,
    reason: text,
    refs: z
      .strictObject({
        boardId: id.optional(),
        revision: z.number().int().positive().optional(),
        taskIds: z.array(id).max(20).optional(),
      })
      .default({}),
    ...write,
  }),
  discussion_inbox: z.strictObject({
    cursor: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(DISCUSSION_PAGE_ITEMS).default(20),
  }),
};
export type DiscussionOperation = keyof typeof discussionInputs;

/**
 * Решение владельца по решению за него. Вне `discussionInputs`: агентский
 * API этой операции не имеет — подтверждает и отменяет только оператор
 * (панель, CLI).
 */
export const standInRulingInput = z.strictObject({
  messageId,
  ruling: z.enum(['confirmed', 'reversed']),
  /** У отмены обязателен: что взамен; у подтверждения — необязательная заметка. */
  text: text.optional(),
  ...write,
});
