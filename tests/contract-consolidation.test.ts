import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import {
  contractDigest,
  contractForks,
  contractRedactionsOf,
  currentText,
  meaningRedactionsSinceConsolidation,
  newerRedaction,
  supersededBy,
} from '../src/core/service.ts';
import { reviewedRedaction } from '../src/runner/sensitive-paths.ts';
import { recordSchema } from '../src/core/sync-model.ts';
import { recordsFromState, stateFromRecords } from '../src/core/sync-state.ts';
import type { Approval, Contract } from '../src/core/model.ts';
import { AgentContext } from '../src/application/context.ts';

const SOURCE = 'docs/contracts/api.md';
/** Одобрение независимого ревью: годно для снятия переноса базы. */
const agent: Approval = {
  actor: 'agent',
  authorRuntime: 'codex',
  reviewerRuntime: 'claude',
  artifact: '/tmp/decisions/fixture',
};

function registry() {
  const f = fixture();
  const b = f.h.createBoard('Board');
  const c1 = f.h.contract('API', 'Rule REQ-1.\n\nRule REQ-2.\n', agent, undefined, SOURCE);
  const t = f.h.addTask(b.id, { ...input('Task'), contracts: [c1.id] });
  f.h.approve(b.id);
  const task = () => f.store.read().tasks.find((x) => x.id === t.id)!;
  return { ...f, b, c1, t, task };
}

test('F20: a consolidation keeps bindings: the predecessor is not superseded, approvable keeps its digest; an amendment after it supersedes both', () => {
  const f = registry();
  try {
    const before = f.task();
    assert.equal(before.status, 'ready');
    const c2 = f.h.contract('API', 'REQ-1, REQ-2.\n', agent, undefined, SOURCE, [], undefined, [], {
      from: f.c1.id,
      review: 'R-1',
    });
    const contracts = () => f.store.read().contracts;
    assert.deepEqual(c2.consolidates, { from: f.c1.id, review: 'R-1' });
    assert.equal(supersededBy(contracts(), f.c1.id), undefined);
    assert.equal(newerRedaction(contracts(), f.c1.id)?.id, c2.id, 'текст заменён');
    assert.equal(currentText(contracts(), f.c1.id)?.id, c2.id);
    // Задача прежней редакции утверждаема без перепривязки, с прежним digest.
    assert.deepEqual(f.h.approvable(f.store.read(), f.task()), { [f.c1.id]: f.c1.digest });
    assert.deepEqual(f.task().contractDigests, before.contractDigests);
    assert.equal(f.task().approvedDigest, before.approvedDigest);
    // Консолидация консолидации — та же цепочка.
    const c3 = f.h.contract('API', 'REQ-1,REQ-2\n', agent, undefined, SOURCE, [], undefined, [], {
      from: c2.id,
      review: 'R-2',
    });
    assert.equal(supersededBy(contracts(), f.c1.id), undefined);
    assert.equal(currentText(contracts(), f.c1.id)?.id, c3.id);
    // Смысловая редакция после консолидаций заменяет все прежние id.
    const c4 = f.h.contract('API', 'REQ-1, REQ-2, REQ-3.\n', agent, undefined, SOURCE);
    for (const id of [f.c1.id, c2.id, c3.id])
      assert.equal(supersededBy(contracts(), id)?.id, c4.id);
    assert.equal(supersededBy(contracts(), c4.id), undefined);
    assert.throws(
      () => f.h.approvable(f.store.read(), f.task()),
      new RegExp(`${f.c1.id} заменён редакцией ${c4.id}`),
    );
    // Считаются смысловые редакции после последней консолидации.
    assert.equal(meaningRedactionsSinceConsolidation(contracts(), SOURCE, undefined), 1);
  } finally {
    f.cleanup();
  }
});

