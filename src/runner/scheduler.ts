// Планировщик DevContour — обёртка над исполнителем очереди harness.
//
// Выдача, реализация, gates, независимое ревью обеих фаз, интеграция, CAS
// продвижения ветки и recovery — `Runner` пакета harness над тем же Store.
// Здесь остаются продуктовые шаги вокруг очереди: подготовка веток
// компонентов, проверка, что база прогонов не отстала от рабочей ветки (и её
// перемотка, когда она — чистый fast-forward), режим команды, применение
// конфигурации операцией. Правил приёмки здесь нет.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HarnessError, Runner, fencedRefMove } from 'devcontour-harness';
import { DevContour, waitBaseCheck } from '../core/service.ts';
import { repository, repositories } from '../core/repositories.ts';
import { validateWorkflow } from '../core/workflow.ts';
import { TaskFailure } from '../core/failure.ts';
import { executionOf, type Execution } from '../harness/execution.ts';
import { devcontourContextSource, taskPacks } from '../harness/host.ts';
import { runtimeAdapters } from '../harness/adapters.ts';
import { devcontourHooks } from '../harness/hooks.ts';
import { adapters } from './adapters.ts';
import { sensitiveBasePaths } from './sensitive-paths.ts';
import { git } from './process.ts';
import { assertTeamCheckout } from './git-sync.ts';
import { reserveRepositories } from './ownership.ts';
import { serveReconfigure } from './reconfigure.ts';

export { classifyFailure } from 'devcontour-harness';

export class Scheduler {
  readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private built?: { execution: Execution; runner: Runner };
  constructor(
    readonly h: DevContour,
    readonly root: string,
    readonly runtimes: typeof adapters = adapters,
  ) {}

  /**
   * Исполнитель очереди для текущей конфигурации. Конфигурация меняется
   * только применением операции после drain — тогда исполнитель собирается
   * заново под новым движком.
   */
  private get runner(): Runner {
    const execution = executionOf(this.h);
    if (this.built?.execution === execution) return this.built.runner;
    const context = devcontourContextSource(this.h, execution.store);
    const runner = new Runner({
      engine: execution.engine,
      stateDir: this.root,
      // Компонентное хранение: попытки компонента — рядом с его данными.
      stateDirFor: (repositoryId) => this.runRoot(repositoryId),
      baseDir: this.root,
      adapters: runtimeAdapters(this.h, execution.engine.policy, this.runtimes),
      // Снимок контекста — закреплённые context packs задачи (те же байты, прежний digest пакета).
      context: (work) => {
        const task = this.h.store.view().tasks.find((t) => t.id === work.id);
        return task && taskPacks(this.h, task).length ? context.forTask(work.id) : undefined;
      },
      hooks: devcontourHooks(this.h),
      owner: this.owner,
      branchPrefix: 'devcontour/run-',
      ...(this.h.config.resourceDatabase
        ? { resourceDatabase: this.h.config.resourceDatabase }
        : {}),
    });
    this.built = { execution, runner };
    return runner;
  }

