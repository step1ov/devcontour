import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Harness, digest } from './service.ts';
import { taskInput, DomainError } from './model.ts';
import { boardOwner } from './sync-state.ts';
import { Workspace } from './workspace.ts';
import { repositories } from './repositories.ts';

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
  token?: string;
  leaseUntil?: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  history: { at: string; stage: number; event: string }[];
};
export class LeadWorkflow {
  constructor(readonly h: Harness) {}
  input(kind: WorkflowJob['kind'], id: string) {
    const s = this.h.store.read();
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
    const owner = kind === 'board' ? boardOwner(boards[0], s) : undefined;
    return {
      owner,
      digest: digest({
        kind,
        id,
        approvalMode: this.h.config.approvalMode,
        completionMode: this.h.config.completionMode,
        boards: boards.map((b) => ({
          id: b.id,
          title: b.title,
          description: b.description,
          revision: b.revisions.at(-1)!.number,
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
  list(owner?: string) {
    return Object.values(this.h.store.localRecords<WorkflowJob>('lead', owner));
  }
  get(key: string, owner?: string) {
    const job = this.h.store.localRecords<WorkflowJob>('lead', owner)[key];
    if (!job) throw new DomainError('Workflow не найден');
    return job;
  }
  private currentInput(job: WorkflowJob) {
    try {
      const current = this.input(job.kind, job.id);
      return current.digest === job.inputDigest && current.owner === job.owner;
    } catch (error) {
      // A removed subject is stale work, not a reason to block every later job.
      if (error instanceof DomainError) return false;
      throw error;
    }
  }
  start(raw: unknown) {
    const input = workflowInput.parse(raw);
    return this.h.store.atomic(() => {
      const bound = this.input(input.kind, input.id),
        key = digest({ kind: input.kind, id: input.id, input: bound.digest });
      const old = this.h.store.localRecords<WorkflowJob>('lead', bound.owner)[key];
      if (old) {
        if (old.authorRuntime !== input.authorRuntime)
          throw new DomainError('Runtime автора уже закреплён для этого входа');
        return old;
      }
      const job: WorkflowJob = {
        ...input,
        key,
        owner: bound.owner,
        inputDigest: bound.digest,
        stage: 0,
        attempts: 0,
        status: 'queued',
        startedAt: new Date().toISOString(),
        history: [],
      };
      this.h.store.saveLocal('lead', job.owner, key, job);
      return job;
    });
  }
  claim(key: string, owner?: string) {
    return this.h.store.atomic(() => {
      const job = this.get(key, owner);
      if (
        !['queued', 'running'].includes(job.status) ||
        (job.status === 'running' && job.leaseUntil! > Date.now())
      )
        return;
      if (!this.currentInput(job)) {
        job.status = 'stale';
        job.error = 'Input changed or removed';
      } else if (job.attempts >= job.maxAttempts) {
        job.status = 'failed';
        job.error = 'Stage attempt budget exhausted';
      } else {
        job.status = 'running';
        job.token = randomUUID();
        job.leaseUntil = Date.now() + this.h.config.leaseMs;
        job.attempts++;
      }
      job.history.push({ at: new Date().toISOString(), stage: job.stage, event: job.status });
      this.h.store.saveLocal('lead', owner, key, job);
      return job.status === 'running' ? job : undefined;
    });
  }
  guard(job: WorkflowJob) {
    const current = this.get(job.key, job.owner);
    if (
      current.status !== 'running' ||
      current.token !== job.token ||
      current.leaseUntil! <= Date.now()
    )
      throw new DomainError('Workflow lease утрачен');
    if (!this.currentInput(job)) throw new DomainError('Workflow input изменился');
    return current;
  }
  heartbeat(job: WorkflowJob) {
    this.h.store.atomic(() => {
      const current = this.guard(job);
      current.leaseUntil = Date.now() + this.h.config.leaseMs;
      this.h.store.saveLocal('lead', job.owner, job.key, current);
    });
  }
  finish(job: WorkflowJob, wait = false) {
    return this.h.store.atomic(() => {
      const current = this.guard(job);
      if (!wait) {
        current.stage++;
        current.attempts = 0;
      } else {
        current.attempts--;
        current.history.pop();
      } // Waiting for domain state performs no external action.
      current.status = current.stage >= 3 ? 'completed' : 'queued';
      if (current.status === 'completed') current.finishedAt = new Date().toISOString();
      current.token = undefined;
      current.leaseUntil = undefined;
      if (!wait)
        current.history.push({
          at: new Date().toISOString(),
          stage: job.stage,
          event: 'completed',
        });
      this.h.store.saveLocal('lead', job.owner, job.key, current);
      return current;
    });
  }
  fail(job: WorkflowJob, message: string, interrupted = false) {
    this.h.store.atomic(() => {
      const current = this.get(job.key, job.owner);
      if (current.token !== job.token || current.status !== 'running') return;
      current.status = !this.currentInput(job) ? 'stale' : interrupted ? 'queued' : 'failed';
      current.error = message.slice(0, 1000);
      current.token = undefined;
      current.leaseUntil = undefined;
      this.h.store.saveLocal('lead', job.owner, job.key, current);
    });
  }
  retry(key: string, owner?: string) {
    return this.h.store.atomic(() => {
      const job = this.get(key, owner);
      if (job.status !== 'failed' || job.attempts >= job.maxAttempts)
        throw new DomainError('Retry недоступен; проверьте статус и бюджет');
      if (!this.currentInput(job))
        throw new DomainError('Нужен новый workflow для изменившегося входа');
      job.status = 'queued';
      job.error = undefined;
      this.h.store.saveLocal('lead', owner, key, job);
      return job;
    });
  }
}
