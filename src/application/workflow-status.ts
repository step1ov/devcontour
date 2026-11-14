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
 *   числом в `finished`;
 * - фильтры `key`, `kind`/`id` и `active` сужают список; задания, названные
 *   ключом или предметом, идут целиком;
 * - если ответ всё равно не помещается: когда не помещаются сами действующие,
 *   их история сокращается до последних событий; затем уходят самые старые
 *   законченные задания. Отказ остаётся только для того, что сузить нечем.
 */
import { z } from 'zod';
import { checkJsonBytes } from 'devcontour-harness';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import type { DevContour } from '../core/service.ts';
import { DomainError } from '../core/model.ts';
import { SHORT, short } from './bounded.ts';
import { queueStopOf, quietAttempts, quietOperations } from './queue-stop.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

/** Сколько законченных заданий перечислено без `limit`. */
export const FINISHED_DEFAULT = 10;
/** Наибольший `limit`. */
export const FINISHED_MAX = 200;
/** Бюджет ответа: предел агентского API 64 KiB с запасом под конверт. */
const BUDGET = 60000;
/** Сколько последних событий истории остаётся у действующего задания при нехватке места. */
const HISTORY_TAIL = 20;

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

/** Отказ по размеру называет существующий путь сузить запрос. */
export const WORKFLOW_STATUS_OVERSIZED =
  'Ответ workflow_status превышает 64 KiB: сузьте запрос полями его входа — key (одно задание), kind и id (задания одной доски или ChangeSet), active (true — только действующие), limit (число законченных)';

const ACTIVE = new Set<WorkflowJob['status']>(['queued', 'running']);
const isActive = (j: Pick<WorkflowJob, 'status'>) => ACTIVE.has(j.status);
/** Когда задание закончилось: для порядка «последние сначала». */
const endedAt = (j: WorkflowJob) => j.finishedAt ?? j.history.at(-1)?.at ?? j.startedAt;

/** Публичный вид задания: без fencing-токена. */
export function publicJob<T extends { token?: string }>(job: T) {
  const { token: _token, ...rest } = job;
  return rest;
}

/** Компактный вид законченного задания: без истории, входного digest и lease. */
function compactJob(job: WorkflowJob) {
  const last = job.history.at(-1);
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
    ...(job.error ? { error: short(job.error, SHORT) } : {}),
    ...(last ? { lastEvent: last } : {}),
    historyLength: job.history.length,
    compact: true as const,
  };
}

function finishedHint(limit: number) {
  return (
    `Finished jobs (completed, failed, stale) are listed compact (no history), latest ${limit} first by end time. ` +
    'Narrow or widen with workflow_status input: key (one job in full), kind and id (the jobs of one board or ChangeSet in full), ' +
    `active (true: only queued and running; false: only finished), limit (finished jobs listed, up to ${FINISHED_MAX}).`
  );
}

export function workflowStatus(h: DevContour, raw: unknown) {
  const input = workflowStatusInput.parse(raw);
  const owner = input.repositoryId;
  const state = h.store.read();
  const now = Date.now();
  const workflow = new LeadWorkflow(h);
  const all = workflow.list(owner);
  const selected = all.filter(
    (j) =>
      (input.key === undefined || j.key === input.key) &&
      (input.kind === undefined || j.kind === input.kind) &&
      (input.id === undefined || j.id === input.id) &&
      (input.active === undefined || isActive(j) === input.active),
  );
  // Названные ключом или предметом задания — немного и целиком: ведущий
  // разбирает именно их историю.
  const named = input.key !== undefined || input.id !== undefined;
  const limit = input.limit ?? FINISHED_DEFAULT;
  const finished = selected.filter((j) => !isActive(j));
  // Последние законченные первыми; при равном времени — по ключу, стабильно.
  const recent = [...finished].sort(
    (a, b) => endedAt(b).localeCompare(endedAt(a)) || a.key.localeCompare(b.key),
  );
  let listed = recent.slice(0, limit);
  let historyClipped = false;
  // Вид задания не зависит от того, сколько законченных перечислено:
  // пересборка ответа при нехватке места не пересчитывает ожидания.
  const views = new Map<string, Record<string, unknown>>();
  const view = (j: WorkflowJob) => {
    const id = `${historyClipped}:${j.key}`;
    if (!views.has(id)) views.set(id, viewOf(j));
    return views.get(id)!;
  };
  const viewOf = (j: WorkflowJob): Record<string, unknown> => {
    if (!isActive(j)) return named ? publicJob(j) : compactJob(j);
    // Стадия ждёт только ответов на вопросы исполнителя: «ждёт ответа», не сбой.
    const waiting = workflow.waitingOf(j, state, now);
    const full = publicJob(j);
    const history =
      historyClipped && j.history.length > HISTORY_TAIL
        ? {
            history: j.history.slice(-HISTORY_TAIL),
            historyOmitted: j.history.length - HISTORY_TAIL,
          }
        : {};
    return { ...full, ...history, ...(waiting ? { waiting } : {}) };
  };
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
  const build = () => {
    const shown = new Set(listed.map((j) => j.key));
    const omitted = finished.length - listed.length;
    return {
      // Порядок хранилища, как прежде; законченные — только перечисленные.
      jobs: selected.filter((j) => isActive(j) || shown.has(j.key)).map(view),
      finished: {
        total: finished.length,
        listed: listed.length,
        omitted,
        compact: !named,
        ...(finished.length && (omitted || !named) ? { hint: finishedHint(limit) } : {}),
      },
      ...(historyClipped ? { historyClipped: true } : {}),
      ...rest,
    };
  };
  const fits = (value: unknown) => checkJsonBytes(value, BUDGET).within;
  let result = build();
  if (!fits(result)) {
    // Действующие сами не помещаются — их история сокращается до хвоста;
    // иначе место освобождают законченные, и история остаётся целой.
    const chosen = listed;
    listed = [];
    if (!fits(build())) historyClipped = true;
    listed = chosen;
    result = build();
    // Затем — старейшие законченные по одному: размер зависит от данных.
    while (!fits(result) && listed.length) {
      listed = listed.slice(0, -1);
      result = build();
    }
  }
  if (!fits(result)) throw new DomainError(WORKFLOW_STATUS_OVERSIZED, 413);
  return result;
}
