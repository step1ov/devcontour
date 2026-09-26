import { selectedWorkspaceMode, assertControllerCheckout } from './workspace-mode.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Store } from '../core/store.ts';
import { developmentBinding } from '../core/preparation.ts';
import { repositories } from '../core/repositories.ts';
import { loadConfig } from './config.ts';
import { attachProductProjection } from './journal.ts';

export function preparationStore(root: string) {
  const workspace = dirname(root);
  if (selectedWorkspaceMode(workspace)) assertControllerCheckout(workspace);
  const path = join(root, 'config.json');
  // Хранилищу подготовки из конфигурации нужен только способ хранения. Полная
  // загрузка сверяет закреплённый профиль, и поднятая версия профиля делала
  // недоступной саму команду, которая его обновляет: workspace-init падал с
  // «Профиль изменился после установки», не дойдя до обновления.
  const storage = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { storage?: string }).storage
    : undefined;
  const config = storage === 'component' ? loadConfig(path) : undefined;
  const store = new Store(
    join(root, 'state.sqlite'),
    config ? repositories(config) : undefined,
    false,
    'DELETE',
  );
  // Every process that opens the preparation store projects the brief: the CLI
  // writes revisions just as often as the panel does.
  try {
    attachProductProjection(store, workspace);
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}
export function requirePreparation(root: string) {
  if (!existsSync(join(root, 'state.sqlite')))
    throw new Error(
      'Сначала запустите start --workspace и согласуйте продукт, архитектуру и стек в панели',
    );
  const store = preparationStore(root);
  try {
    if (!store.read().preparation)
      throw new Error('Сначала включите продуктовый процесс командой start --workspace');
    return developmentBinding(store.read());
  } finally {
    store.close();
  }
}
