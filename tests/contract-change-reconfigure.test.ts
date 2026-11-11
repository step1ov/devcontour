import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, input } from './helpers.ts';
import { type ContractChange } from '../src/runner/contract-change.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { planRepin } from '../src/runner/context.ts';
import { loadConfig } from '../src/runner/config.ts';
import { serveReconfigure } from '../src/runner/reconfigure.ts';
import { stage, withContextPack } from './contract-change-fixture.ts';

test('The operation repins a context pack that pins the previous contract text and applies the configuration itself', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    const before = ctx.digest();
    const pausedBefore = s.store.read().paused;
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    // config.json перезакреплён на проверенную ревизию, остальное не тронуто.
    const head = s.sh('rev-parse', 'HEAD');
    const written = JSON.parse(readFileSync(ctx.path, 'utf8')) as {
      contextPacks: { revision: string }[];
    };
    assert.equal(written.contextPacks[0].revision, head);
    assert.notEqual(head, ctx.pinnedBefore);
    assert.deepEqual(done.config, { before, after: ctx.digest() });
    // Новая конфигурация применена в процессе: рецензент плана видит новый текст.
    assert.equal(s.h.config.contextPacks[0].revision, head);
    assert.deepEqual(s.calls, ['contract / architecture decision', 'task plan']);
    assert.ok(done.history.some((h) => h.step === 'context' && h.event === 'repinned'));
    assert.ok(done.history.some((h) => h.step === 'reconfigure' && h.event === 'applied'));
    // Запрос применения снят, пауза очереди — как до операции.
    const state = s.store.read();
    assert.equal(state.reconfigure, undefined);
    assert.equal(state.paused, pausedBefore);
    assert.equal(state.waits, undefined);
    assert.ok(state.tasks.every((t) => !t.hold));
  } finally {
    await s.remove();
  }
});

test('A user pause set before or during the operation survives it; the operation lifts only its own pause', async () => {
  for (const when of ['before', 'during'] as const) {
    const s = await stage();
    try {
      await withContextPack(s);
      s.h.pause(false);
      if (when === 'before') s.h.pause(true);
      const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
        operation: ContractChange;
      };
      // Человек ставит паузу, пока операция держит свою (после context).
      const done = await s
        .changes((step) => {
          if (when === 'during' && step === 'context') {
            s.h.operationPause(operation.id);
            assert.equal(s.store.read().pauseReason, 'reconfigure');
            s.h.pause(true);
          }
        })
        .advance(operation.id);
      assert.equal(done.status, 'completed', done.error);
      const state = s.store.read();
      assert.equal(state.paused, true, when);
      assert.equal(state.pauseReason, 'operator', when);
    } finally {
      await s.remove();
    }
  }
  // Без паузы человека операция снимает свою.
  const s = await stage();
  try {
    await withContextPack(s);
    s.h.pause(false);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    let pausedInside = false;
    const done = await s
      .changes((step) => {
        if (step === 'reconfigure') pausedInside = true;
      })
      .advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.ok(pausedInside);
    assert.equal(s.store.read().paused, false);
  } finally {
    await s.remove();
  }
});

test('Reconfigure waits for a running attempt and issues nothing new until the configuration is applied', async () => {
  const s = await stage();
  try {
    await withContextPack(s);
    // Попытка другой задачи идёт под прежней конфигурацией.
    const other = s.h.addTask(s.h.createBoard('Other').id, { ...input('Other'), role: 'qa' });
    s.h.approve(s.store.read().boards.at(-1)!.id);
    s.h.pause(false);
    // Задачи контракта на время выдачи удержаны: попытку получает другая.
    s.h.hold([s.api.id, s.screen.id], 'fixture', 'выдать другую задачу');
    const run = s.h.claim('worker')!;
    s.h.release('fixture');
    assert.equal(run.taskId, other.id);
    // Исполнитель жив: его lease не истекает, пока идут шаги операции, даже
    // если машина медленная (истёкшая попытка drain не держит).
    s.store.change('fixture.live-run', (st) => {
      st.runs.find((r) => r.id === run.id)!.leaseUntil = Date.now() + 3_600_000;
    });
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const waiting = await s.changes().advance(operation.id);
    assert.equal(waiting.status, 'waiting', waiting.error);
    assert.equal(waiting.next, 'reconfigure');
    assert.deepEqual(waiting.waitingFor, [run.id]);
    // Пока запрос не применён, выдача и совместные проверки остановлены, даже
    // если человек снял паузу.
    s.h.pause(false);
    assert.equal(s.h.claim('worker-2'), undefined);
    assert.ok(s.store.read().reconfigure && !s.store.read().reconfigure!.appliedAt);
    // Попытка завершилась — операция применяет конфигурацию и продолжает.
    s.store.change('fixture.finish', (st) => {
      st.runs.find((r) => r.id === run.id)!.status = 'failed';
      const t = st.tasks.find((x) => x.id === run.taskId)!;
      t.activeRunId = undefined;
      t.status = 'ready';
    });
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(s.store.read().reconfigure, undefined);
  } finally {
    await s.remove();
  }
});

