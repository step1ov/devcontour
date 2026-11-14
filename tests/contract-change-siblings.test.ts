import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ContractChange } from '../src/runner/contract-change.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { repositories } from '../src/core/repositories.ts';
import { AttentionService } from '../src/application/attention.ts';
import { input } from './helpers.ts';
import { gitCommand, reviewers, stage } from './contract-change-fixture.ts';

/**
 * Этап меняет два контракта одним commit: документ и схему каталога
 * (операция A) и новый документ заказов, ссылающийся на каталог (операция B).
 * Ревьюер каждого видит соседа.
 */
async function twoContracts() {
  const s = await stage();
  await writeFile(
    join(s.repo, 'docs/contracts/catalog.md'),
    '# Catalog\n\nPrice is a number; orders read it (orders.md).\n',
  );
  await writeFile(
    join(s.repo, 'docs/contracts/orders.md'),
    '# Orders\n\nPrices come from catalog.md (number).\n',
  );
  s.sh('add', '.');
  s.sh('commit', '-qm', 'catalog and orders contracts together');
  const orders = { title: 'Orders API v1', file: 'docs/contracts/orders.md' };
  const start = async (proposal: unknown) =>
    ((await s.changes().start(proposal, 'codex')) as { operation: ContractChange }).operation;
  const a = await start(s.proposal);
  const b = await start(orders);
  const op = (id: string) => s.changes().get(id);
  const events = (id: string) => op(id).history.map((e) => e.event);
  const base = () => s.sh('rev-parse', 'devcontour/accepted');
  /** Остановить операцию после шага (имитация сбоя процесса). */
  const stopAfter = (id: string, step: string) =>
    s
      .changes((done) => {
        if (done === step) throw new Error('stop after ' + step);
      })
      .advance(id);
  return { s, orders, a, b, op, events, base, stopAfter };
}

/** Вызов git перед сдвигом ref базы: последний `rev-list` переноса. */
async function beforeRefMove<T>(hook: () => void, run: () => Promise<T>) {
  const realSpawn = cp.spawn;
  let fired = false;
  cp.spawn = function (this: unknown, command: string, args: string[], options: unknown) {
    if (
      !fired &&
      command === 'git' &&
      gitCommand(args)[0] === 'rev-list' &&
      String(gitCommand(args)[2] ?? '').endsWith('..refs/heads/devcontour/accepted')
    ) {
      fired = true;
      hook();
    }
    return realSpawn.call(this, command, args, options as never);
  } as typeof cp.spawn;
  syncBuiltinESMExports();
  try {
    const result = await run();
    assert.ok(fired, 'окно перед сдвигом ref достигнуто');
    return result;
  } finally {
    cp.spawn = realSpawn;
    syncBuiltinESMExports();
  }
}

