import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input, complete } from './helpers.ts';
import { specDigest } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { join } from 'node:path';
import { readyTasks } from '../src/core/graph.ts';

test('DAG rejects cycles and missing dependencies atomically', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const a = f.h.addTask(b.id, input('Task alpha'));
    const c = f.h.addTask(b.id, input('Task beta', [a.id]));
    assert.throws(() => f.h.editTask(a.id, input('Task alpha', [c.id]), specDigest(a)), /Цикл/);
    assert.deepEqual(f.store.read().tasks[0].dependsOn, []);
    assert.throws(() => f.h.addTask(b.id, input('Bad reference', ['T999'])), /не существует/);
    assert.equal(f.store.read().tasks.length, 2);
  } finally {
    f.cleanup();
  }
});
test('Approval binds contracts and spec; dependent jobs wait for accepted predecessor', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const c = f.h.contract('API v1', 'GET /v1 → items');
    const a = f.h.addTask(b.id, { ...input('Task alpha'), contracts: [c.id] });
    const next = f.h.addTask(b.id, input('Task beta', [a.id]));
    assert.equal(f.h.claim('worker'), undefined);
    f.h.approve(b.id);
    assert.equal(f.store.read().tasks[0].contractDigests[c.id], c.digest);
    assert.deepEqual(
      readyTasks(f.store.read()).map((t) => t.id),
      [a.id],
    );
    complete(f.h, a.id);
    assert.deepEqual(
      readyTasks(f.store.read()).map((t) => t.id),
      [next.id],
    );
  } finally {
    f.cleanup();
  }
});
test('Concurrent store clients cannot claim one task twice', () => {
  const f = fixture();
  const second = new Store(join(f.root, 'state.sqlite'));
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const r = f.h.claim('one');
    const other = new DevContour(second, f.h.config).claim('two');
    assert.ok(r);
    assert.equal(other, undefined);
    assert.equal(second.read().runs.length, 1);
  } finally {
    second.close();
    f.cleanup();
  }
});
test('A projection serialises, so a stale snapshot cannot overwrite a newer journal', () => {
  const f = fixture();
  const second = new Store(join(f.root, 'state.sqlite'));
  try {
    f.h.createBoard('Board');
    // Журнал пишут оба процесса в одни и те же файлы. Если проекции идут
    // одновременно, младший снимок ложится поверх старшего и запись, уже
    // попавшая в журнал, из него исчезает — а журнал обещан append-only.
    let concurrent = true;
    f.store.project(() => {
      try {
        second.project(() => undefined);
      } catch {
        concurrent = false;
      }
      // Соседний процесс не должен успеть спроецировать более новое состояние
      // раньше, чем эта проекция закончит писать свои файлы.
      assert.equal(concurrent, false, 'проекции обязаны идти по очереди');
    });
    assert.equal(f.store.read().boards.length, 1);
  } finally {
    second.close();
    f.cleanup();
  }
});
test('Expired attempts are fenced, retries get fresh run IDs and tokens', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const old = f.h.claim('one')!;
    f.h.expire(Date.now() + 60000);
    assert.throws(() => f.h.phase(old.id, old.token, 'verifying'), /владение/);
    assert.equal(f.store.read().tasks[0].status, 'failed');
    f.h.retry(t.id);
    const newer = f.h.claim('two')!;
    assert.notEqual(old.token, newer.token);
    assert.notEqual(old.id, newer.id);
    assert.equal(newer.attempt, 2);
    assert.throws(() => f.h.finish(old.id, old.token, 'merged'), /владение/);
  } finally {
    f.cleanup();
  }
});
test('Done requires exact SHA test evidence and independent review for BOTH phases', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const r = f.h.claim('worker')!;
    f.h.phase(r.id, r.token, 'integrating', { candidateSha: 'new', integrationSha: 'merged' });
    let published = false;
    assert.throws(
      () =>
        f.h.finish(r.id, r.token, 'merged', () => {
          published = true;
        }),
      /Нет PASS/,
    );
    assert.equal(published, false);
    for (const phase of ['candidate', 'integration'] as const)
      for (const kind of ['test', 'review'] as const)
        f.h.evidence(r.id, r.token, {
          kind,
          phase,
          sha: 'stale',
          gate: kind === 'test' ? 'test' : 'independent-review',
          passed: true,
          command: ['test'],
          exitCode: 0,
          log: 'x',
          digest: 'x',
          summary: 'x',
        });
    assert.throws(() => f.h.finish(r.id, r.token, 'merged'), /Нет PASS/);
  } finally {
    f.cleanup();
  }
});
test('Correction makes a new transitive chain and preserves immutable accepted snapshot', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const a = f.h.addTask(b.id, input('Root task'));
    const c = f.h.addTask(b.id, input('Middle task', [a.id]));
    const d = f.h.addTask(b.id, input('Leaf task', [c.id]));
    f.h.approve(b.id);
    [a, c, d].forEach((t) => complete(f.h, t.id));
    f.h.accept(b.id, 'merged');
    const original = structuredClone(f.store.read().boards[0].revisions[0]);
    assert.deepEqual(f.h.impact(b.id, [a.id]).taskIds, [a.id, c.id, d.id]);
    const result = f.h.correct(b.id, [a.id], 'Include archived results in the query');
    const s = f.store.read();
    assert.deepEqual(s.boards[0].revisions[0], original);
    assert.equal(s.boards[0].revisions[1].number, 2);
    assert.equal(s.tasks.find((t) => t.id === a.id)!.status, 'done');
    const next = s.tasks.find((t) => t.id === result.replacements[c.id])!;
    assert.deepEqual(next.dependsOn, [result.replacements[a.id]]);
    assert.equal(next.status, 'draft');
    assert.equal(next.approvedDigest, undefined);
    assert.throws(() => f.h.accept(b.id, 'merged'), /все задачи/);
    assert.throws(() => f.h.correct(b.id, [a.id], 'Another change request'), /Сначала/);
  } finally {
    f.cleanup();
  }
});
test('Cross-board impact is included in correction, unrelated tasks keep their results', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Backend'),
      c = f.h.createBoard('Frontend');
    const a = f.h.addTask(b.id, input('API contract')),
      u = f.h.addTask(b.id, input('Unrelated task')),
      d = f.h.addTask(c.id, input('UI dependent', [a.id]));
    f.h.approve(b.id);
    f.h.approve(c.id);
    [a, u, d].forEach((t) => complete(f.h, t.id));
    f.h.accept(b.id, 'merged');
    f.h.accept(c.id, 'merged');
    const impact = f.h.impact(b.id, [a.id]);
    assert.equal(impact.boards.length, 2);
    const result = f.h.correct(b.id, [a.id], 'Change the API pagination semantics');
    assert.deepEqual(Object.keys(result.replacements), [a.id, d.id]);
    assert.ok(f.store.read().boards[0].revisions[1].taskIds.includes(u.id));
    assert.equal(f.store.read().boards[1].revisions.length, 1);
  } finally {
    f.cleanup();
  }
});
test('Board acceptance rejects empty, incomplete and unapproved tasks', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    assert.throws(() => f.h.accept(b.id, 'head'));
    f.h.addTask(b.id, input());
    assert.throws(() => f.h.accept(b.id, 'head'));
    assert.throws(() => f.h.approve('missing'));
  } finally {
    f.cleanup();
  }
});
test('Cancelled runs cannot publish and cancelled drafts can return to draft', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board'),
      t = f.h.addTask(b.id, input());
    f.h.cancel(t.id);
    f.h.retry(t.id);
    assert.equal(f.store.read().tasks[0].status, 'draft');
    f.h.approve(b.id);
    f.h.pause(false);
    const r = f.h.claim('worker')!;
    f.h.cancel(t.id);
    assert.throws(() => f.h.finish(r.id, r.token, 'sha'));
    assert.equal(f.store.read().tasks[0].status, 'cancelled');
  } finally {
    f.cleanup();
  }
});
test('Optimistic draft editing rejects stale client and atomic publish failure cannot mark done', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board'),
      t = f.h.addTask(b.id, input());
    f.h.editTask(t.id, input('Changed task'), specDigest(t));
    assert.throws(() => f.h.editTask(t.id, input('Lost update'), specDigest(t)), /Обновите/);
    f.h.approve(b.id);
    f.h.pause(false);
    const r = f.h.claim('worker')!;
    f.h.phase(r.id, r.token, 'integrating', { candidateSha: 'c', integrationSha: 'm' });
    for (const phase of ['candidate', 'integration'] as const)
      for (const kind of ['test', 'review'] as const)
        f.h.evidence(r.id, r.token, {
          kind,
          phase,
          sha: phase === 'candidate' ? 'c' : 'm',
          gate: kind === 'test' ? 'test' : 'independent-review',
          passed: true,
          command: [],
          exitCode: 0,
          log: '',
          digest: '',
          summary: '',
        });
    assert.throws(
      () =>
        f.h.finish(r.id, r.token, 'm', () => {
          throw new Error('CAS conflict');
        }),
      /CAS/,
    );
    assert.notEqual(f.store.read().tasks[0].status, 'done');
    assert.equal(f.store.read().runs[0].status, 'active');
  } finally {
    f.cleanup();
  }
});

