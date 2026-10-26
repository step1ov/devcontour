import { access, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, type Config, type DevContourState, type Role } from '../core/model.ts';
import {
  codeReviewVendor,
  declaredRoles,
  repositories,
  reviewerBinding,
  roleBinding,
} from '../core/repositories.ts';
import { DevContourExecutionStore, harnessVersion } from '../harness/index.ts';
import { projectionOptions } from '../harness/host.ts';
import { technicalReviewer } from '../harness/policy.ts';
import { isolationSupport } from './isolation.ts';
import { validateWorkflow } from '../core/workflow.ts';
import { command, git } from './process.ts';
import { outdatedContextPacks } from './context-library.ts';
import { executionEnvironment, runSteps, withEnvironment } from './environment.ts';
import { withResources } from './resources.ts';
import { agentEnvironment, reviewerRunsChecks, toolProfileFor, writerRunsChecks } from './tools.ts';
import { taskContext } from './context.ts';
import { forgeAdapter } from './forge.ts';
import { DevContour, supersededBy } from '../core/service.ts';
import { repository } from '../core/repositories.ts';
import { artifactGuard } from './agent-control.ts';
import { unguardedMessage } from './artifact-closure.ts';
import { Store, journalFiles } from '../core/store.ts';
import { z } from 'zod';

type Check = { id: string; status: 'passed' | 'blocked' | 'not-checked'; detail: string };
const bindingLabel = (b: { runtime: string; model?: string }) =>
  b.model ? `${b.runtime} (${b.model})` : b.runtime;
export async function executable(file: string) {
  const candidates = file.includes('/')
    ? [file]
    : (process.env.PATH ?? '').split(delimiter).map((p) => join(p, file));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* next PATH entry */
    }
  }
  throw new Error('Команда не найдена: ' + file);
}
/**
 * Версия движка исполнения и версии, записавшие состояние: перед обновлением
 * и откатом видно, какая версия последней писала базу. Живая роль controller
 * другой версии движка — блокировка: её процесс ещё работает.
 */
export function engineCheck(
  state: Pick<DevContourState, 'leader' | 'runs'>,
  now = Date.now(),
): Check {
  const leader: { owner: string; leaseUntil: number; engineVersion?: string } | undefined =
    state.leader;
  const attempts = [
    ...new Set(
      state.runs.flatMap((r) => {
        const v = (r as { engineVersion?: string }).engineVersion;
        return v ? [v] : [];
      }),
    ),
  ].sort();
  const live = !!leader && leader.leaseUntil > now;
  const controller = leader
    ? `роль controller ${leader.owner} (${leader.engineVersion ?? 'версия не записана'}${live ? ', живая' : ', истекла'})`
    : 'роли controller нет';
  const detail = `devcontour-harness ${harnessVersion}; ${controller}; попытки записаны версиями: ${attempts.join(', ') || 'нет попыток'}`;
  if (live && leader.engineVersion !== harnessVersion)
    return {
      id: 'engine',
      status: 'blocked',
      detail: `${detail}. Состояние держит процесс другой версии движка: остановите его штатно или дождитесь истечения роли`,
    };
  return { id: 'engine', status: 'passed', detail };
}

/**
 * Проверка совместимости данных: только хранение и формат. Каждая база
 * (центральная или coordinator и базы компонентов) открывается соединением
 * только для чтения до любого доступа на запись: без проекций, журнала,
 * начальных строк и присвоения владельца. Проверяются версия каждого
 * исходного документа, владение баз компонентов, версия движка и роль
 * controller, документ исполнения строгими схемами harness и конфигурация
 * штатного загрузчика. Модели, CLI, песочница и live-проверки не проверяются:
 * результат не означает готовность среды — её подтверждает полный `doctor`
 * на хосте.
 */
