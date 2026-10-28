import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { checkoutPath, chooseCheckoutRoot, type CheckoutRoot } from 'devcontour-harness';
import type { Config } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { repositories } from '../core/repositories.ts';
import { credentialPaths } from './isolation.ts';

/**
 * Один корень рабочих деревьев на workspace.
 *
 * Рабочие деревья попыток, снимки зависимостей, проверки на SHA (доска,
 * база), деревья переноса базы, эксперименты, подтверждение случаев,
 * компоненты совместной проверки и рабочие копии ревью плана создаются под
 * этим корнем, а не в каталоге состояния. Каталог состояния контура закрыт
 * песочнице целиком; если он лежит внутри репозитория (embedded), checkout
 * оказывался вложен в закрытое дерево, и инструменты, которые ищут
 * конфигурацию вверх по дереву, получали EPERM вместо ENOENT.
 *
 * Каталоги состояния контура — каталог данных workspace и
 * `<компонент>/.devcontour-local` каждого компонента: там проверки досок
 * компонента и попытки компонентного хранения. Второй всегда внутри
 * репозитория, поэтому выбор harness (`chooseCheckoutRoot`) даёт кэш
 * пользователя вне дерева (`cache`), заданный в `checkoutRoot` конфигурации
 * корень (`configured`) или — если кэш на другом томе, чем репозиторий, —
 * прежнее место (`cross-volume`, причина в `note`). Корень один для всех
 * вызовов: хэш берётся по каталогу данных workspace, и планировщик, проверки
 * доски и базы, перенос базы и совместная проверка видят одно и то же место.
 */
export function checkoutRootFor(config: Config, dataRoot: string): CheckoutRoot {
  const repos = repositories(config);
  return chooseCheckoutRoot({
    stateDirs: [resolve(dataRoot), ...repos.map((r) => join(r.path, '.devcontour-local'))],
    repositories: repos.map((r) => r.path),
    hidden: credentialPaths(),
    ...(config.checkoutRoot ? { configured: config.checkoutRoot } : {}),
  });
}

/** Каталог данных workspace: каталог его базы (`<data>/state.sqlite`). */
function dataRootOf(h: DevContour) {
  const file = h.store.file;
  return file && file !== ':memory:'
    ? dirname(resolve(file))
    : join(h.config.workspaceRoot ?? h.config.repository, '.devcontour-local');
}

// Выбор фиксируется на контур и его конфигурацию: каталог кэша, появившийся
// после первого вызова, не меняет корень посреди работы.
const chosen = new WeakMap<DevContour, { config: Config; choice: CheckoutRoot }>();
export function workspaceCheckoutRoot(h: DevContour): CheckoutRoot {
  const known = chosen.get(h);
  if (known?.config === h.config) return known.choice;
  const choice = checkoutRootFor(h.config, dataRootOf(h));
  chosen.set(h, { config: h.config, choice });
  return choice;
}

/** `checkoutRoot` для опций harness: без корня вне дерева — ничего (прежнее место). */
export function checkoutRootOption(choice: CheckoutRoot): { checkoutRoot?: string } {
  return choice.root ? { checkoutRoot: choice.root } : {};
}

/** Корни для `checkouts` границы песочницы: пусто, если корня вне дерева нет. */
export function checkoutRoots(h: DevContour): string[] {
  const root = workspaceCheckoutRoot(h).root;
  return root ? [root] : [];
}

/**
 * Каталог рабочего дерева вида `kind` под корнем workspace
 * (`<root>/<repositoryId>/<kind>/<id>`); без корня вне дерева — `legacy`.
 */
export function workspaceCheckout(
  h: DevContour,
  legacy: string,
  repositoryId: string,
  kind: string,
  id: string,
) {
  return checkoutPath(workspaceCheckoutRoot(h), legacy, repositoryId, kind, id);
}

/**
 * Что под корнем закрыть песочнице, оставив открытыми `open` и их предков:
 * чужие попытки закрыты, свой checkout виден целиком вверх по дереву.
 * Корень, не содержащий открытых путей, закрыт целиком. Элемент, появившийся
 * после построения границы (параллельная попытка), не закрыт — та же граница
 * подхода, что у поэлементных запретов harness.
 */
export function closedWorkspaceCheckouts(h: DevContour, open: string[]) {
  const root = workspaceCheckoutRoot(h).root;
  if (!root) return [];
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const opened = open.map(real);
  const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);
  const expand = (dir: string): string[] => {
    if (opened.some((p) => within(dir, p))) return [];
    if (!opened.some((p) => within(p, dir))) return [dir];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.flatMap((name) => expand(join(dir, name)));
  };
  return expand(real(root));
}
