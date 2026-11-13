// Продолжение после ответа без отдельной сессии ведущего: состояние
// автоматического прохода цепочки `input_context` → `input_review` →
// `input_target` → `input_apply`, который ведёт сервер (`InputResumer`,
// src/runner/input-resume.ts). Здесь — общие записи и проекция для сводки
// вопроса, панели, центра внимания и пакета передачи; вызовов модели нет.
import { latestAnswer, type InputRequest } from 'devcontour-harness';
import type { DevContour } from '../core/service.ts';
import type { Task } from '../core/model.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { repositories } from '../core/repositories.ts';
import { pausedByLead } from '../core/work-status.ts';

/** Локальные записи прохода (`local_workflow`): ключ — ID запроса; `@driver` — признак живого сервера. */
export const RESUME = 'input-resume';
export const RESUME_DRIVER = '@driver';

/** Сколько ревью одного ответа (по digest) сервер проводит сам. */
export const RESUME_REVIEWS = 3;
/** Пауза перед повтором после сбоя ревью: 30 с, удваивается. */
export const RESUME_BACKOFF_MS = 30_000;
/** Ответ ведущего сервер берёт не сразу: живой ведущий доводит свою цепочку сам. */
export const RESUME_LEAD_GRACE_MS = 60_000;

/** Состояния вопроса, которые проход доводит сам. */
export const resumable = new Set(['answer-saved', 'stale', 'context-review', 'ready-to-apply']);

/**
 * Запись прохода по запросу. Относится к ответу `answerDigest`: новый ответ
 * начинает проход заново. `trigger` — кто дал ответ, который продолжает работу.
 */
export interface ResumeRecord {
  requestId: string;
  taskId: string;
  answerDigest: string;
  revision: number;
  trigger: 'operator' | 'lead' | 'host';
  phase: 'reviewing' | 'waiting-active' | 'failed' | 'blocked' | 'applied' | 'rejected';
  /** Ревью, начатые проходом по этому ответу (учтены до вызова модели). */
  reviews: number;
  at: string;
  notBefore?: number;
  error?: string;
  problems?: string[];
}

/**
 * Фаза прохода для читателя. `auto` — DevContour продолжает сам, действовать
 * никому не нужно; иначе `detail` называет, почему нужен ведущий агент.
 */
export type ResumePhase =
  | 'pending'
  | 'grace'
  | 'reviewing'
  | 'applying'
  | 'waiting-active'
  | 'retry'
  | 'paused'
  | 'failed'
  | 'blocked'
  | 'needs-lead';
export interface ResumeView {
  phase: ResumePhase;
  auto: boolean;
  trigger: 'operator' | 'lead' | 'host';
  /** Причина остановки прохода или ожидания (текст ошибки, причины цели). */
  detail?: string;
  /** Когда проход продолжит (повтор после сбоя, окончание ожидания ответа ведущего). */
  until?: string;
}

const AUTO = new Set<ResumePhase>([
  'pending',
  'grace',
  'reviewing',
  'applying',
  'waiting-active',
  'retry',
  'paused',
]);

/**
 * Пауза, при которой проход ждёт: остановка сервера, применение
 * конфигурации, отказ рантайма и пауза человека — пока оператор остановил
 * очередь, проход моделей не вызывает. Пауза ведущего (`queue_set`) держит
 * только выдачу; исходная пауза «очередь ещё не запускали» прохода не держит.
 */
export const resumeHeld = (h: DevContour) => {
  const s = h.store.read();
  if (!s.paused) return undefined;
  if (['shutdown', 'reconfigure', 'runtime'].includes(s.pauseReason ?? '')) return s.pauseReason;
  return s.pauseReason === 'operator' && !pausedByLead(s) ? 'operator' : undefined;
};

/** Сервер ведёт проход: его отметка свежая. */
export function resumeDriverAlive(h: DevContour, now = Date.now()) {
  const beat = h.store.localRecord<{ leaseUntil: number }>(RESUME, undefined, RESUME_DRIVER);
  return !!beat && beat.leaseUntil > now;
}

