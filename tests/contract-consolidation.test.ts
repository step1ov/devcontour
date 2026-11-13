import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import {
  currentText,
  meaningRedactionsSinceConsolidation,
  newerRedaction,
  supersededBy,
} from '../src/core/service.ts';
import { reviewedRedaction } from '../src/runner/sensitive-paths.ts';
import { recordSchema } from '../src/core/sync-model.ts';
import { recordsFromState, stateFromRecords } from '../src/core/sync-state.ts';
import type { Approval } from '../src/core/model.ts';
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
      /Консолидация не относится/,
    );
  } finally {
    f.cleanup();
  }
});