test('Plan import accepts forward references, rejects cycles without partial writes', () => {
  const f = fixture();
  try {
    const plan = {
      title: 'A proposed plan',
      description: 'A small vertical slice',
      tasks: [
        { ...input('Second task'), key: 'second', dependsOn: ['first'], contracts: [] },
        { ...input('First task'), key: 'first', dependsOn: [], contracts: [] },
      ],
    };
    f.h.importPlan(plan);
    assert.equal(f.store.read().tasks.length, 2);
    assert.deepEqual(f.store.read().tasks[0].dependsOn, [f.store.read().tasks[1].id]);
    const before = f.store.read();
    assert.throws(
      () =>
        f.h.importPlan({
          ...plan,
          tasks: plan.tasks.map((t) => ({
            ...t,
            dependsOn: t.key === 'first' ? ['second'] : ['first'],
          })),
        }),
      /Цикл/,
    );
    assert.deepEqual(f.store.read(), before);
  } finally {
    f.cleanup();
  }
});

test('Contract approval is a real gate: architecture can start while implementation stays draft', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const a = f.h.addTask(b.id, { ...input('Design API contract'), role: 'architect' });
    const be = f.h.addTask(b.id, { ...input('Implement endpoint', [a.id]), role: 'backend' });
    assert.throws(() => f.h.approve(b.id), /контракт/);
    assert.equal(f.store.read().tasks[0].status, 'draft');
    f.h.approve(b.id, [a.id]);
    assert.equal(f.store.read().tasks[0].status, 'ready');
    assert.equal(f.store.read().tasks[1].status, 'draft');
    const c = f.h.contract('API v1', 'GET /endpoint → response');
    const draft = f.store.read().tasks.find((t) => t.id === be.id)!;
    f.h.editTask(be.id, { ...draft, contracts: [c.id] }, specDigest(draft));
    f.h.approve(b.id, [be.id]);
    assert.equal(f.store.read().tasks[1].status, 'ready');
    assert.deepEqual(
      readyTasks(f.store.read()).map((t) => t.id),
      [a.id],
    );
  } finally {
    f.cleanup();
  }
});

