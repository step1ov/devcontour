import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, fixture, input, removeTestCheckoutRoot, testCheckoutRoot } from './helpers.ts';
import { taskProgress } from '../src/application/context.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { loadConfig } from '../src/runner/config.ts';
import { budgetOverview } from '../src/harness/budget.ts';
import {
  parseOperationalKeys,
  requestConfigApply,
  serveReconfigure,
} from '../src/runner/reconfigure.ts';

/** Работающий сервер: конфигурация из файла, роль controller и применённая политика. */
function served() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-apply-'));
  const checkouts = testCheckoutRoot();
  const path = join(root, 'config.json');
  const repository = mkdtempSync(join(root, 'repo-'));
  writeFileSync(
    path,
    JSON.stringify(config({ checkoutRoot: checkouts, repository }), null, 2) + '\n',
  );
  const server = new DevContour(new Store(join(root, 'state.sqlite')), loadConfig(path));
  assert.ok(server.leader('server'));
  server.recordConfig('server');
  const edit = (change: (raw: Record<string, unknown>) => void) => {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    change(raw);
    writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  };
  // Сервер тикает, как настоящий, пока команда ждёт итога.
  const request = async (keys = parseOperationalKeys(), waitMs = 5000) => {
    let done = false;
    const pending = requestConfigApply(root, keys, { waitMs });
    // Отказ до запроса приходит сразу: обработчик держит его до возврата.
    pending.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) {
      server.leader('server');
      serveReconfigure(server, path, 'server');
      await new Promise((r) => setTimeout(r, 50));
    }
    return pending;
  };
  const events = (type: string) => server.store.events().filter((e) => e.type === type);
  return {
    root,
    path,
    server,
    edit,
    request,
    events,
    cleanup: () => {
      server.store.close();
      rmSync(root, { recursive: true, force: true });
      removeTestCheckoutRoot(checkouts);
    },
  };
}

const price = {
  runtime: 'codex',
  model: 'EXAMPLE_MODEL',
  effectiveAt: '2026-01-01T00:00:00Z',
  input: 1,
  output: 4,
  cacheRead: 0.1,
  cacheWrite: 1,
};

test('A running server applies budgets and prices from config.json on request and records the event', async () => {
  const s = served();
  try {
    s.edit((raw) => {
      raw.budgets = { task: { usd: 25 }, onUnknown: 'continue' };
      raw.prices = [price];
    });
    const result = await s.request();
    assert.equal(result.status, 'applied', JSON.stringify(result));
    assert.deepEqual(s.server.config.budgets, { task: { usd: 25 }, onUnknown: 'continue' });
    assert.equal(s.server.config.prices.length, 1);
    // Движок процесса пересобран с новыми пределами: их видит обзор бюджетов.
    assert.equal(budgetOverview(s.server)?.onUnknown, 'continue');
    const [event] = s.events('config.applied');
    assert.deepEqual((event.data as { changed: string[] }).changed, ['budgets', 'prices']);
    // Применение — новое поколение политики процесса; запрос снят, выдача не держится.
    assert.equal(s.server.store.read().reconfigure, undefined);
    assert.equal(s.server.configStale(), false);
    assert.equal(s.server.store.view().appliedConfig?.digest, s.server.configDigest);
    // Повтор с тем же файлом — уже применено.
    assert.equal((await s.request()).status, 'unchanged');
  } finally {
    s.cleanup();
  }
});

test('An invalid config.json is refused before any request and the server keeps its values', async () => {
  const s = served();
  try {
    s.edit((raw) => (raw.budgets = { task: {}, onUnknown: 'stop' }));
    await assert.rejects(
      s.request(),
      /config\.json не прошёл проверку, применённые значения не изменились: budgets\.task/,
    );
    assert.equal(s.server.config.budgets, undefined);
    assert.equal(s.server.store.read().reconfigure, undefined);
  } finally {
    s.cleanup();
  }
});

