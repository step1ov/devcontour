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
// Длинное описание ChangeSet и попытка ревью с находками сверх первой
// страницы: их панель раскрывает по запросу.
store.change('fixture.panel-details', (s) => {
  s.changeSets[0].description =
    'Обезличенное длинное описание. ' + 'Текст описания изменения. '.repeat(120) + 'КОНЕЦ-ОПИСАНИЯ';
  // 25 проверок одного ChangeSet: история листается страницами.
  const verification = s.changeSets[0].verifications.at(-1)!;
  for (let k = 0; k < 22; k++)
    s.changeSets[0].verifications.push({
      ...structuredClone(verification),
      id: `V-history-${String(k).padStart(2, '0')}`,
      startedAt: new Date(Date.parse(verification.startedAt) + (k + 1) * 60000).toISOString(),
    });
  // Последняя доска пережила 24 корректировки: первая ревизия — с задачами,
  // текущая — пустая. Ранние ревизии и их задачи — по запросу.
  const history = s.boards.at(-1)!;
  const original = history.revisions.at(-1)!;
  history.title = 'Доска с длинной историей';
  for (let k = 0; k < 24; k++)
    history.revisions.push({
      ...structuredClone(original),
      number: original.number + k + 1,
      status: 'active',
      reason: `Корректировка стенда ${k + 1}`,
      taskIds: [],
      snapshot: undefined,
    });
  for (const r of history.revisions.slice(0, -1)) r.status = 'accepted';
  s.contractAttempts = [
    {
      id: 'CA-fixture',
      at: '2026-01-01T00:00:00.000Z',
      subject: 'contract',
      attempt: 1,
      title: 'Обезличенный контракт',
      approved: false,
      summary: 'Ревью с множеством находок.',
      findings: Array.from({ length: 30 }, (_, k) => ({
        severity: 'major',
        message: `Находка стенда ${k + 1}`,
      })),
      artifact: 'review.json',
      authorRuntime: 'codex',
      reviewerRuntime: 'claude',
    },
  ];
});
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
