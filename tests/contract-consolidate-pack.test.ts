import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ContractChange } from '../src/runner/contract-change.ts';
import { pinContext } from '../src/runner/context.ts';
import { loadConfig } from '../src/runner/config.ts';
import { devcontourContextSource } from '../src/harness/host.ts';
import { executionOf } from '../src/harness/execution.ts';
import { reapprove } from './helpers.ts';
import { CONSOLIDATED, consolidationStage } from './consolidation-fixture.ts';

type Stage = Awaited<ReturnType<typeof consolidationStage>>;

/**
 * Пакет контекста роли backend содержит документ контракта и закреплён на
 * прежней редакции; конфигурация загружена из `config.json`, как у
 * работающего сервера.
 */
async function withPack(s: Stage) {
  s.h.config.contextPacks = await pinContext({
    ...s.h.config,
    contextPacks: [
      {
        id: 'contracts',
        version: '1.0',
        repositoryId: 'main',
        roles: ['backend'],
        files: ['docs/contracts/catalog.md'],
        references: [],
      },
    ],
  });
  for (const role of Object.values(s.h.config.roles)) {
    role.runtime = 'codex';
    if (role.reviewer) role.reviewer.runtime = 'claude';
  }
  s.h.config.reviewer = { ...s.h.config.reviewer, runtime: 'claude' };
  const path = join(s.root, 'config.json');
  await writeFile(path, JSON.stringify(s.h.config, null, 2) + '\n');
  s.h.config = loadConfig(path);
  reapprove(s.h);
  return path;
}
const context = (s: Stage, taskId: string) =>
  devcontourContextSource(s.h, executionOf(s.h).store).forTask(taskId);
const start = async (s: Stage) =>
  (
    (await s.changes().start(s.proposal, 'codex', [], 'consolidate')) as {
      operation: ContractChange;
    }
  ).operation;

test('H1: after a consolidation the context pack holds the new text and a task bound to the predecessor still gets its context', async () => {
  const s = await consolidationStage();
  try {
    await withPack(s);
    await context(s, s.api.id);
    await s.commitDoc(CONSOLIDATED);
    const done = await s.changes().advance((await start(s)).id);
    assert.equal(done.status, 'completed', done.error);
    assert.ok(
      done.history.some((h) => h.step === 'context' && h.event === 'repinned'),
      'пакет перезакреплён на консолидированный текст',
    );
    assert.deepEqual(s.task(s.api.id).contracts, [s.c1.id]);
    const snapshot = await context(s, s.api.id);
    assert.ok(JSON.stringify(snapshot).includes('REQ-3. Sorted by name.'));
  } finally {
    await s.remove();
  }
});

test('Consolidation failing at the context step after registration: abandon releases holds, the task keeps its binding', async () => {
  const s = await consolidationStage();
  try {
    const path = await withPack(s);
    await s.commitDoc(CONSOLIDATED);
    const op = await start(s);
    // Чужая правка config.json, не применённая процессом: шаг context откажет.
    await writeFile(path, JSON.stringify({ ...s.h.config, name: 'edited elsewhere' }));
    const failed = await s.changes().advance(op.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.next, 'context');
    assert.match(failed.error ?? '', /config\.json отличается/);
    const c2 = s.store.read().contracts.at(-1)!;
    assert.equal(failed.contractId, c2.id);
    assert.equal(s.task(s.api.id).hold?.operation, op.id);
    const abandoned = s.changes().abandon(op.id);
    assert.equal(abandoned.status, 'abandoned');
    assert.equal(s.task(s.api.id).hold, undefined);
    assert.equal(s.task(s.api.id).status, 'ready');
    assert.deepEqual(s.task(s.api.id).contracts, [s.c1.id]);
    assert.equal(s.store.read().contracts.at(-1)?.consolidates?.from, s.c1.id);
  } finally {
    await s.remove();
  }
});

test('Consolidation failing at the base step: the redaction stays registered, abandon releases holds', async () => {
  const s = await consolidationStage();
  try {
    await s.commitDoc(CONSOLIDATED);
    await s.commitDoc('unrelated\n', 'unrelated.txt');
    const op = await start(s);
    const failed = await s.changes().advance(op.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.next, 'base');
    assert.match(failed.error ?? '', /вне контракта: unrelated\.txt/);
    assert.ok(failed.contractId);
    s.changes().abandon(op.id);
    assert.equal(s.task(s.api.id).hold, undefined);
    assert.equal(s.task(s.api.id).status, 'ready');
    assert.deepEqual(s.task(s.api.id).contracts, [s.c1.id]);
    // После регистрации консолидация не пересматривается.
    await assert.rejects(
      s.changes().revise(op.id, s.changes().get(op.id).version ?? 0),
      /не пересматривают|Пересмотр недоступен/,
    );
  } finally {
    await s.remove();
  }
});
