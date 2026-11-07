import { developmentBinding, assertTaskPreparation } from './preparation.ts';
import { carriedTaskIds } from './work-status.ts';
import { z } from 'zod';
import {
  HarnessError,
  WORKSPACE_OWNER,
  WorkflowQueue,
  blocksWork,
  type WorkflowJob as HarnessJob,
} from 'devcontour-harness';
import { domain, executionOf } from '../harness/execution.ts';
import type { DevContourState } from './model.ts';
import { DevContour, digest, scopeGaps } from './service.ts';
import { taskInput, DomainError } from './model.ts';
import { boardOwner } from './sync-state.ts';
import { Workspace } from './workspace.ts';
import { repositories } from './repositories.ts';
import { technicalReviewer } from '../harness/policy.ts';

/** Событие истории задания: стадия ждёт ответов на вопросы исполнителя. */
export const WAITING_INPUT = 'waiting:input';

/**
 * Стадия доски ждёт только ответов: попыток задач нет, а каждая
 * незавершённая задача держится вопросом исполнителя или зависит (через
 * незавершённые) от такой. Тогда задание не падает и не чинит задачи — оно
 * ждёт `applyInput`, который вернёт задачу в очередь. Независимые задачи,
 * которые ещё можно выдать, ожиданием ответа не считаются.
 */