test('F20: a consolidation must name the current redaction and keep artifacts, checks and underTest', () => {
  const f = registry();
  try {
    const c2 = f.h.contract('API', 'v2 REQ-1 REQ-2', agent, undefined, SOURCE);
    // Не действующая редакция — отказ.
    assert.throws(
      () =>
        f.h.contract('API', 'short', agent, undefined, SOURCE, [], undefined, [], {
          from: f.c1.id,
          review: 'R',
        }),
      /действующей редакции/,
    );
    // Другие обязательства (артефакт) — отказ.
    assert.throws(
      () =>
        f.h.contract(
          'API',
          'short',
          agent,
          undefined,
          SOURCE,
          [
            {
              repositoryId: 'main',
              path: 'schema.json',
              purpose: 'Схема',
              revision: 'a'.repeat(40),
              blob: 'b'.repeat(40),
              digest: 'c'.repeat(64),
            },
          ],
          undefined,
          [],
          { from: c2.id, review: 'R' },
        ),
      /artifacts, checks и underTest/,
    );
    assert.equal(f.store.read().contracts.length, 2, 'ничего не зарегистрировано');
  } finally {
    f.cleanup();
  }
});

test('F20: an open task bound to the consolidated predecessor does not hold the reviewed base move; after an amendment it does', () => {
  const f = registry();
  try {
    const c2 = f.h.contract('API', 'REQ-1 REQ-2', agent, undefined, SOURCE, [], undefined, [], {
      from: f.c1.id,
      review: 'R',
    });
    assert.equal(f.task().status, 'ready');
    assert.equal(reviewedRedaction(f.h.config, f.store.read(), 'main', SOURCE)?.id, c2.id);
    f.h.contract('API', 'REQ-1 REQ-2 REQ-3', agent, undefined, SOURCE);
    assert.equal(reviewedRedaction(f.h.config, f.store.read(), 'main', SOURCE), undefined);
  } finally {
    f.cleanup();
  }
});

test('F20: task_briefing shows the current text of a consolidated contract', () => {
  const f = registry();
  try {
    const c2 = f.h.contract('API', 'REQ-1; REQ-2.', agent, undefined, SOURCE, [], undefined, [], {
      from: f.c1.id,
      review: 'R',
    });
    const brief = JSON.stringify(
      new AgentContext(f.h).execute('task_briefing', { taskId: f.t.id }),
    );
    assert.match(brief, /REQ-1; REQ-2\./);
    assert.ok(brief.includes(c2.id));
    assert.ok(!brief.includes('Rule REQ-1.'), 'прежний текст не показан');
  } finally {
    f.cleanup();
  }
});

/** Запись контракта для Git sync в форме экспорта. */
const syncRecord = (c: ReturnType<typeof registry>['c1'], extra: Record<string, unknown> = {}) => ({
  version: 1,
  kind: 'contract',
  data: {
    id: c.id,
    title: c.title,
    content: c.content,
    digest: c.digest,
    source: c.source,
    approvedAt: c.approvedAt,
    ...extra,
  },
});

test('F20: sync carries consolidates; a record of an older peer without it still validates; a forged consolidation is refused', () => {
  const f = registry();
  try {
    const c2 = f.h.contract('API', 'REQ-1 REQ-2', agent, undefined, SOURCE, [], undefined, [], {
      from: f.c1.id,
      review: 'R-1',
    });
    // Клон прежней версии не знает поля: его запись проходит строгую схему.
    assert.equal(recordSchema.safeParse(syncRecord(f.c1)).success, true);
    const parsed = recordSchema.parse(syncRecord(c2, { consolidates: c2.consolidates }));
    assert.deepEqual((parsed.data as { consolidates?: unknown }).consolidates, {
      from: f.c1.id,
      review: 'R-1',
    });
    assert.equal(
      recordSchema.safeParse(syncRecord(c2, { consolidates: { from: f.c1.id } })).success,
      false,
      'без review — не консолидация',
    );
    // Экспорт и импорт состояния: обе редакции и задача на прежней — привязка
    // и утверждение сохраняются в другом клоне.
    const empty = { ...f.store.read(), contracts: [], tasks: [], boards: [] };
    const exported = recordsFromState(f.h, f.store.read());
    const imported = stateFromRecords(f.h, empty, exported, new Map());
    assert.deepEqual(imported.contracts.find((c) => c.id === c2.id)?.consolidates, c2.consolidates);
    assert.equal(supersededBy(imported.contracts, f.c1.id), undefined);
    const task = imported.tasks.find((t) => t.id === f.t.id)!;
    assert.equal(task.status, 'ready');
    assert.deepEqual(task.contractDigests, { [f.c1.id]: f.c1.digest });
    // Ссылка на неизвестную редакцию — отказ всего импорта.
    const forged = new Map<string | undefined, Record<string, unknown>>([
      [undefined, { b: syncRecord(c2, { consolidates: { from: 'C-unknown', review: 'R-1' } }) }],
    ]);
    assert.throws(
      () => stateFromRecords(f.h, empty, forged as never, new Map()),
      /Редакция контракта .* не принята: консолидация: нет консолидируемой редакции/,
    );
  } finally {
    f.cleanup();
  }
});

