import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setupDemo } from '../../src/demo.ts';
import { loadConfig } from '../../src/runner/config.ts';
import { DevContour } from '../../src/core/service.ts';
import { Store } from '../../src/core/store.ts';
import { Scheduler } from '../../src/runner/scheduler.ts';
import { serve } from '../../src/server/http.ts';

const gitKeys = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/**
 * Свой учебный сервер в процессе спецификации: сценарии, которые запускают
 * очередь или требуют другого режима согласования, не меняют общий
 * демо-проект других спецификаций. Исполнители — учебный runtime `demo`
 * (fixture, не модель). `close` удаляет только свой временный каталог.
 */
export async function ownDemo(name: string, options: { approvalMode?: 'agent' | 'operator' } = {}) {
  const saved: Partial<Record<(typeof gitKeys)[number], string>> = {};
  for (const k of gitKeys) saved[k] = process.env[k];
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'DevContour fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'DevContour fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  const prefix = `devcontour-e2e-${name}-`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const data = join(root, 'data');
  await setupDemo(data, { checkoutRoot: join(root, 'checkouts'), ...options });
  const store = new Store(join(data, 'state.sqlite'));
  const h = new DevContour(store, loadConfig(join(data, 'config.json')));
  const scheduler = new Scheduler(h, data);
  await scheduler.init();
  const app = await serve(h, scheduler, { port: 0 });
  return {
    url: app.url,
    async close() {
      await app.close();
      store.close();
      for (const k of gitKeys)
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      if (root.startsWith(realpathSync(tmpdir()) + sep) && root.includes(prefix))
        rmSync(root, { recursive: true, force: true });
    },
  };
}
