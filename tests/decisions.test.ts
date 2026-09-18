import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import { Observability } from '../src/application/observability.ts';

test('Dispatch journal records only available choices; replay refuses unobserved alternatives', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Dispatch board', '', 'main');
    const a = f.h.addTask(b.id, input('First task'));
    const blocked = f.h.addTask(b.id, input('Dependent task', [a.id]));
    const c = f.h.addTask(b.id, input('Other task'));
    f.h.approve(b.id);
    f.h.pause(false);
    const first = f.h.claim('test')!;
    assert.deepEqual(
      first.dispatch!.eligible.map((t) => t.taskId),
      [a.id, c.id],
    );
    assert.ok(!first.dispatch!.eligible.some((t) => t.taskId === blocked.id));
    f.h.fail(first.id, first.token, 'Known failure');
    f.h.retry(a.id);
    const second = f.h.claim('test')!;
    assert.equal(second.taskId, a.id);
    const reports = new Observability(f.h);
    const fifo = reports.replay({ repositoryId: 'main', policy: 'fifo-ready-v1' });
    assert.equal(fifo.matched, 2);
    assert.equal(fifo.unsupported, 0);
    const alternate = reports.replay({ repositoryId: 'main', policy: 'fewest-attempts-v1' });
    assert.equal(alternate.matched, 1);
    assert.equal(alternate.unsupported, 1);
    assert.equal(alternate.promotable, false);
    assert.equal(reports.decisions({}).records.length, 0);
    assert.equal(reports.decisions({ repositoryId: 'main', limit: 1 }).records.length, 1);
    // Altering future outcomes cannot alter the strategy's recorded choices.
    f.h.fail(second.id, second.token, 'Another outcome');
    assert.equal(
      reports.replay({ repositoryId: 'main', policy: 'fewest-attempts-v1' }).unsupported,
      1,
    );
  } finally {
    f.cleanup();
  }
});