  /** Граница исполнителя и ревьюера: каталоги контура и рабочие деревья компонентов закрыты. */
  boundary(repositoryId = 'main') {
    const repos = repositories(this.h.config);
    return {
      hidden: [...new Set([this.root, this.runRoot(repositoryId), ...repos.map((r) => r.path)])],
      readable: repos.map((r) => join(r.path, '.git')),
    };
  }
  runRoot(repositoryId = 'main') {
    return this.h.config.storage === 'component'
      ? join(repository(this.h.config, repositoryId).path, '.devcontour-local')
      : this.root;
  }
  get active() {
    return this.built?.runner.active ?? 0;
  }
  get target() {
    return `refs/heads/${this.h.config.targetBranch}`;
  }
  targetFor(repositoryId = 'main') {
    return `refs/heads/${repository(this.h.config, repositoryId).targetBranch}`;
  }
  async init() {
    validateWorkflow(this.h.config);
    await reserveRepositories(this.h.config, this.root);
    for (const repo of repositories(this.h.config)) {
      const target = this.targetFor(repo.id);
      try {
        await git(repo.path, 'rev-parse', '--verify', target);
      } catch {
        await git(repo.path, 'branch', repo.targetBranch, 'HEAD');
      }
    }
    await this.runner.init();
  }
  /**
   * Насколько база прогонов отстала от рабочей ветки репозитория. Прогон
   * ответвляется от ветки интеграции, а подготовку (контракты, схемы)
   * делают на рабочей ветке: пока линии не сведены, исполнитель получил бы
   * дерево без того, что ему поручено выполнить.
   */
  async baseDrift() {
    const drift: { repositoryId: string; branch: string; behind: number; ahead: number }[] = [];
    for (const repo of repositories(this.h.config)) {
      const target = this.targetFor(repo.id);
      const head = await git(repo.path, 'rev-parse', 'HEAD');
      const tip = await git(repo.path, 'rev-parse', target);
      if (head === tip) continue;
      const behind = Number(await git(repo.path, 'rev-list', '--count', `${target}..HEAD`));
      if (!behind) continue;
      drift.push({
        repositoryId: repo.id,
        branch: repo.targetBranch,
        behind,
        ahead: Number(await git(repo.path, 'rev-list', '--count', `HEAD..${target}`)),
      });
    }
    return drift;
  }
  /**
   * Перемотать отставшую базу прогонов, когда это чистый fast-forward одних
   * лишь продуктовых изменений: база — предок рабочей ветки (HEAD на ветке,
   * не detached), принятая история остаётся в ней целиком, слияния нет, и
   * перематываемые коммиты не трогают того, что задаёт приёмку и исполнение
   * (`sensitiveBasePaths`). Это та часть `base-update`, которая не требует
   * решения: ручной путь стоит только ради неё.
   *
   * Только на работающей очереди без попыток, без незавершённой операции
   * изменения контракта и применения конфигурации; сдвиг ref — CAS в
   * транзакции, проверяющей, что очередь не встала, попыток не появилось и
   * роль controller у этого процесса. Как и после ручного переноса, очередь
   * встаёт на ожидание `base-check`: новую базу проверяют гейтами до выдачи
   * (D42). Отказ возвращает чувствительные пути — остановка их называет.
   */
  private async fastForwardBase(
    drift: Awaited<ReturnType<Scheduler['baseDrift']>>,
  ): Promise<string[]> {
    if (!drift.length || drift.some((d) => d.ahead > 0)) return [];
    const s = this.h.store.read();
    // Пауза и идущие попытки проверяет транзакция сдвига (ниже) — атомарно со сдвигом.
    if (s.reconfigure && !s.reconfigure.appliedAt) return [];
    const openChange = repositories(this.h.config).some((r) =>
      Object.values(this.h.store.localRecords<{ status: string }>('contract-change', r.id)).some(
        (op) => ['queued', 'running', 'waiting', 'failed'].includes(op.status),
      ),
    );
    if (openChange) return [];
    const moves: {
      repositoryId: string;
      path: string;
      branch: string;
      from: string;
      to: string;
    }[] = [];
    for (const d of drift) {
      const repo = repository(this.h.config, d.repositoryId);
      const branch = await git(repo.path, 'symbolic-ref', '-q', '--short', 'HEAD').catch(() => '');
      if (!branch) return [];
      const to = await git(repo.path, 'rev-parse', 'HEAD');
      const from = await git(repo.path, 'rev-parse', this.targetFor(repo.id));
      // Цель — предок рабочей линии: перемотка ничего не теряет и не переписывает.
      if (
        !(await git(repo.path, 'merge-base', '--is-ancestor', from, to).then(
          () => true,
          () => false,
        ))
      )
        return [];
      const touched = await sensitiveBasePaths(this.h, this.root, s, repo.id, from, to);
      if (touched.length) return touched.map((p) => `${repo.id}:${p}`);
      moves.push({ repositoryId: repo.id, path: repo.path, branch, from, to });
    }
    const move = fencedRefMove(executionOf(this.h).store, (view) => {
      if (view.control().paused) throw new Error('очередь остановлена');
      if (view.attempts().some((a) => a.status === 'active')) throw new Error('идёт попытка');
      if (view.controller()?.owner !== this.owner) throw new Error('роль controller утрачена');
    });
    const moved: typeof moves = [];
    try {
      for (const m of moves) {
        await move(m.path, this.targetFor(m.repositoryId), m.to, m.from);
        moved.push(m);
      }
    } catch {
      // Несостоявшийся сдвиг — прежняя остановка с подсказкой base-update.
    }
    if (!moved.length) return [];
    // Журнал называет перемотку отдельно от ручного base-update (метрики
    // считают её автоматической); ожидание base-check — то же, что после
    // ручного переноса: до проверки гейтами новая база не выдаётся.
    this.h.store.change('base.fast-forwarded', (st) => {
      st.paused = true;
      if (st.pauseReason !== 'operator') st.pauseReason = 'base-check';
      st.pausedAt = new Date().toISOString();
      waitBaseCheck(
        st,
        moved,
        `База прогонов перемотана автоматически (${moved.map((m) => m.repositoryId).join(', ')}): проверьте её гейтами и продолжите очередь`,
      );
      return {
        updated: moved.map(({ repositoryId, branch, from, to }) => ({
          repositoryId,
          branch,
          from,
          to,
        })),
      };
    });
    return [];
  }
  private async assertBaseCurrent(sensitive: string[] = []) {
    const drift = await this.baseDrift();
    if (!drift.length) return;
    throw new TaskFailure(
      'stale-base',
      'База прогонов отстала от рабочей ветки: ' +
        drift.map((d) => `${d.repositoryId} — ${d.branch} без ${d.behind} коммитов`).join('; ') +
        (sensitive.length
          ? `. Перемотка не выполнена автоматически: коммиты меняют приёмку или настройку контура (${sensitive.slice(0, 20).join(', ')})`
          : '') +
        '. Выполните devcontour base-update, иначе исполнитель получит дерево без подготовленной работы.',
    );
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () =>
        void this.tick().catch((e) =>
          this.h.store.change('scheduler.error', (s) => {
            s.paused = true;
            return { error: String(e) };
          }),
        ),
      750,
    );
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Пауза штатной остановки — продуктовая форма (поверх паузы операции);
    // остановка попыток и освобождение роли controller — исполнитель harness.
    this.h.pause(true, 'shutdown');
    await this.runner.stop();
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.h.leader(this.owner)) {
        // Роль у другого controller: свои попытки прерываются, новых нет.
        await this.runner.tick().catch((error: unknown) => {
          if (!(error instanceof HarnessError && error.code === 'CONTROLLER_BUSY')) throw error;
        });
        return;
      }
      // Запуск применяет конфигурацию этого процесса, когда он стал controller;
      // повторяется, пока она не станет применённой. Отставший процесс не пишет.
      if (this.h.store.view().appliedConfig?.digest !== this.h.configDigest)
        this.h.recordConfig(this.owner);
      // Утверждения прежних версий закрепляются за действующей политикой
      // один раз: повторного утверждения всех планов обновление не требует.
      if (this.h.store.view().appliedConfig?.digest === this.h.configDigest)
        this.h.pinLegacyApprovals();
      // Запрошенное операцией применение конфигурации — до выдачи.
      serveReconfigure(this.h, join(this.root, 'config.json'), this.owner);
      const runner = this.runner;
      if (!this.h.store.view().paused && runner.active < this.h.config.concurrency) {
        // Сверка базы — git на каждом такте; без расхождения повторно не читается.
        const drift = await this.baseDrift();
        if (drift.length) await this.assertBaseCurrent(await this.fastForwardBase(drift));
        assertTeamCheckout(this.h);
      }
      await runner.tick();
    } finally {
      this.ticking = false;
    }
  }
  async drain() {
    while (true) {
      await this.tick();
      const runner = this.runner;
      const active = runner.active;
      await runner.settled();
      if (!active) break;
    }
  }
}
