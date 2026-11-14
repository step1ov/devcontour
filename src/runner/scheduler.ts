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
import { STALE_BASE } from './base-update.ts';
import { executionOf, type Execution } from '../harness/execution.ts';
import { devcontourContextSource, pinnedSnapshot, taskPacks } from '../harness/host.ts';
import { runtimeAdapters } from '../harness/adapters.ts';
import { devcontourHooks } from '../harness/hooks.ts';
import { adapters } from './adapters.ts';
import { reviewedContractDocument, sensitiveBaseEntries } from './sensitive-paths.ts';
import { git } from './process.ts';
import { assertTeamCheckout } from './git-sync.ts';
import { reserveRepositories } from './ownership.ts';
import { serveReconfigure } from './reconfigure.ts';
import { checkoutRootOption, checkoutRoots, workspaceCheckoutRoot } from './checkout-root.ts';

export { classifyFailure } from 'devcontour-harness';

export class Scheduler {
  readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private built?: { execution: Execution; runner: Runner };
  /**
   * Исполнители прежних конфигураций: `stop` дожидается их окончания
   * (`settled`). Прежний исполнитель появляется только при применении
   * конфигурации, а оно ждёт, пока под прежней не останется работ
   * (`busyWork`), поэтому своих попыток у него нет или они уже кончаются.
   * Прервать их, не освободив роль controller, исполнитель harness не умеет,
   * а его `stop` отпустил бы роль, которую держит текущий исполнитель с тем
   * же владельцем, — поэтому только `settled`.
   */
  private retired: Runner[] = [];
  /** Идущий такт (интервала, HTTP-запуска или drain): `stop` дожидается его. */
  private current?: Promise<void>;
  private stopped = false;
  /** Планировщик останавливается: новые такты и запуск очереди не принимаются. */
  get stopping() {
    return this.stopped;
  }
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
    // Прежний исполнитель (конфигурацию применили после drain) больше не
    // ведёт очередь: его продление роли и обход зависших останавливаются,
    // когда закончатся его попытки (`settled`), иначе их интервалы жили бы
    // рядом с интервалами нового.
    if (this.built) {
      const previous = this.built.runner;
      this.retired.push(previous);
      void previous
        .settled()
        .catch(() => {})
        .finally(() => (this.retired = this.retired.filter((r) => r !== previous)));
    }
    const context = devcontourContextSource(this.h, execution.store);
    const runner = new Runner({
      engine: execution.engine,
      stateDir: this.root,
      // Компонентное хранение: попытки компонента — рядом с его данными.
      stateDirFor: (repositoryId) => this.runRoot(repositoryId),
      baseDir: this.root,
      adapters: runtimeAdapters(this.h, execution.engine.policy, this.runtimes),
      // Снимок контекста — закреплённые context packs задачи (те же байты,
      // прежний digest пакета). Попытка, выданная со снимком ответа на вопрос
      // исполнителя (`pinned.contextDigest`), получает ровно его: writer и оба
      // reviewer видят одни и те же байты. Не найденный снимок — `undefined`:
      // runner держит эту задачу (needs-lead) до платного вызова.
      context: (work, attempt) => {
        const pin = attempt.pinned?.contextDigest;
        if (typeof pin === 'string') return pinnedSnapshot(execution.store, pin);
        if (pin === null) return undefined;
        const task = this.h.store.view().tasks.find((t) => t.id === work.id);
        return task && taskPacks(this.h, task).length ? context.forTask(work.id) : undefined;
      },
      hooks: devcontourHooks(this.h),
      owner: this.owner,
      branchPrefix: 'devcontour/run-',
      // Один корень рабочих деревьев на workspace — тот же, что у проверок
      // доски и базы, переноса базы и совместной проверки.
      ...checkoutRootOption(workspaceCheckoutRoot(this.h)),
      ...(this.h.config.resourceDatabase
        ? { resourceDatabase: this.h.config.resourceDatabase }
        : {}),
    });
    this.built = { execution, runner };
    return runner;
  }

  /**
   * Граница исполнителя и ревьюера: каталоги контура и рабочие деревья
   * компонентов закрыты; чужие попытки под корнем рабочих деревьев вне
   * дерева закрыты (`checkouts`).
   */
  boundary(repositoryId = 'main') {
    const repos = repositories(this.h.config);
    return {
      hidden: [...new Set([this.root, this.runRoot(repositoryId), ...repos.map((r) => r.path)])],
      readable: repos.map((r) => join(r.path, '.git')),
      checkouts: checkoutRoots(this.h),
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
  /** Убрать рабочие деревья закончившихся попыток; ветки и артефакты остаются. */
  cleanupWorktrees(options: { dryRun?: boolean } = {}) {
    return this.runner.cleanupWorktrees(options);
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
    // Отметка остановки прежнего процесса, роль которого уже не жива
    // (освобождена или истекла после падения), снимается при запуске.
    this.h.markStopping(this.owner, false);
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
   * (D42). Отказ возвращает чувствительные пути — остановка их называет, — и
   * те из них, что после переноса подтвердит только человек (`held`: всё,
   * кроме документов контрактов в редакции, одобренной независимым ревью, —
   * то же правило, что у проверки базы, `baseMoveReview`).
   */
  private async fastForwardBase(
    drift: Awaited<ReturnType<Scheduler['baseDrift']>>,
  ): Promise<{ sensitive: string[]; held: string[] }> {
    const none = { sensitive: [], held: [] };
    if (!drift.length || drift.some((d) => d.ahead > 0)) return none;
    const s = this.h.store.read();
    // Пауза и идущие попытки проверяет транзакция сдвига (ниже) — атомарно со сдвигом.
    if (s.reconfigure && !s.reconfigure.appliedAt) return none;
    const openChange = repositories(this.h.config).some((r) =>
      Object.values(this.h.store.localRecords<{ status: string }>('contract-change', r.id)).some(
        (op) => ['queued', 'running', 'waiting', 'failed'].includes(op.status),
      ),
    );
    if (openChange) return none;
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
      if (!branch) return none;
      const to = await git(repo.path, 'rev-parse', 'HEAD');
      const from = await git(repo.path, 'rev-parse', this.targetFor(repo.id));
      // Цель — предок рабочей линии: перемотка ничего не теряет и не переписывает.
      if (
        !(await git(repo.path, 'merge-base', '--is-ancestor', from, to).then(
          () => true,
          () => false,
        ))
      )
        return none;
      const touched = await sensitiveBaseEntries(this.h, this.root, s, repo.id, from, to);
      if (touched.length) {
        const held: string[] = [];
        for (const e of touched)
          if (
            !e.contractDocument ||
            !(await reviewedContractDocument(this.h, s, repo.id, e.path, to))
          )
            held.push(`${repo.id}:${e.path}`);
        return { sensitive: touched.map((e) => `${repo.id}:${e.path}`), held };
      }
      moves.push({ repositoryId: repo.id, path: repo.path, branch, from, to });
    }
    const move = fencedRefMove(
      executionOf(this.h).store,
      (view) => {
        if (view.control().paused) throw new Error('очередь остановлена');
        if (view.attempts().some((a) => a.status === 'active')) throw new Error('идёт попытка');
        if (view.controller()?.owner !== this.owner) throw new Error('роль controller утрачена');
      },
      undefined,
      'controller',
    );
    const moved: typeof moves = [];
    try {
      for (const m of moves) {
        await move(m.path, this.targetFor(m.repositoryId), m.to, m.from);
        moved.push(m);
      }
    } catch {
      // Несостоявшийся сдвиг — прежняя остановка с подсказкой base-update.
    }
    if (!moved.length) return none;
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
    return none;
  }
  private async assertBaseCurrent(
    { sensitive, held }: { sensitive: string[]; held: string[] } = { sensitive: [], held: [] },
  ) {
    const drift = await this.baseDrift();
    if (!drift.length) return;
    // Перенос, который gates не подтвердят, после base-update ждёт человека
    // (D42): подсказка называет этот шаг заранее, а не только «выполните
    // base-update». В режиме оператора очередь и так запускает человек.
    const operator =
      held.length && this.h.config.approvalMode === 'agent'
        ? ` После переноса очередь продолжит только подтверждение оператора (${held.slice(0, 20).join(', ')}): «Подтвердить и запустить» в «Внимании» панели; ведущий агент это ожидание сам не снимает — попросите пользователя подтвердить перенос. Без человека — только изменение приёмки через contract-change; документ контракта снимает цикл, если его редакцию одобрило независимое ревью (review-contract).`
        : '';
    throw new TaskFailure(
      'stale-base',
      STALE_BASE +
        ': ' +
        drift.map((d) => `${d.repositoryId} — ${d.branch} без ${d.behind} коммитов`).join('; ') +
        (sensitive.length
          ? `. Перемотка не выполнена автоматически: коммиты меняют приёмку или настройку контура (${sensitive.slice(0, 20).join(', ')})`
          : '') +
        '. Выполните devcontour base-update (ведущий агент — с --by host), иначе исполнитель получит дерево без подготовленной работы.' +
        operator,
    );
  }
  /**
   * Вести очередь интервалом. Повторный вызов (сервер запускает уже
   * запущенный планировщик) ничего не меняет. Сбой такта пишется в журнал,
   * только пока планировщик не остановлен: после `stop` хранилище могут
   * закрыть, и запись из запоздавшего такта упала бы необработанным отказом.
   */
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      if (this.stopped || this.current) return;
      void this.tick()
        .catch((e: unknown) => {
          if (this.stopped) return;
          this.h.store.change('scheduler.error', (s) => {
            // Время остановки отличает сбой такта от исходной паузы «очередь
            // ещё не запускали» (у обеих нет причины), даже когда событие
            // ушло из последних записей журнала. Уже стоящую паузу сбой не
            // передатирует.
            if (!s.paused) s.pausedAt = new Date().toISOString();
            s.paused = true;
            return { error: String(e) };
          });
        })
        .catch(() => {
          // Запись сбоя не удалась (хранилище недоступно): следующий такт
          // повторит сам такт; необработанного отказа нет.
        });
    }, 750);
    this.timer.unref();
  }
  /**
   * Начало штатной остановки: отметка в базе, по которой запуск очереди из
   * любого процесса (CLI `queue --start`, отдельный MCP) отклоняется, пока
   * этот планировщик держит роль controller. Сервер ставит её в начале своего
   * `close`, до остановки прочих исполнителей; `stop` — повторно (прямой
   * вызов или отметку держал другой останавливающийся сервер). Записанная
   * отметка повторно не пишется.
   */
  beginStop() {
    if (!this.marked) this.marked = this.h.markStopping(this.owner, true);
  }
  private marked = false;
  async stop() {
    this.stopped = true;
    this.beginStop();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Пауза штатной остановки — сразу, до ожидания идущего такта: он не
    // выдаёт новых попыток, которые тут же пришлось бы прервать. Продуктовая
    // форма (поверх паузы операции); остановка попыток и освобождение роли
    // controller — исполнитель harness.
    this.h.pause(true, 'shutdown');
    // Идущий такт (любой: интервала, HTTP-запуска, drain) доводится до конца
    // до остановки исполнителей: после `stop` вызывающий закрывает хранилище.
    await this.current?.catch(() => {});
    await this.runner.stop();
    await Promise.all(this.retired.map((r) => r.settled().catch(() => {})));
    this.retired = [];
    // Роль освобождена — отметка уже не действует; снимается для порядка
    // (не снятую снимет следующий запуск).
    try {
      this.h.markStopping(this.owner, false);
    } catch {
      /* Отметка без живой роли ничего не блокирует. */
    }
  }
  /**
   * Один такт очереди. Такт один на планировщик: вызов во время идущего ждёт
   * его (без его отказа), после `stop` — ничего не делает. Идущий такт
   * записан в `current` при любом источнике вызова, поэтому `stop` дожидается
   * и такта HTTP-запуска очереди.
   */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current) return this.current.catch(() => {});
    const run = this.tickOnce().finally(() => {
      if (this.current === run) this.current = undefined;
    });
    this.current = run;
    return run;
  }
  private async tickOnce() {
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
    this.h.noteAppliedKeys();
    const runner = this.runner;
    if (!this.h.store.view().paused && runner.active < this.h.config.concurrency) {
      // Сверка базы — git на каждом такте; без расхождения повторно не читается.
      const drift = await this.baseDrift();
      if (drift.length) await this.assertBaseCurrent(await this.fastForwardBase(drift));
      assertTeamCheckout(this.h);
    }
    await runner.tick();
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