/** Экспорт состояния и импорт в пустой клон после правки записей `patch`. */
type Records = Record<string, { kind: string; data: ContractData }>;
type ContractData = {
  id: string;
  previous?: string;
  content: string;
  digest: string;
  consolidates?: { from: string; review: string };
};
function reimport(
  f: ReturnType<typeof registry>,
  patch: (records: Records) => void,
  /** Клон, который уже знает записи (повторный импорт), а не пустой. */
  known = false,
) {
  const empty = known
    ? f.store.read()
    : { ...f.store.read(), contracts: [], tasks: [], boards: [] };
  const exported = recordsFromState(f.h, f.store.read());
  for (const records of exported.values()) patch(records as unknown as Records);
  return stateFromRecords(f.h, empty, exported, new Map());
}
const contractRecord = (records: Records, id: string) =>
  Object.values(records).find((r) => r.kind === 'contract' && r.data.id === id);

test('F20 M1: import re-checks a consolidation: the immediately preceding redaction, shorter text, ids kept', () => {
  const f = registry();
  try {
    const m = f.h.contract(
      'API',
      'Rule REQ-1.\n\nRule REQ-2.\n\nAmended.\n',
      agent,
      undefined,
      SOURCE,
    );
    const c = f.h.contract(
      'API',
      'REQ-1 REQ-2 amended',
      agent,
      undefined,
      SOURCE,
      [],
      undefined,
      [],
      {
        from: m.id,
        review: 'R-1',
      },
    );
    assert.equal(c.previous, m.id);
    // Честная запись проходит.
    assert.equal(supersededBy(reimport(f, () => {}).contracts, m.id), undefined);
    // Консолидация не непосредственно предыдущей редакции.
    assert.throws(
      () =>
        reimport(f, (r) => {
          const rec = contractRecord(r, c.id);
          if (rec) rec.data.consolidates = { from: f.c1.id, review: 'R-1' };
        }),
      /не непосредственно предыдущей редакции/,
    );
    // Подделанный текст: пропал ID правила (digest пересчитан честно).
    assert.throws(
      () =>
        reimport(f, (r) => {
          const rec = contractRecord(r, c.id);
          if (!rec) return;
          rec.data.content = 'REQ-1 amended';
          rec.data.digest = contractDigest(rec.data.content, undefined, undefined);
        }),
      /нет ID правил REQ-2/,
    );
    // Текст не короче.
    assert.throws(
      () =>
        reimport(f, (r) => {
          const rec = contractRecord(r, c.id);
          if (!rec) return;
          rec.data.content = 'Rule REQ-1.\n\nRule REQ-2.\n\nAmended, but longer than before.\n';
          rec.data.digest = contractDigest(rec.data.content, undefined, undefined);
        }),
      /не короче/,
    );
  } finally {
    f.cleanup();
  }
});

test('F20 M1: a concurrent amendment of the consolidated redaction replaces the consolidation (safe order)', () => {
  const f = registry();
  try {
    const base = f.store.read().contracts[0];
    // Два клона: поправка M и консолидация F одной редакции c1; поправка
    // утверждена раньше по часам — порядок всё равно ставит F сразу за c1.
    const at = (iso: string) => ({ approvedAt: iso });
    const m = {
      ...base,
      id: 'C-amend',
      content: 'Rule REQ-1.\n\nRule REQ-2 amended.\n',
      previous: f.c1.id,
      ...at('2020-01-01T00:00:00.000Z'),
    };
    const fc = {
      ...base,
      id: 'C-consolidate',
      content: 'REQ-1, REQ-2.',
      previous: f.c1.id,
      consolidates: { from: f.c1.id, review: 'R' },
      ...at('2020-01-02T00:00:00.000Z'),
    };
    for (const contracts of [
      [f.c1, m, fc],
      [fc, m, f.c1],
    ]) {
      assert.deepEqual(
        contractRedactionsOf(contracts, SOURCE, undefined).map((c) => c.id),
        [f.c1.id, fc.id, m.id],
      );
      assert.equal(supersededBy(contracts, f.c1.id)?.id, m.id);
      assert.equal(supersededBy(contracts, fc.id)?.id, m.id);
      assert.equal(supersededBy(contracts, m.id), undefined);
      assert.equal(meaningRedactionsSinceConsolidation(contracts, SOURCE, undefined), 1);
    }
  } finally {
    f.cleanup();
  }
});

