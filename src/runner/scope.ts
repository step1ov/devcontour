import { isAbsolute, join, resolve, sep, dirname, basename } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

import { fileURLToPath } from 'node:url';

/**
 * Как вызвать CLI в справке и подсказках. Из исходников (модуль `.ts`) —
 * npm script checkout; из установленного пакета (собранный `lib/*.js`) —
 * бинарник `devcontour`, без глобальной установки — `npx devcontour`.
 */
export function launcher(moduleUrl: string = import.meta.url) {
  return moduleUrl.endsWith('.ts') ? 'npm run devcontour --' : 'devcontour';
}
export function launchHint(moduleUrl: string = import.meta.url) {
  return launcher(moduleUrl) === 'devcontour'
    ? 'devcontour <команда> [параметры] (в каталоге установки: npx devcontour <команда> [параметры])'
    : 'npm run devcontour -- <команда> [параметры]';
}

// Scope is passed per invocation. There is no shared "current workspace" setting.
export function commandScope(args: string[], operation: string) {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (args.lastIndexOf(flag) !== index) throw new Error(`Укажите ${flag} только один раз`);
    const result = args[index + 1];
    if (!result?.trim() || result.startsWith('--')) throw new Error(`Укажите значение ${flag}`);
    return result;
  };
  const workspace = value('--workspace'),
    data = value('--data');
  if (workspace && data) throw new Error('Используйте --workspace или --data, не оба одновременно');
  if (workspace && !isAbsolute(workspace)) throw new Error('--workspace требует абсолютный путь');
  const toolRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const canonical = (path: string): string =>
    existsSync(path) ? realpathSync(path) : join(canonical(dirname(path)), basename(path));
  if (
    workspace &&
    (canonical(resolve(workspace)) === toolRoot ||
      canonical(resolve(workspace)).startsWith(toolRoot + sep))
  )
    throw new Error('Workspace должен находиться вне каталога devcontour');
  if (operation === 'demo' && workspace)
    throw new Error('Demo использует отдельные данные; не указывайте продуктовый --workspace');
  if (operation !== 'demo' && operation !== 'workspace-init' && !workspace && !data)
    throw new Error(
      'В какой папке вести workspace этого проекта? Укажите --workspace /absolute/path (или --data для существующей конфигурации). Demo запускается явно: ' +
        launcher() +
        ' demo.',
    );
  return {
    workspace: workspace ? resolve(workspace) : undefined,
    data: workspace
      ? join(resolve(workspace), '.devcontour-local')
      : resolve(data ?? '.devcontour-local/demo'),
  };
}
