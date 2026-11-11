import { join } from 'node:path';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import { SERVER_STOPPING, type DevContour } from '../core/service.ts';
import { DomainError, type ChangeSet, type DevContourState } from '../core/model.ts';
import { repositories, repository } from '../core/repositories.ts';
import { Workspace, changeSnapshot, currentJoint } from '../core/workspace.ts';
import { reviewPlan, acceptBoard } from './agent-control.ts';
import { WorkspaceRunner } from './workspace.ts';
import { adapters } from './adapters.ts';
import { assertTasksRequirements } from './requirements.ts';
import { IntentService } from './intent.ts';
import {
  afterStep,
  boardTasks,
  leadScope,
  loopOutlook,
  pauseStep,
  recoveryStep,
  repairStep,
} from './lead-outlook.ts';
import { executionOf } from '../harness/execution.ts';
import type { AgentAdapter } from './adapters.ts';
import { analyzeRecovery, applyCases } from './recovery.ts';
import { checkBase } from './base-check.ts';

/** Код отказа, у которого есть `code` (ошибки движка, переведённые в доменные). */
const codeOf = (e: unknown) => (e as { code?: unknown } | undefined)?.code;

export class LeadRunner {
  readonly workflow: LeadWorkflow;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private controller?: AbortController;
  /**
   * Совместные проверки ChangeSet, начатые стадией 1. Проверка идёт минуты
   * (установка и полные тесты workspace) и живёт дольше такта и владения
   * заданием: у неё свой lease и heartbeat в движке. Стадия её начинает и
   * отвечает «жду», следующие такты ждут итога. Раньше стадия ждала
   * проверку под своим сигналом, и потеря владения заданием (процесс стоял
   * дольше срока, продление не успело) обрывала проверку до первого gate.
   * Останавливает её только остановка цикла (`halt`, остановка сервера).
   */
  private joints = new Map<string, JointFlight>();
  /**
   * Отказ начала проверки по ожиданию (`NOT_READY`) — повторяемое ожидание,
   * но ограниченное: `limit` отказов подряд с паузой перед новым началом
   * (`delayMs`, удваивается). Иначе постоянная причина (например,
   * расхождение состояния задач продукта и движка) держала бы задание в
   * ожидании навсегда, повторяя синхронный снимок релиза каждые секунды, и
   * не давала бы ни провала, ни карточки.
   */
  startRetry = { limit: 4, delayMs: 15_000 };
  private startWaits = new Map<string, { count: number; notBefore: number }>();
  constructor(
    readonly h: DevContour,
    readonly root: string,
    /** Рантаймы ведущего: ревью плана доски и разбор повторяющегося свойства. */
    readonly runtimes: Record<'codex' | 'claude', AgentAdapter> = adapters,
  ) {
    this.workflow = new LeadWorkflow(h);
  }
  start() {
    this.stopping = false;
    this.timer ??= setInterval(() => {
      void this.tick().catch(() => {
        /* Job status carries errors; later ticks remain available. */
      });
    }, 1000);
    this.timer.unref();
  }
  /**
   * Остановить без ожидания: новых стадий нет, идущая прерывается. Сервер
   * вызывает это в начале остановки, до отметки остановки в базе; `stop`
   * затем дожидается идущей стадии.
   */
  halt() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    for (const flight of this.joints.values()) void flight.runner.stop();
  }
  async stop() {
    this.halt();
    await this.pending;
    await Promise.allSettled([...this.joints.values()].map((f) => f.promise));
  }
  /** Дождаться начатых стадиями совместных проверок (их итог читает следующий такт). */
  async settled() {
    await Promise.allSettled([...this.joints.values()].map((f) => f.promise));
  }
  /**
   * Начать совместную проверку вне такта: стадия уже ответила «жду», и
   * начало (продуктовый снимок релиза, синхронный Git) не идёт под сроком
   * владения заданием. Отказ начала и итог проверки читает следующий такт.
   */
  private launch(changeSetId: string) {
    const runner = new WorkspaceRunner(this.h, this.root);
    const flight: JointFlight = { runner, done: false, promise: Promise.resolve() };
    flight.promise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        if (this.stopping) throw new Error(SERVER_STOPPING);
        await runner.verify(changeSetId);
      })
      .catch((error: unknown) => {
        flight.failed = true;
        flight.error = error;
      })
      .finally(() => {
        flight.done = true;
      });
    this.joints.set(changeSetId, flight);
  }
  /**
   * Сбросить счётчик ожиданий начала ChangeSet, когда у него не осталось
   * идущего задания (провал, устаревший вход, завершение).
   */
  private forgetStartWaits(changeSetId: string, owner?: string) {
    if (!this.startWaits.has(changeSetId)) return;
    const live = this.workflow
      .list(owner)
      .some(
        (j) =>
          j.kind === 'changeset' &&
          j.id === changeSetId &&
          ['queued', 'running'].includes(j.status),
      );
    if (!live) this.startWaits.delete(changeSetId);
  }
  tick() {
    if (this.pending) return this.pending;
    this.pending = this.advance().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async advance() {
    const owners = [undefined, ...repositories(this.h.config).map((r) => r.id)];
    for (const owner of owners)
      for (const saved of this.workflow.list(owner)) {
        if (this.stopping) return;
        if (!['queued', 'running'].includes(saved.status)) {
          // Закончившееся задание: паузы начала его ChangeSet не нужны.
          if (saved.kind === 'changeset') this.forgetStartWaits(saved.id, owner);
          continue;
        }
        // An operator-controlled workspace never spends model calls automatically.
        if (this.h.config.approvalMode === 'operator') continue;
        const job = this.workflow.claim(saved.key, owner);
        if (!job) {
          // Попытки исчерпаны прерываниями: причина последнего — в ошибке.
          // Запись причины — пояснение: её сбой не останавливает такт.
          try {
            this.workflow.noteExhausted(saved, owner);
          } catch {
            /* причина останется общей */
          }
          // Задание закончилось (провал, устаревший вход): паузы начала
          // проверки его ChangeSet больше не нужны.
          if (saved.kind === 'changeset') this.forgetStartWaits(saved.id, owner);
          continue;
        }
        const controller = (this.controller = new AbortController());
        const timer = setInterval(
          () => {
            try {
              this.workflow.heartbeat(job);
            } catch {
              controller.abort();
            }
          },
          Math.max(1000, this.h.config.leaseMs / 3),
        );
        try {
          const waiting = await this.execute(job, controller.signal);
          this.workflow.finish(job, waiting);
        } catch (e) {
          // Отказ снять паузу, пока сервер останавливается, — не провал
          // стадии: она ждёт доменного состояния (пауза остановки), и задание
          // возвращается в очередь без расхода попытки, как стадия «жду».
          // Если и это не записалось — прерывание (тоже снова в очередь).
          const stopping = e instanceof DomainError && e.message === SERVER_STOPPING;
          if (stopping)
            try {
              this.workflow.finish(job, true);
              continue;
            } catch {
              /* ниже — прерывание */
            }
          // Утраченное владение (срок истёк раньше продления) — тоже
          // прерывание, а не итог стадии: задание снова в очереди, как при
          // отмене сигналом по сбою продления.
          // По коду, а не по тексту: текст отказа — дело движка. Итог
          // совместной проверки стадия передаёт без кода (см. `execute`),
          // поэтому истёкший срок самой проверки сюда не попадает.
          const lost = e instanceof DomainError && codeOf(e) === 'LEASE_STALE';
          this.workflow.fail(
            job,
            e instanceof Error ? e.message : String(e),
            controller.signal.aborted || stopping || lost,
          );
        } finally {
          clearInterval(timer);
          this.controller = undefined;
        }
      }
  }
  /**
   * Упала задача доски. Раньше здесь цикл останавливался словами «Task failure
   * requires diagnosis», и дальше требовался человек — даже когда причина была
   * технической и известной. Теперь решение принимает домен по записанному
   * классу отказа, а исполняется оно ровно одним разрешённым действием.
   *
   * Возвращает true, когда повтор назначен и результата нужно дождаться.
   */
  private repair(job: WorkflowJob, taskIds: string[]) {
    // Решение и его исполнение — одна транзакция.
    //
    // Раньше состояние читалось до неё, и между чтением и записью другой
    // клиент успевал отменить задачу: проверка отмены защищала прочитанный
    // снимок, а повтор назначался уже отменённой работе. Внутри транзакции
    // такого промежутка нет, а остановка ничего не пишет и откатывается.
    const decision = this.h.store.atomic(() => {
      // Решение — общее правило цикла (`repairStep`): по нему же пакет
      // передачи называет следующий шаг.
      const decided = repairStep(this.h, job, taskIds);
      if (!decided || decided.action === 'stop') return decided;
      this.workflow.repair(job, `repair:${decided.kind}`, () => {
        this.h.retry(decided.taskId, undefined, 'recovery');
        // Отказ окружения останавливает выдачу — иначе очередь сожгла бы
        // бюджет каждой задачи на одной и той же внешней причине. Раз причина
        // признана разовой и повтор назначен, выдачу нужно вернуть.
        //
        // Снимается при этом только своя причина. Очередь общая на весь
        // workspace: блокировок может быть несколько — обрыв связи по одной
        // доске и отказ провайдера по другой, — и выдача возвращается, только
        // когда не осталось ни одной. Пауза человека не снимается вовсе.
        // Причина, которой нет в списке, ничего не снимает: пустой или чужой
        // список — не разрешение продолжать.
        // Правило движка (`clearFailure`): снимается только этот класс,
        // выдача возвращается, когда причин не осталось; пауза человека
        // не трогается.
        if (decided.blocksQueue) executionOf(this.h).engine.clearFailure([decided.kind]);
      });
      return decided;
    });
    if (!decision) return false;
    if (decision.action === 'stop') throw new Error(decision.reason);
    return true;
  }
  /**
   * Эпизоды повторяющихся отказов по свойству. Возвращает true, когда
   * разрешённое действие назначено и его результата нужно дождаться.
   * Останавливается с причиной там, где автоматического действия нет.
   *
   * Счётчики и вызов модели учитываются до внешнего действия: бюджет
   * восстановлений workflow и разбор эпизода записываются в той же
   * транзакции, что резерв вызова, — рестарт и повтор бесплатного вызова не
   * получают.
   */
  private async recoverProperties(job: WorkflowJob, taskIds: string[], signal: AbortSignal) {
    // Решение по эпизоду — общее правило цикла (`recoveryStep`); здесь
    // только его исполнение.
    const step = recoveryStep(this.h, this.h.store.read(), job, taskIds);
    if (!step) return false;
    const { task } = step;
    const r = task.recovery!;
    switch (step.kind) {
      case 'stop':
        throw new Error(step.reason);
      case 'analyze': {
        const reserved = this.h.store.atomic(() => {
          this.workflow.repair(job, `recovery:${r.property}`, () => undefined);
          return this.h.recoveryReserve(task.id, r.id);
        });
        if (reserved.status !== 'analyzing') throw new Error(`${task.id}: ${reserved.reason}`);
        let decision;
        try {
          decision = await analyzeRecovery(
            this.h,
            this.root,
            this.h.store.read().tasks.find((t) => t.id === task.id)!,
            job.authorRuntime,
            signal,
            this.runtimes,
          );
        } catch (error) {
          this.h.recoveryInterrupted(
            task.id,
            r.id,
            'Разбор ведущего не дал решения: ' +
              (error instanceof Error ? error.message : String(error)),
          );
          throw error;
        }
        this.workflow.guard(job);
        const decided = this.h.recoveryDecide(task.id, r.id, decision);
        if (decided.status === 'applying') await this.applyRecovery(task.id);
        return this.afterDecision(task.id);
      }
      case 'interrupted':
        // Разбор оборвался без решения (рестарт): вызов уже учтён.
        this.h.recoveryInterrupted(
          task.id,
          r.id,
          'Разбор ведущего прерван до решения; повторный автоматический вызов не выполняется.',
        );
        throw new Error(step.reason);
      case 'apply':
        // Добавление случаев идемпотентно по ключам эпизода.
        await this.applyRecovery(task.id);
        return this.afterDecision(task.id);
      case 'after':
        return this.afterDecision(task.id);
    }
  }
  private async applyRecovery(taskId: string) {
    const task = this.h.store.read().tasks.find((t) => t.id === taskId)!;
    const outcomes = await applyCases(this.h, this.root, task);
    this.h.recoveryApplied(taskId, task.recovery!.id, outcomes);
  }
  private afterDecision(taskId: string) {
    const task = this.h.store.read().tasks.find((t) => t.id === taskId)!;
    const after = afterStep(task);
    if (after.kind === 'none') return false;
    if (after.kind === 'stop') throw new Error(after.reason);
    if (after.kind === 'retry-task') this.h.retry(taskId, undefined, 'recovery');
    return true;
  }
  private boardRoot(job: WorkflowJob) {
    return job.owner
      ? join(repository(this.h.config, job.owner).path, '.devcontour-local')
      : this.root;
  }
  async execute(job: WorkflowJob, signal: AbortSignal): Promise<boolean> {
    // Закрывающее событие проверки (`closing`) пишется и после отмены:
    // иначе отменённая проверка оставалась бы в журнале без окончания.
    // Fencing задания соблюдается и для него.
    const guard = (options?: { closing?: boolean }) => {
      if (!options?.closing) signal.throwIfAborted();
      this.workflow.guard(job);
    };
    const s = this.h.store.read();
    guard();
    if (job.kind === 'board') {
      // Работа ревизии — без задач, перенесённых из принятой предыдущей: их
      // результат и отмены уже учтены приёмкой (см. carriedTaskIds).
      const { board: b, tasks: all } = boardTasks(s, job.id)!;
      // Исполнение и приёмка — без задач, отменённых ведущим (`leadScope`):
      // их, как и приёмка доски, работа не ждёт.
      const scope = leadScope(all, s.runs);
      const tasks = job.stage === 0 ? all : scope.tasks;
      if (job.stage > 0 && scope.stop) throw new Error(scope.stop.reason);
      if (job.stage === 0) {
        // Согласование нужно черновикам и задачам, утверждённым при другой
        // политике исполнения: их движок не выдаёт до повторного утверждения
        // (правило `loopOutlook`).
        if (loopOutlook(this.h, s, job).step !== 'review-plan') return false;
        await assertTasksRequirements(this.h, tasks);
        if (this.h.config.mode === 'demo')
          this.h.store.atomic(() => {
            guard();
            this.h.approve(b.id);
          });
        else {
          // Адаптеры — как есть, отмена задания — сигналом: живой адаптер
          // harness выбирается по тождеству (`runtimeAdapters`), и оболочка
          // отправила бы ревью запасным путём.
          const root = job.owner
            ? join(repository(this.h.config, job.owner).path, '.devcontour-local')
            : this.root;
          await reviewPlan(
            this.h,
            root,
            b.id,
            job.authorRuntime,
            this.runtimes,
            guard,
            undefined,
            false,
            signal,
          );
        }
      } else if (job.stage === 1) {
        if (
          await this.recoverProperties(
            job,
            tasks.map((t) => t.id),
            signal,
          )
        )
          return true;
        if (
          this.repair(
            job,
            tasks.map((t) => t.id),
          )
        )
          return true;
        // Стадия включает выдачу — но не отменяет чужих решений. Остановка
        // человека после старта задания и блокировка по отказу рантайма
        // сохраняются; снимаются исходное «очередь ещё не запускали», штатная
        // остановка сервера и пауза человека до старта задания. В режиме
        // агента перенесённую базу проверяет сам цикл (base-check.ts).
        // Правило — `pauseStep`, общее с пакетом передачи.
        const pause = pauseStep(s, job, tasks);
        if (pause.checkBase)
          await checkBase(this.h, { data: this.root, state: this.boardRoot(job) }, guard, signal);
        if (pause.lift)
          this.h.store.atomic(() => {
            guard();
            this.h.pause(false);
          });
      } else {
        if (
          await this.recoverProperties(
            job,
            tasks.map((t) => t.id),
            signal,
          )
        )
          return true;
        if (
          this.repair(
            job,
            tasks.map((t) => t.id),
          )
        )
          return true;
        if (!tasks.every((t) => t.status === 'done')) {
          // Задачи ждут только ответов на вопросы исполнителя: задание ждёт
          // (без повтора и без провала) и отмечает это в истории один раз.
          if (this.workflow.waitingOf(job, s)) this.workflow.noteWaiting(job);
          const pause = pauseStep(s, job, tasks);
          if (pause.checkBase)
            await checkBase(this.h, { data: this.root, state: this.boardRoot(job) }, guard, signal);
          if (pause.lift)
            this.h.store.atomic(() => {
              guard();
              this.h.pause(false);
            });
          return true;
        }
        await assertTasksRequirements(this.h, tasks);
        const root = job.owner
          ? join(repository(this.h.config, job.owner).path, '.devcontour-local')
          : this.root;
        await acceptBoard(this.h, b.id, job.authorRuntime, false, guard, { root, signal });
      }
      return false;
    }
    const c = s.changeSets.find((c) => c.id === job.id)!;
    // Начатая циклом проверка ещё идёт — ждать, ничего не перечитывая.
    // Закончившаяся забирается сразу, до всех проверок стадии: её итог
    // относится к этому такту и не достаётся следующей попытке, если стадия
    // упадёт по другой причине (например, изменились требования).
    let flight = this.joints.get(c.id);
    if (flight && !flight.done) {
      if (job.stage === 1) return true;
      flight = undefined;
    } else if (flight) this.joints.delete(c.id);
    if (c.acceptance) {
      this.startWaits.delete(c.id);
      return false;
    }
    if (job.stage === 0)
      return c.boardIds.some(
        (id) => s.boards.find((b) => b.id === id)?.revisions.at(-1)?.status !== 'accepted',
      );
    // Пауза после отказа начала: стадия только ждёт — без чтения
    // требований (Git), новой проверки и снимка релиза.
    if (job.stage === 1 && !flight && (this.startWaits.get(c.id)?.notBefore ?? 0) > Date.now())
      return true;
    if (job.stage === 1)
      try {
        return await this.jointStage(c, s, flight, guard);
      } catch (error) {
        // Стадия упала (любая причина): следующая попытка задания начинает
        // ожидания начала заново, с паузами.
        this.startWaits.delete(c.id);
        throw error;
      }
    await assertTasksRequirements(this.h, changeSnapshot(s, c).tasks);
    const workspace = new Workspace(this.h, new IntentService(this.h));
    if (
      this.h.config.completionMode === 'remote' &&
      !c.deliveries?.some((d) => d.status === 'delivered')
    )
      return true;
    this.h.store.atomic(() => {
      guard();
      // Результат приёмки, с отложенными решением пользователя сценариями
      // (`deferredScenarios`), пишется в журнал событием changeset.accepted;
      // ведущий читает их там и в product-view. Если сценарии прошлой
      // приёмки изменены или удалены, ответ — awaiting-operator: задание
      // заканчивается, приёмку решает пользователь карточкой «Примите …».
      workspace.accept(c.id, { actor: 'agent', authorRuntime: job.authorRuntime });
    });
    return false;
  }
  /**
   * Стадия 1 задания ChangeSet: свежесть требований, итог начатой циклом
   * проверки, ожидание после отказа начала и начало новой проверки.
   */
  private async jointStage(
    before: ChangeSet,
    read: DevContourState,
    flight: JointFlight | undefined,
    guard: () => void,
  ): Promise<boolean> {
    await assertTasksRequirements(this.h, changeSnapshot(read, before).tasks);
    // Чтение требований идёт секунды, и состояние за это время меняется:
    // оператор начинает проверку вручную, становится активной попытка.
    // Дальше стадия решает по свежему состоянию, иначе начала бы вторую
    // проверку поверх идущей.
    guard();
    const s = this.h.store.read();
    const c = s.changeSets.find((x) => x.id === before.id);
    if (!c) throw new DomainError('ChangeSet не найден: ' + before.id);
    if (c.acceptance) {
      this.startWaits.delete(c.id);
      return false;
    }
    // Закончившаяся проверка цикла — итог стадии: отказ — провал стадии,
    // как прежде; успех — дальше, к приёмке, которая сама проверит
    // актуальность.
    if (flight?.failed) {
      const error = flight.error;
      // Начало, отложенное за пределы такта, может встретить ожидание:
      // попытку, выданную в этом окне, или остановку цикла. Это не итог
      // проверки — стадия ждёт и начнёт проверку снова.
      const message = error instanceof Error ? error.message : String(error);
      if (message === SERVER_STOPPING) return true;
      if (codeOf(error) === 'NOT_READY') {
        const count = (this.startWaits.get(c.id)?.count ?? 0) + 1;
        if (count > this.startRetry.limit) {
          this.startWaits.delete(c.id);
          throw new Error(
            `Совместная проверка не начинается: ${message} (отказ начала ${count} раз подряд)`,
          );
        }
        this.startWaits.set(c.id, {
          count,
          notBefore: Date.now() + this.startRetry.delayMs * 2 ** (count - 1),
        });
        return true;
      }
      this.startWaits.delete(c.id);
      // Итог проверки — провал стадии, без кода отказа движка.
      throw new Error(message);
    }
    if (flight) {
      this.startWaits.delete(c.id);
      return false;
    }
    const last = c.verifications.at(-1);
    let productFresh = c.releaseId === last?.productRelease?.releaseId;
    if (c.releaseId && last?.productRelease) {
      try {
        new IntentService(this.h).validate(
          last.productRelease,
          changeSnapshot(s, c),
          last.manifest,
        );
      } catch {
        productFresh = false;
      }
    }
    // Актуальность проверки — правило движка; продуктовый релиз — выше.
    if (productFresh && currentJoint(this.h, c).current) {
      this.startWaits.delete(c.id);
      return false;
    }
    if (
      s.runs.some((r) => r.status === 'active') ||
      s.changeSets.some((c) =>
        c.verifications.some((v) => v.status === 'active' && v.leaseUntil > Date.now()),
      )
    )
      return true;
    this.launch(c.id);
    return true;
  }
}

type JointFlight = {
  runner: WorkspaceRunner;
  promise: Promise<void>;
  done: boolean;
  failed?: boolean;
  error?: unknown;
};
