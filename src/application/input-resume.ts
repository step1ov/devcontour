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
import { executionOf } from '../harness/execution.ts';
import { inputReviewDigest, inputReviewRounds } from '../harness/input-host.ts';

/** Локальные записи прохода (`local_workflow`): ключ — ID запроса; `@driver` — признак живого сервера. */
export const RESUME = 'input-resume';
export const RESUME_DRIVER = '@driver';

/** Сколько ревью одного ответа (по digest) сервер проводит сам: считаются записанные раунды. */
export const RESUME_REVIEWS = 3;
/** Пауза перед повтором после сбоя ревью: 30 с, удваивается. */
export const RESUME_BACKOFF_MS = 30_000;

/** Состояния вопроса, которые проход доводит сам. */
export const resumable = new Set(['answer-saved', 'stale', 'context-review', 'ready-to-apply']);

/**
 * Запись прохода по запросу. Относится к ответу `answerDigest`: новый ответ
 * начинает проход заново. `trigger` — кто дал ответ (проход ведёт только
 * ответы оператора); `author` — рантайм автора для ревью, закреплённый при
 * первом шаге прохода по этому ответу, и его источник.
 */
export interface ResumeRecord {
  requestId: string;
  taskId: string;
  answerDigest: string;
  revision: number;
  trigger: 'operator' | 'lead' | 'host';
  author?: { runtime: 'codex' | 'claude'; source: ResumeAuthorSource };
  /** `reviewed` — раунд одобрен, применение отложено паузой или сменой режима. */
  phase:
    'reviewing' | 'reviewed' | 'waiting-active' | 'failed' | 'blocked' | 'applied' | 'rejected';
  /**
   * Ревью прохода по этому ответу: учтено до вызова модели (перезапуск
   * лишнего вызова не получает) и возвращено, если раунд не записан
   * (повтор одобренного раунда, отмена остановкой сервера).
   */
  reviews: number;
  at: string;
  /** Срок идущего ревью (`reviewing`): после него запись — прерванный проход. */
  leaseUntil?: number;
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
  /** Причина остановки прохода или ожидания (текст ошибки, причины цели, вид паузы). */
  detail?: string;
  /** Когда проход продолжит (повтор после сбоя). */
  until?: string;
}

const AUTO = new Set<ResumePhase>([
  'pending',
  'reviewing',
  'applying',
  'waiting-active',
  'retry',
  'paused',
]);

/**
 * Пауза, при которой проход ждёт: остановка сервера, применение
 * конфигурации, отказ рантайма, проверка базы и пауза человека — пока оператор остановил
 * очередь, проход моделей не вызывает. Пауза ведущего (`queue_set`) держит
 * только выдачу; исходная пауза «очередь ещё не запускали» прохода не держит.
 */
export const resumeHeld = (h: DevContour) => {
  // Общий замороженный снимок: такт простаивающего controller на паузе
  // документ состояния заново не разбирает.
  const s = h.store.view();
  if (!s.paused) return undefined;
  // Проверка базы тоже держит проход: пока база не подтверждена, ревью ответа
  // по ней — лишний платный вызов, а выдачи всё равно нет.
  if (['shutdown', 'reconfigure', 'runtime', 'base-check'].includes(s.pauseReason ?? ''))
    return s.pauseReason;
  return s.pauseReason === 'operator' && !pausedByLead(s) ? 'operator' : undefined;
};

/** Сервер ведёт проход: его отметка свежая. */
export function resumeDriverAlive(h: DevContour, now = Date.now()) {
  const beat = h.store.localRecord<{ leaseUntil: number }>(RESUME, undefined, RESUME_DRIVER);
  return !!beat && beat.leaseUntil > now;
}

export type ResumeAuthorSource = 'task-approval' | 'board-job' | 'demo';

/**
 * Рантайм автора для ревью ответа оператора — рантайм ведущего, который
 * отвечает за эту задачу: автор утверждения задачи (ревью плана), иначе
 * задание этой же доски (новейшее). Чужие доски его не решают. В учебном
 * режиме ревьюер учебный, и автор его не выбирает. Неизвестен — проход
 * ждёт ведущего (`needs-lead`), а не угадывает.
 */