test('F20 R2-H1: import checks run once, for records new to the clone: a later sibling linking to a removed anchor or a consolidation accepted under older rules does not block sync', () => {
  const f = registry();
  try {
    const a = f.h.contract(
      'API',
      '# API\n\n## Old\n\nREQ-1 old rule.\n\n## New\n\nREQ-2.\n',
      agent,
      undefined,
      SOURCE,
    );
    // Законная консолидация: на «Old» никто не ссылается.
    f.h.contract(
      'API',
      '# API\n\n## New\n\nREQ-1, REQ-2.\n',
      agent,
      undefined,
      SOURCE,
      [],
      undefined,
      [],
      {
        from: a.id,
        review: 'R-1',
      },
    );
    // Позже сосед ссылается на убранный раздел.
    f.h.contract(
      'Orders',
      'See api.md#old for prices.',
      agent,
      undefined,
      'docs/contracts/orders.md',
    );
    reimport(f, () => {});
    reimport(f, () => {}, true);
    // Консолидация, принятая этим клоном раньше (здесь — зарегистрированная
    // без проверки текста, как запись прежних правил), не пересуживается при
    // повторном импорте; новому клону она не передаётся.
    const lossy = f.h.contract('API', 'REQ-2 only.', agent, undefined, SOURCE, [], undefined, [], {
      from: f.store.read().contracts.find((c) => c.source === SOURCE && c.consolidates)!.id,
      review: 'R-2',
    });
    assert.ok(lossy.consolidates);
    reimport(f, () => {}, true);
    assert.throws(() => reimport(f, () => {}), /нет ID правил REQ-1/);
  } finally {
    f.cleanup();
  }
});

test('F20 R2-L2: previous must name a redaction of the same document; a consolidation without previous is refused', () => {
  const f = registry();
  try {
    const c = f.h.contract('API', 'REQ-1 REQ-2', agent, undefined, SOURCE, [], undefined, [], {
      from: f.c1.id,
      review: 'R-1',
    });
    const other = f.h.contract('Orders', 'Orders.', agent, undefined, 'docs/contracts/orders.md');
    assert.throws(
      () =>
        reimport(f, (r) => {
          const rec = contractRecord(r, c.id);
          if (rec) rec.data.previous = other.id;
        }),
      /previous не называет редакцию того же документа/,
    );
    assert.throws(
      () =>
        reimport(f, (r) => {
          const rec = contractRecord(r, c.id);
          if (rec) delete rec.data.previous;
        }),
      /не непосредственно предыдущей редакции/,
    );
  } finally {
    f.cleanup();
  }
});

