import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { largeHistory } from '../../tests/large-history.ts';
import { Store } from '../../src/core/store.ts';
import { DevContour } from '../../src/core/service.ts';
import { Scheduler } from '../../src/runner/scheduler.ts';
import { loadConfig } from '../../src/runner/config.ts';
import { serve } from '../../src/server/http.ts';

// Обезличенная большая история для e2e панели: учебное демо, размноженное.
const port = Number(process.argv[2] ?? 4397);
const root = mkdtempSync(join(tmpdir(), 'devcontour-large-'));
const data = join(root, 'data');
await largeHistory(data, {
  copies: 8,
  failedAttempts: 4,
  events: 2000,
  changeSets: 10,
  verifications: 3,
});
const store = new Store(join(data, 'state.sqlite'));
const h = new DevContour(store, loadConfig(join(data, 'config.json')));
const scheduler = new Scheduler(h, data);
await scheduler.init();
const app = await serve(h, scheduler, { port });
// Задача с пятью попытками на незакрытой доске: она видна в навигации сразу.
const state = store.read();
const open = new Set(
  state.boards
    .filter((b) => b.revisions.at(-1)!.status === 'active')
    .flatMap((b) => b.revisions.at(-1)!.taskIds),
);
const busy = state.tasks.find(
  (t) => open.has(t.id) && state.runs.filter((r) => r.taskId === t.id).length >= 5,
)!;
console.log(`READY ${app.url} ${busy.id}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => scheduler.stop())
      .then(() => store.close())
      .finally(() => {
        rmSync(root, { recursive: true, force: true });
        process.exit(0);
      });
  });
