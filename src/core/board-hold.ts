import { digest, type DevContour } from './service.ts';
import type { DevContourState, Task } from './model.ts';
import { DomainError } from './model.ts';
import { LeadWorkflow, type WorkflowJob } from './lead-workflow.ts';
import { boardOwner } from './sync-state.ts';
import { compareWorkflowJobs } from 'devcontour-harness';

/**
 * Решения ведущего (или оператора) о доске, которые не меняют её план и не
 * синхронизируются через Git: «доска отложена» и «задание мёртвой доски
 * закрыто» (F86). Это локальные записи workspace (`local_workflow`), как
 * операции изменения контракта: они влияют только на то, что показывают
 * шаг `session_handoff` (`host.next`) и центр внимания, а не на выдачу,
 * приёмку или вход задания.
 */
const PARK = 'board-park';
const CLOSURE = 'job-closure';

/** Кто записал решение: `lead` — ведущий агент (`--by host`), `operator` — человек. */
export type HoldActor = 'lead' | 'operator';

/** Доска отложена: решения о её плане и старт задания ждут снятия отметки. */
export interface BoardPark {
  boardId: string;
  reason: string;
  /** Срок отметки (ISO): после него доска снова в обычных шагах. */
  until?: string;
  by: HoldActor;
  at: string;
  /** Ревизия доски, которую отложили: новая ревизия снимает действие отметки. */
  revision: number;
  /** Последнее событие журнала при записи: утверждение после него снимает отметку. */
  eventId: number;
  /**
   * Утверждения задач ревизии при записи (`approvedAt`, `approvedDigest`):
   * новое утверждение — в том числе пришедшее через Git sync, где события
   * `board.approved` нет, — снимает отметку.
   */
  approvals: Record<string, { at?: string; digest?: string }>;
  /** Остановка последнего задания доски при записи; `null` — заданий не было. */
  job: string | null;
  /** Отметка опиралась на закрытие упавшего задания (`workflow_close`). */
  closed?: true;
}

/**
 * Упавшее задание мёртвой доски закрыто: его остановка больше не шаг.
 * Закрытие относится к одному эпизоду остановки: тому же заданию с теми же
 * попытками, окончанием и ошибкой и тем же задачам ревизии (`tasks` —
 * digest статуса, актёра отмены, попыток, утверждения, класса отказа и
 * прогонов каждой). Повтор задания, любое событие задач ревизии после
 * закрытия по номеру журнала (`task.retry`, `task.reopened`,
 * `task.cancelled`, `board.approved` после `eventId`) или другая перемена
 * этих полей возвращает обычные шаги навсегда: возврат состояния к прежнему
 * виду эпизод не восстанавливает, новое закрытие — новое решение.
 */
export interface JobClosure {
  boardId: string;
  jobKey: string;
  reason: string;
  by: HoldActor;
  at: string;
  job: { attempts: number; stage: number; finishedAt?: string; error?: string };
  tasks: string;
  eventId: number;
}

const REASON_MIN = 10;
/** Предел причины: она идёт в `host.parked` пакета передачи (до десяти досок). */
const REASON_MAX = 300;
const reasonOf = (text: string) => {
  const reason = text.trim();
  if ([...reason].length < REASON_MIN || [...reason].length > REASON_MAX)
    throw new DomainError(`Причина: от ${REASON_MIN} до ${REASON_MAX} знаков`, 400);
  return reason;
};

/** Действующая отметка «отложена»; истёкшая (`until` в прошлом) не действует. */
export function parkOf(h: DevContour, boardId: string, now = Date.now()): BoardPark | undefined {
  const park = h.store.localRecord<BoardPark>(PARK, undefined, boardId);
  if (!park) return undefined;
  if (park.until && Date.parse(park.until) <= now) return undefined;
  return park;
}

/**
 * Отметка, которая действует на шаги доски в этом состоянии: срок не истёк,
 * ревизия не принята и в ней нет утверждённых незаконченных задач. Задачи,
 * утверждённые после отметки (например, ревью плана изменения контракта),
 * очередь выдаст и так — их шаги отметка не прячет.
 */
