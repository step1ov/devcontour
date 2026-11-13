import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ContractChange } from '../src/runner/contract-change.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { baseUpdateOperation } from '../src/runner/base-update.ts';
import { pinContext, stalePins } from '../src/runner/context.ts';
import { loadConfig } from '../src/runner/config.ts';
import { input, reapprove } from './helpers.ts';
import { gitCommand, reviewers, stage } from './contract-change-fixture.ts';

/**
 * Этап меняет пять документов контрактов одним commit: две поправки
 * действующих контрактов, каждая своей операцией contract-change (каталог —
 * A, заказы — B), и три новых документа, зарегистрированных без операции
 * (`review-contract`). Документ заказов прежней редакции уже в базе.
 */
const NEW = ['payments', 'users', 'shipping'].map((n) => `docs/contracts/${n}.md`);
const ORDERS = 'docs/contracts/orders.md';
const orders = { title: 'Orders API v1', file: ORDERS };

async function fiveDocuments(
  options: { extra?: string; ordersTask?: boolean; ordersAmended?: boolean } = {},
) {
  const s = await stage();
  const head = () => s.sh('rev-parse', 'HEAD');
  const register = (proposal: unknown, at = head()) =>
    reviewContract(s.h, s.root, proposal, 'codex', reviewers([]), () => {}, at);
  // Действующий контракт заказов: зарегистрирован, его документ — в базе.
  await writeFile(join(s.repo, ORDERS), '# Orders\n\nPrices come from the catalog.\n');
  s.sh('add', '.');
  s.sh('commit', '-qm', 'orders v0');
  await register(orders);
  s.sh('branch', '-f', 'devcontour/accepted', 'HEAD');
  if (options.ordersTask) {
    const c = s.store.read().contracts.find((x) => x.source === ORDERS)!;
    s.h.addTask(s.h.createBoard('Orders').id, { ...input('Orders'), contracts: [c.id] });
  }
  await writeFile(
    join(s.repo, 'docs/contracts/catalog.md'),
    '# Catalog\n\nPrice is a number; payments read it (payments.md).\n',
  );
  if (options.ordersAmended !== false)
    await writeFile(join(s.repo, ORDERS), '# Orders\n\nPrices come from catalog.md (number).\n');
  for (const p of NEW) await writeFile(join(s.repo, p), `# ${p}\n\nReads catalog.md.\n`);
  if (options.extra) await writeFile(join(s.repo, options.extra), 'not a contract\n');
  s.sh('add', '.');
  s.sh('commit', '-qm', 'five contract documents together');
  for (const p of NEW) await register({ title: p, file: p });
  const start = async (proposal: unknown) =>
    ((await s.changes().start(proposal, 'codex')) as { operation: ContractChange }).operation;
  const op = (id: string) => s.changes().get(id);
  const events = (id: string) => op(id).history.map((e) => e.event);
  const base = () => s.sh('rev-parse', 'devcontour/accepted');
  const stopAfter = (id: string, step: string) =>
    s
      .changes((done) => {
        if (done === step) throw new Error('stop after ' + step);
      })
      .advance(id);
  return { s, head, register, start, op, events, base, stopAfter };
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

test('Two amendments and three new documents registered without an operation: one base move, no detour', async () => {
  const { s, start, head, events, base } = await fiveDocuments();
  try {
    const a = await start(s.proposal);
    const b = await start(orders);
    // B дошёл до базы первым: документ каталога ещё ведёт A — ожидание, а
    // новые документы без операции уже не посторонние.
    const waiting = await s.changes().advance(b.id);
    assert.equal(waiting.status, 'waiting', waiting.error);
    assert.deepEqual(waiting.waitingFor, [a.id]);
    const done = await s.changes().advance(a.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(base(), head(), 'база — проверенный commit этапа');
    const registered = done.history.find((e) => e.event === 'registered')?.detail ?? '';
    for (const p of NEW) {
      const c = s.store.read().contracts.find((x) => x.source === p)!;
      assert.match(registered, new RegExp(`${p.replace('.', '\\.')} \\(${c.id}\\)`));
    }
    assert.match(done.history.find((e) => e.event === 'siblings')?.detail ?? '', /orders\.md/);
    assert.equal(done.continued?.[0].id, b.id);
    assert.equal(done.continued?.[0].status, 'completed', done.continued?.[0].error);
    for (const id of [a.id, b.id]) {
      assert.ok(!events(id).includes('failed'), `${id}: без отказов`);
      assert.ok(!events(id).includes('stale'), `${id}: без устаревания`);
    }
  } finally {
    await s.remove();
  }
});

test('After an explicit base-update the stopped operations finish instead of going stale, even when HEAD moved', async () => {
  const { s, start, head, op, events, base } = await fiveDocuments({ extra: 'notes.txt' });
  try {
    const a = await start(s.proposal);
    const b = await start(orders);
    // Посторонний файл этапа: обе операции останавливаются на базе.
    const stoppedB = await s.changes().advance(b.id);
    assert.equal(stoppedB.status, 'failed');
    assert.match(stoppedB.error ?? '', /вне контракта: notes\.txt\./);
    const stoppedA = await s.changes().advance(a.id);
    assert.equal(stoppedA.status, 'failed');
    assert.equal(stoppedA.next, 'base');
    // Ведущий переносит базу явно, затем продолжает работу на ветке.
    const reviewed = head();
    await baseUpdateOperation(s.h, s.root, { by: 'host' });
    assert.equal(base(), reviewed);
    await writeFile(join(s.repo, 'later.txt'), 'next stage\n');
    s.sh('add', '.');
    s.sh('commit', '-qm', 'next stage work');
    for (const id of [a.id, b.id]) {
      const done = await s.changes().advance(id);
      assert.equal(done.status, 'completed', `${id}: ${done.error}`);
      assert.equal(op(id).expected.head, reviewed, 'HEAD не принят: шаги идут от проверенного');
      assert.ok(events(id).includes('head-moved'));
      const carried = done.history.find((e) => e.event === 'carried')?.detail ?? '';
      assert.match(carried, /уже содержит проверенную редакцию.*перенос вне операции/);
      assert.ok(!events(id).includes('stale'));
    }
    assert.equal(base(), reviewed, 'ничего сверх перенесённого не сдвинуто');
    // Без сдвига HEAD тот же путь: base-update, продолжение, завершение.
  } finally {
    await s.remove();
  }
  {
    const { s, start, events } = await fiveDocuments({ extra: 'notes.txt' });
    try {
      const a = await start(s.proposal);
      s.changes().abandon((await start(orders)).id);
      assert.equal((await s.changes().advance(a.id)).status, 'failed');
      await baseUpdateOperation(s.h, s.root, { by: 'host' });
      const done = await s.changes().advance(a.id);
      assert.equal(done.status, 'completed', done.error);
      assert.ok(!events(a.id).includes('head-moved'));
      assert.ok(events(a.id).includes('carried'));
    } finally {
      await s.remove();
    }
  }
});

test('A base that does not carry the reviewed redaction keeps the operation stale: edited after approval, base reset', async () => {
  for (const variant of ['edited', 'reset'] as const) {
    const { s, start, base } = await fiveDocuments({ extra: 'notes.txt' });
    try {
      const a = await start(s.proposal);
      s.changes().abandon((await start(orders)).id);
      assert.equal((await s.changes().advance(a.id)).status, 'failed');
      const before = base();
      if (variant === 'edited') {
        // Документ A правят после одобрения; base-update несёт правку.
        await writeFile(join(s.repo, 'docs/contracts/catalog.md'), '# Catalog\n\nPrice is text.\n');
        s.sh('commit', '-qam', 'catalog edited after approval');
        await baseUpdateOperation(s.h, s.root, { by: 'host' });
      } else {
        await baseUpdateOperation(s.h, s.root, { by: 'host' });
        execFileSync('git', ['update-ref', 'refs/heads/devcontour/accepted', before], {
          cwd: s.repo,
        });
        await writeFile(join(s.repo, 'later.txt'), 'next stage\n');
        s.sh('add', '.');
        s.sh('commit', '-qm', 'next stage work');
      }
      const stale = await s.changes().advance(a.id);
      assert.equal(stale.status, 'stale', variant);
      assert.match(stale.error ?? '', /сдвинулась/);
    } finally {
      await s.remove();
    }
  }
});

test('A registered document that is not the approved redaction is not carried; fixed and re-registered, the operation adopts HEAD', async () => {
  const { s, start, head, register, events, base } = await fiveDocuments();
  try {
    // Новый документ правят после его регистрации.
    await writeFile(join(s.repo, NEW[0]), '# payments\n\nEdited after review.\n');
    s.sh('commit', '-qam', 'payments edited after review');
    const a = await start(s.proposal);
    s.changes().abandon((await start(orders)).id);
    const before = base();
    const refused = await s.changes().advance(a.id);
    assert.equal(refused.status, 'failed');
    assert.equal(refused.next, 'base');
    assert.match(
      refused.error ?? '',
      /контрактов без операции, не годные[^:]*: (?:\S+, )*docs\/contracts\/payments\.md\./,
    );
    // Документ заказов отменённой B: её редакцию переносит только она.
    assert.match(refused.error ?? '', /docs\/contracts\/orders\.md/);
    assert.equal(base(), before, 'база не сдвинута');
    // Ведущий исправляет документ и регистрирует его снова; HEAD сдвинулся
    // только в документе контракта без операции — A его принимает.
    await writeFile(join(s.repo, NEW[0]), '# payments\n\nReads catalog.md, fixed.\n');
    s.sh('commit', '-qam', 'payments fixed');
    await register({ title: NEW[0], file: NEW[0] });
    // Черновик заказов отменённой B возвращён к редакции базы.
    await writeFile(join(s.repo, ORDERS), '# Orders\n\nPrices come from the catalog.\n');
    s.sh('commit', '-qam', 'orders draft withdrawn');
    const done = await s.changes().advance(a.id);
    assert.equal(done.status, 'completed', done.error);
    assert.ok(events(a.id).includes('rebased'));
    assert.equal(base(), head());
  } finally {
    await s.remove();
  }
});

test('Amendments registered without an operation are not carried with open work on the previous redaction or a changed mode', async () => {
  for (const variant of ['open-task', 'mode'] as const) {
    const { s, start, register, base } = await fiveDocuments({
      ordersTask: variant === 'open-task',
    });
    try {
      // Поправка заказов зарегистрирована review-contract, без операции.
      await register(orders);
      if (variant === 'mode') {
        s.sh('update-index', '--chmod=+x', ORDERS);
        s.sh('commit', '-qm', 'orders made executable');
      }
      const before = base();
      const a = await start(s.proposal);
      const refused = await s.changes().advance(a.id);
      assert.equal(refused.status, 'failed', variant);
      assert.match(
        refused.error ?? '',
        /контрактов без операции, не годные[^:]*: docs\/contracts\/orders\.md\./,
        variant,
      );
      assert.equal(base(), before, `${variant}: база не сдвинута`);
    } finally {
      await s.remove();
    }
  }
  // Без открытых задач и с прежним режимом та же поправка переносится.
  const { s, start, register, head, base } = await fiveDocuments();
  try {
    await register(orders);
    const done = await s.changes().advance((await start(s.proposal)).id);
    assert.equal(done.status, 'completed', done.error);
    assert.match(done.history.find((e) => e.event === 'registered')?.detail ?? '', /orders\.md/);
    assert.equal(base(), head());
  } finally {
    await s.remove();
  }
});

test('A pinned artifact of a contract registered without an operation is carried at its pinned blob and mode', async () => {
  for (const variant of ['carried', 'mode'] as const) {
    const s = await stage();
    try {
      const before = s.sh('rev-parse', 'devcontour/accepted');
      await writeFile(join(s.repo, 'docs/contracts/payments.md'), '# Payments\n\nSee schema.\n');
      await writeFile(join(s.repo, 'payments.schema.json'), '{"amount":"number"}\n');
      s.sh('add', '.');
      s.sh('commit', '-qm', 'payments contract');
      await reviewContract(
        s.h,
        s.root,
        {
          title: 'Payments',
          file: 'docs/contracts/payments.md',
          artifacts: [{ path: 'payments.schema.json', purpose: 'Схема' }],
        },
        'codex',
        reviewers([]),
        () => {},
        s.sh('rev-parse', 'HEAD'),
      );
      if (variant === 'mode') {
        s.sh('update-index', '--chmod=+x', 'payments.schema.json');
        s.sh('commit', '-qm', 'schema made executable');
      }
      const result = await s
        .changes()
        .advance(
          ((await s.changes().start(s.proposal, 'codex')) as { operation: ContractChange })
            .operation.id,
        );
      if (variant === 'carried') {
        assert.equal(result.status, 'completed', result.error);
        const detail = result.history.find((e) => e.event === 'registered')?.detail ?? '';
        assert.match(detail, /docs\/contracts\/payments\.md/);
        assert.match(detail, /payments\.schema\.json/);
        assert.equal(s.sh('rev-parse', 'devcontour/accepted'), s.sh('rev-parse', 'HEAD'));
      } else {
        assert.equal(result.status, 'failed');
        assert.match(result.error ?? '', /не годные[^:]*: payments\.schema\.json\./);
        assert.equal(s.sh('rev-parse', 'devcontour/accepted'), before);
      }
    } finally {
      await s.remove();
    }
  }
});

test('A registered document pinned in a context pack: the operation repins the pack; an operation without the context step refuses', async () => {
  for (const variant of ['repin', 'legacy'] as const) {
    const { s, start, register, base, stopAfter } = await fiveDocuments();
    try {
      // Пакет закреплён на базе: документ заказов прежней редакции.
      s.h.config.contextPacks = await pinContext(
        {
          ...s.h.config,
          contextPacks: [
            {
              id: 'orders-pack',
              version: '1.0',
              repositoryId: 'main',
              roles: ['backend'],
              files: [ORDERS],
              references: [],
            },
          ],
        },
        'devcontour/accepted',
      );
      for (const role of Object.values(s.h.config.roles)) {
        role.runtime = 'codex';
        if (role.reviewer) role.reviewer.runtime = 'claude';
      }
      s.h.config.reviewer = { ...s.h.config.reviewer, runtime: 'claude' };
      const path = join(s.root, 'config.json');
      await writeFile(path, JSON.stringify(s.h.config, null, 2) + '\n');
      s.h.config = loadConfig(path);
      reapprove(s.h);
      const pinned = s.h.config.contextPacks[0].revision;
      await register(orders);
      const amended = s.store.read().contracts.at(-1)!;
      assert.deepEqual(await stalePins(s.h.config, amended), ['orders-pack']);
      const a = await start(s.proposal);
      const before = base();
      if (variant === 'repin') {
        const done = await s.changes().advance(a.id);
        assert.equal(done.status, 'completed', done.error);
        assert.match(done.history.find((e) => e.event === 'repinned')?.detail ?? '', /orders-pack/);
        const repinned = loadConfig(path).contextPacks[0].revision;
        assert.notEqual(repinned, pinned);
        assert.equal(repinned, s.changes().get(a.id).expected.head);
        assert.deepEqual(await stalePins(loadConfig(path), amended), []);
      } else {
        assert.equal((await stopAfter(a.id, 'rebind')).next, 'base');
        s.store.atomic(() => {
          const current = s.changes().get(a.id);
          s.store.saveLocal('contract-change', current.owner, current.id, {
            ...current,
            order: 2,
          });
        });
        const refused = await s.changes().advance(a.id);
        assert.equal(refused.status, 'failed');
        assert.match(
          refused.error ?? '',
          /context pack у операции без шага context\): docs\/contracts\/orders\.md\./,
        );
        assert.equal(base(), before);
      }
    } finally {
      await s.remove();
    }
  }
});

test('A newer redaction of a registered document, or an operation taking it, while the base move is in flight: the ref does not move', async () => {
  for (const variant of ['newer', 'taken'] as const) {
    const { s, start, base } = await fiveDocuments({ ordersAmended: false });
    try {
      const fresh = await start(s.proposal);
      const before = base();
      const refused = await beforeRefMove(
        () => {
          if (variant === 'newer')
            s.store.change('fixture.newer-redaction', (st) => {
              const c = st.contracts.find((x) => x.source === NEW[0])!;
              st.contracts.push({ ...c, id: c.id + '-newer', previous: c.id });
            });
          else
            s.store.atomic(() =>
              s.store.saveLocal('contract-change', 'main', 'CC-taken', {
                ...s.changes().get(fresh.id),
                id: 'CC-taken',
                key: 'main:payments',
                proposal: { title: NEW[0], file: NEW[0] },
                status: 'queued',
                step: 0,
                token: undefined,
                leaseUntil: undefined,
                contractId: undefined,
                history: [],
              }),
            );
        },
        () => s.changes().advance(fresh.id),
      );
      assert.equal(refused.status, 'failed', variant);
      assert.match(refused.error ?? '', /Соседний контракт изменился во время переноса базы/);
      assert.match(refused.error ?? '', /payments\.md/);
      assert.equal(base(), before, `${variant}: база не сдвинута`);
    } finally {
      await s.remove();
    }
  }
});
