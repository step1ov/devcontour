// Продолжение после ответа оператора без отдельной сессии ведущего (режим `agent`).
//
// Ответ на вопрос исполнителя сам задачу не продолжает: снимок с ответом
// (`input_context`) → независимое ревью ответа (`input_review`, вызов модели
// ревьюера по политике `review.plan`) → цель (`input_target`) → применение
// (`input_apply`). Раньше эту цепочку вёл только ведущий агент в своей
// сессии, и ответ оператора на критический вопрос без живой сессии лежал
// «сохранённым» бесконечно. Теперь её ведёт сервер — теми же операциями
// `InputService`, с теми же отказами, ревьюером, арендой ревью и бюджетами;
// меняется только то, кто их вызывает. Решения после отклонённого ревью,
// причины цели, изменение требований и ответы ведущего (он доводит их сам)
// остаются ведущему и оператору: проход их не обходит.
//
// Каждый запрос — свой полёт, как совместная проверка ChangeSet: такт цикла
// ведущего только начинает полёты и не ждёт ревью, задания досок идут дальше.
import { latestAnswer } from 'devcontour-harness';
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
  coveringRound,
  needsReview,
  resumeAuthor,
  resumeHeld,
  resumeRecord,
  type ResumeRecord,
} from '../application/input-resume.ts';
import { adapters, type AgentAdapter } from './adapters.ts';

/** Первая перепроверка ожидания идущих попыток доски; удваивается до предела. */
export const RESUME_ACTIVE_RECHECK_MS = 5_000;
export const RESUME_ACTIVE_RECHECK_MAX_MS = 60_000;
/** Как часто проход перепроверяет причины, по которым ответ нельзя применить. */
export const RESUME_BLOCKED_RECHECK_MS = 60_000;
/** Просмотр кандидатов без изменения данных — не чаще. */
export const RESUME_SCAN_MS = 30_000;
/** Сколько ревью ответов идёт одновременно. */
export const RESUME_PARALLEL = 2;

const codeOf = (e: unknown) => (e as { code?: unknown } | undefined)?.code;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000);

export class InputResumer {
  private flights = new Map<string, Promise<void>>();
  /**
   * Перепроверки без записи (ожидание попыток, чужая аренда ревью, причины
   * цели): `ID запроса:digest ответа` → срок и шаг. Новый ответ начинает
   * с нуля; записи запросов, которые проход больше не ведёт, удаляются.
   */
  private rechecks = new Map<string, { at: number; delay: number }>();
  private scanned?: { revision: number; at: number };
  private controller = new AbortController();
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

  /** Остановить: идущие ревью прерываются, отметка снимается — цепочку снова ведёт ведущий. */
  stop() {
    this.controller.abort();
    try {
      this.h.store.atomic(() => this.h.store.deleteLocal(RESUME, undefined, RESUME_DRIVER));
    } catch {
      /* Хранилище закрыто: отметка истечёт сама. */
    }
  }

