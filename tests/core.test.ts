import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input, complete, config, CANDIDATE, MERGED } from './helpers.ts';
import { specDigest, supersededBy } from '../src/core/service.ts';
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
test('A stale snapshot does not overwrite a newer journal', () => {
  const f = fixture();
  const second = new Store(join(f.root, 'state.sqlite'));
  try {
    f.h.createBoard('Первая');
    const written: string[][] = [];
    const record = (store: Store) =>
      store.project((state) => written.push(state.boards.map((b) => b.title)));

    // Свежий снимок пишет журнал.
    record(f.store);
    new DevContour(second, f.h.config).createBoard('Вторая');
    record(second);
    assert.deepEqual(written, [['Первая'], ['Первая', 'Вторая']]);

    // Процесс, читавший состояние раньше, не должен положить свой снимок
    // поверх: запись «Вторая» уже в журнале, а журнал обещан append-only.
    record(f.store);
    assert.deepEqual(
      written,
      [['Первая'], ['Первая', 'Вторая']],
      'устаревшая проекция не пишет ничего',
    );

    // Новое событие снова открывает запись.
    f.h.createBoard('Третья');
    record(f.store);
    assert.deepEqual(written.at(-1), ['Первая', 'Вторая', 'Третья']);
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
    // Выдаёт тот же controller: новая попытка — новый id и токен.
    const newer = f.h.claim('one')!;
    assert.notEqual(old.token, newer.token);
    assert.notEqual(old.id, newer.id);
    // Истёкшее владение попытку не засчитывает: номер тот же, расходуется
    // только предел незасчитанных отказов.
    assert.equal(newer.attempt, 1);
    assert.equal(f.store.read().tasks[0].neutralFailures, 1);
    assert.throws(() => f.h.finish(old.id, old.token, MERGED), /владение/);
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
    f.h.phase(r.id, r.token, 'integrating', { candidateSha: CANDIDATE, integrationSha: MERGED });
    let published = false;
    assert.throws(
      () =>
        f.h.finish(r.id, r.token, MERGED, () => {
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
          sha: 'a'.repeat(40),
          gate: kind === 'test' ? 'test' : 'independent-review',
          passed: true,
          command: ['test'],
          exitCode: 0,
          log: 'x',
          digest: 'e'.repeat(64),
          summary: 'x',
        });
    assert.throws(() => f.h.finish(r.id, r.token, MERGED), /Нет PASS/);
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
    f.h.accept(b.id, MERGED);
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
    assert.throws(() => f.h.accept(b.id, MERGED), /все задачи/);
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
    f.h.accept(b.id, MERGED);
    f.h.accept(c.id, MERGED);
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
    f.h.phase(r.id, r.token, 'integrating', { candidateSha: CANDIDATE, integrationSha: MERGED });
    for (const phase of ['candidate', 'integration'] as const)
      for (const kind of ['test', 'review'] as const)
        f.h.evidence(r.id, r.token, {
          kind,
          phase,
          sha: phase === 'candidate' ? CANDIDATE : MERGED,
          gate: kind === 'test' ? 'test' : 'independent-review',
          passed: true,
          command: [],
          exitCode: 0,
          log: '',
          digest: 'e'.repeat(64),
          summary: '',
        });
    assert.throws(
      () =>
        f.h.finish(r.id, r.token, MERGED, () => {
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

test('Следующий этап — ревизия той же доски, а не новая доска', () => {
  const f = fixture();
  try {
    const plan = (title: string, key: string, dependsOn: string[] = []) => ({
      title,
      description: 'Цель: ' + title,
      tasks: [{ ...input('Task ' + key), key, dependsOn, contracts: [] }],
    });
    const first = f.h.importPlan(plan('Release 0.1, stage 1', 'one'));
    const one = f.store.read().tasks[0];
    assert.throws(
      () => f.h.importPlan(plan('Release 0.1, stage 2', 'two'), first.boardId),
      /после приёмки текущей ревизии/,
    );
    f.h.approve(first.boardId);
    complete(f.h, one.id);
    f.h.accept(first.boardId, MERGED);
    const accepted = structuredClone(f.store.read().boards[0].revisions[0]);
    const before = f.store.read();
    assert.throws(() => f.h.importPlan(plan('Stage', 'x'), 'B-missing'), /не найдена/);
    // Отказ после того, как задачи этапа уже добавлены, тоже ничего не оставляет.
    assert.throws(
      () =>
        f.h.importPlan(
          {
            ...plan('Cyclic stage', 'x'),
            tasks: [
              { ...input('Task x'), key: 'x', dependsOn: ['y'], contracts: [] },
              { ...input('Task y'), key: 'y', dependsOn: ['x'], contracts: [] },
            ],
          },
          first.boardId,
        ),
      /Цикл/,
    );
    assert.deepEqual(f.store.read(), before);

    const second = f.h.importPlan(plan('Release 0.1, stage 2', 'two', [one.id]), first.boardId);
    const s = f.store.read();
    assert.equal(s.boards.length, 1, 'этап не заводит новую доску');
    assert.deepEqual(second, { boardId: first.boardId, revision: 2, tasks: 1 });
    const [r1, r2] = s.boards[0].revisions;
    assert.deepEqual(r1, accepted, 'принятая ревизия неизменна');
    const two = s.tasks.find((t) => t.title === 'Task two')!;
    assert.deepEqual(r2.taskIds, [one.id, two.id]);
    assert.equal(r2.status, 'active');
    assert.match(r2.reason, /^Следующий этап: Release 0.1, stage 2\n\nЦель: /);
    assert.deepEqual(two.dependsOn, [one.id]);
    assert.equal(s.boards[0].title, 'Release 0.1, stage 1', 'название доски не меняется');

    f.h.approve(first.boardId);
    assert.equal(f.store.read().tasks.find((t) => t.id === one.id)!.status, 'done');
    assert.throws(() => f.h.accept(first.boardId, MERGED), /все задачи/);
    complete(f.h, two.id);
    f.h.accept(first.boardId, MERGED);
    const done = f.store.read().boards[0].revisions[1];
    assert.equal(done.status, 'accepted');
    assert.deepEqual(
      done.snapshot?.tasks.map((t) => t.id),
      [one.id, two.id],
    );
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
    f.h.accept(b.id, MERGED);
    const second = f.h.correct(b.id, [leaf.id], 'Correct only the downstream result');
    f.h.approve(b.id);
    complete(f.h, second.replacements[leaf.id]);
    f.h.accept(b.id, MERGED);
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

test('A task that produced nothing can return to draft, one that delivered cannot', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    assert.equal(f.store.read().tasks[0].status, 'ready');

    // Контракт исправлен до приёмки доски: переписывать под старый нечего, а
    // штатного пути не было — correct требует принятой ревизии, edit-task
    // черновика. Оставался тупик и правка базы руками.
    assert.throws(() => f.h.reopen(t.id, 'коротко'), /от 10 до 5000/);
    const result = f.h.reopen(t.id, 'Контракт исправлен: привязка ссылается на прежнюю редакцию');
    assert.deepEqual(result, {
      taskId: t.id,
      reason: 'Контракт исправлен: привязка ссылается на прежнюю редакцию',
      wasApproved: true,
    });
    const draft = f.store.read().tasks[0];
    assert.equal(draft.status, 'draft');
    // Утверждение снято: доска обязана пройти ревью плана заново, иначе это
    // был бы обход независимого согласования.
    assert.equal(draft.approvedDigest, undefined);
    assert.equal(draft.approval, undefined);
    // Digest контрактов принадлежал снятому утверждению: оставить его значит
    // закреплять одну редакцию контракта, ссылаясь на другую.
    assert.deepEqual(draft.contractDigests, {});
    // Идемпотентно: черновик со следами снятого утверждения тоже вычищается,
    // иначе digest переживает возврат и противоречит новой привязке.
    assert.deepEqual(f.h.reopen(t.id, 'Повторный возврат ничего не ломает'), {
      taskId: t.id,
      reason: 'Повторный возврат ничего не ломает',
      wasApproved: false,
    });

    // Задача с принятым результатом возвращается только корректировкой доски:
    // под неё уже велась работа, и история этого не должна терять.
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('one')!;
    f.h.phase(run.id, run.token, 'integrating', { candidateSha: 'a'.repeat(40) });
    f.store.change('test.finish', (s) => {
      s.tasks[0].resultSha = 'b'.repeat(40);
      s.tasks[0].status = 'done';
      s.tasks[0].activeRunId = undefined;
    });
    assert.throws(
      () => f.h.reopen(t.id, 'Контракт снова изменился, хочу переписать'),
      /корректировка/,
    );
  } finally {
    f.cleanup();
  }
});

test('A ready task at the attempt ceiling is not a silent dead end', () => {
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
    // Постановку исправили и утвердили заново: задача снова ready, но бюджет
    // остался израсходованным. Диспетчер её не берёт и ничего не говорит, а
    // повтор отказывал, потому что она уже не «сбой», — тупик тот же.
    f.h.reopen(t.id, 'Контракт исправлен, постановка обновлена');
    f.h.approve(b.id);
    assert.equal(f.store.read().tasks[0].status, 'ready');
    assert.equal(f.store.read().tasks[0].attempt, f.h.config.maxAttempts);
    assert.equal(f.h.claim('one'), undefined, 'диспетчер такую задачу не берёт');

    f.h.retry(t.id, { reason: 'Причина устранена, даём задаче ход' });
    assert.equal(f.store.read().tasks[0].attempt, 0);
    assert.ok(f.h.claim('one'), 'после сброса задача выдаётся');
  } finally {
    f.cleanup();
  }
});

test('Цель доски правится до утверждения плана и после приёмки, но не во время работы', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Границы и целостность прежней сборки', 'Обещает три результата');
    const kept = f.h.addTask(b.id, input('Границы'));
    const dropped = f.h.addTask(b.id, input('Целостность'));
    f.h.cancel(dropped.id);
    // План сузили — сузить можно и обещание доски, не пересоздавая её.
    f.h.editBoard(b.id, { title: 'Границы', description: 'Обещает один результат' });
    const edited = f.store.read().boards.find((x) => x.id === b.id)!;
    assert.equal(edited.title, 'Границы');
    assert.equal(edited.description, 'Обещает один результат');
    assert.throws(() => f.h.editBoard(b.id, { title: 'x' }), /от 3 до 180/);
    f.h.approve(b.id, [kept.id]);
    assert.throws(
      () => f.h.editBoard(b.id, { description: 'Другое обещание' }),
      /до утверждения плана или после приёмки/,
    );
    complete(f.h, kept.id);
    f.h.accept(b.id, MERGED);
    const accepted = structuredClone(f.store.read().boards[0].revisions[0]);
    // Принятая доска ведёт релиз дальше: название становится названием релиза.
    f.h.editBoard(b.id, { title: 'Релиз 0.1', description: 'Весь релиз' });
    const renamed = f.store.read().boards[0];
    assert.equal(renamed.title, 'Релиз 0.1');
    assert.equal(renamed.description, 'Весь релиз');
    assert.deepEqual(renamed.revisions[0], accepted, 'принятая ревизия не меняется');
  } finally {
    f.cleanup();
  }
});

test('Уровень рассуждения роли доходит до прогона, а у claude отвергается', () => {
  const f = fixture();
  try {
    f.h.config.roles.qa = { runtime: 'codex', model: 'gpt-6-astra', effort: 'low' };
    const b = f.h.createBoard('Доска');
    f.h.addTask(b.id, input('Сценарий'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.model, 'gpt-6-astra');
    assert.equal(run.effort, 'low');
    assert.equal(run.reviewerEffort, undefined, 'ревьюер без своего уровня его не наследует');
  } finally {
    f.cleanup();
  }
  // Поле, которое claude не получит, не должно обещать экономию.
  const g = fixture();
  try {
    assert.throws(
      () =>
        new DevContour(g.store, config({ roles: { qa: { runtime: 'claude', effort: 'low' } } })),
      /effort поддерживается только для codex: qa/,
    );
  } finally {
    g.cleanup();
  }
});

test('Задача не утверждается и не запускается по заменённой редакции контракта', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const old = f.h.contract('API', 'v1', undefined, undefined, 'docs/contracts/api.md');
    const other = f.h.contract('Другой', 'x', undefined, undefined, 'docs/contracts/other.md');
    const t = f.h.addTask(b.id, { ...input('Task'), contracts: [old.id] });
    const next = f.h.contract('API', 'v2', undefined, undefined, 'docs/contracts/api.md');
    assert.equal(supersededBy(f.store.read().contracts, old.id)?.id, next.id);
    assert.equal(supersededBy(f.store.read().contracts, other.id), undefined);
    assert.equal(supersededBy(f.store.read().contracts, next.id), undefined);
    assert.throws(() => f.h.approve(b.id), new RegExp(`${old.id} заменён редакцией ${next.id}`));
    f.h.editTask(
      t.id,
      { ...input('Task'), contracts: [next.id] },
      specDigest(f.store.read().tasks[0]),
    );
    f.h.approve(b.id);
    assert.equal(f.store.read().tasks[0].status, 'ready');
  } finally {
    f.cleanup();
  }
});

test('Отменённая задача не делает ревизию непринимаемой и не входит в снимок', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const kept = f.h.addTask(b.id, input('Kept'));
    const dropped = f.h.addTask(b.id, input('Dropped'));
    f.h.approve(b.id);
    f.h.cancel(dropped.id, 'Решено в контракте');
    complete(f.h, kept.id);
    f.h.accept(b.id, MERGED);
    const r = f.store.read().boards[0].revisions[0];
    assert.equal(r.status, 'accepted');
    assert.deepEqual(
      r.snapshot?.tasks.map((t) => t.id),
      [kept.id],
    );
    // Ревизия, где отменено всё, принимать нечего.
    const empty = f.h.createBoard('Empty');
    const only = f.h.addTask(empty.id, input('Only'));
    f.h.approve(empty.id);
    f.h.cancel(only.id, 'Не нужна');
    assert.throws(() => f.h.accept(empty.id, MERGED), /все задачи/);
  } finally {
    f.cleanup();
  }
});

// «Черновик берётся у последней содержательной попытки» — правило reuse
// harness: tests/reuse.test.ts пакета (перенос из этого файла).

test('Причина неудавшегося продления владения сохраняется и не затирается истечением', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('worker')!;
    f.h.heartbeatFailed(run.id, 'other-token', 'Чужой владелец');
    assert.equal(f.store.read().runs.find((x) => x.id === run.id)!.error, undefined);
    f.h.heartbeatFailed(run.id, run.token, 'Политика проверок изменилась; нужна новая попытка');
    f.h.expire(Date.now() + 10 * 60_000);
    const r = f.store.read().runs.find((x) => x.id === run.id)!;
    assert.equal(r.status, 'expired');
    assert.match(r.error!, /^Продление владения не удалось: Политика проверок изменилась/);
    assert.match(r.error!, /Истёк срок владения/);
    assert.ok(f.store.events().some((e) => e.type === 'run.heartbeat-failed'));
  } finally {
    f.cleanup();
  }
});

