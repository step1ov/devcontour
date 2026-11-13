// Продолжение после ответа без отдельной сессии ведущего (режим `agent`).
//
// Ответ на вопрос исполнителя сам задачу не продолжает: снимок с ответом
// (`input_context`) → независимое ревью ответа (`input_review`, вызов модели
// ревьюера по политике `review.plan`) → цель (`input_target`) → применение
// (`input_apply`). Раньше эту цепочку вёл только ведущий агент в своей
// сессии, и ответ оператора на критический вопрос без живой сессии лежал
// «сохранённым» бесконечно. Теперь её ведёт сервер в такте цикла ведущего —
// теми же операциями `InputService`, с теми же отказами, ревьюером, арендой
// ревью и бюджетами; меняется только то, кто их вызывает. Решения после
// отклонённого ревью, причины цели и изменение требований остаются ведущему
// и оператору: проход их не обходит.
import { latestAnswer, type InputRequest } from 'devcontour-harness';
import type { DevContour } from '../core/service.ts';
import { SERVER_STOPPING } from '../core/service.ts';
import { executionOf } from '../harness/execution.ts';
import { inputReviewRounds } from '../harness/input-host.ts';
import { InputService } from '../application/input.ts';
import {
  RESUME,
  RESUME_BACKOFF_MS,
  RESUME_DRIVER,
  RESUME_REVIEWS,
  resumeAuthor,
  resumeRecord,
  type ResumeRecord,
} from '../application/input-resume.ts';
import { adapters, type AgentAdapter } from './adapters.ts';

/** Как часто проход перепроверяет ожидание идущих попыток доски. */
export const RESUME_ACTIVE_RECHECK_MS = 5_000;
/** Как часто проход перепроверяет причины, по которым ответ нельзя применить. */
export const RESUME_BLOCKED_RECHECK_MS = 60_000;

const codeOf = (e: unknown) => (e as { code?: unknown } | undefined)?.code;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000);

export class InputResumer {
  constructor(
    readonly h: DevContour,
    readonly root: string,
    readonly runtimes: Record<string, AgentAdapter> = adapters,
  ) {}

  private get service() {
    return new InputService(this.h, this.root, { ...adapters, ...this.runtimes });
  }

  /** Отметка живого прохода: проекции называют фазы, только пока сервер его ведёт. */
  private beat(now = Date.now()) {
    const store = this.h.store;
    const lease = Math.max(this.h.config.leaseMs, 5000);
    const beat = store.localRecord<{ leaseUntil: number }>(RESUME, undefined, RESUME_DRIVER);
    if (beat && beat.leaseUntil - now > (lease * 2) / 3) return;
    store.atomic(() =>
      store.saveLocal(RESUME, undefined, RESUME_DRIVER, { leaseUntil: now + lease }, 'lease'),
    );
  }

  /** Снять отметку при остановке: без сервера цепочку снова ведёт ведущий агент. */
  stop() {
    try {
      this.h.store.atomic(() => this.h.store.deleteLocal(RESUME, undefined, RESUME_DRIVER));
    } catch {
      /* Хранилище закрыто: отметка истечёт сама. */
    }
  }

  private save(record: ResumeRecord, event?: Record<string, unknown>) {
    const store = this.h.store;
    store.atomic(() => {
      store.saveLocal(RESUME, undefined, record.requestId, record);
      // Журнал: что сделал проход и чей ответ его начал (текста ответа нет).
      if (event)
        store.appendEvent('input.resume', {
          requestId: record.requestId,
          taskId: record.taskId,
          answerRevision: record.revision,
          answerDigest: record.answerDigest,
          trigger: record.trigger,
          phase: record.phase,
          ...event,
        });
    });
  }

  /** Причина, по которой ответ нельзя применить: журнал — только новой причины. */
  private blocked(prior: ResumeRecord | undefined, record: ResumeRecord) {
    const same = prior?.phase === 'blocked' && prior.problems?.join() === record.problems?.join();
    this.save(record, same ? undefined : { problems: record.problems });
  }

  /**
   * Один такт: каждый вопрос, который сервер ведёт сейчас (`resume.auto` или
   * повтор цели после причины), — один шаг цепочки. Отказ одного запроса
   * записывается в его проход и не останавливает остальные.
   */
  async tick(signal?: AbortSignal) {
    if (this.h.config.approvalMode !== 'agent') return;
    this.beat();
    const now = Date.now();
    // Ожидание идущих попыток и причины цели перепроверяются реже такта:
    // каждая проверка применения пишет журнал.
    const since = (requestId: string, ms: number) => {
      const at = resumeRecord(this.h, requestId)?.at;
      return !at || now - Date.parse(at) >= ms;
    };
    const due = this.service.list().requests.filter((r) => {
      switch (r.resume?.phase) {
        case 'pending':
        case 'applying':
        case 'reviewing':
          return true;
        case 'waiting-active':
          return since(r.requestId, RESUME_ACTIVE_RECHECK_MS);
        case 'blocked':
          return since(r.requestId, RESUME_BLOCKED_RECHECK_MS);
        case 'retry':
          return !r.resume?.until || Date.parse(r.resume.until) <= now;
        default:
          return false;
      }
    });
    for (const summary of due) {
      if (signal?.aborted) return;
      try {
        await this.drive(summary.requestId, summary.state, summary.boardId ?? undefined, signal);
      } catch {
        /* Причина записана в проход; следующий такт прочитает свежее состояние. */
      }
    }
  }