export function parkedHold(h: DevContour, s: DevContourState, boardId: string) {
  const park = parkOf(h, boardId);
  if (!park) return undefined;
  const board = s.boards.find((b) => b.id === boardId);
  const revision = board?.revisions.at(-1);
  if (!board || !revision || revision.status === 'accepted') return undefined;
  // Новая ревизия, утверждение задач доски или старт её задания после
  // отметки — решение выпустить работу: отметка перестаёт действовать
  // навсегда, даже когда задачи потом снова отменены или в черновике.
  if (revision.number !== park.revision) return undefined;
  const tasks = s.tasks.filter((t) => revision.taskIds.includes(t.id));
  if (tasks.some(releasable)) return undefined;
  // Утверждение по состоянию: локальное меняет `approvedAt` (возврат в
  // черновик его не стирает), пришедшее через sync — `approvedDigest`.
  for (const t of tasks) {
    const was = park.approvals[t.id];
    if (t.approvedAt !== was?.at) return undefined;
    if (t.approvedDigest && t.approvedDigest !== was?.digest) return undefined;
  }
  // Утверждение по журналу (последовательность, а не время): возврат в
  // черновик после него утверждения не отменяет.
  const ids = new Set(revision.taskIds);
  const later = h.store.eventsAfterOfTypes(park.eventId, ['board.approved', 'task.reopened']);
  if (
    later.some((e) => {
      const d = e.data as { boardId?: string; taskId?: string; wasApproved?: boolean } | null;
      return e.type === 'board.approved'
        ? d?.boardId === boardId
        : !!d?.taskId && ids.has(d.taskId) && !!d.wasApproved && !park.approvals[d.taskId]?.digest;
    })
  )
    return undefined;
  // Задание доски после отметки: новое, повтор или новая остановка — решение
  // о работе, и отметка его не прячет; закрытие, на которое она опиралась,
  // тоже должно действовать.
  const last = boardJobs(h, s, boardId).at(-1);
  if (jobStop(last) !== park.job) return undefined;
  if (park.closed && (!last || !closureOf(h, s, boardId, last))) return undefined;
  return park;
}

/** Остановка задания для сравнения: ключ, статус, попытки, окончание и ошибка. */
const jobStop = (job: WorkflowJob | undefined) =>
  job
    ? JSON.stringify([
        job.key,
        job.status,
        job.attempts,
        job.stage,
        job.finishedAt ?? null,
        job.error ?? null,
      ])
    : null;

/** Все действующие отметки «отложена» (для пакета передачи). */
export function parkedBoards(h: DevContour, now = Date.now()) {
  return Object.values(h.store.localRecords<BoardPark>(PARK)).filter(
    (p) => !p.until || Date.parse(p.until) > now,
  );
}

/** Отказ действия, которое выпустило бы работу отложенной доски. */
export function assertNotParked(h: DevContour, boardId: string, action: string) {
  const park = parkedHold(h, h.store.read(), boardId);
  if (!park) return;
  throw new DomainError(
    `Доска ${boardId} отложена (${park.reason}${park.until ? `; до ${park.until}` : ''}): ${action} ждёт снятия отметки — board_park {"boardId": "${boardId}", "parked": false} (CLI devcontour board-park --board ${boardId} --unpark)`,
    409,
    { code: 'BOARD_PARKED' },
  );
}

/** Задачи ревизии, которые очередь может выдать: утверждённые и не законченные. */
const releasable = (t: Task) => !['draft', 'done', 'cancelled'].includes(t.status);

/** Задания доски у её владельца, последнее — последним. */
function boardJobs(h: DevContour, s: DevContourState, boardId: string) {
  const board = s.boards.find((b) => b.id === boardId)!;
  return new LeadWorkflow(h)
    .list(boardOwner(board, s))
    .filter((j) => j.kind === 'board' && j.id === boardId)
    .sort(compareWorkflowJobs);
}

/**
 * Отложить доску (или снять отметку). Отложить можно только доску, работа
 * которой не идёт и не будет выдана без решения: у текущей ревизии нет
 * утверждённых незаконченных задач (очередь выдала бы их и без задания,
 * F75), а последнее задание доски не действует и не упало (упавшее —
 * решение по заданию: повтор, решение пользователя или его закрытие).
 * Принятую ревизию откладывать нечего. Отметка не меняет вход задания,
 * план и приёмку; пока она действует, `workflow_start` и `plan_review`
 * доски отказывают, а шаг пакета и карточка центра внимания доски не
 * показываются.
 */