test('Отменённый потребитель не мешает корректировке предшественника', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const a = f.h.addTask(b.id, input('Root task'));
    const dropped = f.h.addTask(b.id, input('Dropped consumer', [a.id]));
    f.h.approve(b.id);
    f.h.cancel(dropped.id, 'Решено иначе');
    complete(f.h, a.id);
    f.h.accept(b.id, MERGED);
    assert.deepEqual(f.h.impact(b.id, [a.id]).taskIds, [a.id]);
    const result = f.h.correct(b.id, [a.id], 'Change the root behaviour');
    assert.deepEqual(Object.keys(result.replacements), [a.id]);
  } finally {
    f.cleanup();
  }
});

test('Отказ после неудавшегося продления сохраняет его причину впереди', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('worker')!;
    f.h.heartbeatFailed(run.id, run.token, 'Хранилище временно недоступно');
    f.h.fail(run.id, run.token, 'Попытка прервана');
    const r = f.store.read().runs.find((x) => x.id === run.id)!;
    assert.match(
      r.error!,
      /^Продление владения не удалось: Хранилище временно недоступно\. Попытка прервана$/,
    );
    assert.match(f.store.read().tasks[0].failure!, /Хранилище временно недоступно/);
  } finally {
    f.cleanup();
  }
});

test('Первая причина продления не затирается следующей и доходит до отказа без записи в хранилище', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('First'));
    f.h.addTask(b.id, input('Second'));
    f.h.approve(b.id);
    f.h.pause(false);
    const one = f.h.claim('worker')!;
    f.h.heartbeatFailed(one.id, one.token, 'Первая причина');
    f.h.heartbeatFailed(one.id, one.token, 'Вторая причина');
    assert.equal(
      f.store.read().runs.find((x) => x.id === one.id)!.error,
      'Продление владения не удалось: Первая причина',
    );
    // Запись причины не удалась — планировщик передаёт её сам.
    f.h.fail(one.id, one.token, 'Attempt aborted');
    const two = f.h.claim('worker')!;
    f.h.fail(two.id, two.token, 'Attempt aborted', false, 'unknown', 'Хранилище недоступно');
    const r = f.store.read().runs.find((x) => x.id === two.id)!;
    assert.equal(r.error, 'Продление владения не удалось: Хранилище недоступно. Attempt aborted');
    const plain = f.store.read().runs.find((x) => x.id === one.id)!;
    assert.equal(r.failureFingerprint, plain.failureFingerprint, 'отпечаток — по исходной ошибке');
  } finally {
    f.cleanup();
  }
});
