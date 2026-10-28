import { join } from 'node:path';
import { carriedTaskIds } from '../core/work-status.ts';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import type { DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import { Workspace, changeSnapshot, currentJoint } from '../core/workspace.ts';
import { reviewPlan, acceptBoard } from './agent-control.ts';
import { WorkspaceRunner } from './workspace.ts';
import { adapters } from './adapters.ts';
import { assertRequirements } from './requirements.ts';
import { IntentService } from './intent.ts';
import { repairDecision } from '../core/repair.ts';
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
    /** Рантаймы ведущего для разбора повторяющегося свойства. */
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
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
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
          this.workflow.fail(
            job,
            e instanceof Error ? e.message : String(e),
            controller.signal.aborted,
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
      const state = this.h.store.read();
      const tasks = state.tasks.filter((t) => taskIds.includes(t.id));
      const decided = repairDecision(this.h, tasks, {
        budgetLeft: this.h.config.repairBudget - (job.repairs ?? 0),
        maxAttempts: this.h.config.maxAttempts,
      });
      if (!decided || decided.action === 'stop') return decided;
      this.workflow.repair(job, `repair:${decided.kind}`, () => {
        this.h.retry(decided.taskId);
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
    const s = this.h.store.read();
    const tasks = s.tasks.filter((t) => taskIds.includes(t.id) && t.recovery);
    for (const task of tasks) {
      const r = task.recovery!;
      if (task.status === 'cancelled') continue;
      switch (r.status) {
        case 'awaiting-lead': {
          // Пауза человека, наступившая после старта работы, — его решение:
          // разбор её не обходит.
          if (
            s.paused &&
            s.pauseReason === 'operator' &&
            (!s.pausedAt || s.pausedAt >= job.startedAt)
          )
            throw new Error(
              `${task.id}: разбор свойства ${r.property} ждёт снятия паузы человеком`,
            );
          if ((job.repairs ?? 0) >= this.h.config.repairBudget)
            throw new Error(
              `${task.id}: исчерпан бюджет восстановлений доски; разбор свойства ${r.property} — решение человека`,
            );
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
        case 'analyzing':
          // Разбор оборвался без решения (рестарт): вызов уже учтён.
          this.h.recoveryInterrupted(
            task.id,
            r.id,
            'Разбор ведущего прерван до решения; повторный автоматический вызов не выполняется.',
          );
          throw new Error(`${task.id}: разбор прерван до решения; нужен ведущий или пользователь`);
        case 'applying':
          // Добавление случаев идемпотентно по ключам эпизода.
          await this.applyRecovery(task.id);
          return this.afterDecision(task.id);
        case 'retry':
        case 'retrying':
          return this.afterDecision(task.id);
        default:
          throw new Error(
            `${task.id}: ${r.reason ?? 'разбор свойства ' + r.property + ' ждёт решения'}`,
          );
      }
    }
    return false;
  }
  private async applyRecovery(taskId: string) {
    const task = this.h.store.read().tasks.find((t) => t.id === taskId)!;
    const outcomes = await applyCases(this.h, this.root, task);
    this.h.recoveryApplied(taskId, task.recovery!.id, outcomes);
  }
  private afterDecision(taskId: string) {
    const task = this.h.store.read().tasks.find((t) => t.id === taskId)!;
    const r = task.recovery;
    if (!r) return false;
    if (r.status === 'retry' && ['failed', 'cancelled'].includes(task.status)) {
      if (task.status === 'cancelled') throw new Error(`${taskId}: задача отменена человеком`);
      this.h.retry(taskId);
      return true;
    }
    if (r.status === 'retry' || r.status === 'retrying') return true;
    throw new Error(`${taskId}: ${r.reason ?? r.status}`);
  }
  private boardRoot(job: WorkflowJob) {
    return job.owner
      ? join(repository(this.h.config, job.owner).path, '.devcontour-local')
      : this.root;
  }
  async execute(job: WorkflowJob, signal: AbortSignal): Promise<boolean> {
    const guard = () => {
      signal.throwIfAborted();
      this.workflow.guard(job);
    };
    const s = this.h.store.read();
    guard();
    if (job.kind === 'board') {
      const b = s.boards.find((b) => b.id === job.id)!,
        revision = b.revisions.at(-1)!;
      // Работа ревизии — без задач, перенесённых из принятой предыдущей: их
      // результат и отмены уже учтены приёмкой (см. carriedTaskIds).
      const carried = carriedTaskIds(b, s.tasks);
      const tasks = s.tasks.filter((t) => revision.taskIds.includes(t.id) && !carried.has(t.id));
      if (job.stage === 0) {
        // Согласование нужно черновикам и задачам, утверждённым при другой
        // политике исполнения: их движок не выдаёт до повторного утверждения.
        if (
          revision.status === 'accepted' ||
          tasks.every((t) => t.status !== 'draft' && !this.h.approvalStale(t))
        )
          return false;
        for (const task of tasks) assertRequirements(this.h, task);
        if (this.h.config.mode === 'demo')
          this.h.store.atomic(() => {
            guard();
            this.h.approve(b.id);
          });
        else {
          const runtimes = Object.fromEntries(
            ['codex', 'claude'].map((name) => {
              const adapter = adapters[name as 'codex' | 'claude'];
              return [
                name,
                {
                  ...adapter,
                  execute: (request: Parameters<typeof adapter.execute>[0]) =>
                    adapter.execute({
                      ...request,
                      signal: AbortSignal.any([signal, request.signal]),
                    }),
                },
              ];
            }),
          ) as Pick<typeof adapters, 'codex' | 'claude'>;
          const root = job.owner
            ? join(repository(this.h.config, job.owner).path, '.devcontour-local')
            : this.root;
          await reviewPlan(this.h, root, b.id, job.authorRuntime, runtimes, guard);
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
        // человека («operator») и блокировка по отказу рантайма («runtime»)
        // сохраняются: разрешение начать работу однажды не означает права
        // снимать любые будущие паузы, а критерий восстановления прямо
        // требует, чтобы пауза останавливала новые выдачи. Снимаются только
        // штатная остановка сервера и исходное «очередь ещё не запускали», у
        // которого причины нет: это не решение о работе.
        //
        // Пауза человека без времени записана прежней версией. Когда она
        // поставлена, неизвестно, а отсутствие сведений — не разрешение:
        // такая пауза стоит до явного продолжения.
        // В режиме агента перенесённую базу проверяет сам цикл: её gates
        // прошли — ожидание снято (base-check.ts); в режиме оператора это
        // по-прежнему решение человека.
        if (s.paused && s.pauseReason === 'base-check' && !tasks.every((t) => t.status === 'done'))
          await checkBase(this.h, { data: this.root, state: this.boardRoot(job) }, guard, signal);
        const decided =
          s.paused &&
          (s.pauseReason === 'runtime' ||
            // Перенесённую базу проверяет ведущий или человек: цикл не снимает
            // это ожидание сам.
            s.pauseReason === 'base-check' ||
            (s.pauseReason === 'operator' &&
              (s.pausedAt === undefined || s.pausedAt >= job.startedAt)));
        if (!tasks.every((t) => t.status === 'done') && !decided)
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
          if (s.paused && s.pauseReason === 'base-check')
            await checkBase(this.h, { data: this.root, state: this.boardRoot(job) }, guard, signal);
          if (s.paused && s.pauseReason === 'shutdown')
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
