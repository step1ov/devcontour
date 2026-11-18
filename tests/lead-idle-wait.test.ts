import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { complete, fixture, input } from './helpers.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { panelSummary } from '../src/application/panel.ts';
import type { DevContourState } from '../src/core/model.ts';
import type { WorkflowJob } from '../src/core/lead-workflow.ts';

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
    // Запас по времени — сотни миллисекунд: такт под нагрузкой не путает
    // «пауза ещё идёт» и «пауза прошла».
    runner.idleWait = { initialMs: 300, maxMs: 600 };
    await runner.tick();
    const start = claims();
    await runner.tick();
    assert.equal(claims(), start, 'до паузы — без захвата');
    await sleep(450);
    await runner.tick();
    assert.equal(claims(), start + 1, 'пауза 300 мс прошла');
    await sleep(300);
    await runner.tick();
    assert.equal(claims(), start + 1, 'пауза удвоилась до 600 мс');
    await sleep(450);
    await runner.tick();
    assert.equal(claims(), start + 2, 'пауза 600 мс прошла');
    // Предел: пауза больше не растёт.
    await sleep(750);
    await runner.tick();
    assert.equal(claims(), start + 3, 'пауза осталась на пределе 600 мс');
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('F61: на паузе очереди ожидающая стадия доски не захватывается и после предела — ревизия стоит, снятие паузы захватывает сразу', async () => {
  const f = fixture();
  try {
    const { flow, job, runner, claims } = await waitingBoard(f);
    runner.idleWait = { initialMs: 100, maxMs: 200 };
    f.h.pause(true, 'operator', 'lead');
    // Первый такт после паузы — перемена отпечатка: один захват.
    await runner.tick();
    const claimed = claims();
    const revision = f.store.revision();
    const summary = panelSummary(f.h, f.root, {}) as { revision: string };
    for (let i = 0; i < 4; i++) {
      await sleep(250);
      await runner.tick();
    }
    assert.equal(claims(), claimed, 'пауза очереди: без захватов и после предела паузы');
    assert.equal(f.store.revision(), revision, 'ревизия данных не росла');
    assert.deepEqual(panelSummary(f.h, f.root, { revision: summary.revision }), {
      revision: summary.revision,
      unchanged: true,
    });
    const before = flow.get(job.key, 'main');
    assert.equal(before.status, 'queued');

    f.h.pause(false, 'operator', 'lead');
    await runner.tick();
    assert.equal(claims(), claimed + 1, 'снятие паузы — немедленный захват');
    assert.equal(flow.get(job.key, 'main').attempts, before.attempts);
    // Без паузы предел снова действует.
    await sleep(250);
    await runner.tick();
    assert.equal(claims(), claimed + 2, 'без паузы — проверка после предела');
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('F60: отпечаток ожидания ChangeSet видит живую проверку другого ChangeSet — её конец снова захватывает стадию', () => {
  // Начало совместной проверки ждёт, пока идёт любая проверка с живым lease
  // (`jointStage`): её окончание — перемена для ожидающей стадии.
  const f = fixture();
  try {
    const board = f.h.createBoard('Joint wait', '', 'main');
    f.h.addTask(board.id, input());
    const changeSet = (id: string, verifications: unknown[]) =>
      ({
        id,
        title: id,
        description: '',
        boardIds: [board.id],
        createdAt: new Date().toISOString(),
        verifications,
      }) as unknown as DevContourState['changeSets'][number];
    f.store.change('fixture.changesets', (s) => {
      s.changeSets.push(
        changeSet('CS-own', []),
        changeSet('CS-other', [
          { id: 'V-other', status: 'active', leaseUntil: Date.now() + 60_000, tasks: [] },
        ]),
      );
    });
    const runner = new LeadRunner(f.h, f.root);
    const job = { kind: 'changeset', id: 'CS-own', stage: 1 } as WorkflowJob;
    const print = () =>
      (runner as unknown as { waitPrint(j: WorkflowJob, e: () => []): string }).waitPrint(
        job,
        () => [],
      );
    const during = print();
    f.store.change('fixture.finished', (s) => {
      const v = s.changeSets.find((c) => c.id === 'CS-other')!.verifications[0];
      v.status = 'passed';
    });
    assert.notEqual(print(), during, 'конец чужой проверки меняет отпечаток');
  } finally {
    f.cleanup();
  }
});
