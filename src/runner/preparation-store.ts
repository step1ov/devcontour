import { selectedWorkspaceMode, assertControllerCheckout } from './workspace-mode.ts';
import { existsSync } from 'node:fs';
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
  const config = existsSync(path) ? loadConfig(path) : undefined;
  const store = new Store(
    join(root, 'state.sqlite'),
    config?.storage === 'component' ? repositories(config) : undefined,
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
