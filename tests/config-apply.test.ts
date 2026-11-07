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
import { approvalPolicyDigest, policyFromConfig } from '../src/harness/policy.ts';
import { workspacePolicyDigest } from '../src/core/workspace.ts';
import { executionDigest } from 'devcontour-harness';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
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

test('--keys accepts only budgets, prices, stallSweep and inputPolicy', () => {
  // Без флага — прежний состав запроса: сервер без stallSweep и inputPolicy его понимает.
  assert.deepEqual(parseOperationalKeys(), ['budgets', 'prices']);
  assert.deepEqual(parseOperationalKeys('prices,budgets'), ['budgets', 'prices']);
  assert.deepEqual(parseOperationalKeys('stallSweep'), ['stallSweep']);
  assert.deepEqual(parseOperationalKeys('stallSweep,budgets'), ['budgets', 'stallSweep']);
  assert.deepEqual(parseOperationalKeys('inputPolicy'), ['inputPolicy']);
  assert.throws(
    () => parseOperationalKeys('budgets,concurrency'),
    /не поддерживается: concurrency/,
  );
  assert.throws(() => parseOperationalKeys(''), /только budgets, prices, stallSweep, inputPolicy/);
});

test('inputPolicy applies without restart: the attempt keeps its pinned threshold, the next claim pins the new one', async () => {
  const s = served();
  try {
    s.server.pause(false);
    const board = s.server.createBoard('Board');
    s.server.addTask(board.id, input('First'));
    s.server.addTask(board.id, input('Second'));
    s.server.approve(board.id);
    const before = approvalDigests(s.server);
    const first = s.server.claim('server');
    assert.ok(first);
    // Без поля — умолчание harness, закреплённое в попытке.
    assert.deepEqual(s.server.store.read().runs.find((r) => r.id === first.id)?.inputPolicy, {
      threshold: 7,
      criticalPaths: [],
    });
    s.edit((raw) => (raw.inputPolicy = { threshold: 4, criticalPaths: ['db/migrations'] }));
    // Запрос без --keys inputPolicy не отправляет: файл отличается не только budgets/prices.
    const implicit = await s.request(undefined, 300);
    assert.notEqual(implicit.status, 'applied', JSON.stringify(implicit));
    assert.equal(s.server.config.inputPolicy, undefined);
    s.server.store.change('test.clear', (st) => {
      st.reconfigure = undefined;
    });
    s.server.store.change('test.lease-expired', (st) => {
      st.runs.find((r) => r.id === first.id)!.leaseUntil = 0;
    });
    const applied = await s.request(['inputPolicy']);
    assert.equal(applied.status, 'applied', JSON.stringify(applied));
    assert.deepEqual(s.server.config.inputPolicy, {
      threshold: 4,
      criticalPaths: ['db/migrations'],
    });
    // Ни одно из оснований утверждения и исполнения не сдвинулось.
    assert.deepEqual(approvalDigests(s.server), before);
    const second = s.server.claim('server');
    assert.ok(second);
    const runs = s.server.store.read().runs;
    assert.deepEqual(runs.find((r) => r.id === second.id)?.inputPolicy, {
      threshold: 4,
      criticalPaths: ['db/migrations'],
    });
    assert.equal(runs.find((r) => r.id === first.id)?.inputPolicy?.threshold, 7);
  } finally {
    s.cleanup();
  }
});