test('An edit of other keys next to budgets is refused by the server; the old values stay', async () => {
  const s = served();
  try {
    s.edit((raw) => {
      raw.budgets = { task: { usd: 5 } };
      raw.concurrency = 3;
    });
    const result = await s.request();
    assert.equal(result.status, 'refused');
    assert.match(
      (result as { error: string }).error,
      /отличается от действующей конфигурации не только budgets, prices/,
    );
    assert.equal(s.server.config.budgets, undefined);
    assert.equal(s.server.config.concurrency, 2);
    assert.equal(s.events('config.apply-refused').length, 1);
    // Отказ снимает запрос: выдачу он не держит.
    assert.equal(s.server.store.read().reconfigure, undefined);
    // Ключ, не названный в --keys, — тоже другая конфигурация.
    s.edit((raw) => {
      raw.concurrency = 2;
      raw.prices = [price];
    });
    const onlyBudgets = await s.request(['budgets']);
    assert.equal(onlyBudgets.status, 'refused');
    assert.deepEqual(s.server.config.prices, []);
  } finally {
    s.cleanup();
  }
});

test('config-apply waits for work under the previous configuration; without a server it writes no request', async () => {
  const s = served();
  try {
    s.server.pause(false);
    const board = s.server.createBoard('Board');
    s.server.addTask(board.id, input('Work'));
    s.server.approve(board.id);
    const run = s.server.claim('server');
    assert.ok(run);
    s.edit((raw) => (raw.budgets = { workspace: { usd: 100 } }));
    const pending = await s.request(undefined, 300);
    assert.equal(pending.status, 'pending', JSON.stringify(pending));
    assert.deepEqual((pending as { waitingFor: string[] }).waitingFor, [run.id]);
    assert.equal(s.server.config.budgets, undefined);
    // Пока запрос не применён, он держит выдачу.
    assert.ok(s.server.store.read().reconfigure);
    // Попытка закончилась (срок владения истёк) — сервер применяет запрос сам.
    s.server.store.change('test.lease-expired', (st) => {
      st.runs.find((r) => r.id === run.id)!.leaseUntil = 0;
    });
    s.server.leader('server');
    serveReconfigure(s.server, s.path, 'server');
    assert.deepEqual(s.server.config.budgets, { workspace: { usd: 100 }, onUnknown: 'stop' });
    assert.equal(s.events('config.applied').length, 1);
    assert.equal(s.server.store.read().reconfigure, undefined);
    // Роли controller нет: запрос не пишется, файл применит запуск serve.
    s.server.store.change('test.leader-gone', (st) => {
      st.leader = undefined;
    });
    s.edit((raw) => (raw.budgets = { workspace: { usd: 50 } }));
    const deferred = await requestConfigApply(s.root, ['budgets'], { waitMs: 0 });
    assert.equal(deferred.status, 'deferred', JSON.stringify(deferred));
    assert.equal(s.server.store.read().reconfigure, undefined);
  } finally {
    s.cleanup();
  }
});

test('--keys accepts only budgets and prices', () => {
  assert.deepEqual(parseOperationalKeys(), ['budgets', 'prices']);
  assert.deepEqual(parseOperationalKeys('prices,budgets'), ['budgets', 'prices']);
  assert.throws(
    () => parseOperationalKeys('budgets,concurrency'),
    /не поддерживается: concurrency/,
  );
  assert.throws(() => parseOperationalKeys(''), /только budgets, prices/);
});

test('Task progress names the budget block with its reason; a cancelled task does not', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board');
    const task = f.h.addTask(board.id, input('Work'));
    f.h.approve(board.id);
    const progress = () => {
      const s = f.store.read();
      return taskProgress(
        f.h,
        s,
        s.tasks.find((t) => t.id === task.id)!,
        Date.now(),
      );
    };
    assert.ok(!progress().reasons.includes('budget_blocked'));
    assert.equal(progress().budgetBlock, undefined);
    f.store.change('test.budget-block', (s) => {
      s.tasks.find((t) => t.id === task.id)!.budgetBlock = {
        reason: 'Бюджет задачи исчерпан: 25.4 из 25 USD',
        at: '2026-11-01T00:00:00.000Z',
      };
    });
    assert.ok(progress().reasons.includes('budget_blocked'));
    assert.equal(progress().budgetBlock?.reason, 'Бюджет задачи исчерпан: 25.4 из 25 USD');
    assert.match(progress().budgetBlock!.hint, /config-apply --keys budgets/);
    f.store.change('test.cancelled', (s) => {
      s.tasks.find((t) => t.id === task.id)!.status = 'cancelled';
    });
    assert.ok(!progress().reasons.includes('budget_blocked'));
    assert.equal(progress().budgetBlock, undefined);
  } finally {
    f.cleanup();
  }
});
