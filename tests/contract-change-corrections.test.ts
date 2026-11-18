import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ContractChange } from '../src/runner/contract-change.ts';
import { changedSections } from '../src/runner/contract-impact.ts';
import { AttentionService } from '../src/application/attention.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { DomainError } from '../src/core/model.ts';
import { reviewers, stage } from './contract-change-fixture.ts';
import { ContractChanges } from '../src/runner/contract-change.ts';
import { AgentService } from '../src/application/agent.ts';
import { type AgentAdapter, type AgentRequest } from '../src/runner/adapters.ts';
import { statePrevious } from './helpers.ts';
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
    assert.match(card.reason, /contract_change_ack_correction/);
    assert.doesNotMatch(card.reason, new RegExp(docs.id), 'закрытая сразу не названа');
    const host = devcontourHandoff(s.h).host;
    assert.deepEqual(
      host.corrections?.items.map((c) => [c.operation, c.taskId, c.effects]),
      [[done.id, s.shipped.id, ['scope']]],
    );
    assert.match(host.corrections.items[0].command, /^contract_change_ack_correction \{"id": "CC-/);
    // Пакет доски — только её задачи.
    assert.equal(devcontourHandoff(s.h, { boardId: s.board.id }).host.corrections, undefined);

    // Причина обязательна; чужая задача и закрытая сразу — отказ.
    assert.throws(
      () => s.changes().ackCorrection(done.id, [s.shipped.id], 'ok'),
      (e: unknown) => e instanceof DomainError && e.status === 400,
    );
    assert.throws(
      () => s.changes().ackCorrection(done.id, [s.api.id], 'checked: nothing to do here'),
      (e: unknown) => e instanceof DomainError && e.status === 404,
    );
    assert.throws(
      () => s.changes().ackCorrection(done.id, [docs.id], 'checked: nothing to do here'),
      (e: unknown) => e instanceof DomainError && e.status === 409,
    );
    const acked = s
      .changes()
      .ackCorrection(
        done.id,
        [s.shipped.id],
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
      () => s.changes().ackCorrection(done.id, [s.shipped.id], 'checked again, nothing new'),
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

/** Ещё одна принятая задача без области записи: изменённая схема — в её области. */
function acceptedWhole(s: Awaited<ReturnType<typeof stage>>) {
  const t = s.h.addTask(s.h.createBoard('Admin').id, {
    ...input('Admin API'),
    role: 'backend',
    contracts: [s.c1.id],
  });
  s.store.change('fixture.done-whole', (st) => {
    st.tasks.find((x) => x.id === t.id)!.status = 'done';
  });
  return t;
}

test('F69: several corrections close with one reason by list or all; the card keeps its version while the open set shrinks', async () => {
  const s = await stage();
  try {
    const admin = acceptedWhole(s);
    const third = acceptedWhole(s);
    const done = await completed(s);
    const before = cards(s)[0];
    assert.match(before.reason, new RegExp(admin.id));
    // Список — всё или ничего: неизвестная задача отменяет и остальные.
    assert.throws(
      () =>
        s.changes().ackCorrection(done.id, [s.shipped.id, 'T-unknown'], 'checked: nothing to do'),
      (e: unknown) => e instanceof DomainError && e.status === 404,
    );
    assert.equal(cards(s)[0].reason, before.reason);
    s.changes().ackCorrection(done.id, [s.shipped.id, admin.id], 'checked: API unchanged for them');
    const after = cards(s)[0];
    assert.equal(after.sourceVersion, before.sourceVersion, 'закрытие части — та же версия');
    assert.doesNotMatch(after.reason, new RegExp(admin.id));
    assert.match(after.reason, new RegExp(third.id));
    const closed = s.changes().ackCorrection(done.id, 'all', 'checked: the rest needs nothing');
    assert.ok(closed.correctionDetails!.every((c) => c.closed));
    assert.deepEqual(cards(s), []);
    // all без открытых — 409.
    assert.throws(
      () => s.changes().ackCorrection(done.id, 'all', 'checked: the rest needs nothing'),
      (e: unknown) => e instanceof DomainError && e.status === 409,
    );
  } finally {
    await s.remove();
  }
});

test('F69: contract_change_ack_correction closes corrections over the agent API with the same refusals', async () => {
  const s = await stage();
  try {
    const done = await completed(s);
    const agent = new AgentService(s.h, s.root);
    const ack = (input: unknown) =>
      agent.execute({ operation: 'contract_change_ack_correction', input });
    const status = (fn: () => unknown) => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return (e as DomainError).status;
      }
    };
    assert.equal(
      status(() => ack({ id: done.id, taskIds: [s.shipped.id], reason: 'ok' })),
      400,
    );
    assert.equal(
      status(() => ack({ id: done.id, taskIds: ['T-unknown'], reason: 'checked: nothing to do' })),
      404,
    );
    const view = ack({ id: done.id, taskIds: 'all', reason: 'checked: nothing to do here' }) as {
      correctionDetails: { closed?: { by: string } }[];
    };
    assert.ok(view.correctionDetails.every((c) => c.closed?.by === 'lead'));
    assert.equal(
      status(() => ack({ id: done.id, taskIds: [s.shipped.id], reason: 'checked: nothing to do' })),
      409,
    );
  } finally {
    await s.remove();
  }
});

test('F69: an operation recorded before correction tracking names it in contract_change_status', async () => {
  const s = await stage();
  try {
    const done = await completed(s);
    // Запись прежней версии: список без correctionDetails.
    s.store.atomic(() => {
      const { correctionDetails: _dropped, ...legacy } = s.changes().get(done.id);
      void _dropped;
      s.store.saveLocal('contract-change', legacy.owner, legacy.id, legacy);
    });
    const view = new AgentService(s.h, s.root).execute({
      operation: 'contract_change_status',
      input: { id: done.id },
    }) as { correctionsHint?: string };
    assert.match(view.correctionsHint ?? '', /before correction tracking/);
    assert.deepEqual(cards(s), [], 'прежние корректировки не отслеживаются');
    assert.throws(
      () => s.changes().ackCorrection(done.id, 'all', 'checked: nothing to do here'),
      (e: unknown) => e instanceof DomainError && e.status === 404,
    );
  } finally {
    await s.remove();
  }
});

/** Ревьюер: первое ревью контракта отклоняет, остальные одобряет. */
function rejectFirst(calls: string[]) {
  let rejected = false;
  const base = reviewers(calls);
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    async execute(r: AgentRequest) {
      const subject = /Independently review this ([a-z /]+)\./.exec(r.prompt)?.[1] ?? '?';
      if (rejected || !subject.startsWith('contract')) {
        const approved = await base[name].execute(r);
        return {
          ...approved,
          data: { ...(approved.data as object), previous: statePrevious(r.prompt, true) },
        };
      }
      rejected = true;
      calls.push(subject);
      return {
        data: {
          approved: false,
          summary: 'Fixture rejection',
          findings: [{ severity: 'blocking', message: 'Раздел противоречит схеме' }],
          discoveries: [],
          previous: statePrevious(r.prompt, false),
        },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      };
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

test('F69: a revise before effects recomputes corrections for the new redaction', async () => {
  const s = await stage();
  try {
    const docs = acceptedOutside(s);
    await writeFile(
      join(s.repo, 'docs/contracts/catalog.md'),
      '# Catalog\n\nSee schema.json.\n\n## Prices\n\nPrice is a number.\n',
    );
    s.sh('commit', '-qam', 'contract text');
    const changes = new ContractChanges(s.h, s.root, rejectFirst(s.calls));
    const started = await changes.start(s.proposal, 'codex');
    const failed = await changes.advance((started as { operation: ContractChange }).operation.id);
    assert.equal(failed.status, 'failed', 'ревью отклонено до эффектов');
    const before = failed.correctionDetails!.find((c) => c.taskId === docs.id)!;
    assert.deepEqual(before.effects, ['document']);
    assert.deepEqual(before.sections, ['Prices']);
    // Новая редакция меняет только схему — вне области записи задачи docs.
    await writeFile(join(s.repo, 'docs/contracts/catalog.md'), '# Catalog\n\nSee schema.json.\n');
    s.sh('commit', '-qam', 'contract text back');
    const revised = await changes.revise(failed.id, failed.version!);
    assert.equal(revised.status, 'revised');
    const done = await changes.advance(failed.id);
    assert.equal(done.status, 'completed', done.error);
    const after = done.correctionDetails!.find((c) => c.taskId === docs.id)!;
    assert.deepEqual(after.effects, []);
    assert.equal(after.sections, undefined);
    assert.equal(after.closed?.by, 'auto');
  } finally {
    await s.remove();
  }
});
