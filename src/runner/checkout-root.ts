import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  HarnessError,
  checkoutPath,
  chooseCheckoutRoot,
  type CheckoutRoot,
} from 'devcontour-harness';
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
export function checkoutRootFor(
  config: Config,
  dataRoot: string,
  /** `false` — диагностика: каталоги кэша не создаются, только проверяются. */
  create = true,
): CheckoutRoot {
  const repos = repositories(config);
  try {
    return chooseCheckoutRoot({
      stateDirs: [resolve(dataRoot), ...repos.map((r) => join(r.path, '.devcontour-local'))],
      repositories: repos.map((r) => r.path),
      hidden: credentialPaths(),
      ...(config.checkoutRoot ? { configured: config.checkoutRoot } : {}),
      create,
    });
  } catch (error) {
    // Отказ harness (корень внутри репозитория, каталога состояния или
    // закрытого пути; ссылка; чужой владелец) — ошибка настройки, которую
    // оператор исправляет в config.json, а не сбой процесса.
    if (error instanceof HarnessError && error.code === 'INVALID_INPUT')
      throw new CheckoutRootError(error.message);
    throw error;
  }
}

/** Недопустимый `checkoutRoot` конфигурации: сообщение называет исправление. */
export class CheckoutRootError extends Error {
  constructor(reason: string) {
    super(
      `Недопустимый checkoutRoot в config.json: ${reason}. Задайте абсолютный путь вне репозиториев и каталога контура или уберите checkoutRoot (тогда — кэш пользователя).`,
    );
    this.name = 'CheckoutRootError';
  }
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
 * Каталоги, в которых может лежать окружение попытки (`environment-cleanup`):
 * каталог данных workspace, каталоги состояния компонентов и корень рабочих
 * деревьев — у новых попыток рабочий каталог окружения под ним.
 */
export function environmentRoots(h: DevContour, dataRoot: string) {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return [
    ...new Set([
      real(dataRoot),
      ...repositories(h.config).map((r) => real(join(r.path, '.devcontour-local'))),
      ...checkoutRoots(h).map(real),
    ]),
  ];
}