/**
 * Рантайм автора для ревью ответа — рантайм ведущего: задание доски
 * (новейшее, живое — первым), иначе автор утверждения задачи (ревью плана),
 * иначе новейшее задание workspace. В учебном режиме ревьюер учебный, и
 * автор его не выбирает. Ревьюера выбирает политика `review.plan` для автора.
 */
export function resumeAuthor(
  h: DevContour,
  task: Task,
  boardId: string | undefined,
): 'codex' | 'claude' | undefined {
  const workflow = new LeadWorkflow(h);
  const jobs = [undefined, ...repositories(h.config).map((r) => r.id)].flatMap((owner) => {
    try {
      return workflow.list(owner);
    } catch {
      return [];
    }
  });
  const newest = (list: typeof jobs) => {
    const live = list.filter((j) => ['queued', 'running'].includes(j.status));
    return (live.length ? live : list).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  };
  const board = boardId
    ? newest(jobs.filter((j) => j.kind === 'board' && j.id === boardId))
    : undefined;
  return (
    board?.authorRuntime ??
    task.approval?.authorRuntime ??
    newest(jobs)?.authorRuntime ??
    (h.config.mode === 'demo' ? 'codex' : undefined)
  );
}

export function resumeRecord(h: DevContour, requestId: string) {
  return h.store.localRecord<ResumeRecord>(RESUME, undefined, requestId);
}

/**
 * Фаза прохода по запросу или `undefined`, если сервер его не ведёт: режим
 * `operator`, вопрос не ждёт продолжения, сервера нет (тогда цепочку ведёт
 * ведущий агент, как прежде).
 */
export function resumeOf(
  h: DevContour,
  request: InputRequest,
  state: string,
  task: Task | undefined,
  boardId: string | undefined,
  now = Date.now(),
): ResumeView | undefined {
  if (h.config.approvalMode !== 'agent') return undefined;
  if (request.kind !== 'question' || !request.blocking || request.lifecycle !== 'answered')
    return undefined;
  if (!resumable.has(state) || !task || !boardId) return undefined;
  if (task.status === 'done' || task.status === 'cancelled') return undefined;
  const answer = latestAnswer(request);
  if (!answer || !resumeDriverAlive(h, now)) return undefined;
  const trigger = answer.actor.kind;
  const view = (phase: ResumePhase, extra: Partial<ResumeView> = {}): ResumeView => ({
    phase,
    auto: AUTO.has(phase),
    trigger,
    ...extra,
  });
  if (answer.kind === 'requirement-change')
    return view('needs-lead', { detail: 'requirement-change' });
  // Пауза держит любой шаг прохода — и ревью, и применение (моделей нет).
  const held = resumeHeld(h);
  if (held) return view('paused', { detail: held });
  const saved = resumeRecord(h, request.id);
  const record = saved?.answerDigest === answer.digest ? saved : undefined;
  const reviewing = state === 'answer-saved' || state === 'stale';
  if (record?.phase === 'failed' && reviewing)
    return record.reviews >= RESUME_REVIEWS
      ? view('failed', { ...(record.error ? { detail: record.error } : {}) })
      : view('retry', {
          ...(record.error ? { detail: record.error } : {}),
          ...(record.notBefore ? { until: new Date(record.notBefore).toISOString() } : {}),
        });
  if (record?.phase === 'reviewing' && reviewing) return view('reviewing');
  if (!reviewing && record?.phase === 'blocked')
    return view('blocked', { detail: (record.problems ?? []).join('; ') });
  if (!reviewing && record?.phase === 'waiting-active') return view('waiting-active');
  if (reviewing && !resumeAuthor(h, task, boardId))
    return view('needs-lead', { detail: 'author-runtime' });
  if (reviewing && trigger !== 'operator') {
    const until = Date.parse(answer.at) + RESUME_LEAD_GRACE_MS;
    if (until > now) return view('grace', { until: new Date(until).toISOString() });
  }
  return view(reviewing ? 'pending' : 'applying');
}
