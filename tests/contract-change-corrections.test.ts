import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ContractChange } from '../src/runner/contract-change.ts';
import { changedSections } from '../src/runner/contract-impact.ts';
import { AttentionService } from '../src/application/attention.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { DomainError } from '../src/core/model.ts';
import { stage } from './contract-change-fixture.ts';
import { input } from './helpers.ts';

/** Принятая задача фикстуры с областью записи вне изменённой схемы. */
function acceptedOutside(s: Awaited<ReturnType<typeof stage>>) {
  const t = s.h.addTask(s.h.createBoard('Docs').id, {
    ...input('Docs page'),
    role: 'backend',
    contracts: [s.c1.id],
  });
  s.store.change('fixture.done-outside', (st) => {
    const task = st.tasks.find((x) => x.id === t.id)!;
    task.status = 'done';
    task.writePaths = ['web'];
  });
  return t;
}

async function completed(s: Awaited<ReturnType<typeof stage>>, proposal = s.proposal) {
  const started = await s.changes().start(proposal, 'codex');
  const done = await s.changes().advance((started as { operation: ContractChange }).operation.id);
  assert.equal(done.status, 'completed', done.error);
  return done;
}

const cards = (s: Awaited<ReturnType<typeof stage>>) =>
  new AttentionService(s.store, s.h, { root: s.root })
    .agentList({})
    .items.filter((i) => i.sourceKey.endsWith(':corrections'));

test('F69: each correction names what the change touches; a binding-only task is closed at once', async () => {
  const s = await stage();
  try {
    const docs = acceptedOutside(s);
    const done = await completed(s);
    // Прежний список остаётся: те же принятые задачи.
    assert.deepEqual([...done.corrections].sort(), [s.shipped.id, docs.id].sort());
    const details = new Map((done.correctionDetails ?? []).map((c) => [c.taskId, c]));
    // Задача без области записи (весь репозиторий) — изменённая схема в её области.
    const shipped = details.get(s.shipped.id)!;
    assert.deepEqual(shipped.effects, ['scope']);
    assert.deepEqual(shipped.paths, ['schema.json']);
    assert.match(shipped.reason, /schema\.json/);
    assert.equal(shipped.closed, undefined);
    // Область записи web: схема вне её, текст и проверки прежние — только привязка.
    const outside = details.get(docs.id)!;
    assert.deepEqual(outside.effects, []);
    assert.deepEqual(outside.outside, ['schema.json']);
    assert.match(outside.reason, /только привязка/);
    assert.equal(outside.closed?.by, 'auto');
  } finally {
    await s.remove();
  }
});

test('F69: open corrections stay in attention and session_handoff until acknowledged with a reason', async () => {
  const s = await stage();
  try {
    const docs = acceptedOutside(s);
    const done = await completed(s);
    const [card] = cards(s);
    assert.ok(card, 'карточка корректировок есть');
    assert.equal(card.actor, 'lead');
    assert.match(card.reason, new RegExp(s.shipped.id));
    assert.match(card.reason, new RegExp(`--ack-correction`));
    assert.doesNotMatch(card.reason, new RegExp(docs.id), 'закрытая сразу не названа');
    const host = devcontourHandoff(s.h).host;
    assert.deepEqual(
      host.corrections?.items.map((c) => [c.operation, c.taskId, c.effects]),
      [[done.id, s.shipped.id, ['scope']]],
    );
    assert.match(host.corrections.items[0].command, /--ack-correction/);
    // Пакет доски — только её задачи.
    assert.equal(devcontourHandoff(s.h, { boardId: s.board.id }).host.corrections, undefined);

    // Причина обязательна; чужая задача и закрытая сразу — отказ.
    assert.throws(
      () => s.changes().ackCorrection(done.id, s.shipped.id, 'ok'),
      (e: unknown) => e instanceof DomainError && e.status === 400,
    );
    assert.throws(
      () => s.changes().ackCorrection(done.id, s.api.id, 'checked: nothing to do here'),
      (e: unknown) => e instanceof DomainError && e.status === 404,
    );
    assert.throws(
      () => s.changes().ackCorrection(done.id, docs.id, 'checked: nothing to do here'),
      (e: unknown) => e instanceof DomainError && e.status === 409,
    );
    const acked = s
      .changes()
      .ackCorrection(
        done.id,
        s.shipped.id,
        'Accepted API keeps price as a string; follow-up task T-x converts it',
      );
    const item = acked.correctionDetails!.find((c) => c.taskId === s.shipped.id)!;
    assert.equal(item.closed?.by, 'lead');
    assert.match(item.closed.reason, /follow-up/);
    assert.equal(acked.history.at(-1)?.event, 'correction-acked');
    assert.deepEqual(cards(s), [], 'карточка ушла');
    assert.equal(devcontourHandoff(s.h).host.corrections, undefined);
    const history = new AttentionService(s.store, s.h, { root: s.root })
      .history({})
      .items.filter((i) => i.sourceKey.endsWith(':corrections'));
    assert.equal(history.length, 1, 'закрытие — в истории внимания');
    assert.throws(
      () => s.changes().ackCorrection(done.id, s.shipped.id, 'checked again, nothing new'),
      (e: unknown) => e instanceof DomainError && e.status === 409,
    );
  } finally {
    await s.remove();
  }
});

test('F69: a document change names the changed sections for every accepted task', async () => {
  const s = await stage();
  try {
    const docs = acceptedOutside(s);
    await writeFile(
      join(s.repo, 'docs/contracts/catalog.md'),
      '# Catalog\n\nSee schema.json.\n\n## Prices\n\nPrice is a number.\n',
    );
    s.sh('commit', '-qam', 'contract text');
    const done = await completed(s);
    const outside = done.correctionDetails!.find((c) => c.taskId === docs.id)!;
    assert.deepEqual(outside.effects, ['document']);
    assert.deepEqual(outside.sections, ['Prices']);
    assert.match(outside.reason, /Prices/);
    assert.equal(outside.closed, undefined, 'текст изменился — корректировка открыта');
  } finally {
    await s.remove();
  }
});

test('F69: changedSections lists changed, added and removed Markdown sections', () => {
  assert.deepEqual(
    changedSections(
      '# A\n\none\n\n## B\n\ntwo\n\n## C\n\nthree\n',
      '# A\n\none\n\n## B\n\nTWO\n\n## D\n\nfour\n',
    ),
    ['B', 'D', 'C'],
  );
  assert.deepEqual(changedSections('intro\n# A\nx\n', 'intro2\n# A\nx\n'), ['(начало документа)']);
  assert.deepEqual(changedSections('# A\nx\n', '# A\nx\n'), []);
});