export function setPark(
  h: DevContour,
  boardId: string,
  value: { parked: boolean; reason?: string; until?: string },
  by: HoldActor,
) {
  return h.store.atomic(() => {
    const s = h.store.read();
    const board = s.boards.find((b) => b.id === boardId);
    if (!board) throw new DomainError('Доска не найдена', 404);
    if (!value.parked) {
      const was = h.store.localRecord<BoardPark>(PARK, undefined, boardId);
      if (was) h.store.deleteLocal(PARK, undefined, boardId);
      return { boardId, parked: false as const, ...(was ? { was } : {}) };
    }
    if (value.reason === undefined) throw new DomainError('Укажите причину: reason', 400);
    const reason = reasonOf(value.reason);
    let until: string | undefined;
    if (value.until !== undefined) {
      const at = isoDateTime(value.until);
      if (at === undefined)
        throw new DomainError(
          'until: ожидается дата и время ISO 8601 со смещением, например 2026-12-01T00:00:00Z',
          400,
        );
      if (at <= Date.now()) throw new DomainError('until: срок уже прошёл', 400);
      until = new Date(at).toISOString();
    }
    const revision = board.revisions.at(-1)!;
    if (revision.status === 'accepted')
      throw new DomainError(
        'Ревизия доски принята: откладывать нечего (следующий этап — plan_import с boardId)',
        409,
      );
    const released = s.tasks.filter((t) => revision.taskIds.includes(t.id) && releasable(t));
    if (released.length)
      throw new DomainError(
        `Задачи доски уже утверждены и будут выданы без её задания: ${released.map((t) => t.id).join(', ')}. Отложить можно доску только с черновиками (верните задачи в черновик — reopen — или отмените их)`,
        409,
      );
    const last = boardJobs(h, s, boardId).at(-1);
    if (last && ['queued', 'running'].includes(last.status))
      throw new DomainError(
        `У доски действующее задание ${last.key} (${last.status}): отложенная доска заданий не ведёт`,
        409,
      );
    if (last?.status === 'failed' && !closureOf(h, s, boardId, last))
      throw new DomainError(
        `Последнее задание доски ${last.key} упало: это решение по заданию (повтор, решение пользователя или workflow_close для мёртвой доски), а не отметка «отложена»`,
        409,
      );
    const park: BoardPark = {
      boardId,
      reason,
      ...(until ? { until } : {}),
      by,
      at: new Date().toISOString(),
      revision: revision.number,
      eventId: h.store.lastEventId(),
      approvals: Object.fromEntries(
        s.tasks
          .filter((t) => revision.taskIds.includes(t.id))
          .map((t) => [
            t.id,
            {
              ...(t.approvedAt ? { at: t.approvedAt } : {}),
              ...(t.approvedDigest ? { digest: t.approvedDigest } : {}),
            },
          ]),
      ),
      job: jobStop(last),
      ...(last?.status === 'failed' ? { closed: true as const } : {}),
    };
    h.store.saveLocal(PARK, undefined, boardId, park);
    return { boardId, parked: true as const, park };
  });
}

/**
 * Строгая дата и время ISO 8601 со смещением (`Z` или `±hh:mm`): число
 * миллисекунд или `undefined`. `Date.parse` принял бы и местное время, и
 * несуществующий день (30 февраля — 2 марта).
 */
export function isoDateTime(text: string): number | undefined {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!m) return undefined;
  const [y, mo, d, hh, mm, ss] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d)
    return undefined;
  if (hh > 23 || mm > 59 || ss > 59) return undefined;
  if (m[7] !== 'Z') {
    const [oh, om] = m[7].slice(1).split(':').map(Number);
    if (oh > 23 || om > 59) return undefined;
  }
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

/** Задание, к эпизоду остановки которого относится закрытие. */
type ClosedJob = Pick<WorkflowJob, 'key' | 'attempts' | 'stage' | 'finishedAt' | 'error'>;

/** Эпизод задачи ревизии для закрытия: перемена любого поля снимает его. */
function tasksEpisode(s: DevContourState, taskIds: readonly string[]) {
  return digest(
    taskIds.map((id) => {
      const t = s.tasks.find((x) => x.id === id);
      return t
        ? {
            id,
            status: t.status,
            cancelledBy: t.cancelledBy ?? null,
            attempt: t.attempt,
            approvedAt: t.approvedAt ?? null,
            approvedDigest: t.approvedDigest ?? null,
            failureKind: t.failureKind ?? null,
            budget: !!t.budgetBlock,
            runs: s.runs.filter((r) => r.taskId === id).length,
          }
        : { id };
    }),
  );
}

const jobEpisode = (job: ClosedJob) => ({
  attempts: job.attempts,
  stage: job.stage,
  ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
  ...(job.error ? { error: job.error } : {}),
});

/**
 * Закрытие упавшего задания `job` доски, если оно записано для этого же
 * эпизода остановки (см. `JobClosure`).
 */
export function closureOf(h: DevContour, s: DevContourState, boardId: string, job: ClosedJob) {
  const closure = h.store.localRecord<JobClosure>(CLOSURE, undefined, boardId);
  if (!closure || closure.jobKey !== job.key) return undefined;
  if (JSON.stringify(closure.job) !== JSON.stringify(jobEpisode(job))) return undefined;
  const taskIds = s.boards.find((b) => b.id === boardId)?.revisions.at(-1)?.taskIds ?? [];
  if (closure.tasks !== tasksEpisode(s, taskIds)) return undefined;
  const ids = new Set(taskIds);
  // Любая перемена задач ревизии после закрытия по журналу (номер события,
  // а не время): повтор, возврат в черновик, новая отмена, утверждение.
  // Состояние могло вернуться к прежнему виду — эпизод уже другой.
  if (
    h.store
      .eventsAfterOfTypes(closure.eventId, [
        'task.retry',
        'task.reopened',
        'task.cancelled',
        'board.approved',
      ])
      .some((e) => {
        const d = e.data as { taskId?: string; boardId?: string } | null;
        return e.type === 'board.approved' ? d?.boardId === boardId : ids.has(d?.taskId ?? '');
      })
  )
    return undefined;
  return closure;
}