test('Only one operation applies a configuration at a time', () => {
  const f = fixture();
  try {
    f.h.requestReconfigure('CC-a', f.h.configDigest);
    // Повтор того же запроса — не конфликт.
    f.h.requestReconfigure('CC-a', f.h.configDigest);
    assert.throws(
      () => f.h.requestReconfigure('CC-b', 'b'.repeat(64)),
      /уже применяет операция CC-a/,
    );
    // Применение — процессом с ожидаемой конфигурацией.
    f.h.settleReconfigure('CC-a', f.h.configDigest, 'server');
    f.h.requestReconfigure('CC-b', 'b'.repeat(64));
    assert.equal(f.store.read().reconfigure?.operation, 'CC-b');
  } finally {
    f.cleanup();
  }
});

test('A configuration changed outside the operation is refused with both digests, not applied', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // После перезакрепления кто-то правит config.json вне операции.
    const stopped = await s
      .changes((step) => {
        if (step === 'context') {
          const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as Record<string, unknown>;
          writeFileSync(
            ctx.path,
            JSON.stringify({ ...raw, runTimeoutMs: Number(raw.runTimeoutMs) + 1 }, null, 2) + '\n',
          );
        }
      })
      .advance(operation.id);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.error ?? '', /ожидался digest [0-9a-f]{16}, загружен [0-9a-f]{16}/);
    assert.equal(
      s.h.config.runTimeoutMs,
      loadConfig(ctx.path).runTimeoutMs - 1,
      'чужая правка не применена',
    );
  } finally {
    await s.remove();
  }
});

test('A crash after repinning or after applying resumes without a repeated review or a second write', async () => {
  for (const crashAt of ['context', 'reconfigure'] as const) {
    const s = await stage();
    try {
      const ctx = await withContextPack(s);
      const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
        operation: ContractChange;
      };
      const crashed = await s
        .changes((step) => {
          if (step === crashAt) throw new Error('crash after ' + step);
        })
        .advance(operation.id);
      assert.equal(crashed.status, 'failed');
      const written = ctx.digest();
      const mtime = statSync(ctx.path).mtimeMs;
      // Новый процесс читает уже записанный config.json.
      s.h.config = loadConfig(ctx.path);
      const done = await s.changes().advance(operation.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(ctx.digest(), written, crashAt);
      assert.equal(statSync(ctx.path).mtimeMs, mtime, 'файл не переписан: ' + crashAt);
      assert.deepEqual(s.calls, ['contract / architecture decision', 'task plan'], crashAt);
      assert.equal(done.history.filter((h) => h.event === 'repinned').length, 1, crashAt);
    } finally {
      await s.remove();
    }
  }
});

test('A running server applies the requested configuration and confirms it; an edit without a request is not applied', async () => {
  const s = await stage();
  let server: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    server = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    // Правка config.json без запроса операции работающий сервер не подхватывает.
    const raw = readFileSync(ctx.path, 'utf8');
    writeFileSync(ctx.path, raw.replace('"concurrency": 2', '"concurrency": 3'));
    serveReconfigure(server, ctx.path, 'server');
    assert.equal(server.config.concurrency, s.h.config.concurrency);
    writeFileSync(ctx.path, raw);
    // Сервер — живой лидер; операция ждёт его подтверждения.
    assert.ok(server.leader('server'));
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Сервер тикает, как настоящий: продлевает лидерство и обрабатывает
    // запрос, когда операция его запишет.
    let finished = false;
    const advancing = s
      .changes()
      .advance(operation.id)
      .finally(() => (finished = true));
    while (!finished) {
      server.leader('server');
      serveReconfigure(server, ctx.path, 'server');
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = await advancing;
    assert.equal(
      done.history.find((h) => h.step === 'reconfigure' && h.event === 'applied') !== undefined,
      true,
    );
    assert.equal(done.status, 'completed', done.error);
    assert.equal(server.config.contextPacks[0].revision, s.sh('rev-parse', 'HEAD'));
  } finally {
    server?.store.close();
    await s.remove();
  }
});

test('An attempt started under the previous configuration cannot be accepted under the new one', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    s.h.pause(false);
    const run = s.h.claim('worker')!;
    const before = s.h.policyDigest('main');
    // Новое закрепление применено (минуя drain — моделирует опоздавшего исполнителя).
    writeFileSync(
      ctx.path,
      await planRepin(s.h.config, readFileSync(ctx.path, 'utf8'), ['contracts'], 'HEAD'),
    );
    s.h.reconfigure(loadConfig(ctx.path));
    assert.notEqual(s.h.policyDigest('main'), before);
    assert.throws(
      () => s.h.phase(run.id, run.token, 'integrating', { candidateSha: 'c' }),
      /Политика (проверок )?изменилась/,
    );
  } finally {
    await s.remove();
  }
});