test('inputPolicy bounds 1..11; absent leaves the policy and config digest as before', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-input-policy-'));
  try {
    const path = join(root, 'config.json');
    const write = (extra: Record<string, unknown>) =>
      writeFileSync(path, JSON.stringify({ ...config({ repository: root }), ...extra }));
    for (const threshold of [0, 12, 3.5])
      assert.throws(() => (write({ inputPolicy: { threshold } }), loadConfig(path)), /inputPolicy/);
    assert.throws(
      () => (write({ inputPolicy: { threshold: 5, extra: 1 } }), loadConfig(path)),
      /inputPolicy/,
    );
    write({});
    const plain = loadConfig(path);
    assert.equal('inputPolicy' in policyFromConfig(plain), false);
    write({ inputPolicy: { threshold: 11 } });
    const autonomous = loadConfig(path);
    assert.deepEqual(policyFromConfig(autonomous).inputPolicy, { threshold: 11, criticalPaths: [] });
    assert.equal(
      executionDigest(policyFromConfig(autonomous)),
      executionDigest(policyFromConfig(plain)),
    );
    assert.equal(approvalPolicyDigest(autonomous), approvalPolicyDigest(plain));
    assert.equal(workspacePolicyDigest(autonomous), workspacePolicyDigest(plain));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Основания утверждения и исполнения, которые порог вопросов не должен менять. */
function approvalDigests(h: DevContour) {
  const task = h.store.read().tasks[0];
  return {
    execution: executionDigest(policyFromConfig(h.config)),
    approval: approvalPolicyDigest(h.config),
    task: h.taskPolicyDigest(task),
    workspace: workspacePolicyDigest(h.config),
  };
}

/** Завершённый вызов модели с известной стоимостью: расход общего бюджета. */
function spend(store: Store, id: string, costUsd: number | null) {
  store.atomic(() =>
    store.saveLocal('usage', undefined, id, {
      id,
      stage: 'implementation',
      runtime: 'codex',
      model: 'EXAMPLE_MODEL',
      runtimeVersion: null,
      startedAt: '2026-11-01T00:00:00Z',
      outcome: 'returned',
      promptBytes: 1,
      promptDigest: 'd'.repeat(64),
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedUsd: costUsd,
        complete: true,
        source: 'fixture',
      },
      costUsd,
      costSource: costUsd === null ? 'unknown' : 'provider-reported',
    }),
  );
}

test('The task card computes the budget block live: raising the limit by config-apply clears it without a claim', async () => {
  const s = served();
  try {
    s.edit((raw) => (raw.budgets = { workspace: { usd: 1 }, onUnknown: 'continue' }));
    assert.equal((await s.request()).status, 'applied');
    const board = s.server.createBoard('Board');
    const task = s.server.addTask(board.id, input('Work'));
    s.server.approve(board.id);
    spend(s.server.store, 'U1', 5);
    const progress = () => {
      const st = s.server.store.read();
      return taskProgress(
        s.server,
        st,
        st.tasks.find((t) => t.id === task.id)!,
        Date.now(),
      );
    };
    // Блок есть, хотя claim его ещё не записал: карточка считает тем же правилом движка.
    assert.equal(s.server.store.read().tasks.find((t) => t.id === task.id)!.budgetBlock, undefined);
    let p = progress();
    assert.ok(p.reasons.includes('budget_blocked'), JSON.stringify(p));
    assert.match(p.budgetBlock?.reason ?? '', /Бюджет total исчерпан: предел \$1/);
    assert.match(p.budgetBlock!.hint, /Поднимите предел в budgets.*config-apply --keys budgets$/);
    // Повышение предела применено, выдачи не было (очередь на паузе): блок снят сразу.
    s.edit((raw) => (raw.budgets = { workspace: { usd: 100 }, onUnknown: 'continue' }));
    assert.equal((await s.request()).status, 'applied');
    p = progress();
    assert.ok(!p.reasons.includes('budget_blocked'), JSON.stringify(p));
    assert.equal(p.budgetBlock, undefined);
    // Неизвестная стоимость при onUnknown: stop — предел не поможет: подсказка о onUnknown.
    s.edit((raw) => (raw.budgets = { workspace: { usd: 100 }, onUnknown: 'stop' }));
    assert.equal((await s.request()).status, 'applied');
    spend(s.server.store, 'U2', null);
    p = progress();
    assert.match(p.budgetBlock?.reason ?? '', /не определён/);
    assert.match(p.budgetBlock!.hint, /onUnknown: "continue".*config-apply --keys budgets,prices/);
    // Отменённая задача бюджетом не держится.
    s.server.store.change('test.cancelled', (st) => {
      st.tasks.find((t) => t.id === task.id)!.status = 'cancelled';
    });
    assert.equal(progress().budgetBlock, undefined);
  } finally {
    s.cleanup();
  }
});

test('A reader not on the applied config shows the server budget block, not its own limits', async () => {
  const s = served();
  let reader: DevContour | undefined;
  try {
    s.edit((raw) => (raw.budgets = { workspace: { usd: 1 }, onUnknown: 'continue' }));
    assert.equal((await s.request()).status, 'applied');
    const board = s.server.createBoard('Board');
    const task = s.server.addTask(board.id, input('Work'));
    s.server.approve(board.id);
    spend(s.server.store, 'U1', 5);
    // Кэш claim сервера по применённому пределу $1.
    s.server.store.change('test.budget-block', (st) => {
      st.tasks.find((t) => t.id === task.id)!.budgetBlock = {
        reason: 'Бюджет total исчерпан: предел $1',
        at: '2026-11-01T00:00:00.000Z',
      };
    });
    // Файл правлен без config-apply; MCP-процесс загрузил уже новый предел.
    s.edit((raw) => (raw.budgets = { workspace: { usd: 100 }, onUnknown: 'continue' }));
    reader = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(s.path));
    assert.notEqual(reader.configDigest, s.server.store.view().appliedConfig?.digest);
    const st = reader.store.read();
    const p = taskProgress(
      reader,
      st,
      st.tasks.find((t) => t.id === task.id)!,
      Date.now(),
    );
    assert.ok(p.reasons.includes('budget_blocked'), JSON.stringify(p));
    assert.equal(p.budgetBlock?.reason, 'Бюджет total исчерпан: предел $1');
    assert.equal(p.budgetBlock?.at, '2026-11-01T00:00:00.000Z');
  } finally {
    reader?.store.close();
    s.cleanup();
  }
});