export function resumeAuthor(
  h: DevContour,
  task: Task,
  boardId: string | undefined,
): { runtime: 'codex' | 'claude'; source: ResumeAuthorSource } | undefined {
  if (task.approval?.authorRuntime)
    return { runtime: task.approval.authorRuntime, source: 'task-approval' };
  if (boardId) {
    const workflow = new LeadWorkflow(h);
    const jobs = [undefined, ...repositories(h.config).map((r) => r.id)].flatMap((owner) => {
      try {
        return workflow.list(owner).filter((j) => j.kind === 'board' && j.id === boardId);
      } catch {
        return [];
      }
    });
    const newest = jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (newest) return { runtime: newest.authorRuntime, source: 'board-job' };
  }
  return h.config.mode === 'demo' ? { runtime: 'codex', source: 'demo' } : undefined;
}

export function resumeRecord(h: DevContour, requestId: string) {
  return h.store.localRecord<ResumeRecord>(RESUME, undefined, requestId);
}

/**
 * Одобренный раунд ревью, который уже покрывает текущий ответ и
 * утверждение задачи: устаревшее применение (`stale` не по контексту) не
 * требует нового ревью — тот же снимок, новая цель. `undefined` — нужно ревью.
 */
export function coveringRound(
  h: DevContour,
  request: InputRequest,
  task: Task,
): string | undefined {
  const answer = latestAnswer(request);
  if (!answer) return undefined;
  if (request.stale?.reason === 'context') return undefined;
  const last = executionOf(h).engine.read((v) => inputReviewRounds(v, request.id).at(-1));
  return last?.approved &&
    last.contextDigest &&
    last.digest === inputReviewDigest(h, task, request.id, answer.digest)
    ? last.contextDigest
    : undefined;
}

/** Нужно ли ответу новое ревью: сохранён без раунда или устарел по контексту. */
export function needsReview(h: DevContour, request: InputRequest, state: string, task: Task) {
  if (state === 'answer-saved') return true;
  return state === 'stale' && !coveringRound(h, request, task);
}

/**
 * Фаза прохода по запросу или `undefined`, если сервер его не ведёт: режим
 * `operator`, вопрос не ждёт продолжения, ответ дал не оператор (ведущий
 * доводит свою цепочку сам), сервера нет (тогда цепочку ведёт ведущий
 * агент, как прежде).
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
  if (!answer || answer.actor.kind !== 'operator' || !resumeDriverAlive(h, now)) return undefined;
  const trigger = answer.actor.kind;
  const view = (phase: ResumePhase, extra: Partial<ResumeView> = {}): ResumeView => ({
    phase,
    auto: AUTO.has(phase),
    trigger,
    ...extra,
  });
  if (answer.kind === 'requirement-change')
    return view('needs-lead', { detail: 'requirement-change' });
  // Пауза держит любой шаг прохода — и ревью, и применение — раньше записей.
  const held = resumeHeld(h);
  if (held) return view('paused', { detail: held });
  const saved = resumeRecord(h, request.id);
  const record = saved?.answerDigest === answer.digest ? saved : undefined;
  const review = needsReview(h, request, state, task);
  if (review) {
    // Идущее ревью — пока не истёк его срок; запись прерванного процесса —
    // уже не ревью: проход начнёт его снова или остановится на пределе.
    const live = record?.phase === 'reviewing' && (record.leaseUntil ?? 0) > now;
    if (live) return view('reviewing');
    if (record && record.reviews >= RESUME_REVIEWS)
      return view('failed', { detail: record.error ?? 'достигнут предел ревью ответа' });
    if (record?.phase === 'failed')
      return view('retry', {
        ...(record.error ? { detail: record.error } : {}),
        ...(record.notBefore ? { until: new Date(record.notBefore).toISOString() } : {}),
      });
    if (!record?.author && !resumeAuthor(h, task, boardId))
      return view('needs-lead', { detail: 'author-runtime' });
    return view('pending');
  }
  if (record?.phase === 'blocked')
    return view('blocked', { detail: (record.problems ?? []).join('; ') });
  if (record?.phase === 'waiting-active') return view('waiting-active');
  return view('applying');
}
