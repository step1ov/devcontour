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

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const messageId = z.string().regex(/^DM-[0-9a-f-]{36}$/);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const text = z
  .string()
  .trim()
  .min(1)
  .refine(
    (t) => Buffer.byteLength(t, 'utf8') <= DISCUSSION_TEXT_BYTES,
    `Сообщение больше ${DISCUSSION_TEXT_BYTES} байт UTF-8`,
  );

export const dispositionOutcome = z.enum(['accepted', 'rejected', 'needs-answer']);
export const discussionMessage = z.strictObject({
  id: messageId,
  seq: z.number().int().positive(),
  taskId: id,
  /** Тред v1 — сама задача. */
  threadId: id,
  author: z.enum(['operator', 'lead', 'runtime']),
  kind: z.enum(['note', 'change-request', 'answer', 'disposition']),
  text,
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
    kind: z.enum(['note', 'change-request']),
    text,
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
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(DISCUSSION_PAGE_ITEMS).default(20),
  }),
};
export type DiscussionOperation = keyof typeof discussionInputs;
