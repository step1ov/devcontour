/**
 * Ответ агентской операции `workflow_status`.
 *
 * Задания владельца копятся: завершённые, упавшие и устаревшие остаются в
 * local_workflow навсегда, каждое — с полной историей событий. У долго
 * живущего компонента список целиком перерастал предел ответа агентского API
 * (64 KiB), и единственный документированный опрос идущего задания отвечал
 * отказом без пути сузить запрос. Поэтому:
 *
 * - действующие задания (queued, running) идут целиком, как раньше;
 * - законченные (completed, failed, stale) по умолчанию свёрнуты: последние
 *   `limit` (по умолчанию 10) в компактном виде без истории, остальные —
 *   числом в `finished` (и по статусам). Упавшие задания, которые ещё можно
 *   повторить (попыток стадии меньше предела), перечислены всегда: ведущий
 *   разбирает именно их перед `workflow_retry`;
 * - фильтры `key`, `kind`/`id` и `active` сужают список; задания, названные
 *   ключом или предметом, идут целиком;
 * - если ответ всё равно не помещается, история полных заданий сокращается
 *   до последних событий (когда не помещаются обязательные задания или
 *   законченные названы и идут целиком), затем уходят законченные — сначала
 *   старейшие неповторяемые, затем старейшие повторяемые. Задание, названное
 *   `key`, не уходит никогда. Отказ остаётся только для того, что сузить нечем.
 */
import { z } from 'zod';
import { checkJsonBytes, jsonBytes } from 'devcontour-harness';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import type { DevContour } from '../core/service.ts';
import { DomainError } from '../core/model.ts';
import { short } from './bounded.ts';
import { queueStopOf, quietAttempts, quietOperations } from './queue-stop.ts';
import { WORKFLOW_STATUS_OVERSIZED } from './response-limit.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

/** Сколько законченных заданий перечислено без `limit`. */
export const FINISHED_DEFAULT = 10;
/** Наибольший `limit`. */
export const FINISHED_MAX = 200;
/** Бюджет ответа: предел агентского API 64 KiB с запасом под конверт. */
const BUDGET = 60000;
/** Сколько последних событий истории остаётся у полного задания при нехватке места. */
const HISTORY_TAIL = 20;
/** Предел текста ошибки: столько хранит очередь harness. */
const ERROR_MAX = 1000;

export const workflowStatusInput = z.strictObject({
  repositoryId: id.optional(),
  key: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  kind: z.enum(['board', 'changeset']).optional(),
  id: id.optional(),
  active: z.boolean().optional(),
  limit: z.number().int().min(1).max(FINISHED_MAX).optional(),
});
export type WorkflowStatusInput = z.infer<typeof workflowStatusInput>;

const ACTIVE = new Set<WorkflowJob['status']>(['queued', 'running']);
const isActive = (j: Pick<WorkflowJob, 'status'>) => ACTIVE.has(j.status);
/** Сколько повторяемых упавших заданий перечислено сверх `limit`. */
export const RETRYABLE_PINNED = 10;

/**
 * Упавшие задания, которые `workflow_retry` ещё может повторить: попыток
 * стадии меньше предела и задание — последнее для своего предмета (доски или
 * ChangeSet). Обычный выход после диагностики — новая регистрация того же
 * предмета под новым ключом; прежнее упавшее задание остаётся `failed`
 * навсегда (очередь пересматривает только queued и running), и его повтор
 * отклоняется. Более новое задание того же предмета — дешёвый признак этого.
 */
function retryableKeys(jobs: WorkflowJob[]) {
  const newest = new Map<string, WorkflowJob>();
  for (const j of jobs) {
    const subject = `${j.kind}:${j.id}`;
    const seen = newest.get(subject);
    if (
      !seen ||
      j.startedAt > seen.startedAt ||
      (j.startedAt === seen.startedAt && j.key > seen.key)
    )
      newest.set(subject, j);
  }
  return new Set(
    [...newest.values()]
      .filter((j) => j.status === 'failed' && j.attempts < j.maxAttempts)
      .map((j) => j.key),
  );
}

/**
 * Когда задание закончилось. Завершение пишет `finishedAt`, отказ при взятии
 * стадии — событие истории со своим статусом. С harness 0.1.0-alpha.46
 * отказ стадии в ходе работы (`fail` очереди) тоже пишет `finishedAt`;
 * задания, упавшие на прежних версиях, времени не имеют: для них лучшее, что
 * есть, — последнее событие истории или начало задания, что позже; такое
 * время помечено как оценка.
 */