test('Two contract documents committed together: the base moves once, the waiting operation continues by itself', async () => {
  const { s, a, b, events, base } = await twoContracts();
  try {
    const before = base();
    // A дошёл до базы раньше соседа: документ заказов ещё не одобрен —
    // ожидание операции B, а не отказ и не перенос.
    const waiting = await s.changes().advance(a.id);
    assert.equal(waiting.status, 'waiting', waiting.error);
    assert.equal(waiting.next, 'base');
    assert.deepEqual(waiting.waitingFor, [b.id]);
    assert.equal(base(), before, 'база не сдвинута');
    assert.match(
      waiting.history.at(-1)?.detail ?? '',
      new RegExp(`docs/contracts/orders\\.md.*${b.id}.*contract-change --id ${a.id}`),
    );
    // B одобрен и переносит базу: документ и схема каталога — одобренная
    // редакция A. Затем A продолжается сам.
    const done = await s.changes().advance(b.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(base(), s.sh('rev-parse', 'HEAD'), 'база — проверенный commit');
    const lift = done.history.find((e) => e.event === 'siblings')?.detail ?? '';
    assert.match(lift, new RegExp(`docs/contracts/catalog\\.md \\(${waiting.contractId}\\)`));
    assert.match(lift, new RegExp(`schema\\.json \\(${waiting.contractId}\\)`));
    assert.equal(done.continued?.length, 1);
    assert.equal(done.continued?.[0].id, a.id);
    assert.equal(done.continued?.[0].status, 'completed', done.continued?.[0].error);
    const carried = s
      .changes()
      .get(a.id)
      .history.find((e) => e.event === 'carried');
    assert.match(carried?.detail ?? '', new RegExp(`перенесла операция ${b.id}`));
    for (const id of [a.id, b.id]) {
      assert.ok(!events(id).includes('failed'), `${id}: без отказов`);
      assert.ok(!events(id).includes('stale'), `${id}: без устаревания`);
    }
    assert.equal(s.task(s.api.id).hold, undefined, 'удержание снято');
  } finally {
    await s.remove();
  }
});

test('A sibling document fixed after its operation started does not make the waiting operation stale', async () => {
  const { s, orders, a, b, events, base } = await twoContracts();
  try {
    assert.equal((await s.changes().advance(a.id)).status, 'waiting');
    // Документ соседа исправлен и закоммичен: HEAD сдвинулся только в нём.
    await writeFile(
      join(s.repo, 'docs/contracts/orders.md'),
      '# Orders\n\nPrices come from catalog.md (number, in cents).\n',
    );
    s.sh('commit', '-qam', 'fix orders');
    const head = s.sh('rev-parse', 'HEAD');
    const revised = await s
      .changes()
      .revise(b.id, s.changes().get(b.id).version!, undefined, orders);
    assert.equal(revised.status, 'revised');
    const again = await s.changes().advance(a.id);
    assert.equal(again.status, 'waiting', again.error);
    assert.equal(s.changes().get(a.id).expected.head, head, 'A принял новый HEAD');
    assert.ok(events(a.id).includes('rebased'));
    const done = await s.changes().advance(b.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(base(), head);
    assert.equal(done.continued?.[0].status, 'completed');
    assert.ok(!events(a.id).includes('stale'));
  } finally {
    await s.remove();
  }
});

test('A sibling document or artifact changed after its approval is not carried: content, mode', async () => {
  for (const edit of ['document', 'mode'] as const) {
    const { s, a, b, base } = await twoContracts();
    try {
      const before = base();
      assert.equal((await s.changes().advance(a.id)).status, 'waiting');
      if (edit === 'document') {
        await writeFile(join(s.repo, 'docs/contracts/catalog.md'), '# Catalog\n\nPrice is text.\n');
        s.sh('commit', '-qam', 'catalog edited after approval');
      } else {
        // Тот же blob, бит исполнения: ревью A его не видело.
        s.sh('update-index', '--chmod=+x', 'schema.json');
        s.sh('commit', '-qm', 'schema made executable after approval');
      }
      const path = edit === 'document' ? 'docs/contracts/catalog\\.md' : 'schema\\.json';
      const refused = await s.changes().advance(b.id);
      assert.equal(refused.status, 'failed', edit);
      assert.equal(refused.next, 'base');
      assert.match(refused.error ?? '', new RegExp(`не в одобренной редакции[^.]*${path}`));
      assert.match(refused.error ?? '', /base-update --by host/);
      assert.match(refused.error ?? '', new RegExp(`contract-change --id ${b.id}`));
      assert.equal(base(), before, `${edit}: база не сдвинута`);
      // Сама A видит изменение своего пути и устаревает, как прежде.
      assert.equal((await s.changes().advance(a.id)).status, 'stale', edit);
    } finally {
      await s.remove();
    }
  }
});

test('A waited-for sibling abandoned after review: the waiting operation is surfaced, and its resume refuses and names it', async () => {
  const { s, a, b, base, stopAfter } = await twoContracts();
  try {
    const before = base();
    assert.equal((await s.changes().advance(a.id)).status, 'waiting');
    assert.equal((await stopAfter(b.id, 'review')).next, 'rebind');
    const attention = async () =>
      (await new AttentionService(s.store, s.h).active()).items.find(
        (i) => i.sourceKey === `contract-change:${a.id}`,
      );
    assert.equal(await attention(), undefined, 'сосед ещё идёт к базе');
    s.changes().abandon(b.id);
    assert.equal(s.changes().stalledWait(s.changes().get(a.id)), true);
    const card = await attention();
    assert.ok(card, 'ожидание без соседей видно ведущему');
    assert.equal(card.actor, 'lead');
    assert.match(card.reason, new RegExp(`contract-change --id ${a.id}`));
    const refused = await s.changes().advance(a.id);
    assert.equal(refused.status, 'failed');
    // Редакцию отменённого соседа зарегистрировала незавершённая операция:
    // как контракт без операции она не переносится.
    assert.match(
      refused.error ?? '',
      /контрактов без операции, не годные[^:]*: docs\/contracts\/orders\.md\./,
    );
    assert.match(refused.error ?? '', new RegExp(`${b.id} \\(abandoned\\)`));
    assert.equal(base(), before, 'одобренная редакция отменённого соседа не перенесена');
  } finally {
    await s.remove();
  }
});

test('A sibling revised after review: its successor is waited for and the earlier redaction does not move', async () => {
  const { s, orders, a, b, base, stopAfter } = await twoContracts();
  try {
    const before = base();
    assert.equal((await s.changes().advance(a.id)).status, 'waiting');
    assert.equal((await stopAfter(b.id, 'review')).next, 'rebind');
    await writeFile(
      join(s.repo, 'docs/contracts/orders.md'),
      '# Orders\n\nPrices come from catalog.md (number, two decimals).\n',
    );
    s.sh('commit', '-qam', 'orders fixed after review');
    const next = await s.changes().revise(b.id, s.changes().get(b.id).version!, undefined, orders);
    assert.equal(next.status, 'superseded');
    const successor = next.operation.id;
    const waiting = await s.changes().advance(a.id);
    assert.equal(waiting.status, 'waiting', waiting.error);
    assert.deepEqual(waiting.waitingFor, [successor]);
    assert.equal(base(), before);
    const done = await s.changes().advance(successor);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:docs/contracts/orders.md'),
      s.sh('rev-parse', 'HEAD:docs/contracts/orders.md'),
    );
    assert.equal(done.continued?.[0].status, 'completed');
  } finally {
    await s.remove();
  }
});

test('A newer redaction of the sibling document, registered meanwhile, stops the carry', async () => {
  const { s, a, b, base, stopAfter } = await twoContracts();
  try {
    const before = base();
    assert.equal((await s.changes().advance(a.id)).status, 'waiting');
    // B прошёл ревью; затем его документу зарегистрировали новую редакцию
    // (тот же текст, другая запись).
    assert.equal((await stopAfter(b.id, 'review')).next, 'rebind');
    s.store.change('fixture.newer-redaction', (st) => {
      const c = st.contracts.find((x) => x.id === s.changes().get(b.id).contractId)!;
      st.contracts.push({ ...c, id: c.id + '-newer' });
    });
    // B дошёл до шага базы: A продолжается сам и не несёт документ B.
    const stopped = await stopAfter(b.id, 'rebind');
    assert.equal(stopped.next, 'base');
    const refused = stopped.continued?.[0];
    assert.equal(refused?.id, a.id);
    assert.equal(refused?.status, 'failed');
    assert.match(refused?.error ?? '', /не в одобренной редакции[^.]*docs\/contracts\/orders\.md/);
    assert.equal(base(), before);
  } finally {
    await s.remove();
  }
});

test('An artifact pinned differently by another contract of open work: the operation refuses at once instead of waiting', async () => {
  const { s, a, base } = await twoContracts();
  try {
    const before = base();
    // Ещё один договор открытой работы закрепляет схему в прежней редакции.
    await reviewContract(
      s.h,
      s.root,
      {
        title: 'Pricing',
        content: '# Pricing\n\nUses schema.json.\n',
        artifacts: [{ path: 'schema.json', purpose: 'Схема' }],
      },
      'codex',
      reviewers([]),
      () => {},
      before,
    );
    const pricing = s.store.read().contracts.at(-1)!;
    s.h.addTask(s.h.createBoard('Pricing').id, { ...input('Pricing'), contracts: [pricing.id] });
    const refused = await s.changes().advance(a.id);
    assert.equal(refused.status, 'failed', refused.error);
    assert.equal(refused.next, 'base');
    assert.match(refused.error ?? '', /не смогут перенести пути этой \(schema\.json\)/);
    assert.equal(base(), before);
  } finally {
    await s.remove();
  }
});

test('No adoption when HEAD is rewritten or after the base move: stale unless the base carries the reviewed redaction', async () => {
  {
    const { s, a } = await twoContracts();
    try {
      assert.equal((await s.changes().advance(a.id)).status, 'waiting');
      // История переписана: новый HEAD — не потомок проверенного.
      s.sh('reset', '-q', '--hard', 'HEAD~1');
      await writeFile(
        join(s.repo, 'docs/contracts/catalog.md'),
        '# Catalog\n\nPrice is a number; orders read it (orders.md).\n',
      );
      await writeFile(join(s.repo, 'docs/contracts/orders.md'), '# Orders\n\nRewritten.\n');
      s.sh('add', '.');
      s.sh('commit', '-qm', 'rewritten stage');
      const stale = await s.changes().advance(a.id);
      assert.equal(stale.status, 'stale');
      assert.match(stale.error ?? '', /сдвинулась/);
    } finally {
      await s.remove();
    }
  }
  {
    const { s, a, b } = await twoContracts();
    try {
      assert.equal((await s.changes().advance(a.id)).status, 'waiting');
      // B переносит базу и останавливается; A продолжается и тоже
      // останавливается после своего шага базы.
      const stopped = await s
        .changes((step) => {
          if (step === 'base') throw new Error('stop after base');
        })
        .advance(b.id);
      assert.equal(stopped.next, 'context');
      assert.equal(stopped.continued?.[0].next, 'context');
      // После переноса базы HEAD не принимается: операция, чья проверенная
      // редакция уже в базе, продолжается по проверенному commit.
      const reviewed = s.changes().get(b.id).expected.head;
      await writeFile(join(s.repo, 'docs/contracts/catalog.md'), '# Catalog\n\nLater.\n');
      s.sh('commit', '-qam', 'catalog later');
      const done = await s.changes().advance(b.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(s.changes().get(b.id).expected.head, reviewed, 'HEAD не принят');
      assert.ok(done.history.some((e) => e.event === 'head-moved'));
      // Для A это правка своего документа после ревью: устаревание с
      // объяснением, а не завершение по прежнему тексту.
      const stale = await s.changes().advance(a.id);
      assert.match(stale.error ?? '', /меняет документ или артефакты этой операции после её ревью/);
      assert.equal(stale.status, 'stale');
    } finally {
      await s.remove();
    }
  }
});

test('A sibling of another component is neither waited for nor carried', async () => {
  const { s, a, b, base } = await twoContracts();
  try {
    const before = base();
    s.changes().abandon(b.id);
    const [main] = repositories(s.h.config);
    s.h.config.repositories = [main, { ...main, id: 'web', name: 'Web' }];
    s.store.atomic(() =>
      s.store.saveLocal('contract-change', 'web', 'CC-web', {
        ...s.changes().get(b.id),
        id: 'CC-web',
        key: 'web:orders',
        owner: 'web',
        status: 'queued',
        step: 0,
        history: [],
      }),
    );
    const refused = await s.changes().advance(a.id);
    assert.equal(refused.status, 'failed', refused.error);
    assert.match(refused.error ?? '', /вне контракта: docs\/contracts\/orders\.md\./);
    assert.equal(base(), before);
  } finally {
    await s.remove();
  }
});

test('A sibling abandoned while the base move is in flight: the ref does not move', async () => {
  const { s, a, b, base } = await twoContracts();
  try {
    const before = base();
    assert.equal((await s.changes().advance(a.id)).status, 'waiting');
    const refused = await beforeRefMove(
      () => s.changes().abandon(a.id),
      () => s.changes().advance(b.id),
    );
    assert.equal(refused.status, 'failed');
    assert.match(refused.error ?? '', /Соседний контракт изменился во время переноса базы/);
    assert.equal(base(), before, 'база не сдвинута');
  } finally {
    await s.remove();
  }
});

test('A newer redaction of the sibling document registered while the base move is in flight: the ref does not move', async () => {
  const { s, a, b, base } = await twoContracts();
  try {
    const before = base();
    const waiting = await s.changes().advance(a.id);
    assert.equal(waiting.status, 'waiting');
    // Сосед жив и с тем же contractId: перенос останавливает сверка самой
    // редакции (siblingLiftHolds), а не живость операции.
    const refused = await beforeRefMove(
      () =>
        s.store.change('fixture.newer-redaction', (st) => {
          const c = st.contracts.find((x) => x.id === waiting.contractId)!;
          st.contracts.push({ ...c, id: c.id + '-newer' });
        }),
      () => s.changes().advance(b.id),
    );
    assert.equal(refused.status, 'failed');
    assert.match(refused.error ?? '', /Соседний контракт изменился во время переноса базы/);
    assert.ok(
      !s
        .changes()
        .get(b.id)
        .history.some((e) => e.event === 'moved'),
      'B ref не сдвинул',
    );
    // A, ждавший B, продолжается сам и переносит базу уже своим ревью
    // (свои пути), а не снятием из транзакции B.
    const moved = s
      .changes()
      .get(a.id)
      .history.some((e) => e.event === 'moved');
    assert.equal(base() !== before, moved, 'база сдвинута только переносом A');
  } finally {
    await s.remove();
  }
});

test('Two operations moving the same base: the one that loses the ref race continues', async () => {
  const { s, a, b, base } = await twoContracts();
  try {
    assert.equal((await s.changes().advance(a.id)).status, 'waiting');
    const head = s.sh('rev-parse', 'HEAD');
    // Другой перенос сдвигает базу на тот же commit прямо перед сдвигом B.
    const done = await beforeRefMove(
      () =>
        execFileSync('git', ['update-ref', 'refs/heads/devcontour/accepted', head], {
          cwd: s.repo,
        }),
      () => s.changes().advance(b.id),
    );
    assert.equal(done.status, 'completed', done.error);
    assert.ok(done.history.some((e) => e.event === 'carried'));
    assert.equal(base(), head);
  } finally {
    await s.remove();
  }
});
