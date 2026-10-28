import { join } from 'node:path';
import { JointRunner } from 'devcontour-harness';
import type { DevContour } from '../core/service.ts';
import { Workspace } from '../core/workspace.ts';
import { executionOf, toDomain } from '../harness/execution.ts';
import { IntentService } from './intent.ts';
import { reserveRepositories } from './ownership.ts';
import { checkoutRootOption, workspaceCheckoutRoot } from './checkout-root.ts';

/**
 * Исполнение совместной проверки ChangeSet — `JointRunner` пакета harness:
 * снимки target ref, manifest, gates уровня workspace в песочнице проверок,
 * сверка целостности после каждого gate, записи только через fencing движка.
 * DevContour начинает проверку своей операцией (продуктовые условия и снимок
 * релиза в той же записи), задаёт каталог проверки, её переменные и резерв
 * репозиториев; продуктовые условия каждой записи — `HostGuards.joint`.
 */
export class WorkspaceRunner {
  readonly workspace: Workspace;
  private jobs = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  constructor(
    readonly h: DevContour,
    readonly root: string,
  ) {
    this.workspace = new Workspace(h, new IntentService(h));
  }
  verify(id: string) {
    const run = this.workspace.start(id);
    const controller = new AbortController();
    const promise = this.execute(id, run.id, controller).finally(() => this.jobs.delete(run.id));
    this.jobs.set(run.id, { controller, promise });
    return promise;
  }
  async stop() {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
  }
  private async execute(changeSetId: string, verificationId: string, controller: AbortController) {
    const { engine } = executionOf(this.h);
    const runner = new JointRunner({
      engine,
      stateDir: this.root,
      baseDir: this.root,
      directory: (v) => join(this.root, 'workspace-checks', v.id),
      // Снимки компонентов — под корнем рабочих деревьев workspace.
      ...checkoutRootOption(workspaceCheckoutRoot(this.h)),
      env: () => ({ DEVCONTOUR_CHANGESET_ID: changeSetId }),
      prepare: async () => {
        await reserveRepositories(this.h.config, this.root);
      },
      ...(this.h.config.resourceDatabase
        ? { resourceDatabase: this.h.config.resourceDatabase }
        : {}),
    });
    const started = engine.read((view) => view.verification(verificationId));
    if (!started) throw new Error('Проверка workspace не найдена: ' + verificationId);
    const result = await runner.run(started, controller.signal).catch((error: unknown) => {
      throw toDomain(error);
    });
    if (result.status !== 'passed')
      throw new Error(result.status === 'failed' ? result.error : 'Проверка workspace не прошла');
    return { changeSetId, verificationId, manifest: result.manifest };
  }
}