/**
 * Отменённые задачи ревизии, остановка на которых — решение пользователя:
 * отменённые человеком или без записанного актёра (в том числе
 * синхронизированные из Git, где актёра и прогонов нет — происхождение
 * неизвестно, и правило закрыто), либо остановленные бюджетом (поднять
 * предел — решение пользователя). Проверяются все отменённые задачи, а не
 * только выданные здесь: о чужой выдаче локальные прогоны не знают. Пустой
 * список у мёртвой доски — ведущий может закрыть её задание (`closable`).
 */
export function userStoppers(s: DevContourState, taskIds: readonly string[]) {
  return s.tasks
    .filter((t) => taskIds.includes(t.id) && t.status === 'cancelled')
    .filter(
      (t) =>
        (t.cancelledBy !== 'host' && t.cancelledBy !== 'graph') ||
        t.failureKind === 'budget' ||
        !!t.budgetBlock ||
        s.runs.findLast((r) => r.taskId === t.id)?.failureKind === 'budget',
    );
}

/**
 * Закрыть упавшее задание мёртвой доски (F86). Мёртвая доска — все задачи
 * её текущей ревизии отменены: принять её нельзя (приёмке нужна хотя бы
 * одна неотменённая задача), и упавшее на отменённой выданной задаче
 * задание (D46) не продолжится никогда. Его остановка оставалась шагом
 * ведущего (`job-cancelled-task`, `job-exhausted`) и карточкой оператора,
 * хотя работа давно перепланирована на другой доске.
 *
 * Гарантия D46 сохраняется: закрытие ничего не принимает и задачу не
 * выводит из работы, а только снимает показ остановки. Ведущий закрывает
 * задание, только если все отменённые задачи ревизии отменил он сам (`host`)
 * или новая редакция графа (`graph`) и ни одну не остановил бюджет: повтор
 * отмены человека и подъём предела — решения человека, и закрытие такого
 * задания — тоже (`--by operator`). Доска с неотменённой
 * задачей мёртвой не считается: её приёмка без задачи — решение
 * пользователя. Закрытие действует на один эпизод остановки (`JobClosure`):
 * повтор задания или задачи, новая задача ревизии, новый актёр отмены
 * возвращают обычные шаги.
 */
export function closeDeadJob(h: DevContour, boardId: string, reasonText: string, by: HoldActor) {
  const reason = reasonOf(reasonText);
  return h.store.atomic(() => {
    const s = h.store.read();
    const board = s.boards.find((b) => b.id === boardId);
    if (!board) throw new DomainError('Доска не найдена', 404);
    const revision = board.revisions.at(-1)!;
    const tasks = s.tasks.filter((t) => revision.taskIds.includes(t.id));
    const alive = tasks.filter((t) => t.status !== 'cancelled');
    if (!tasks.length || alive.length)
      throw new DomainError(
        `Доска не мертва: в её ревизии есть неотменённые задачи (${alive.map((t) => t.id).join(', ') || 'задач нет'}). Закрыть можно только задание доски, все задачи которой отменены; приёмка ревизии без задачи — решение пользователя`,
        409,
      );
    const job: WorkflowJob | undefined = boardJobs(h, s, boardId).at(-1);
    if (!job || job.status !== 'failed')
      throw new DomainError(
        job
          ? `Последнее задание доски ${job.key} — ${job.status}, не упавшее: закрывать нечего${['queued', 'running'].includes(job.status) ? ' (действующее задание упадёт на отменённой задаче само)' : ''}`
          : 'У доски нет заданий: закрывать нечего',
        409,
      );
    if (by === 'lead') {
      const user = userStoppers(s, revision.taskIds);
      if (user.length)
        throw new DomainError(
          `Задачи ${user.map((t) => t.id).join(', ')} отменены человеком (или актёр не записан) либо остановлены бюджетом: продолжение или закрытие задания их доски — решение пользователя (devcontour workflow-close --board ${boardId} --reason … --by operator)`,
          409,
        );
    }
    const closure: JobClosure = {
      boardId,
      jobKey: job.key,
      reason,
      by,
      at: new Date().toISOString(),
      job: jobEpisode(job),
      tasks: tasksEpisode(s, revision.taskIds),
      eventId: h.store.lastEventId(),
    };
    h.store.saveLocal(CLOSURE, undefined, boardId, closure);
    return { boardId, job: { key: job.key, status: job.status }, closure };
  });
}
