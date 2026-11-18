import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { complete, fixture, input } from './helpers.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { panelSummary } from '../src/application/panel.ts';

/**
 * Доска на стадии 2: вторая задача ждёт первую, исполнителей нет — стадия
 * на каждом такте отвечает «жду». Счётчик захватов — обёртка `claim`.
 */
async function waitingBoard(f: ReturnType<typeof fixture>) {
  const b = f.h.createBoard('Idle wait', '', 'main');
  const first = f.h.addTask(b.id, input('First'));
  f.h.addTask(b.id, input('Second', [first.id]));
  const flow = new LeadWorkflow(f.h);
  const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
  const runner = new LeadRunner(f.h, f.root);
  let claims = 0;
  const claim = runner.workflow.claim.bind(runner.workflow);
  runner.workflow.claim = (...args) => {
    claims++;
    return claim(...args);
  };
  for (let i = 0; i < 4 && flow.get(job.key, 'main').stage < 2; i++) await runner.tick();
  assert.equal(flow.get(job.key, 'main').stage, 2);
  return { first, flow, job, runner, claims: () => claims };
}

test('F60: ожидающая стадия без перемен не захватывается на каждом такте — ревизия данных стоит, сводка отвечает «без изменений»', async () => {
  const f = fixture();
  try {
    const { first, flow, job, runner, claims } = await waitingBoard(f);
    // Пауза длиннее теста: здесь проверяется только реакция на перемены.
    runner.idleWait = { initialMs: 60_000, maxMs: 60_000 };
    await runner.tick();
    const claimed = claims();
    const revision = f.store.revision();
    const summary = panelSummary(f.h, f.root, {}) as { revision: string };
    for (let i = 0; i < 10; i++) await runner.tick();
    assert.equal(claims(), claimed, 'ожидающая стадия не захватывалась');
    assert.equal(f.store.revision(), revision, 'ревизия данных не росла от тактов');
    assert.deepEqual(panelSummary(f.h, f.root, { revision: summary.revision }), {
      revision: summary.revision,
      unchanged: true,
    });
    const before = flow.get(job.key, 'main');
    assert.equal(before.status, 'queued');

    // Зависимость выполнена — стадия захватывается сразу, без паузы.
    complete(f.h, first.id);
    await runner.tick();
    assert.equal(claims(), claimed + 1, 'перемена в задачах доски — немедленный захват');
    const after = flow.get(job.key, 'main');
    assert.equal(after.status, 'queued');
    assert.equal(after.attempts, before.attempts, 'ожидание не расходует попыток');
    // Снова ничего не меняется — и снова без захватов.
    await runner.tick();
    await runner.tick();
    assert.equal(claims(), claimed + 1);
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('F60: без перемен ожидающая стадия всё же проверяется — после паузы, удваивающейся до предела', async () => {
  const f = fixture();
  try {
    const { runner, claims } = await waitingBoard(f);
    runner.idleWait = { initialMs: 100, maxMs: 200 };
    await runner.tick();
    const start = claims();
    await runner.tick();
    assert.equal(claims(), start, 'до паузы — без захвата');
    await sleep(150);
    await runner.tick();
    assert.equal(claims(), start + 1, 'пауза 100 мс прошла');
    await sleep(120);
    await runner.tick();
    assert.equal(claims(), start + 1, 'пауза удвоилась до 200 мс');
    await sleep(120);
    await runner.tick();
    assert.equal(claims(), start + 2, 'пауза 200 мс прошла');
    // Предел: пауза больше не растёт.
    await sleep(250);
    await runner.tick();
    assert.equal(claims(), start + 3, 'пауза осталась на пределе 200 мс');
    await runner.stop();
  } finally {
    f.cleanup();
  }
});
