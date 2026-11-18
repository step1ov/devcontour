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