function ending(j: WorkflowJob) {
  const last = j.history.at(-1);
  if (j.finishedAt) return { at: j.finishedAt, estimated: false };
  if (last?.event === j.status) return { at: last.at, estimated: false };
  const at = last && last.at > j.startedAt ? last.at : j.startedAt;
  return { at, estimated: true };
}

/** Публичный вид задания: без fencing-токена. */
export function publicJob<T extends { token?: string }>(job: T) {
  const { token: _token, ...rest } = job;
  return rest;
}

/** Компактный вид законченного задания: без истории, входного digest и lease. */
function compactJob(job: WorkflowJob, retryable: boolean) {
  const last = job.history.at(-1);
  const end = ending(job);
  return {
    key: job.key,
    kind: job.kind,
    id: job.id,
    ...(job.owner === undefined ? {} : { owner: job.owner }),
    authorRuntime: job.authorRuntime,
    stage: job.stage,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    ...(job.repairs ? { repairs: job.repairs } : {}),
    startedAt: job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    endedAt: end.at,
    ...(end.estimated ? { endedAtEstimated: true } : {}),
    ...(job.error ? { error: short(job.error, ERROR_MAX) } : {}),
    // Последнее событие не противоречит статусу: отказ без отметки в истории
    // назван статусом, без времени (его нет в записи).
    lastEvent:
      last?.event === job.status ? last : { stage: job.stage, event: job.status as string },
    historyLength: job.history.length,
    ...(retryable ? { retryable: true } : {}),
    compact: true as const,
  };
}

const READ_MORE =
  'key returns one job in full (whole error and history); kind and id list the jobs of one board or ChangeSet in full; ' +
  `active true lists only queued and running jobs; limit sets how many finished jobs are listed (up to ${FINISHED_MAX}).`;

function finishedHint(o: {
  named: boolean;
  activeOnly: boolean;
  limit: number;
  total: number;
  omitted: number;
  clipped: boolean;
  retryableUnlisted: number;
}) {
  if (o.activeOnly)
    return `active true lists no finished jobs; ${o.total} match: omit active or pass false to list them.`;
  if (o.named)
    return (
      'Finished jobs are listed in full' +
      (o.clipped ? '; a history longer than 20 events is cut to its tail (historyOmitted)' : '') +
      (o.omitted
        ? `; the oldest ${o.omitted} were dropped to fit the response limit: lower limit or read one job by key`
        : '') +
      '.'
    );
  return (
    `Finished jobs (completed, failed, stale): the latest ${o.limit} by end time and up to ${RETRYABLE_PINNED} retryable failed jobs ` +
    '(the newest job of their board or ChangeSet, attempts left) are listed compact, without history; ' +
    'jobs keep store order, not time order (sort by endedAt). ' +
    (o.retryableUnlisted
      ? `${o.retryableUnlisted} retryable failed jobs are not listed (over ${RETRYABLE_PINNED} or dropped to fit the response limit): read them by key, or with active false and a smaller limit. `
      : '') +
    READ_MORE
  );
}

