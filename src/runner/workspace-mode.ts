import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const workspaceMode = z.enum(['embedded', 'separate']);
export type WorkspaceMode = z.infer<typeof workspaceMode>;
const selection = z.strictObject({ version: z.literal(1), mode: workspaceMode });
const marker = 'devcontour.workspace.json';

function read(path: string) {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error('Workspace selection не читает symlink');
  return selection.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function assertControllerCheckout(workspace: string) {
  let info: string[];
  try {
    info = execFileSync(
      'git',
      ['-C', workspace, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      },
    )
      .trim()
      .split('\n');
  } catch (error) {
    const failure = error as { status?: number; stderr?: string | Buffer };
    // Only an uninitialized project is allowed; broken Git or a timeout is not proof of it.
    if (
      failure.status === 128 &&
      /not a git repository \(or any (?:of the parent directories|parent up to mount point)/.test(
        String(failure.stderr),
      )
    )
      return;
    throw new Error('Не удалось проверить основной Git checkout workspace', { cause: error });
  }
  const [top, gitDir, common] = info;
  if (realpathSync(top) !== realpathSync(workspace))
    throw new Error('Выберите корень Git-репозитория, а не вложенный каталог workspace');
  if (realpathSync(resolve(workspace, gitDir)) !== realpathSync(resolve(workspace, common)))
    throw new Error(
      'Worktree исполнителя не может быть workspace/controller. Используйте основной checkout',
    );
}

/** Read a portable choice and its local pin without guessing from cwd or paths. */
export function selectedWorkspaceMode(workspace: string): WorkspaceMode | undefined {
  const portable = read(join(workspace, marker));
  const local = read(join(workspace, '.devcontour-local', 'workspace-selection.json'));
  if (local && (!portable || local.mode !== portable.mode))
    throw new Error(
      'Сохранённый режим workspace изменён. Требуется явная миграция; восстановите прежний выбор',
    );
  return portable?.mode ?? local?.mode;
}

export function chooseWorkspaceMode(workspace: string, requested?: WorkspaceMode): WorkspaceMode {
  if (requested !== undefined) workspaceMode.parse(requested);
  const saved = selectedWorkspaceMode(workspace);
  const configFile = join(workspace, '.devcontour-local', 'config.json');
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : undefined;
  const configured = config ? workspaceMode.parse(config.workspaceMode ?? 'separate') : undefined;
  if (saved && configured && saved !== configured)
    throw new Error('Режим конфигурации не соответствует сохранённому выбору workspace');
  const previous = saved ?? configured;
  if (previous && requested && previous !== requested)
    throw new Error(
      'Режим workspace уже выбран. Переключение требует миграции, данные не изменены',
    );
  const mode = previous ?? requested;
  if (!mode)
    throw new Error(
      'Выберите размещение: --workspace-mode embedded (в корне одного репозитория) или --workspace-mode separate (отдельный workspace для репозиториев). Укажите --workspace /absolute/path',
    );
  assertControllerCheckout(workspace);
  // Protect runtime state before the first database exists, including before git init/setup.
  const ignorePath = join(workspace, '.gitignore');
  const ignoreStat = lstatSync(ignorePath, { throwIfNoEntry: false });
  if (ignoreStat && !ignoreStat.isFile())
    throw new Error('Для локальной памяти нужен обычный файл .gitignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  // Keep the rule last so preceding project negations cannot include the runtime directory.
  if (
    !ignore.trimEnd().endsWith('\n/.devcontour-local/') &&
    ignore.trim() !== '/.devcontour-local/'
  )
    writeFileSync(
      ignorePath,
      (ignore && !ignore.endsWith('\n') ? '\n' : '') + '/.devcontour-local/\n',
      { flag: 'a' },
    );
  for (const path of [
    join(workspace, marker),
    join(workspace, '.devcontour-local', 'workspace-selection.json'),
  ]) {
    if (existsSync(path)) continue;
    const parent = dirname(path);
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error('Workspace selection не пишет через symlink');
    mkdirSync(parent, { recursive: true });
    try {
      writeFileSync(path, JSON.stringify({ version: 1, mode }, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || read(path)?.mode !== mode)
        throw error;
    }
  }
  return mode;
}

export function workspaceDescription(workspace: string) {
  const mode = selectedWorkspaceMode(workspace);
  return mode ? { mode, path: realpathSync(workspace) } : undefined;
}
