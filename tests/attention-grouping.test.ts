import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionService } from '../src/application/attention.ts';
import { ATTENTION_LIMITS } from '../src/core/attention-model.ts';
import { chainBlockers } from '../src/core/work-status.ts';
import { executionOf } from '../src/harness/execution.ts';
import { fixture, input } from './helpers.ts';

// D04-E: каскад — одна корневая карточка с влиянием, а не карточка на
// каждую зависимую задачу.

test('100 зависимых от одного сбоя (с ромбом) — одна карточка с влиянием 100, как у chainBlockers', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const root = f.h.addTask(b.id, input('Root task'));
    // Ромб: две ветви от корня и общий потомок, дальше цепочка.
    const left = f.h.addTask(b.id, input('Left branch', [root.id]));
    const right = f.h.addTask(b.id, input('Right branch', [root.id]));
    let previous = f.h.addTask(b.id, input('Join task', [left.id, right.id])).id;
    for (let i = 0; i < 97; i++) previous = f.h.addTask(b.id, input(`Chain ${i}`, [previous])).id;
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, root.id);
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    const view = await new AttentionService(f.store, f.h).active();
    const work = view.items.filter((i) => i.source === 'work');
    assert.equal(work.length, 1);
    assert.equal(work[0].impact.tasks, 1);
    assert.equal(work[0].impact.waiting, 100);
    const chain = chainBlockers(f.store.read().tasks, f.h.config.maxAttempts);
    assert.equal(chain.length, 1);
    assert.equal(work[0].impact.waiting, chain[0].waiting);
  } finally {
    f.cleanup();
  }
});

test('Один бюджет держит 40 готовых задач — одна карточка; причина та же, что у budgetBlockOf', async () => {
  const f = fixture();
  try {
    f.h.config.budgets = { workspace: { usd: 0.01 }, onUnknown: 'stop' };
    const b = f.h.createBoard('Board');
    for (let i = 0; i < 40; i++) f.h.addTask(b.id, input(`Task ${i}`));
    f.h.approve(b.id);
    f.store.atomic(() =>
      f.store.saveLocal('usage', undefined, 'U1', {
        id: 'U1',
        stage: 'implementation',
        runtime: 'codex',
        model: 'fixture-model',
        runtimeVersion: null,
        startedAt: new Date().toISOString(),
        outcome: 'returned',
        promptBytes: 1,
        promptDigest: 'd'.repeat(64),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 1,
          complete: true,
          source: 'fixture',
        },
        costUsd: 1,
        costSource: 'provider-reported',
      }),
    );
    const view = await new AttentionService(f.store, f.h).active();
    const budget = view.items.filter((i) => i.source === 'budget');
    assert.equal(budget.length, 1);
    assert.equal(budget[0].impact.tasks, 40);
    assert.equal(budget[0].category, 'budget');
    assert.equal(view.items[0].source, 'budget', 'блокировка бюджета — в начале очереди');
    const { engine } = executionOf(f.h);
    const reason = engine.read((v) => engine.budgetBlockOf(f.store.read().tasks[0].id, v))!;
    // Причина карточки — та же причина движка (без подробности расхода,
    // если целиком не умещается), а команда действия уцелела в пределе.
    assert.ok(budget[0].reason.startsWith(reason.split('; израсходовано')[0]));
    assert.ok(budget[0].reason.length <= ATTENTION_LIMITS.reason);
    assert.match(
      budget[0].reason,
      /Поднимите предел в budgets и примените: devcontour config-apply --keys budgets\./,
    );
    assert.match(budget[0].reason, /за всё время workspace/);
    // Предел поднят выше расхода — карточки нет; исчерпан снова — новое появление.
    f.h.config.budgets = { workspace: { usd: 5 }, onUnknown: 'stop' };
    const lifted = await new AttentionService(f.store, f.h).active();
    assert.equal(lifted.items.filter((i) => i.source === 'budget').length, 0);
    f.h.config.budgets = { workspace: { usd: 0.5 }, onUnknown: 'stop' };
    const again = (await new AttentionService(f.store, f.h).active()).items.find(
      (i) => i.source === 'budget',
    )!;
    assert.notEqual(again.occurrenceId, budget[0].occurrenceId);
  } finally {
    f.cleanup();
  }
});

test('Неопределённый бюджет: карточка в пределе сохраняет команду onUnknown и не советует поднять предел', async () => {
  const f = fixture();
  try {
    f.h.config.budgets = { workspace: { usd: 100 }, onUnknown: 'stop' };
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('Task'));
    f.h.approve(b.id);
    // Завершённые вызовы без стоимости: бюджет не определён.
    f.store.atomic(() => {
      for (const id of ['U1', 'U2', 'U3'])
        f.store.saveLocal('usage', undefined, id, {
          id,
          stage: 'implementation',
          runtime: 'codex',
          model: null,
          runtimeVersion: null,
          startedAt: new Date().toISOString(),
          outcome: 'returned',
          promptBytes: 1,
          promptDigest: 'd'.repeat(64),
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reportedUsd: null,
            complete: true,
            source: 'fixture',
          },
          costUsd: null,
          costSource: 'unknown',
        });
    });
    const card = (await new AttentionService(f.store, f.h).active()).items.find(
      (i) => i.source === 'budget',
    )!;
    assert.ok(card, 'карточка неопределённого бюджета');
    assert.equal(card.title, 'Бюджет не определён');
    assert.match(card.reason, /^Бюджет total не определён: у 3 вызовов неизвестна стоимость/);
    assert.ok(card.reason.length <= ATTENTION_LIMITS.reason);
    assert.match(
      card.reason,
      /onUnknown: "continue".*devcontour config-apply --keys budgets,prices/,
    );
    assert.doesNotMatch(card.reason, /Поднимите предел|…$/);
  } finally {
    f.cleanup();
  }
});