test('Repeated partial correction follows current replacements, never clones superseded history again', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const a = f.h.addTask(b.id, input('Upstream task'));
    const leaf = f.h.addTask(b.id, input('Downstream task', [a.id]));
    f.h.approve(b.id);
    complete(f.h, a.id);
    complete(f.h, leaf.id);
    f.h.accept(b.id, 'merged');
    const second = f.h.correct(b.id, [leaf.id], 'Correct only the downstream result');
    f.h.approve(b.id);
    complete(f.h, second.replacements[leaf.id]);
    f.h.accept(b.id, 'merged');
    const impacted = f.h.impact(b.id, [a.id]);
    assert.deepEqual(impacted.taskIds, [a.id, second.replacements[leaf.id]]);
    const third = f.h.correct(b.id, [a.id], 'Change upstream after the downstream correction');
    assert.equal(Object.keys(third.replacements).length, 2);
    assert.equal(third.replacements[leaf.id], undefined);
    const replacement = f.store
      .read()
      .tasks.find((t) => t.id === third.replacements[second.replacements[leaf.id]])!;
    assert.deepEqual(replacement.dependsOn, [third.replacements[a.id]]);
    assert.equal(f.store.read().boards[0].revisions.length, 3);
  } finally {
    f.cleanup();
  }
});

