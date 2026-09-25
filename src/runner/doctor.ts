import { access, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config, Role } from '../core/model.ts';
import { repositories, roleBinding, reviewerBinding, declaredRoles } from '../core/repositories.ts';
import { validateWorkflow } from '../core/workflow.ts';
import { command, git } from './process.ts';
import { outdatedContextPacks } from './context-library.ts';
import { executionEnvironment, runSteps, withEnvironment } from './environment.ts';
import { withResources } from './resources.ts';
import { agentEnvironment, toolProfileFor } from './tools.ts';
import { taskContext } from './context.ts';
import { forgeAdapter } from './forge.ts';
import { DevContour } from '../core/service.ts';
import { Store } from '../core/store.ts';
import { z } from 'zod';

type Check = { id: string; status: 'passed' | 'blocked' | 'not-checked'; detail: string };
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
export async function doctor(config: Config, root: string, probe = false) {
  const checks: Check[] = [];
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
  // Независимое ревью, которое может только читать diff, слабее ревью,
  // которое может запустить проверки. Право даётся профилем инструментов, и
  // разойтись оно может незаметно: раньше codex-ревьюер получал shell по
  // умолчанию, а claude-ревьюер — нет. Doctor называет это прямо.
  for (const { repo, role, review, binding } of bindings.filter((b) => b.review)) {
    const profile = toolProfileFor(config, binding.runtime, role, review, repo.id);
    const runsChecks =
      binding.runtime === 'codex' ? profile?.codexShell : !!profile?.claudeTools?.includes('Bash');
    checks.push({
      id: `reviewer:${repo.id}:${role}`,
      status: runsChecks ? 'passed' : 'not-checked',
      detail: runsChecks
        ? `${binding.runtime} может выполнить проверки при ревью — в песочнице ОС без сети и без записи в проверяемый каталог`
        : `${binding.runtime} проверяет только чтением: профиль не даёт запускать команды. Ревью не обнаружит то, что видно лишь прогоном.`,
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