  /** Дождаться начатых полётов (остановка сервера, тесты). */
  async settled() {
    while (this.flights.size) await Promise.allSettled([...this.flights.values()]);
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

  private recheck(key: string, base: number, max = base) {
    const prev = this.rechecks.get(key);
    const delay = prev ? Math.min(prev.delay * 2, max) : base;
    this.rechecks.set(key, { at: Date.now() + delay, delay });
  }

  /**
   * Один такт: начать полёты для запросов, которые сервер ведёт сейчас. Ни
   * ревью, ни применение такт не ждёт. На паузе — ничего (пауза человека,
   * остановка, применение конфигурации, отказ рантайма).
   */
  tick() {
    if (this.h.config.approvalMode !== 'agent' || this.controller.signal.aborted) return;
    this.beat();
    if (resumeHeld(this.h)) return;
    const now = Date.now();
    // Просмотр — только когда данные изменились или подошёл срок перепроверки.
    const revision = this.h.store.revision();
    const timed = [...this.rechecks.values()].some((r) => r.at <= now);
    if (
      this.scanned &&
      this.scanned.revision === revision &&
      now - this.scanned.at < RESUME_SCAN_MS &&
      !timed
    )
      return;
    const { engine } = executionOf(this.h);
    // Дешёвый отбор по запросам движка; сводка — только по кандидатам.
    const candidates = engine.inputRequests().flatMap((r) => {
      const answer = latestAnswer(r);
      return r.kind === 'question' &&
        r.blocking &&
        r.lifecycle === 'answered' &&
        answer?.actor.kind === 'operator'
        ? [{ request: r, key: `${r.id}:${answer.digest}` }]
        : [];
    });
    // Перепроверки запросов, которые проход больше не ведёт (применил ведущий,
    // задача закончилась, пришёл новый ответ), не держат просмотр каждый такт.
    const live = new Set(candidates.map((c) => c.key));
    for (const key of this.rechecks.keys()) if (!live.has(key)) this.rechecks.delete(key);
    for (const { request, key } of candidates) {
      // Остальные начнут следующие такты: окончание полёта меняет данные.
      if (this.flights.size >= RESUME_PARALLEL) break;
      if (this.flights.has(request.id)) continue;
      const recheck = this.rechecks.get(key);
      if (recheck && recheck.at > now) continue;
      let resume;
      try {
        resume = this.service
          .list({ taskId: request.workId })
          .requests.find((r) => r.requestId === request.id)?.resume;
      } catch {
        continue;
      }
      const due =
        resume?.phase === 'pending' ||
        resume?.phase === 'applying' ||
        resume?.phase === 'waiting-active' ||
        resume?.phase === 'blocked' ||
        (resume?.phase === 'retry' && (!resume.until || Date.parse(resume.until) <= now));
      if (!due) continue;
      const flight = this.drive(request.id, key)
        .catch(() => {
          /* Причина записана в проход; следующий такт прочитает свежее состояние. */
        })
        .finally(() => {
          this.flights.delete(request.id);
        });
      this.flights.set(request.id, flight);
    }
    // Отметка просмотра — после полного прохода: оборванный просмотр повторится.
    this.scanned = { revision, at: now };
  }

  private async drive(requestId: string, key: string) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const signal = this.controller.signal;
    if (signal.aborted || this.h.config.approvalMode !== 'agent' || resumeHeld(this.h)) return;
    const service = this.service;
    const { engine } = executionOf(this.h);
    const request = engine.inputRequest(requestId);
    const answer = latestAnswer(request);
    const task = this.h.store.read().tasks.find((t) => t.id === request.workId);
    if (!answer || !task) return;
    // Состояние — свежее, а не прочитанное при отборе.
    const summary = service
      .list({ taskId: task.id })
      .requests.find((r) => r.requestId === requestId);
    if (!summary?.resume || summary.resume.trigger !== 'operator') return;
    const state = summary.state;
    const saved = resumeRecord(this.h, requestId);
    const prior = saved?.answerDigest === answer.digest ? saved : undefined;
    const author = prior?.author ?? resumeAuthor(this.h, task, summary.boardId ?? undefined);
    if (!author) return;
    const base: Omit<ResumeRecord, 'phase' | 'at'> = {
      requestId,
      taskId: task.id,
      answerDigest: answer.digest,
      revision: answer.revision,
      trigger: answer.actor.kind,
      author,
      reviews: prior?.reviews ?? 0,
    };
    const record = (phase: ResumeRecord['phase'], extra: Partial<ResumeRecord> = {}) => ({
      ...base,
      phase,
      at: new Date().toISOString(),
      ...extra,
    });
    let contextDigest: string | undefined;
    if (needsReview(this.h, request, state, task)) {
      // Предел — явная остановка прохода: карточка ведущего и шаг передачи.
      if (base.reviews >= RESUME_REVIEWS) {
        if (prior?.phase !== 'failed')
          this.save(record('failed', { error: prior?.error ?? 'достигнут предел ревью ответа' }), {
            error: 'review limit reached',
          });
        return;
      }
      // Ревью уже ведёт другой (ведущий агент, другой процесс): ждать без
      // записей и журнала, проверка — только чтением.
      if (service.reviewLeaseHeld(requestId)) {
        this.recheck(key, RESUME_ACTIVE_RECHECK_MS, RESUME_ACTIVE_RECHECK_MAX_MS);
        return;
      }
      const rounds = () => engine.read((v) => inputReviewRounds(v, requestId).length);
      const before = rounds();
      // Ревью учитывается, когда аренда взята, до вызова модели: перезапуск
      // лишнего вызова не получает, а запись и журнал говорят о настоящем ревью.
      const reviewing = record('reviewing', {
        reviews: base.reviews + 1,
        leaseUntil: Date.now() + this.h.config.runTimeoutMs + this.h.config.leaseMs,
      });
      let leased = false;
      let review;
      try {
        const context = await service.context({ requestId });
        // Пауза или остановка за время снимка: модель не вызывается.
        if (signal.aborted || resumeHeld(this.h)) return;
        review = await service.review(
          { requestId, contextDigest: context.contextDigest, authorRuntime: author.runtime },
          signal,
          {
            leased: () => {
              leased = true;
              this.save(reviewing, {
                authorRuntime: author.runtime,
                authorSource: author.source,
              });
            },
          },
        );
        contextDigest = review.contextDigest ?? context.contextDigest;
      } catch (error) {
        // Аренду взял другой между проверкой и ревью: ждать, ничего не записывая.
        if (codeOf(error) === 'REVIEW_IN_PROGRESS') {
          this.recheck(key, RESUME_ACTIVE_RECHECK_MS, RESUME_ACTIVE_RECHECK_MAX_MS);
          return;
        }
        // Остановка сервера оборвала ревью без раунда: попытка возвращается.
        const stopping = signal.aborted || messageOf(error) === SERVER_STOPPING;
        const reviews = stopping && rounds() === before ? base.reviews : reviewing.reviews;
        this.save(
          record('failed', {
            reviews,
            error: messageOf(error),
            notBefore:
              Date.now() + (stopping ? 0 : RESUME_BACKOFF_MS * 2 ** Math.max(0, reviews - 1)),
          }),
          { error: messageOf(error), ...(leased ? {} : { stage: 'context' }) },
        );
        return;
      }
      // Считается только записанный раунд: повтор одобренного раунда — не ревью.
      base.reviews = rounds() > before ? reviewing.reviews : base.reviews;
      if (!review.approved) {
        // Отклонённое ревью — решение оператора (состояние `review-rejected`).
        this.save(record('rejected'), { round: review.round });
        return;
      }
      // Режим, пауза или остановка могли смениться за время ревью: раунд
      // записан, применение — после (идущее ревью пауза не обрывает).
      if (signal.aborted || this.h.config.approvalMode !== 'agent' || resumeHeld(this.h)) {
        this.save(record('reviewed'));
        return;
      }
    } else {
      contextDigest =
        state === 'stale'
          ? coveringRound(this.h, request, task)
          : (engine.read((v) => inputReviewRounds(v, requestId).at(-1))?.contextDigest ??
            undefined);
      if (!contextDigest) return;
    }
    const blocked = (problems: string[]) => {
      this.recheck(key, RESUME_BLOCKED_RECHECK_MS);
      if (prior?.phase === 'blocked' && prior.problems?.join() === problems.join()) return;
      this.save(record('blocked', { problems }), { problems });
    };
    const waiting = () => {
      this.recheck(key, RESUME_ACTIVE_RECHECK_MS, RESUME_ACTIVE_RECHECK_MAX_MS);
      // Запись и журнал — только при входе в ожидание.
      if (prior?.phase !== 'waiting-active') this.save(record('waiting-active'), {});
    };
    // Идущие попытки доски — проверка только чтением: применение без них.
    if (service.activeInGraph(task.id).length) {
      waiting();
      return;
    }
    try {
      const target = service.target({ requestId, contextDigest });
      if (target.problems.length || !target.targetDigest) {
        blocked(target.problems.length ? target.problems : ['нет основания продолжения']);
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
        { origin: 'server' },
      );
      if (applied.applied) {
        this.rechecks.delete(key);
        this.save(record('applied'), { applied: true });
        return;
      }
      if ('blocker' in applied && applied.blocker) {
        blocked([`${applied.blocker.code}: ${applied.blocker.message}`]);
        return;
      }
      waiting();
    } catch (error) {
      // Отказ цели или применения (версия, область, конфликт с ведущим):
      // без вызова модели, следующая перепроверка перечитает состояние.
      blocked([messageOf(error)]);
    }
  }
}