export function dataDoctor(config: Config, root: string) {
  const checks: Check[] = [];
  const check = (id: string, action: () => string) => {
    try {
      checks.push({ id, status: 'passed', detail: action() });
      return true;
    } catch (e) {
      checks.push({ id, status: 'blocked', detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  const result = () => ({
    scope: 'data-compatibility',
    compatible: !checks.some((c) => c.status === 'blocked'),
    checks,
    note: 'Проверка совместимости данных: модели, CLI, песочница и live-проверки не проверялись. Готовность среды подтверждает полный devcontour doctor на хосте после установки, до возобновления writers.',
  });
  check('config', () => {
    validateWorkflow(config);
    return 'Конфигурация загружена штатным загрузчиком, принадлежит workspace и согласована';
  });
  let store: Store | undefined;
  // Без файлов журнала база WAL читается как неизменяемая (Store, только
  // чтение): ни `-wal`, ни `-shm` проверка не создаёт. Появились файлы
  // журнала или изменился сам файл базы (writer открыл, записал, перенёс
  // журнал в базу и закрылся) — прочитанное могло устареть.
  const file = join(root, 'state.sqlite');
  const journal = journalFiles(file);
  const print = () => {
    try {
      const s = statSync(file);
      return JSON.stringify([s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    } catch {
      return 'missing';
    }
  };
  const quiet = !journal.some((f) => existsSync(f));
  const before = print();
  const settled = () => {
    if (quiet && (journal.some((f) => existsSync(f)) || print() !== before))
      checks.push({
        id: 'storage-quiet',
        status: 'blocked',
        detail:
          'Во время проверки базу менял другой процесс (файлы журнала SQLite или файл базы): остановите writers и повторите проверку',
      });
  };
  if (
    !check('storage', () => {
      store = new Store(
        join(root, 'state.sqlite'),
        config.storage === 'component' ? repositories(config) : undefined,
        false,
        undefined,
        true,
      );
      return config.storage === 'component'
        ? `Базы компонентов существуют и принадлежат этому coordinator: ${repositories(config)
            .map((r) => r.id)
            .join(', ')}; открыты только для чтения`
        : 'Центральная база существует; открыта только для чтения';
    })
  )
    return result();
  try {
    let state: DevContourState | undefined;
    if (
      !check('state', () => {
        state = store!.read();
        return 'Версии исходных документов поддерживаются (stateVersion 1)';
      })
    )
      return result();
    checks.push(engineCheck(state!));
    check('execution-state', () => {
      const h = new DevContour(store!, config);
      const execution = new DevContourExecutionStore(h.store, projectionOptions(h));
      const counts = execution.read((v) => {
        v.control();
        v.controller();
        return {
          graphs: v.graphs().length,
          works: v.works().length,
          attempts: v.attempts().length,
          verifications: v.verifications().length,
        };
      });
      return `Документ исполнения читается строгими схемами devcontour-harness ${harnessVersion} (stateVersion ${execution.stateVersion}): графов ${counts.graphs}, работ ${counts.works}, попыток ${counts.attempts}, совместных проверок ${counts.verifications}`;
    });
  } finally {
    store!.close();
  }
  settled();
  return result();
}

/**
 * Состояние для полного `doctor` — только чтением, как в проверке данных:
 * без PRAGMA режима журнала, DDL, начальных строк и владельца баз
 * компонентов. Полный doctor не становится writer: таблицы и строки, которых
 * нет в базе прежней версии, создаёт первый writer (`serve`, `run`).
 *
 * База WAL без файлов журнала читается как неизменяемая. Если за время чтения
 * появились файлы журнала или изменился файл базы, прочитанное могло
 * устареть — чтение повторяется (теперь с журналом, обычным соединением).
 *
 * Базы ещё нет (центральной — пустое состояние, как у новой базы; базы
 * компонента — проверка `state` not-checked): doctor её не создаёт.
 */
export function doctorState(
  config: Config,
  root: string,
): { state?: DevContourState; check?: Check } {
  const file = join(root, 'state.sqlite');
  if (!existsSync(file)) return { state: emptyState() };
  const components = config.storage === 'component' ? repositories(config) : undefined;
  const missing = (components ?? []).filter(
    (r) => !existsSync(join(r.path, '.devcontour-local', 'state.sqlite')),
  );
  if (missing.length)
    return {
      check: {
        id: 'state',
        status: 'not-checked',
        detail: `Базы компонентов ещё не созданы: ${missing.map((r) => r.id).join(', ')}. Doctor баз не создаёт — их создаст первый writer (serve или run); состояние не проверено`,
      },
    };
  const print = () => {
    try {
      const s = statSync(file);
      return JSON.stringify([s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    } catch {
      return 'missing';
    }
  };
  for (let attempt = 1; ; attempt++) {
    const journal = journalFiles(file);
    const quiet = !journal.some((f) => existsSync(f));
    const before = print();
    let state: DevContourState | undefined;
    let failure: unknown;
    try {
      const store = new Store(file, components, false, undefined, true);
      try {
        state = store.read();
      } finally {
        store.close();
      }
    } catch (e) {
      failure = e;
    }
    const settled = !quiet || (!journal.some((f) => existsSync(f)) && print() === before);
    if (settled || attempt === 3) {
      if (state && settled) return { state };
      return {
        check: {
          id: 'state',
          status: 'blocked',
          detail: settled
            ? `Состояние не читается: ${failure instanceof Error ? failure.message : String(failure)}`
            : 'Базу непрерывно меняет другой процесс: состояние не прочитано согласованно',
        },
      };
    }
  }
}

export async function doctor(
  config: Config,
  root: string,
  probe = false,
  state?: Pick<DevContourState, 'leader' | 'runs'> & Partial<Pick<DevContourState, 'contracts'>>,
  stateCheck?: Check,
) {
  const checks: Check[] = [];
  if (stateCheck) checks.push(stateCheck);
  if (state) checks.push(engineCheck(state));
  const check = async (id: string, action: () => Promise<string>) => {
    try {
      checks.push({ id, status: 'passed', detail: await action() });
    } catch (e) {
      checks.push({ id, status: 'blocked', detail: e instanceof Error ? e.message : String(e) });
    }
  };
  await check('config', async () => {
    validateWorkflow(config);
    return 'Графы и профили согласованы';
  });
  // Роли берутся объявленные, а не только workspace-уровня: роль, добавленную
  // компонентом, doctor иначе не проверил бы вовсе.
  const bindings = repositories(config).flatMap((repo) =>
    declaredRoles(config, repo.id).flatMap((role) =>
      [false, true].map((review) => ({
        repo,
        role,
        review,
        binding: review
          ? reviewerBinding(config, role, repo.id)
          : roleBinding(config, role, repo.id),
      })),
    ),
  );
  // Назначение ролей: кто пишет, кто проверяет и по какому правилу вендора.
  // Ревьюер того же вендора возможен только явным разрешением — doctor
  // называет его прямо, а не подразумевает «другой вендор».
  for (const repo of repositories(config))
    for (const role of declaredRoles(config, repo.id)) {
      const writer = roleBinding(config, role, repo.id),
        reviewer = reviewerBinding(config, role, repo.id);
      const rule = codeReviewVendor(config, role, repo.id);
      const same = writer.runtime === reviewer.runtime;
      checks.push({
        id: `role:${repo.id}:${role}`,
        status:
          same && rule !== 'same-vendor-allowed' && config.mode !== 'demo' ? 'blocked' : 'passed',
        detail:
          `writer ${bindingLabel(writer)} → reviewer ${bindingLabel(reviewer)}; правило вендора: ${rule}` +
          (same ? ' (ревью тем же вендором)' : ''),
      });
    }
  for (const kind of ['plan', 'contract'] as const)
    checks.push({
      id: `review:${kind}`,
      status: 'passed',
      detail: (['codex', 'claude'] as const)
        .map((author) => {
          const chosen = technicalReviewer(config, kind, author);
          return `автор ${author} → ${chosen ? chosen.runtime + (chosen.sameVendor ? ' (тот же вендор)' : '') : 'отказ правила вендора'}`;
        })
        .join('; '),
    });
  // Независимое ревью, которое может только читать diff, слабее ревью,
  // которое может запустить проверки. Право даётся профилем инструментов, и
  // разойтись оно может незаметно: раньше codex-ревьюер получал shell по
  // умолчанию, а claude-ревьюер — нет. Doctor называет это прямо.
  for (const { repo, role, review, binding } of bindings.filter((b) => b.review)) {
    const profile = toolProfileFor(config, binding.runtime, role, review, repo.id);
    const runsChecks = reviewerRunsChecks(binding.runtime, profile);
    checks.push({
      id: `reviewer:${repo.id}:${role}`,
      status: runsChecks ? 'passed' : 'not-checked',
      detail: runsChecks
        ? `${binding.runtime} может выполнить проверки при ревью — в песочнице ОС без сети и без записи в проверяемый каталог`
        : `${binding.runtime} проверяет только чтением: профиль не даёт запускать команды. Ревью не обнаружит то, что видно лишь прогоном.`,
    });
  }
  // Исполнитель без shell пишет вслепую: не запускает ни тесты, ни проверку
  // типов и узнаёт о провале только от гейтов после попытки. На пилоте так
  // прошли все попытки сложной задачи — таймауты и круги находок ревью, хотя
  // каждую из них исполнитель поймал бы сам первым же прогоном теста.
  for (const { repo, role, binding } of bindings.filter((b) => !b.review)) {
    if (binding.runtime === 'demo') continue;
    const profile = toolProfileFor(config, binding.runtime, role, false, repo.id);
    // То же правило, что у адаптера: shell по умолчанию есть, явный отказ
    // профиля соблюдается. Раньше codex-исполнитель считался способным
    // запускать команды всегда, хотя codexShell: false выключал ему shell.
    const runsChecks = writerRunsChecks(binding.runtime, profile);
    const fix =
      binding.runtime === 'codex'
        ? 'уберите codexShell: false'
        : 'добавьте Bash в claudeTools или уберите claudeTools, чтобы действовал набор по умолчанию';
    checks.push({
      id: `writer:${repo.id}:${role}`,
      status: runsChecks ? 'passed' : 'not-checked',
      detail: runsChecks
        ? `${binding.runtime} может запускать тесты и проверки во время реализации — в песочнице ОС`
        : `${binding.runtime} пишет код вслепую: профиль инструментов явно не даёт shell, и тесты исполнитель не запустит. Если отказ не намеренный, ${fix} в профиле ${binding.toolProfile ?? binding.runtime}.`,
    });
  }
  const runtimes = new Set(bindings.map((b) => b.binding.runtime));
  for (const runtime of ['git', ...runtimes].filter((s) => s !== 'demo'))
    await check('cli:' + runtime, async () => {
      await executable(runtime);
      const r = await command([runtime, '--version'], config.repository, { timeoutMs: 10000 });
      if (r.code) throw new Error('CLI --version завершился с ошибкой');
      return r.stdout.trim().slice(0, 200);
    });
  // `--version` проходит и у неавторизованного CLI: он доказывает, что файл
  // на месте, а не что им можно работать. Отказ авторизации выяснялся только
  // на первой выданной задаче — прогоном, который тратил время и попытку.
  // Проверяется то самое окружение, которое получит исполнитель.
  if (probe)
    for (const runtime of [...runtimes].filter((s) => s !== 'demo'))
      await check('auth:' + runtime, async () => {
        const execution = agentEnvironment(config, toolProfileFor(config, runtime));
        const argv =
          runtime === 'claude'
            ? ['claude', '--print', '--setting-sources', '', 'ping']
            : ['codex', 'exec', '--sandbox', 'read-only', '-c', 'approval_policy="never"', 'ping'];
        const r = await command(argv, config.repository, { ...execution, timeoutMs: 120000 });
        const output = r.stdout + r.stderr;
        if (
          r.code ||
          /not logged in|please run \/login|invalid api key|credit balance/i.test(output)
        )
          throw new Error(
            `Runtime не авторизован в окружении прогона: ${output.trim().slice(-200) || 'код ' + r.code}`,
          );
        return 'Авторизован в том окружении, которое получит исполнитель';
      });
  // Область записи — пересечение роли и задачи. Роль без неё не ограничивает
  // ничего, и всё держится на том, что область указана у каждой задачи. Роль,
  // владеющая сквозными решениями, оказывается при этом самой широкой — это
  // стоит видеть, а не обнаруживать по принятому diff.
  // Инструкция, по которой написан код, — часть договора. Библиотека DevContour
  // живёт своей жизнью: её пакет обновляется, а копия в проекте остаётся. Молча
  // подменять нельзя, молчать о расхождении — тоже: проект узнал бы о нём на
  // ревью, когда код уже не отвечает правилам.
  // Проверки исполняются в песочнице ОС. Без её механизма они не запустятся —
  // об этом лучше узнать здесь, а не на первой задаче.
  await check('isolation', async () => {
    if (config.isolation.mode === 'none')
      return 'Изоляция проверок снята явно (isolation.mode: none): проверки идут процессом хоста';
    const support = isolationSupport();
    if (!support.ok) throw new Error(support.detail + '. Или явно задайте isolation.mode: none');
    return (
      'Проверки, исполнитель и ревьюер — в песочнице ОС' +
      (support.detail ? `; ${support.detail}` : '')
    );
  });
  if (config.preview)
    await check('preview', async () => {
      const docker = await command(['docker', 'info', '--format', '{{.ServerVersion}}'], root);
      if (docker.code !== 0)
        throw new Error(
          'Docker недоступен: preview не соберётся и не запустится. ' +
            docker.stderr.trim().slice(0, 200),
        );
      const compose = await command(['docker', 'compose', 'version', '--short'], root);
      if (compose.code !== 0) throw new Error('Нет docker compose: preview собирается через него');
      return `Docker ${docker.stdout.trim()}, compose ${compose.stdout.trim()}; URL http://127.0.0.1:${config.preview!.port}`;
    });
  await check('context-library', async () => {
    const stale = (
      await Promise.all(
        repositories(config).map((repo) =>
          outdatedContextPacks(
            repo.path,
            config.contextPacks.filter((pack) => pack.repositoryId === repo.id),
          ),
        ),
      )
    ).flat();
    if (!stale.length) return 'Пакеты контекста совпадают с библиотекой';
    return `Библиотека ушла вперёд: ${stale
      .map((p) => `${p.id} ${p.version} → ${p.library}`)
      .join('; ')}. Решите: остаться на своей версии или перейти — context-adopt --pack <id>`;
  });
  await check('write-scope', async () => {
    const open = bindings
      .filter((b) => !b.review && !roleBinding(config, b.role, b.repo.id)?.writePaths?.length)
      .map((b) => `${b.repo.id}:${b.role}`);
    if (open.length)
      return `Область записи задаётся только задачами у ролей: ${[...new Set(open)].join(', ')}`;
    return 'У каждой роли объявлена область записи';
  });
  await check('environment', async () => {
    executionEnvironment([config.environment]);
    return 'Обязательные переменные заданы; значения скрыты';
  });
  for (const { repo, role, review, binding } of bindings)
    await check(`tools:${repo.id}:${role}:${review ? 'review' : 'write'}`, async () => {
      const profile = toolProfileFor(config, binding.runtime, role, review, repo.id);
      agentEnvironment(config, profile);
      for (const server of Object.values(profile?.mcp ?? {}))
        if (server.command) await executable(server.command);
      return profile
        ? 'Профиль и переменные MCP доступны; соединение проверяет project preflight'
        : 'Штатный CLI без явно заданного профиля MCP';
    });
  for (const repo of repositories(config)) {
    await check('repository:' + repo.id, async () => {
      if (
        (await realpath(repo.path)) !==
        (await realpath(await git(repo.path, 'rev-parse', '--show-toplevel')))
      )
        throw new Error('Ожидается корень Git');
      await git(repo.path, 'rev-parse', '--verify', 'HEAD');
      await git(repo.path, 'check-ref-format', '--branch', repo.targetBranch);
      const common = resolve(repo.path, await git(repo.path, 'rev-parse', '--git-common-dir'));
      try {
        const owner = JSON.parse(await readFile(join(common, 'devcontour-owner.json'), 'utf8'));
        if (
          owner.owner !== (await realpath(root)) ||
          owner.repositoryId !== repo.id ||
          owner.targetBranch !== repo.targetBranch
        )
          throw new Error('Репозиторий принадлежит другому workspace');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (
        (await git(repo.path, 'worktree', 'list', '--porcelain'))
          .split('\n')
          .includes(`branch refs/heads/${repo.targetBranch}`)
      )
        throw new Error('Ветка интеграции открыта в worktree');
      executionEnvironment([config.environment, repo.environment]);
      for (const step of [
        ...repo.gates,
        ...(repo.prepare ?? []),
        ...(repo.dependencyBuild ?? []),
        ...(repo.preflight ?? []),
        ...(repo.lifecycle?.setup ?? []),
        ...(repo.lifecycle?.ready ?? []),
        ...(repo.lifecycle?.teardown ?? []),
      ])
        if (!step.command[0].includes('/') || isAbsolute(step.command[0]))
          await executable(step.command[0]);
      return 'Git, окружение и исполняемые команды доступны';
    });
    if (repo.forge)
      await check('forge:' + repo.id, async () => {
        await git(repo.path, 'check-ref-format', '--branch', repo.forge!.targetBranch);
        await git(repo.path, 'remote', 'get-url', repo.forge!.remote);
        const connection = config.forgeConnections[repo.forge!.connection];
        if (!connection) throw new Error('Не настроен forge connection');
        if (connection.tokenEnv && !process.env[connection.tokenEnv])
          throw new Error('Не задан read-only token: ' + connection.tokenEnv);
        if (probe) {
          const store = new Store(':memory:');
          try {
            await forgeAdapter(connection, new DevContour(store, config)).observe(
              repo,
              'devcontour-doctor-nonexistent',
              AbortSignal.timeout(30000),
            );
          } finally {
            store.close();
          }
        }
        return probe
          ? 'Read-only forge доступен; запись не выполнялась'
          : 'Конфигурация доступна; сеть не проверена';
      });
    if (probe && repo.preflight?.length)
      await check('probe:' + repo.id, async () => {
        const runId = randomUUID(),
          dir = join(root, 'doctor', runId),
          cwd = join(dir, repo.id);
        await mkdir(dir, { recursive: true });
        const sha = await git(repo.path, 'rev-parse', 'HEAD');
        await git(repo.path, 'worktree', 'add', '--detach', cwd, sha);
        try {
          await withResources(
            config,
            repo.gates.flatMap((g) => g.resources ?? []),
            `doctor:${runId}`,
            AbortSignal.timeout(config.runTimeoutMs),
            async (signal, resources) => {
              const execution = executionEnvironment([config.environment, repo.environment], {
                DEVCONTOUR_REPOSITORY_ID: repo.id,
                DEVCONTOUR_RUN_ID: runId,
                DEVCONTOUR_RESOURCES_JSON: JSON.stringify(resources),
              });
              await withEnvironment(
                repo.lifecycle,
                cwd,
                join(dir, 'environment'),
                execution,
                signal,
                () => runSteps(repo.preflight!, cwd, join(dir, 'preflight'), execution, signal),
              );
            },
          );
          return 'Project preflight прошёл в отдельном worktree';
        } finally {
          // Keep failed environments for explicit cleanup instead of deleting their scripts.
          let clean = true;
          try {
            clean =
              JSON.parse(await readFile(join(dir, 'environment', 'environment.json'), 'utf8'))
                .status === 'cleaned';
          } catch {
            /* no lifecycle */
          }
          if (clean) await git(repo.path, 'worktree', 'remove', '--force', cwd);
        }
      });
  }
  // Утверждённые контракты не отзываются задним числом: незащищённый helper
  // закреплённой приёмки — предупреждение, а не блокировка. Новая редакция
  // с ним отклоняется до ревью (review-contract, contract-change).
  checks.push(...(await contractClosureChecks(config, state?.contracts ?? [])));
  if (config.contextPacks.length)
    await check('context', async () => {
      for (const role of declaredRoles(config))
        await taskContext(config, {
          role,
          contextPacks: config.contextPacks.map((p) => p.id),
        } as Parameters<typeof taskContext>[1]);
      return 'Закреплённые инструкции доступны и совпадают с digest';
    });
  for (const dir of [
    join(root, 'artifacts'),
    join(root, 'workspace-checks'),
    join(root, 'doctor'),
    ...(config.storage === 'component'
      ? repositories(config).map((r) => join(r.path, '.devcontour-local/artifacts'))
      : []),
  ]) {
    let files: string[] = [];
    try {
      files = await readdir(dir, { recursive: true });
    } catch {
      /* no receipts */
    }
    for (const file of files.filter((p) => p.endsWith('environment.json')))
      await check(`cleanup:${dir}/${file}`, async () => {
        const receipt = JSON.parse(await readFile(join(dir, file), 'utf8'));
        if (receipt.status !== 'cleaned')
          throw new Error(
            'Есть незавершённое окружение; проверьте владельца и выполните environment-cleanup',
          );
        return 'Окружение очищено';
      });
  }
  checks.push({
    id: 'live-models',
    status: 'not-checked',
    detail:
      'Модели не вызываются. Авторизация и реальная работа инструментов подтверждаются отдельным пилотом.',
  });
  if (!probe || !repositories(config).every((r) => r.preflight?.length))
    checks.push({
      id: 'project-probes',
      status: 'not-checked',
      detail:
        'Настройте preflight команд установки/доступов/MCP и выполните doctor --probe. Отсутствующие проверки не считаются PASS.',
    });
  const result = {
    scope: probe ? 'configured-probes' : 'static',
    ready: !checks.some((c) => c.status === 'blocked'),
    checks,
  };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'doctor.json'), JSON.stringify(result, null, 2));
  return result;
}

/**
 * Локальные зависимости закреплённых артефактов действующих контрактов,
 * которые не закреплены и не защищены: правкой их исполнитель ослабил бы
 * приёмку без нового ревью. Проверяется ревизия закрепления; защита —
 * текущие protectedPaths компонента.
 */
export async function contractClosureChecks(
  config: Config,
  contracts: DevContourState['contracts'],
): Promise<Check[]> {
  const out: Check[] = [];
  let checked = 0;
  for (const c of contracts) {
    if (!c.artifacts?.length || supersededBy(contracts, c.id)) continue;
    const byRepo = new Map<string, typeof c.artifacts>();
    for (const a of c.artifacts)
      byRepo.set(a.repositoryId, [...(byRepo.get(a.repositoryId) ?? []), a]);
    for (const [repositoryId, artifacts] of byRepo) {
      let detail: string | undefined;
      try {
        const { unguarded } = await artifactGuard(
          repository(config, repositoryId),
          artifacts,
          c.underTest ?? [],
        );
        if (unguarded.length) detail = unguardedMessage(unguarded);
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e);
      }
      checked++;
      if (detail)
        out.push({
          id: `contract-closure:${c.id}:${repositoryId}`,
          status: 'not-checked',
          detail: `Контракт ${c.id} (${c.title}) утверждён, но закрепление неполно. ${detail}. Исправление — новая редакция через contract-change.`,
        });
    }
  }
  if (checked && !out.length)
    out.push({
      id: 'contract-closure',
      status: 'passed',
      detail: `Локальные зависимости закреплённых артефактов закреплены или защищены (${checked})`,
    });
  return out;
}
