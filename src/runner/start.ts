import { chooseWorkspaceMode, type WorkspaceMode } from './workspace-mode.ts';
import { preparationStore } from './preparation-store.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync as canonicalPath } from 'node:fs';
import { Store } from '../core/store.ts';
import { DevContour } from '../core/service.ts';
import { Preparation, assertAnyDevelopmentReady } from '../core/preparation.ts';
import { DomainError } from '../core/model.ts';
import { repositories } from '../core/repositories.ts';
import { loadConfig } from './config.ts';
import { Scheduler } from './scheduler.ts';
import { serve } from '../server/http.ts';

export { preparationStore, requirePreparation } from './preparation-store.ts';

function developmentReadyAny(store: Store) {
  const state = store.read();
  if (!state.preparation) return false;
  try {
    assertAnyDevelopmentReady(state);
    return true;
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}

export async function startWorkspace(
  workspace: string,
  options: { port: number; dev?: boolean; workspaceMode?: WorkspaceMode; instance?: string },
) {
  mkdirSync(workspace, { recursive: true });
  const canonical = canonicalPath(workspace),
    root = join(canonical, '.devcontour-local');
  const configPath = join(root, 'config.json');
  if (existsSync(configPath) && loadConfig(configPath).workspaceRoot !== canonical)
    throw new Error('Конфигурация относится к другому workspace');
  chooseWorkspaceMode(canonical, options.workspaceMode);
  const store = preparationStore(root);
  try {
    new Preparation(store).enable();
    const app = await serve(undefined, undefined, {
      ...options,
      dataRoot: root,
      bootstrap: {
        store,
        workspace: canonical,
        connect: async () => {
          // Техника подключается по применённой конфигурации. Готовность
          // проверяется у любого изменения, а не у активного: новое изменение
          // в проработке не отключает работу над уже утверждённым.
          if (!existsSync(join(root, 'config.json')) || !developmentReadyAny(store)) return;
          const config = loadConfig(join(root, 'config.json'));
          if (config.workspaceRoot !== canonical)
            throw new Error('Конфигурация относится к другому workspace');
          const runtimeStore = new Store(
            join(root, 'state.sqlite'),
            config.storage === 'component' ? repositories(config) : undefined,
          );
          try {
            const h = new DevContour(runtimeStore, config),
              scheduler = new Scheduler(h, root);
            await scheduler.init();
            return { h, scheduler };
          } catch (error) {
            runtimeStore.close();
            throw error;
          }
        },
      },
    });
    return {
      ...app,
      close: async () => {
        await app.close();
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