test('Without budgets a stored budgetBlock cache does not block the task card', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board');
    const task = f.h.addTask(board.id, input('Work'));
    f.h.approve(board.id);
    f.store.change('test.budget-block', (s) => {
      s.tasks.find((t) => t.id === task.id)!.budgetBlock = {
        reason: 'Бюджет задачи исчерпан: 25.4 из 25 USD',
        at: '2026-11-01T00:00:00.000Z',
      };
    });
    const s = f.store.read();
    const p = taskProgress(
      f.h,
      s,
      s.tasks.find((t) => t.id === task.id)!,
      Date.now(),
    );
    assert.ok(!p.reasons.includes('budget_blocked'));
    assert.equal(p.budgetBlock, undefined);
  } finally {
    f.cleanup();
  }
});

test('config-apply does not take over the reconfigure slot of another operation, even once applied', async () => {
  const s = served();
  try {
    s.edit((raw) => (raw.budgets = { workspace: { usd: 10 } }));
    // Изменение контракта применило конфигурацию, но ещё не сняло свой запрос.
    s.server.requestReconfigure('CC-1', s.server.configDigest);
    s.server.settleReconfigure('CC-1', s.server.configDigest, 'server');
    assert.ok(s.server.store.read().reconfigure?.appliedAt);
    await assert.rejects(
      requestConfigApply(s.root, ['budgets'], { waitMs: 0 }),
      /Конфигурацию сейчас применяет операция CC-1 \(применена, ещё не завершена\).*contract-change --id CC-1 --abandon/,
    );
    assert.equal(s.server.store.read().reconfigure?.operation, 'CC-1');
    // Операция сняла запрос — config-apply проходит.
    s.server.clearReconfigure('CC-1');
    assert.equal((await s.request(['budgets'])).status, 'applied');
    // Применённый, но не снятый (падение сервера) прежний config-apply не держит следующий.
    s.edit((raw) => (raw.budgets = { workspace: { usd: 20 } }));
    s.server.requestReconfigure('config-apply:budgets:old', s.server.configDigest);
    s.server.settleReconfigure('config-apply:budgets:old', s.server.configDigest, 'server');
    assert.ok(s.server.store.read().reconfigure?.appliedAt);
    assert.equal((await s.request(['budgets'])).status, 'applied');
    assert.deepEqual(s.server.config.budgets, { workspace: { usd: 20 }, onUnknown: 'stop' });
    // Отклонённый и не снятый — тоже.
    s.edit((raw) => (raw.budgets = { workspace: { usd: 30 } }));
    s.server.requestReconfigure('config-apply:budgets:failed', 'a'.repeat(64));
    s.server.settleReconfigure('config-apply:budgets:failed', 'a'.repeat(64), 'server', 'сбой');
    assert.ok(s.server.store.read().reconfigure?.error);
    assert.equal((await s.request(['budgets'])).status, 'applied');
    assert.deepEqual(s.server.config.budgets, { workspace: { usd: 30 }, onUnknown: 'stop' });
  } finally {
    s.cleanup();
  }
});