const record = (id: string, extra: Partial<Contract> = {}): Contract => ({
  id,
  title: 'API',
  content: id,
  digest: 'd-' + id,
  source: SOURCE,
  approvedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const order = (cs: Contract[]) => contractRedactionsOf(cs, SOURCE, undefined).map((c) => c.id);

test('F20 R2-L1: equal approval times are ordered by id, the same on every clone', () => {
  const x = record('C-b'),
    y = record('C-a');
  assert.deepEqual(order([x, y]), ['C-a', 'C-b']);
  assert.deepEqual(order([y, x]), ['C-a', 'C-b']);
});

test('F20: mixed legacy records (no links, ordered by time) and new records (ordered by links)', () => {
  const l1 = record('C-z', { approvedAt: '2026-01-01T00:00:00.000Z' });
  const l2 = record('C-y', { approvedAt: '2026-01-02T00:00:00.000Z' });
  // Новые записи: часы клона отстают, порядок задают ссылки.
  const n3 = record('C-x', { approvedAt: '2025-01-01T00:00:00.000Z', previous: l2.id });
  const f4 = record('C-w', {
    approvedAt: '2025-01-01T00:00:00.000Z',
    previous: n3.id,
    consolidates: { from: n3.id, review: 'R' },
  });
  const n5 = record('C-v', { approvedAt: '2024-01-01T00:00:00.000Z', previous: f4.id });
  for (const cs of [
    [l1, l2, n3, f4, n5],
    [n5, f4, n3, l2, l1],
    [f4, l1, n5, l2, n3],
  ])
    assert.deepEqual(order(cs), ['C-z', 'C-y', 'C-x', 'C-w', 'C-v']);
  assert.equal(supersededBy([l1, l2, n3, f4, n5], n3.id)?.id, n5.id);
  assert.equal(currentText([l1, l2, n3, f4], n3.id)?.id, f4.id);
});

test('F20 R2-M1: a fork — two amendments of the same redaction — is detected with the winner', () => {
  const p = record('C-p');
  const m1 = record('C-m1', { previous: p.id, approvedAt: '2026-01-02T00:00:00.000Z' });
  const m2 = record('C-m2', { previous: p.id, approvedAt: '2026-01-03T00:00:00.000Z' });
  assert.deepEqual(contractForks([p, m1, m2]), [
    { source: SOURCE, base: p.id, branches: [m1.id, m2.id], winner: m2.id },
  ]);
  // Поправка после консолидации P и параллельная поправка P — тоже развилка.
  const f = record('C-f', {
    previous: p.id,
    consolidates: { from: p.id, review: 'R' },
    approvedAt: '2026-01-02T00:00:00.000Z',
  });
  const n = record('C-n', { previous: f.id, approvedAt: '2026-01-04T00:00:00.000Z' });
  assert.deepEqual(contractForks([p, f, n, m2])[0]?.branches.sort(), [m2.id, n.id].sort());
  // Цепочка без развилки и поправка консолидации — не развилка.
  assert.deepEqual(contractForks([p, f, n]), []);
  assert.deepEqual(contractForks([p, f, m2]), []);
});

test('F20 R2-L2: a consolidation record without previous is not an equivalent redaction', () => {
  const p = record('C-p');
  const linked = record('C-f', { previous: p.id, consolidates: { from: p.id, review: 'R' } });
  const bare = record('C-f', { consolidates: { from: p.id, review: 'R' } });
  assert.equal(supersededBy([p, linked], p.id), undefined);
  assert.equal(supersededBy([p, bare], p.id)?.id, bare.id);
});

test('F20 R3-M1: a redaction on top of the winner resolves a fork; a consolidation of the winner does not', () => {
  const p = record('C-p');
  const m1 = record('C-m1', { previous: p.id, approvedAt: '2026-01-02T00:00:00.000Z' });
  const m2 = record('C-m2', { previous: p.id, approvedAt: '2026-01-03T00:00:00.000Z' });
  assert.equal(contractForks([p, m1, m2]).length, 1);
  const f = record('C-f2', {
    previous: m2.id,
    consolidates: { from: m2.id, review: 'R' },
    approvedAt: '2026-01-04T00:00:00.000Z',
  });
  assert.equal(contractForks([p, m1, m2, f]).length, 1, 'консолидация действующей не сводит');
  const merge = record('C-merge', { previous: f.id, approvedAt: '2026-01-05T00:00:00.000Z' });
  assert.deepEqual(contractForks([p, m1, m2, f, merge]), []);
  assert.deepEqual(contractForks([p, m1, m2, record('C-n', { previous: m2.id })]), []);
});

test('F20 R3: a peer cannot add consolidates to a contract record this clone already knows', () => {
  const f = registry();
  try {
    const m = f.h.contract('API', 'Rule REQ-1 REQ-2, short', agent, undefined, SOURCE);
    assert.throws(
      () =>
        reimport(
          f,
          (r) => {
            const rec = contractRecord(r, m.id);
            if (rec) rec.data.consolidates = { from: f.c1.id, review: 'R-x' };
          },
          true,
        ),
      /Утверждённый контракт неизменяем/,
    );
  } finally {
    f.cleanup();
  }
});
