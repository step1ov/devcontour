import { join } from 'node:path';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import type { DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import { Workspace, changeSnapshot, snapshotDigest } from '../core/workspace.ts';
import { reviewPlan, acceptBoard } from './agent-control.ts';
import { WorkspaceRunner } from './workspace.ts';
import { adapters } from './adapters.ts';
import { assertRequirements } from './requirements.ts';

export class LeadRunner {
  readonly workflow: LeadWorkflow;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private controller?: AbortController;
  constructor(
    readonly h: DevContour,
    readonly root: string,
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
      const tasks = s.tasks.filter((t) => revision.taskIds.includes(t.id));
      if (job.stage === 0) {
        if (revision.status === 'accepted' || tasks.every((t) => t.status !== 'draft'))
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
        if (tasks.some((t) => ['failed', 'cancelled'].includes(t.status)))
          throw new Error('Task failure requires diagnosis');
        if (!tasks.every((t) => t.status === 'done'))
          this.h.store.atomic(() => {
            guard();
            this.h.pause(false);
          });
      } else {
        if (tasks.some((t) => ['failed', 'cancelled'].includes(t.status)))
          throw new Error('Task failure requires diagnosis');
        if (!tasks.every((t) => t.status === 'done')) {
          if (s.paused && s.pauseReason === 'shutdown')
            this.h.store.atomic(() => {
              guard();
              this.h.pause(false);
            });
          return true;
        }
        for (const task of tasks) assertRequirements(this.h, task);
        await acceptBoard(this.h, b.id, job.authorRuntime, false, guard);
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
    const workspace = new Workspace(this.h);
    if (job.stage === 1) {
      const last = c.verifications.at(-1);
      if (
        last?.status === 'passed' &&
        last.specDigest === snapshotDigest(changeSnapshot(s, c)) &&
        last.policyDigest === workspace.policyDigest()
      )
        return false;
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
