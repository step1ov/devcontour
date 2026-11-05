import { join } from 'node:path';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import { SERVER_STOPPING, type DevContour } from '../core/service.ts';
import { DomainError } from '../core/model.ts';
import { repositories, repository } from '../core/repositories.ts';
import { Workspace, changeSnapshot, currentJoint } from '../core/workspace.ts';
import { reviewPlan, acceptBoard } from './agent-control.ts';
import { WorkspaceRunner } from './workspace.ts';
import { adapters } from './adapters.ts';
import { assertRequirements } from './requirements.ts';
import { IntentService } from './intent.ts';
import {
  afterStep,
  boardTasks,
  loopOutlook,
  pauseStep,
  recoveryStep,
  repairStep,
} from './lead-outlook.ts';
import { executionOf } from '../harness/execution.ts';
import type { AgentAdapter } from './adapters.ts';
import { analyzeRecovery, applyCases } from './recovery.ts';
import { checkBase } from './base-check.ts';

export class LeadRunner {
  readonly workflow: LeadWorkflow;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private controller?: AbortController;
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
  }
  async stop() {
    this.halt();
    await this.pending;
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
        if (!['queued', 'running'].includes(saved.status)) continue;
        // An operator-controlled workspace never spends model calls automatically.
        if (this.h.config.approvalMode === 'operator') continue;
        const job = this.workflow.claim(saved.key, owner);
        if (!job) continue;
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
          this.workflow.fail(
            job,
            e instanceof Error ? e.message : String(e),
            controller.signal.aborted || stopping,
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
      const { board: b, tasks } = boardTasks(s, job.id)!;
      if (job.stage === 0) {
        // Согласование нужно черновикам и задачам, утверждённым при другой
        // политике исполнения: их движок не выдаёт до повторного утверждения
        // (правило `loopOutlook`).
        if (loopOutlook(this.h, s, job).step !== 'review-plan') return false;
        for (const task of tasks) assertRequirements(this.h, task);
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
        for (const task of tasks) assertRequirements(this.h, task);
        const root = job.owner
          ? join(repository(this.h.config, job.owner).path, '.devcontour-local')
          : this.root;
        await acceptBoard(this.h, b.id, job.authorRuntime, false, guard, { root, signal });
      }
      return false;
    }
    const c = s.changeSets.find((c) => c.id === job.id)!;
    if (c.acceptance) return false;
    if (job.stage === 0)
      return c.boardIds.some(
        (id) => s.boards.find((b) => b.id === id)?.revisions.at(-1)?.status !== 'accepted',
      );
    for (const task of changeSnapshot(s, c).tasks) assertRequirements(this.h, task);
    const workspace = new Workspace(this.h, new IntentService(this.h));
    if (job.stage === 1) {
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
      if (productFresh && currentJoint(this.h, c).current) return false;
      if (
        s.runs.some((r) => r.status === 'active') ||
        s.changeSets.some((c) =>
          c.verifications.some((v) => v.status === 'active' && v.leaseUntil > Date.now()),
        )
      )
        return true;
      const runner = new WorkspaceRunner(this.h, this.root);
      const abort = () => {
        void runner.stop();
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await runner.verify(c.id);
      } finally {
        signal.removeEventListener('abort', abort);
        await runner.stop();
      }
    } else {
      if (
        this.h.config.completionMode === 'remote' &&
        !c.deliveries?.some((d) => d.status === 'delivered')
      )
        return true;
      this.h.store.atomic(() => {
        guard();
        workspace.accept(c.id, { actor: 'agent', authorRuntime: job.authorRuntime });
      });
    }
    return false;
  }
}
