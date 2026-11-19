// F62: попытка, прерванная штатной остановкой controller, хранится как
// `failed` с классом `environment` (`interrupted: 'shutdown'`), но не
// засчитана, и задача снова в очереди. Там, где её видят человек и ведущий,
// она — прерванная, а не провал. Хранимые данные не меняются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, fixture, input } from './helpers.ts';
import { executionOf } from '../src/harness/execution.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { AttentionService } from '../src/application/attention.ts';
import { panelSummary } from '../src/application/panel.ts';
import { attemptHistory } from '../src/runner/agent-control.ts';

test('F62: прерванная остановкой попытка — не провал в пакете передачи, сводке, истории ревьюеру и истории внимания', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Interrupted task'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    executionOf(f.h).engine.fail(run.id, run.token, 'Остановка сервера', {
      kind: 'environment',
      interrupted: true,
    });
    f.h.pause(true);
    const s = f.store.read();
    const stored = s.runs.find((r) => r.id === run.id)!;
    // Хранимая запись — прежняя: совместимость данных.
    assert.equal(stored.status, 'failed');
    assert.equal(stored.failureKind, 'environment');
    assert.equal(stored.interrupted, 'shutdown');
    assert.equal(s.tasks.find((x) => x.id === t.id)!.status, 'ready');

    const pack = devcontourHandoff(f.h).pack;
    assert.deepEqual(
      pack.failures.filter((x) => x.runId === run.id),
      [],
      'пакет передачи не называет прерванную попытку провалом',
    );
    assert.equal(pack.truncated.failures, 0);
    const scoped = devcontourHandoff(f.h, { boardId: b.id }).pack;
    assert.deepEqual(scoped.failures, []);

    const summary = panelSummary(f.h, f.root, {}) as {
      runs: { id: string; status: string; interrupted?: string }[];
    };
    assert.equal(summary.runs.find((r) => r.id === run.id)?.interrupted, 'shutdown');

    const history = attemptHistory(
      s,
      [{ ...s.tasks.find((x) => x.id === t.id)! }],
      3,
    ).attemptHistory!;
    assert.deepEqual(
      history.tasks[0].runs.map((r) => [r.status, r.failureKind]),
      [['interrupted', undefined]],
      'ревьюер плана видит прерванную, без класса отказа',
    );

    // Задача принята после прерывания: в истории внимания сбоя нет — карточкой
    // он не был.
    complete(f.h, t.id);
    const service = new AttentionService(f.store, f.h);
    assert.deepEqual(
      service.history().items.filter((i) => i.sourceKey === `work:${t.id}`),
      [],
    );
  } finally {
    f.cleanup();
  }
});

const interrupt = (f: ReturnType<typeof fixture>, run: { id: string; token: string }) =>
  executionOf(f.h).engine.fail(run.id, run.token, 'Остановка сервера', {
    kind: 'environment',
    interrupted: true,
  });

test('F62: пакет передачи — счёт отброшенных провалов без прерываний, по своей доске; настоящий отказ окружения рядом с прерыванием остаётся', async () => {
  const f = fixture();
  try {
    // Сначала прерывание на доске B, затем на A — самые старые; потом на A
    // 11 провалов gate и последним — настоящий отказ окружения.
    const b = f.h.createBoard('Board B');
    f.h.addTask(b.id, input('Task B'));
    f.h.approve(b.id);
    f.h.pause(false);
    const onB = f.h.claim('test')!;
    interrupt(f, onB);
    const interruptedB = onB.id;
    f.h.cancel(onB.taskId, 'not needed in this test');
    const a = f.h.createBoard('Board A');
    for (let i = 0; i < 12; i++) f.h.addTask(a.id, input('Task A' + i));
    f.h.approve(a.id);
    f.h.pause(false);
    let interruptedA: string | undefined;
    let environment: string | undefined;
    for (let gates = 0; !environment;) {
      // Время окончания различает порядок «новые первыми».
      await new Promise((resolve) => setTimeout(resolve, 3));
      const run = f.h.claim('test')!;
      assert.ok(run, 'есть задача к выдаче');
      if (!interruptedA) {
        interrupt(f, run);
        interruptedA = run.id;
      } else if (gates < 11) {
        f.h.fail(run.id, run.token, 'gate failed', false, 'gate');
        gates++;
      } else {
        f.h.fail(run.id, run.token, 'network unreachable', false, 'environment');
        environment = run.id;
      }
    }
    const failed = (runs: { status: string }[]) => runs.filter((r) => r.status === 'failed');
    assert.equal(failed(f.store.read().runs).length, 14);

    const whole = devcontourHandoff(f.h).pack;
    assert.equal(whole.failures.length, 10);
    assert.ok(whole.failures.every((x) => x.runId !== interruptedA && x.runId !== interruptedB));
    assert.ok(
      whole.failures.some((x) => x.runId === environment && x.failureKind === 'environment'),
      'настоящий отказ окружения остаётся в списке',
    );
    // 12 настоящих провалов, показано 10.
    assert.equal(whole.truncated.failures, 2);
    // Прерывания пакет harness считает отдельно (0.1.0-alpha.52).
    assert.equal(whole.interruptions, 2);

    const scoped = devcontourHandoff(f.h, { boardId: a.id }).pack;
    assert.equal(scoped.failures.length, 10);
    // Прерывание на доске B не уменьшает счёт пакета доски A.
    assert.equal(scoped.truncated.failures, 2);
    assert.equal(scoped.interruptions, 1);
  } finally {
    f.cleanup();
  }
});

test('F62: десять прерываний новее настоящего провала не вытесняют его из пакета передачи', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('Failing task'));
    f.h.addTask(b.id, input('Interrupted task'));
    f.h.approve(b.id);
    f.h.pause(false);
    const first = f.h.claim('test')!;
    f.h.fail(first.id, first.token, 'gate failed', false, 'gate');
    // Прерванная попытка не засчитана: та же задача выдаётся снова.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3));
      const run = f.h.claim('test')!;
      assert.ok(run, 'задача снова выдаётся после прерывания');
      interrupt(f, run);
    }
    const pack = devcontourHandoff(f.h).pack;
    assert.deepEqual(
      pack.failures.map((x) => x.runId),
      [first.id],
      'настоящий провал в списке',
    );
    assert.equal(pack.truncated.failures, 0);
    assert.equal(pack.interruptions, 10);
  } finally {
    f.cleanup();
  }
});

test('F62: история внимания — настоящий сбой, затем прерывание и принятие: в истории настоящий сбой', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Fails, then interrupted'));
    f.h.approve(b.id);
    f.h.pause(false);
    const genuine = f.h.claim('test')!;
    f.h.fail(genuine.id, genuine.token, 'unit tests failed', false, 'gate');
    f.h.retry(t.id);
    f.h.pause(false);
    const cut = f.h.claim('test')!;
    interrupt(f, cut);
    complete(f.h, t.id);
    const items = new AttentionService(f.store, f.h)
      .history()
      .items.filter((i) => i.sourceKey === `work:${t.id}`);
    assert.deepEqual(
      items.map((i) => i.occurrenceId),
      [genuine.id],
    );
    assert.ok(items[0].resolvedAt);
  } finally {
    f.cleanup();
  }
});