export function workflowStatus(h: DevContour, raw: unknown) {
  const input = workflowStatusInput.parse(raw);
  const owner = input.repositoryId;
  const state = h.store.read();
  const now = Date.now();
  const workflow = new LeadWorkflow(h);
  const owned = workflow.list(owner);
  // Повторяемость решают все задания владельца, а не только выбранные.
  const retryables = retryableKeys(owned);
  const retryable = (j: WorkflowJob) => retryables.has(j.key);
  // Предмет запроса без `active`: законченные считаются и при active true.
  const matching = owned.filter(
    (j) =>
      (input.key === undefined || j.key === input.key) &&
      (input.kind === undefined || j.kind === input.kind) &&
      (input.id === undefined || j.id === input.id),
  );
  const selected = matching.filter(
    (j) => input.active === undefined || isActive(j) === input.active,
  );
  // Названные ключом или предметом задания — немного и целиком: ведущий
  // разбирает именно их историю.
  const named = input.key !== undefined || input.id !== undefined;
  const limit = input.limit ?? FINISHED_DEFAULT;
  const finished = matching.filter((j) => !isActive(j));
  const ends = new Map(finished.map((j) => [j.key, ending(j).at]));
  // Последние законченные первыми; при равном времени — по ключу, стабильно.
  const recent = selected
    .filter((j) => !isActive(j))
    .sort((a, b) => ends.get(b.key)!.localeCompare(ends.get(a.key)!) || a.key.localeCompare(b.key));
  const chosen = new Set([
    ...recent.slice(0, limit).map((j) => j.key),
    ...recent
      .filter(retryable)
      .slice(0, RETRYABLE_PINNED)
      .map((j) => j.key),
  ]);
  // Порядок ухода при нехватке места: старейшие неповторяемые, затем
  // старейшие повторяемые; задание, названное ключом, не уходит.
  const dropOrder = [...recent]
    .reverse()
    .filter((j) => chosen.has(j.key) && j.key !== input.key)
    .sort((a, b) => Number(retryable(a)) - Number(retryable(b)));
  let historyClipped = false;
  const clip = (j: WorkflowJob) =>
    historyClipped && j.history.length > HISTORY_TAIL
      ? {
          history: j.history.slice(-HISTORY_TAIL),
          historyOmitted: j.history.length - HISTORY_TAIL,
        }
      : {};
  // Вид задания не зависит от того, сколько законченных перечислено:
  // пересборка ответа при нехватке места не пересчитывает ожидания.
  const views = new Map<string, Record<string, unknown>>();
  const view = (j: WorkflowJob) => {
    const id = `${historyClipped}:${j.key}`;
    if (!views.has(id)) views.set(id, viewOf(j));
    return views.get(id)!;
  };
  const viewOf = (j: WorkflowJob): Record<string, unknown> => {
    if (!isActive(j)) return named ? { ...publicJob(j), ...clip(j) } : compactJob(j, retryable(j));
    // Стадия ждёт только ответов на вопросы исполнителя: «ждёт ответа», не сбой.
    const waiting = workflow.waitingOf(j, state, now);
    return { ...publicJob(j), ...clip(j), ...(waiting ? { waiting } : {}) };
  };
  const byStatus = { completed: 0, failed: 0, stale: 0 };
  for (const j of finished) byStatus[j.status as keyof typeof byStatus] += 1;
  const rest = {
    // Задания досок компонентов идут у своих владельцев: без repositoryId
    // они не в `jobs`, но их число и подсказка — здесь.
    ...(owner === undefined ? workflow.otherOwners() : {}),
    operatorBlocked: h.config.approvalMode === 'operator',
    // Стадии ждут выдачи: остановленная очередь и её причина — рядом.
    queue: queueStopOf(h, state),
    // Идущие попытки без движения: зависание замечают без запроса журнала.
    liveness: quietAttempts(state, now, owner),
    // Проверки вне попыток (совместная, базы, доски) без движения.
    operations: quietOperations(h, state, now, 'agent', owner),
  };
  const activeOnly = input.active === true;
  const build = (shown: Set<string>) => {
    const omitted = finished.length - shown.size;
    return {
      // Порядок хранилища, как прежде; законченные — только перечисленные.
      jobs: selected.filter((j) => isActive(j) || shown.has(j.key)).map(view),
      finished: {
        total: finished.length,
        byStatus,
        retryable: finished.filter(retryable).length,
        listed: shown.size,
        omitted,
        compact: !named,
        ...(finished.length && (activeOnly || !named || omitted || historyClipped)
          ? {
              hint: finishedHint({
                named,
                activeOnly,
                limit,
                total: finished.length,
                omitted,
                clipped: historyClipped,
                retryableUnlisted: recent.filter((j) => retryable(j) && !shown.has(j.key)).length,
              }),
            }
          : {}),
      },
      ...(historyClipped ? { historyClipped: true } : {}),
      ...rest,
    };
  };
  const fits = (value: unknown) => checkJsonBytes(value, BUDGET).within;
  const keep = new Set(chosen);
  let result = build(keep);
  if (!fits(result)) {
    // История сокращается, если без законченных (кроме названного ключом)
    // ответ всё равно не помещается или законченные названы и идут целиком.
    const required = new Set([...chosen].filter((k) => k === input.key));
    if (named || !fits(build(required))) {
      historyClipped = true;
      result = build(keep);
    }
    // Затем уходят законченные по порядку. Размер вычитается по видам
    // заданий, без сериализации ответа на каждом шаге; итог сверяется.
    let size = jsonBytes(result);
    const pending = [...dropOrder];
    while (size > BUDGET && pending.length) {
      const j = pending.shift()!;
      keep.delete(j.key);
      size -= jsonBytes(view(j)) + 1;
    }
    result = build(keep);
    while (!fits(result) && pending.length) {
      keep.delete(pending.shift()!.key);
      result = build(keep);
    }
  }
  if (!fits(result))
    throw new DomainError(
      input.key === undefined
        ? WORKFLOW_STATUS_OVERSIZED
        : 'Ответ workflow_status превышает 64 KiB даже для одного задания key: не помещается и хвост его истории (последние 20 событий). Сузить запрос нечем',
      413,
    );
  return result;
}