  private async drive(
    requestId: string,
    state: string,
    boardId: string | undefined,
    signal?: AbortSignal,
  ) {
    const service = this.service;
    const { engine } = executionOf(this.h);
    const request: InputRequest = engine.inputRequest(requestId);
    const answer = latestAnswer(request);
    const task = this.h.store.read().tasks.find((t) => t.id === request.workId);
    if (!answer || !task) return;
    const saved = resumeRecord(this.h, requestId);
    const prior = saved?.answerDigest === answer.digest ? saved : undefined;
    const base: Omit<ResumeRecord, 'phase' | 'at'> = {
      requestId,
      taskId: task.id,
      answerDigest: answer.digest,
      revision: answer.revision,
      trigger: answer.actor.kind,
      reviews: prior?.reviews ?? 0,
    };
    let contextDigest: string | undefined;
    if (state === 'answer-saved' || state === 'stale') {
      const author = resumeAuthor(this.h, task, boardId);
      if (!author || base.reviews >= RESUME_REVIEWS) return;
      // Ревью учтено до вызова модели: перезапуск лишнего вызова не получает.
      const reviewing: ResumeRecord = {
        ...base,
        reviews: base.reviews + 1,
        phase: 'reviewing',
        at: new Date().toISOString(),
      };
      this.save(reviewing, { authorRuntime: author });
      let review;
      try {
        const context = await service.context({ requestId });
        review = await service.review(
          { requestId, contextDigest: context.contextDigest, authorRuntime: author },
          signal,
        );
        contextDigest = review.contextDigest ?? context.contextDigest;
      } catch (error) {
        // Ревью уже ведёт другой (ведущий агент): этот такт его не считает.
        if (codeOf(error) === 'REVIEW_IN_PROGRESS') {
          if (prior) this.save(prior);
          else this.h.store.atomic(() => this.h.store.deleteLocal(RESUME, undefined, requestId));
          return;
        }
        const stopping = signal?.aborted || messageOf(error) === SERVER_STOPPING;
        this.save(
          {
            ...reviewing,
            phase: 'failed',
            at: new Date().toISOString(),
            error: messageOf(error),
            notBefore:
              Date.now() + (stopping ? 0 : RESUME_BACKOFF_MS * 2 ** (reviewing.reviews - 1)),
          },
          { error: messageOf(error) },
        );
        return;
      }
      if (!review.approved) {
        // Отклонённое ревью — решение людей и ведущего (состояние
        // `review-rejected`): проход дальше не идёт.
        this.save(
          { ...reviewing, phase: 'rejected', at: new Date().toISOString() },
          { round: review.round },
        );
        return;
      }
    } else {
      contextDigest =
        engine.read((v) => inputReviewRounds(v, requestId).at(-1))?.contextDigest ?? undefined;
      if (!contextDigest) return;
    }
    const current = (phase: ResumeRecord['phase'], extra: Partial<ResumeRecord> = {}) => ({
      ...base,
      ...(state === 'answer-saved' || state === 'stale' ? { reviews: base.reviews + 1 } : {}),
      phase,
      at: new Date().toISOString(),
      ...extra,
    });
    try {
      const target = service.target({ requestId, contextDigest });
      if (target.problems.length || !target.targetDigest) {
        const problems = target.problems.length ? target.problems : ['нет основания продолжения'];
        this.blocked(prior, current('blocked', { problems }));
        return;
      }
      const applied = service.apply(
        {
          requestId,
          answerDigest: answer.digest,
          expectedVersion: target.version,
          contextDigest,
          targetDigest: target.targetDigest,
        },
        'lead',
      );
      if (applied.applied) {
        this.save(current('applied'), { applied: true });
        return;
      }
      if ('blocker' in applied && applied.blocker) {
        const problems = [applied.blocker.message];
        this.blocked(prior, current('blocked', { problems }));
        return;
      }
      // Идут попытки графа доски: применение подождёт их окончания.
      // Время записи — начало следующей перепроверки; журнал — только при входе.
      this.save(current('waiting-active'), prior?.phase === 'waiting-active' ? undefined : {});
    } catch (error) {
      // Отказ цели или применения (версия, область, конфликт с ведущим):
      // без вызова модели, следующий такт перечитает состояние.
      const problems = [messageOf(error)];
      this.blocked(prior, current('blocked', { problems }));
    }
  }
}