test('config-apply --keys stallSweep against a server that refuses without clearing: refused, request cleared, issuance not held', async () => {
  const s = served();
  try {
    s.edit((raw) => {
      raw.stallSweep = { action: 'stop' };
    });
    const pending = requestConfigApply(s.root, ['stallSweep'], { waitMs: 5000 });
    // Сервер прежней версии: ключа не знает, читает запрос как применение
    // операцией, отклоняет и запрос не снимает.
    let request = s.server.store.read().reconfigure;
    for (let i = 0; i < 100 && !request; i++) {
      await new Promise((r) => setTimeout(r, 20));
      request = s.server.store.read().reconfigure;
    }
    assert.ok(request, 'запрос записан');
    s.server.settleReconfigure(
      request.operation,
      request.digest,
      'server',
      'Новая конфигурация отличается не только закреплением context packs',
    );
    assert.ok(s.server.store.read().reconfigure?.error, 'отклонён, но не снят');
    const result = await pending;
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.match(
      (result as { error: string }).error,
      /^Новая конфигурация отличается.*Запрос снят командой.*stallSweep.*перезапуском serve$/,
    );
    assert.equal(s.server.store.read().reconfigure, undefined, 'запрос снят');
    const [event] = s.events('config.apply-refused');
    assert.equal((event.data as { clearedBy?: string }).clearedBy, 'config-apply');
    assert.equal(s.server.config.stallSweep, undefined, 'действующая конфигурация прежняя');
  } finally {
    s.cleanup();
  }
});

test('The operator changes inputPolicy in the panel: expected digest, validation, applied by the server tick', async () => {
  const s = served();
  const app = await serve(s.server, new Scheduler(s.server, s.root), { port: 0 });
  try {
    const post = (body: unknown) =>
      fetch(app.url + '/api/config/input-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
        body: JSON.stringify(body),
      });
    const state = (await (await fetch(app.url + '/api/state')).json()) as {
      config: { inputPolicy: unknown; configDigest: string };
    };
    assert.equal(state.config.inputPolicy, null);
    const before = readFileSync(s.path, 'utf8');
    // Чужой digest — отказ без записи файла.
    const stale = await post({ threshold: 5, expectedConfigDigest: 'a'.repeat(64) });
    assert.equal(stale.status, 409);
    assert.equal(readFileSync(s.path, 'utf8'), before);
    // Вне границ — отказ схемы без записи.
    const bad = await post({ threshold: 12, expectedConfigDigest: state.config.configDigest });
    assert.equal(bad.status, 400);
    assert.equal(readFileSync(s.path, 'utf8'), before);
    const ok = await post({ threshold: 5, expectedConfigDigest: state.config.configDigest });
    assert.equal(ok.status, 200, await ok.clone().text());
    const result = (await ok.json()) as { status: string; operation: string };
    assert.equal(result.status, 'requested');
    assert.match(result.operation, /^config-apply:inputPolicy:/);
    assert.deepEqual(
      (JSON.parse(readFileSync(s.path, 'utf8')) as { inputPolicy?: unknown }).inputPolicy,
      { threshold: 5 },
    );
    // Такт сервера применяет запрос тем же правилом, что config-apply.
    s.server.leader('server');
    serveReconfigure(s.server, s.path, 'server');
    assert.deepEqual(s.server.config.inputPolicy, { threshold: 5 });
    assert.equal(s.events('config.applied').length, 1);
    // Агентский API такой операции не знает: автономность — выбор оператора.
    const agent = await fetch(app.url + '/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
      body: JSON.stringify({ operation: 'input_policy', input: { threshold: 11 } }),
    });
    assert.notEqual(agent.status, 200);
  } finally {
    await app.close();
    s.cleanup();
  }
});