test('Mixed runtimes route every role to its independent reviewer and retain configured model', () => {
  const f = fixture();
  try {
    f.h.config.roles.qa = {
      runtime: 'codex',
      model: 'configured-writer',
      reviewer: { runtime: 'claude', model: 'configured-reviewer' },
    };
    const b = f.h.createBoard('Mixed runtime board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const r = f.h.claim('worker')!;
    assert.equal(r.runtime, 'codex');
    assert.equal(r.reviewer, 'claude');
    assert.equal(r.model, 'configured-writer');
    assert.equal(r.reviewerModel, 'configured-reviewer');
  } finally {
    f.cleanup();
  }
});

test('An environment refusal does not spend the task attempt budget', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);

    // Отказ окружения: исполнителю не дали работать. Бюджет попыток задачи на
    // неполадках контура сгорать не должен — иначе задача блокируется, ни разу
    // не дойдя до исполнителя.
    const blocked = f.h.claim('one')!;
    f.h.fail(blocked.id, blocked.token, 'runtime: Not logged in', true);
    // Классификацию самого отказа проверяет runner.test.ts: там она проходит
    // через scheduler, а здесь — только учёт попытки.
    assert.equal(f.store.read().tasks[0].attempt, 0);
    assert.equal(f.store.read().runs[0].blocked, true);
    f.h.retry(t.id);

    // Настоящая попытка расходуется: исполнитель работал и не справился.
    const real = f.h.claim('one')!;
    f.h.fail(real.id, real.token, 'Исполнитель сообщил о незавершённой работе');
    assert.equal(f.store.read().tasks[0].attempt, 1);
    assert.equal(f.store.read().runs[1].blocked, undefined);
  } finally {
    f.cleanup();
  }
});

test('An exhausted attempt budget can be reset, but only deliberately and with a reason', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    for (let i = 0; i < f.h.config.maxAttempts; i++) {
      const run = f.h.claim('one')!;
      f.h.fail(run.id, run.token, 'Исполнитель сообщил о незавершённой работе');
      if (i + 1 < f.h.config.maxAttempts) f.h.retry(t.id);
    }
    // Лимит упирался в тупик: причину устранили, а вернуть задачу в работу
    // было нечем, кроме правки базы руками.
    assert.throws(() => f.h.retry(t.id), /со сбросом/);
    assert.throws(() => f.h.retry(t.id, { reason: '   ' }), /со сбросом/);

    const reset = f.h.retry(t.id, { reason: 'Окружение исправлено: runtime авторизован' });
    assert.equal(f.store.read().tasks[0].status, 'ready');
    assert.equal(f.store.read().tasks[0].attempt, 0);
    // Сброшенные попытки и его причина остаются в журнале: иначе история
    // показывает задачу, которая справилась с первого раза.
    assert.deepEqual(reset, {
      taskId: t.id,
      reset: { spent: f.h.config.maxAttempts, reason: 'Окружение исправлено: runtime авторизован' },
    });
    assert.equal(f.store.read().runs.length, f.h.config.maxAttempts);

    // О сбросе сообщается только когда он случился: после одного сбоя бюджет
    // не исчерпан, попытка сохраняется, и запись о сбросе была бы неправдой.
    const run = f.h.claim('one')!;
    f.h.fail(run.id, run.token, 'Исполнитель сообщил о незавершённой работе');
    assert.deepEqual(f.h.retry(t.id, { reason: 'на всякий случай' }), { taskId: t.id });
    assert.equal(f.store.read().tasks[0].attempt, 1);
  } finally {
    f.cleanup();
  }
});