export function inputWaiting(
  h: DevContour,
  s: DevContourState,
  taskIds: readonly string[],
): { kind: 'input'; requestIds: string[] } | undefined {
  const ids = new Set(taskIds);
  if (s.runs.some((r) => r.status === 'active' && ids.has(r.taskId))) return undefined;
  const open = s.tasks.filter(
    (t) => ids.has(t.id) && t.status !== 'done' && t.status !== 'cancelled',
  );
  if (!open.length) return undefined;
  const held = new Map<string, string>();
  for (const r of executionOf(h).engine.inputRequests())
    if (ids.has(r.workId) && blocksWork(r)) held.set(r.workId, r.id);
  if (!held.size) return undefined;
  const byId = new Map(open.map((t) => [t.id, t]));
  const waits = (id: string, seen = new Set<string>()): boolean => {
    if (held.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const task = byId.get(id);
    return !!task && task.dependsOn.some((d) => byId.has(d) && waits(d, seen));
  };
  return open.every((t) => waits(t.id))
    ? { kind: 'input', requestIds: [...new Set(held.values())] }
    : undefined;
}

export const workflowInput = z.strictObject({
  kind: z.enum(['board', 'changeset']),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  authorRuntime: z.enum(['codex', 'claude']),
  maxAttempts: z.number().int().min(1).max(5).default(3),
});
export type WorkflowJob = z.infer<typeof workflowInput> & {
  key: string;
  owner?: string;
  inputDigest: string;
  stage: number;
  attempts: number;
  status: 'queued' | 'running' | 'failed' | 'stale' | 'completed';
  /** Сколько раз цикл уже чинил упавшие задачи этой работы. */
  repairs?: number;
  token?: string;
  leaseUntil?: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  history: { at: string; stage: number; event: string }[];
};
export class LeadWorkflow {
  constructor(readonly h: DevContour) {}
  input(kind: WorkflowJob['kind'], id: string, s: DevContourState = this.h.store.read()) {
    developmentBinding(s);
    const changeSet = kind === 'changeset' ? s.changeSets.find((c) => c.id === id) : undefined;
    if (kind === 'changeset' && !changeSet) throw new DomainError('ChangeSet не найден');
    const boardIds = changeSet?.boardIds ?? [id];
    const boards = boardIds.map((id) => {
      const b = s.boards.find((b) => b.id === id);
      if (!b) throw new DomainError('Доска не найдена');
      return b;
    });
    const taskIds = new Set(boards.flatMap((b) => b.revisions.at(-1)!.taskIds));
    const tasks = s.tasks.filter((t) => taskIds.has(t.id));
    if (!tasks.length) throw new DomainError('В workflow нет задач');
    // Перенесённые из принятой ревизии задачи — уже принятая работа: их
    // привязку к подготовке проверила та приёмка (см. carriedTaskIds).
    const carried = new Set(boards.flatMap((b) => [...carriedTaskIds(b, s.tasks)]));
    // Отменённая задача не входит ни в приёмку доски, ни в снимок ChangeSet:
    // проверять её привязку значило бы блокировать результат, где её нет.
    tasks
      .filter((t) => !carried.has(t.id) && t.status !== 'cancelled')
      .forEach((task) => assertTaskPreparation(s, task));
    const owner = kind === 'board' ? boardOwner(boards[0], s) : undefined;
    return {
      owner,
      digest: digest({
        kind,
        id,
        approvalMode: this.h.config.approvalMode,
        completionMode: this.h.config.completionMode,
        releaseId: changeSet?.releaseId,
        boards: boards.map((b) => ({
          id: b.id,
          title: b.title,
          description: b.description,
          revision: b.revisions.at(-1)!.number,
          // Цель этапа — часть утверждаемого. У первой ревизии причина
          // постоянна; без неё digest прежних jobs не меняется при обновлении.
          ...(b.revisions.length > 1 ? { reason: b.revisions.at(-1)!.reason } : {}),
          taskIds: b.revisions.at(-1)!.taskIds,
        })),
        tasks: tasks.map((t) => ({ id: t.id, ...taskInput.parse(t) })),
        contracts: s.contracts
          .filter((c) => tasks.some((t) => t.contracts.includes(c.id)))
          .map((c) => ({ id: c.id, digest: c.digest })),
        policies: repositories(this.h.config).map((r) => this.h.policyDigest(r.id)),
        workspacePolicy: new Workspace(this.h).policyDigest(),
      }),
    };
  }
  /**
   * Очередь технических заданий harness над хранилищем DevContour: fencing
   * владельца, устаревание входа, попытки стадии и учёт восстановлений — её
   * правила. Здесь — только продуктовый вход задания (доска или ChangeSet) и
   * его владелец-компонент.
   */
  queue() {
    const { engine, store } = executionOf(this.h);
    return new WorkflowQueue(engine.host.store, engine.policy, Date.now, {
      input: (kind, id, view) => {
        try {
          const bound = this.input(kind as WorkflowJob['kind'], id, store.stateOf(view));
          return { digest: bound.digest, ...(bound.owner ? { owner: bound.owner } : {}) };
        } catch (error) {
          // Удалённый или недопустимый предмет — изменившийся вход.
          if (error instanceof DomainError) throw new HarnessError('INVALID_INPUT', error.message);
          throw error;
        }
      },
    });
  }
  list(owner?: string) {
    return this.queue().list(owner) as WorkflowJob[];
  }
  /**
   * Безопасное представление работ для панели.
   *
   * Причина окончательной остановки жила только в local_workflow и доходила до
   * агентского API, но не до интерфейса: человек видел «ожидание выдачи» там,
   * где восстановление уже прекращено навсегда. Fencing-поля наружу не идут —
   * интерфейсу они не нужны и не должны быть доступны.
   */
  view() {
    const stale = this.staleBoards();
    return [undefined, ...repositories(this.h.config).map((r) => r.id)].flatMap((owner) =>
      this.list(owner).map((job) => ({
        ...(job.kind === 'board' && stale.get(job.id)?.key === job.key
          ? { inputStale: stale.get(job.id)! }
          : {}),
        key: job.key,
        kind: job.kind,
        id: job.id,
        owner: job.owner,
        stage: job.stage,
        status: job.status,
        error: job.error,
        attempts: job.attempts,
        startedAt: job.startedAt,
        authorRuntime: job.authorRuntime,
        // Ревью плана доски: кто его проводит по правилу вендора конфигурации.
        ...(job.kind === 'board'
          ? { reviewer: technicalReviewer(this.h.config, 'plan', job.authorRuntime) }
          : {}),
        maxAttempts: job.maxAttempts,
        repairs: job.repairs ?? 0,
        repairBudget: this.h.config.repairBudget,
        history: job.history.slice(-20),
        ...(job.kind === 'board' && ['queued', 'running'].includes(job.status)
          ? (() => {
              const waiting = this.waitingOf(job);
              return waiting ? { waiting } : {};
            })()
          : {}),
      })),
    );
  }
  /** Ожидание ответов на вопросы исполнителя стадией доски (чтение, без записи). */
  waitingOf(job: Pick<WorkflowJob, 'kind' | 'id' | 'stage'>, s = this.h.store.read()) {
    if (job.kind !== 'board' || job.stage < 1) return undefined;
    const revision = s.boards.find((b) => b.id === job.id)?.revisions.at(-1);
    return revision ? inputWaiting(this.h, s, revision.taskIds) : undefined;
  }
  /**
   * Отметить ожидание ответов в истории задания один раз: повторный такт,
   * который снова ждёт, второй записи не добавляет (захват стадии `running`
   * между ними не считается).
   */
  noteWaiting(job: WorkflowJob, event = WAITING_INPUT) {
    const { engine } = executionOf(this.h);
    domain(() =>
      engine.host.store.transact('workflow.updated', (tx) => {
        const current = this.queue().guard(job, tx) as WorkflowJob;
        const last = current.history.filter((h) => h.event !== 'running').at(-1);
        if (last?.event === event) return;
        tx.putLocal('workflow-jobs', job.owner ?? WORKSPACE_OWNER, job.key, {
          ...current,
          history: [...current.history, { at: new Date().toISOString(), stage: job.stage, event }],
        });
      }),
    );
  }
  /**
   * Доски, чьё действующее задание ведущего (queued или running) согласовано
   * по прежнему входу: после согласования изменилась политика исполнения
   * (роли, ревьюеры, gates — например, после workspace-init), постановка или
   * контракт. Очередь заданий помечает такое задание `stale` только при
   * следующем взятии стадии, а на паузе стадии не берутся, и оператор видел
   * лишь паузу и удержания. Здесь устаревание считается чтением, без записи.
   *
   * Доска, у которой уже есть задание по текущему входу (новое задание,
   * начатое и на паузе), не устарела: прежнее задание закроется `stale` само.
   * Вход, который нельзя построить (продукт не согласован, доска удалена), —
   * не устаревшее согласование: его причину называет прогресс задачи.
   */
  staleBoards(s: DevContourState = this.h.store.read()) {
    const stale = new Map<string, { key: string; reason: string; hint: string }>();
    const fresh = new Set<string>();
    const inputs = new Map<string, { digest: string; owner?: string } | undefined>();
    const bound = (id: string) => {
      if (!inputs.has(id))
        try {
          inputs.set(id, this.input('board', id, s));
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          inputs.set(id, undefined);
        }
      return inputs.get(id);
    };
    for (const owner of [undefined, ...repositories(this.h.config).map((r) => r.id)])
      for (const job of this.list(owner)) {
        if (job.kind !== 'board' || !['queued', 'running'].includes(job.status)) continue;
        const input = bound(job.id);
        if (!input) continue;
        if (input.digest === job.inputDigest && input.owner === job.owner) fresh.add(job.id);
        else
          stale.set(job.id, {
            key: job.key,
            reason:
              'Задание доски начато по прежнему входу: после него изменились политика исполнения (роли, ревьюеры, gates), постановка или контракт',
            hint: `Начните новое задание доски ${job.id} (workflow_start, kind board); прежнее закроется как stale, а план при другой политике утверждает review-plan`,
          });
      }
    for (const id of fresh) stale.delete(id);
    return stale;
  }
  get(key: string, owner?: string) {
    return domain(() => this.queue().get(key, owner)) as WorkflowJob;
  }
  start(raw: unknown) {
    const input = workflowInput.parse(raw);
    return domain(() => this.queue().start(input)) as WorkflowJob;
  }
  /**
   * Пробелы областей задач досок работы (`scopeGaps`): видны при регистрации,
   * а не через часы исполнения на приёмке. Регистрацию они не останавливают —
   * приёмка доски выполнит эти gates на её итоговом SHA.
   */
  scopeGaps(kind: WorkflowJob['kind'], id: string, s: DevContourState = this.h.store.read()) {
    const boardIds =
      kind === 'changeset' ? (s.changeSets.find((c) => c.id === id)?.boardIds ?? []) : [id];
    return boardIds.flatMap((boardId) => {
      const revision = s.boards.find((b) => b.id === boardId)?.revisions.at(-1);
      if (!revision || revision.status === 'accepted') return [];
      const tasks = s.tasks.filter((t) => revision.taskIds.includes(t.id));
      return scopeGaps(this.h, tasks).map((gap) => ({ boardId, ...gap }));
    });
  }
  claim(key: string, owner?: string) {
    return domain(() => this.queue().claim(key, owner)) as WorkflowJob | undefined;
  }
  guard(job: WorkflowJob) {
    return domain(() => this.queue().guard(job as HarnessJob)) as WorkflowJob;
  }
  heartbeat(job: WorkflowJob) {
    domain(() => this.queue().heartbeat(job as HarnessJob));
  }
  /** Три стадии DevContour: согласование, исполнение, приёмка. */
  finish(job: WorkflowJob, wait = false) {
    return domain(() => this.queue().finish(job as HarnessJob, wait, 3)) as WorkflowJob;
  }
  fail(job: WorkflowJob, message: string, interrupted = false) {
    domain(() => this.queue().fail(job as HarnessJob, message, interrupted));
  }
  /**
   * Записать восстановление и выполнить его одной транзакцией (правило
   * очереди harness): прерывание между учётом и повтором не даёт ни повтора
   * мимо бюджета, ни учёта без повтора.
   */
  repair(job: WorkflowJob, event: string, apply: () => void) {
    return domain(() => this.queue().repair(job as HarnessJob, event, apply));
  }
  retry(key: string, owner?: string) {
    return domain(() => this.queue().retry(key, owner)) as WorkflowJob;
  }
}
