import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { largeHistory, type HistoryShape } from './large-history.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import {
  panelChangeSet,
  panelContract,
  panelEvents,
  panelRun,
  panelRuns,
  panelSummary,
  panelTask,
  panelTaskSearch,
  type PanelSummary,
} from '../src/application/panel.ts';

/**
 * Проекции панели на настоящей большой истории (учебное демо, размноженное):
 * периодическая сводка ограничена и не несёт тел истории, а детали приходят
 * по запросу страницами.
 */
async function history(shape: HistoryShape) {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-panel-'));
  await largeHistory(join(root, 'data'), shape);
  const store = new Store(join(root, 'data', 'state.sqlite'));
  const h = new DevContour(store, loadConfig(join(root, 'data', 'config.json')));
  return {
    root,
    store,
    h,
    summary: (query: Record<string, string> = {}) =>
      panelSummary(h, join(root, 'data'), query) as PanelSummary,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const small: HistoryShape = {
  copies: 4,
  failedAttempts: 4,
  events: 500,
  changeSets: 6,
  verifications: 3,
};

test('The polled summary is bounded, carries no history bodies and does not grow with finished attempts, checks and events', async () => {
  const a = await history(small);
  const b = await history({ ...small, failedAttempts: 12, events: 5000, verifications: 9 });
  try {
    const sa = a.summary();
    const sb = b.summary();
    // Другая история той же формы досок: больше отказавших попыток, проверок
    // ChangeSet и событий. Размер сводки от этого не зависит.
    assert.ok(b.store.read().runs.length > a.store.read().runs.length * 2);
    assert.ok(bytes(sb) < bytes(sa) * 1.1, `${bytes(sb)} vs ${bytes(sa)}`);
    const text = JSON.stringify(sb);
    // Тела истории — только в деталях.
    assert.equal(text.includes('step 39: fixture assertion output'), false, 'логи не в сводке');
    assert.equal(text.includes('Fixture finding'), false, 'findings не в сводке');
    for (const c of sb.changeSets)
      for (const v of c.verifications) {
        assert.deepEqual(v.tasks, []);
        assert.ok(v.taskCount > 0);
        for (const e of v.evidence) assert.equal(e.log, '');
      }
    for (const r of sb.runs) assert.equal('token' in r, false);
    // Попытки — только активные и последняя по каждой задаче сводки.
    const ids = new Set(sb.tasks.map((t) => t.id));
    assert.ok(sb.runs.every((r) => r.status === 'active' || ids.has(r.taskId)));
    assert.ok(
      sb.runs.length <= sb.tasks.length + sb.runs.filter((r) => r.status === 'active').length,
    );
    // Доски — компактными строками; списки задач — только у выбранной.
    assert.ok(sb.boards.every((x) => x.revisions.every((r) => r.taskIds.length === 0)));
    assert.ok(sb.board!.revisions.at(-1)!.taskIds.length > 0);
    assert.ok(sb.events.length <= 40);
  } finally {
    a.close();
    b.close();
  }
});

test('Doubling the boards grows the summary only by compact board and change set lines', async () => {
  const a = await history(small);
  const b = await history({ ...small, copies: small.copies * 2, changeSets: small.changeSets * 2 });
  try {
    const sa = a.summary();
    const sb = b.summary();
    const extraBoards = sb.boards.length - sa.boards.length;
    const extraChanges = sb.changeSets.length - sa.changeSets.length;
    const perBoard = bytes(sb.boards) / sb.boards.length;
    const perChange = bytes(sb.changeSets) / sb.changeSets.length;
    const growth = bytes(sb) - bytes(sa);
    assert.ok(perBoard < 1500, `строка доски ${perBoard}`);
    assert.ok(
      growth <= extraBoards * perBoard * 1.2 + extraChanges * perChange * 1.2 + 2000,
      `рост ${growth}`,
    );
    // Задачи сводки — выбранная доска и текущая работа, а не все задачи.
    assert.ok(sb.tasks.length < b.store.read().tasks.length / 2);
  } finally {
    a.close();
    b.close();
  }
});

test('An unchanged revision answers with the number only; lease renewals do not count as changes', async () => {
  const d = await history({ ...small, copies: 1 });
  try {
    const first = d.summary();
    const same = panelSummary(d.h, d.root, { revision: String(first.revision) });
    assert.deepEqual(same, { revision: first.revision, unchanged: true });
    assert.ok(bytes(same) < 1024);
    // Продление lease не меняет видимых данных.
    d.h.leader('panel-probe');
    assert.equal(d.store.revision(), first.revision);
    // Видимое изменение — новая ревизия и полный ответ.
    d.h.pause(false);
    const next = panelSummary(d.h, d.root, { revision: String(first.revision) }) as PanelSummary;
    assert.ok(next.revision > first.revision);
    assert.equal(next.paused, false);
  } finally {
    d.close();
  }
});

test('Details arrive on request: task with attempt pages, run with log tails, change set history, contract text, event pages, task search', async () => {
  const d = await history(small);
  try {
    const state = d.store.read();
    const busy = state.tasks.find((t) => state.runs.filter((r) => r.taskId === t.id).length >= 5)!;
    const detail = panelTask(d.h, busy.id, { limit: '2' });
    assert.equal(detail.task.id, busy.id);
    assert.equal(detail.runs.total, 5);
    assert.equal(detail.runs.items.length, 2);
    assert.equal(detail.runs.next, 2);
    // Новые сначала; страницы не пересекаются и покрывают всё.
    const rest = panelRuns(d.h, busy.id, { limit: '50', cursor: '2' });
    const all = [...detail.runs.items, ...rest.items].map((r) => r.attempt);
    assert.deepEqual(all, [5, 4, 3, 2, 1]);
    assert.equal(rest.next, null);
    assert.throws(() => panelRuns(d.h, busy.id, { limit: '51' }), /51|too_big|less than/i);
    const run = panelRun(d.h, detail.runs.items[1].id);
    assert.equal(run.token, '');
    for (const e of run.evidence) assert.ok(e.log.length <= 4001);
    // ChangeSet: последняя проверка в строке, прежние — страницей, снимок задач
    // только по явному запросу.
    const change = state.changeSets[0];
    const c = panelChangeSet(d.h, change.id, { limit: '2' });
    assert.equal(c.history.total, small.verifications);
    assert.equal(c.history.items.length, 2);
    assert.deepEqual(c.history.items[0].tasks, []);
    const withTasks = panelChangeSet(d.h, change.id, { tasks: '1' });
    assert.ok(withTasks.history.items[0].tasks.length > 0);
    assert.deepEqual(withTasks.history.items[1].tasks, []);
    assert.equal(panelContract(d.h, state.contracts[0].id).content, state.contracts[0].content);
    const events = panelEvents(d.h, { limit: '30' });
    assert.equal(events.items.length, 30);
    const older = panelEvents(d.h, { limit: '30', before: String(events.next) });
    assert.ok(older.items.every((e) => e.id < events.next!));
    const found = panelTaskSearch(d.h, { q: 'копия 2', limit: '5' });
    assert.ok(found.items.length > 0 && found.items.every((t) => t.title.includes('копия 2')));
    assert.throws(() => panelTask(d.h, 'T-missing', {}), /не найдена/);
  } finally {
    d.close();
  }
});
