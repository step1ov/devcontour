import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCheck } from 'devcontour-harness';
import type { Config } from '../core/model.ts';
import { command } from './process.ts';

/**
 * Установка зависимостей в песочнице проверок на чистом дереве.
 *
 * Песочница проверок запрещает запись в часть путей всегда, даже внутри
 * разрешённого worktree, — например в каталоги IDE. Пакеты публикуют такие
 * каталоги (`.idea/`), и gate установки в чистом worktree падал при любом
 * коде; узнавали об этом только на первой задаче, сжигая её попытки. Проба
 * ставит `npm install` пакет-фикстуру с `.idea/` внутри в той же песочнице и
 * сверяет сам файл: npm отказ записи только предупреждает и выходит с 0.
 */
export interface InstallProbeResult {
  status: 'passed' | 'blocked' | 'not-checked';
  detail: string;
}

const marker = join(
  'node_modules',
  'devcontour-probe-dep',
  '.idea',
  'codeStyles',
  'codeStyleConfig.xml',
);

function npmPath() {
  for (const dir of [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]) {
    const candidate = join(dir, 'npm');
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function installProbe(
  config: Pick<Config, 'isolation'>,
  /** Каталог workspace: проба создаёт и убирает свой подкаталог `doctor/<uuid>`. */
  root: string,
  run: typeof runCheck = runCheck,
): Promise<InstallProbeResult> {
  if (config.isolation.mode === 'none')
    return {
      status: 'not-checked',
      detail: 'Изоляция проверок снята (isolation.mode: none): установка идёт процессом хоста',
    };
  const npm = npmPath();
  if (!npm)
    return {
      status: 'not-checked',
      detail: 'npm не найден: установку в песочнице проверить нечем',
    };
  const dir = join(root, 'doctor', 'install-' + randomUUID());
  await mkdir(dir, { recursive: true });
  try {
    const base = await realpath(dir);
    const pkg = join(base, 'src', 'package');
    await mkdir(join(pkg, '.idea', 'codeStyles'), { recursive: true });
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'devcontour-probe-dep', version: '1.0.0' }),
    );
    await writeFile(join(pkg, '.idea', 'codeStyles', 'codeStyleConfig.xml'), '<probe/>');
    const app = join(base, 'app');
    const cache = join(base, 'cache');
    await mkdir(app);
    await mkdir(cache);
    const packed = await command(
      ['tar', 'czf', join(app, 'dep.tgz'), 'package'],
      join(base, 'src'),
      {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
        timeoutMs: 30000,
      },
    );
    if (packed.code) throw new Error('tar не собрал пакет-фикстуру: ' + packed.stderr.trim());
    await writeFile(
      join(app, 'package.json'),
      JSON.stringify({
        name: 'devcontour-probe-app',
        version: '1.0.0',
        private: true,
        dependencies: { 'devcontour-probe-dep': 'file:dep.tgz' },
      }),
    );
    await writeFile(join(base, 'npmrc'), '');
    const result = await run(
      { config: { isolation: config.isolation } },
      {
        argv: [npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
        cwd: app,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          // Кэш вне дерева — как хранилище пакетного менеджера; пользовательский
          // .npmrc закрыт песочницей вместе с учётными данными.
          npm_config_cache: cache,
          npm_config_userconfig: join(base, 'npmrc'),
          npm_config_update_notifier: 'false',
        },
        timeoutMs: 120000,
        signal: AbortSignal.timeout(150000),
        write: [app, cache],
        readable: [],
        controller: [],
        settingsDir: join(base, 'settings'),
      },
    );
    const output = result.stdout + '\n' + result.stderr;
    const installed = await readFile(join(app, marker), 'utf8').catch(() => undefined);
    if (result.code === 0 && installed === '<probe/>')
      return {
        status: 'passed',
        detail:
          'npm install в песочнице проверок ставит зависимость с каталогом .idea целиком: gate установки не упрётся в запреты песочницы',
      };
    const denied = output
      .split('\n')
      .filter((line) => /EPERM|operation not permitted|permission denied/i.test(line))
      .slice(0, 2)
      .map((line) => line.trim().replace(base + '/', ''));
    return {
      status: 'blocked',
      detail:
        `Установка зависимости с каталогом .idea в песочнице проверок не прошла (код ${result.code}` +
        `${result.code === 0 ? ', но файла ' + marker + ' нет' : ''}): ` +
        (denied.length ? denied.join('; ') : output.trim().slice(-300)) +
        '. Gates установки в чистом worktree упадут при любом коде: обновите DevContour (harness с открытыми каталогами IDE в node_modules) или задайте isolation.mode: none',
    };
  } finally {
    // Убирается только собственный каталог пробы с уникальным именем.
    await rm(dir, { recursive: true, force: true });
  }
}
