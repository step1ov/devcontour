import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ContractChange } from '../src/runner/contract-change.ts';
import { stage } from './contract-change-fixture.ts';

/**
 * Этап меняет два контракта: схему каталога (операция A) и новый документ
 * заказов, ссылающийся на каталог (операция B). Оба коммитятся вместе, чтобы
 * ревьюер каждого видел соседа.
 */
async function twoContracts() {
  const s = await stage();
  await writeFile(
    join(s.repo, 'docs/contracts/orders.md'),
    '# Orders\n\nPrices come from catalog.md (number).\n',
  );
  s.sh('add', '.');
  s.sh('commit', '-qm', 'orders contract next to the catalog schema');
  const orders = { title: 'Orders API v1', file: 'docs/contracts/orders.md' };
  const start = async (proposal: unknown) =>
    ((await s.changes().start(proposal, 'codex')) as { operation: ContractChange }).operation;
  const a = await start(s.proposal);
  const b = await start(orders);
  const events = (id: string) =>
    s
      .changes()
      .get(id)
      .history.map((e) => e.event);
  const base = () => s.sh('rev-parse', 'devcontour/accepted');
  return { s, orders, a, b, events, base };
}

test('A stage changing two contracts moves the base once, without failures or stale operations', async () => {
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
    // B одобрен и переносит базу: схема каталога — одобренная редакция A.
    const done = await s.changes().advance(b.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(base(), s.sh('rev-parse', 'HEAD'), 'база — проверенный commit');
    const lift = done.history.find((e) => e.event === 'siblings');
    assert.match(lift?.detail ?? '', new RegExp(`schema\\.json \\(${waiting.contractId}\\)`));
    // A продолжает: переносить уже нечего.
    const finished = await s.changes().advance(a.id);
    assert.equal(finished.status, 'completed', finished.error);
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
    const waiting = await s.changes().advance(a.id);
    assert.equal(waiting.status, 'waiting', waiting.error);
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
    assert.equal((await s.changes().advance(b.id)).status, 'completed');
    assert.equal(base(), head);
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:docs/contracts/orders.md'),
      s.sh('rev-parse', 'HEAD:docs/contracts/orders.md'),
    );
    const finished = await s.changes().advance(a.id);
    assert.equal(finished.status, 'completed', finished.error);
    assert.ok(!events(a.id).includes('stale'));
  } finally {
    await s.remove();
  }
});

test('Unreviewed content does not move with a sibling: an edited approved artifact or an unrelated file stops the operation', async () => {
  const { s, a, b, base } = await twoContracts();
  try {
    const before = base();
    assert.equal((await s.changes().advance(a.id)).status, 'waiting');
    // Схему A правят после её одобрения: для B это путь живого соседа, но
    // blob уже не одобренный — перенос его не несёт.
    await writeFile(join(s.repo, 'schema.json'), '{"price":"boolean"}\n');
    s.sh('commit', '-qam', 'schema edited after approval');
    const refused = await s.changes().advance(b.id);
    assert.equal(refused.status, 'failed');
    assert.equal(refused.next, 'base');
    assert.match(refused.error ?? '', /вне контракта: schema\.json/);
    assert.match(refused.error ?? '', /base-update --by host/);
    assert.match(refused.error ?? '', new RegExp(`contract-change --id ${b.id}`));
    assert.equal(base(), before, 'база не сдвинута');
    // Сама A видит изменение своего артефакта и устаревает, как прежде.
    assert.equal((await s.changes().advance(a.id)).status, 'stale');
  } finally {
    await s.remove();
  }
  const r = await twoContracts();
  try {
    // Посторонний файл рядом с соседним контрактом: отказ называет только его.
    await writeFile(join(r.s.repo, 'unrelated.txt'), 'x\n');
    r.s.sh('add', 'unrelated.txt');
    r.s.sh('commit', '-qm', 'unrelated');
    const stale = await r.s.changes().advance(r.a.id);
    assert.equal(stale.status, 'stale', 'HEAD сдвинулся не только в соседях');
    r.s.changes().abandon(r.a.id);
    const again = (
      (await r.s.changes().start(r.s.proposal, 'codex')) as { operation: ContractChange }
    ).operation;
    const failed = await r.s.changes().advance(again.id);
    assert.equal(failed.status, 'failed', failed.error);
    assert.match(failed.error ?? '', /вне контракта: unrelated\.txt\./);
    assert.doesNotMatch(failed.error ?? '', /orders\.md/);
  } finally {
    await r.s.remove();
  }
});
