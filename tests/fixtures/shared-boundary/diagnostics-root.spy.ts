// Наблюдение границы общих проекций workProgress и nextAction корня пакета
// (запускается из tests/harness-shared-diagnostics.test.ts с
// --experimental-test-module-mocks). Подмена корня сохраняет все настоящие
// экспорты: хост загружает через корень и остальное исполнение.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as real from 'devcontour-harness';
import type { NextInput, NextView, ProgressInput, ProgressView } from 'devcontour-harness';

type Mode<T> = { answer?: T; error?: Error };
let progressMode: Mode<ProgressView> = {};
let nextMode: Mode<NextView> = {};
const calls = { progress: [] as ProgressInput[], next: [] as NextInput[] };
const reset = () => {
  progressMode = {};
  nextMode = {};
  calls.progress.length = 0;
  calls.next.length = 0;
};

mock.module('devcontour-harness', {
  namedExports: {
    ...real,
    workProgress: (input: ProgressInput) => {
      calls.progress.push(input);
      if (progressMode.error) throw progressMode.error;
      return progressMode.answer ?? real.workProgress(input);
    },
    nextAction: (input: NextInput) => {
      calls.next.push(structuredClone(input));
      if (nextMode.error) throw nextMode.error;
      return nextMode.answer ?? real.nextAction(input);
    },
  },
});

const { taskProgress } = await import('../../../src/application/context.ts');
const { taskChecks } = await import('../../../src/application/checks.ts');
const { fixture, input } = await import('../../helpers.ts');

/** Доска с готовой задачей и её зависимостью; очередь запущена. */
function board() {
  const f = fixture();
  const b = f.h.createBoard('Board');
  const dep = f.h.addTask(b.id, input('Dependency task'));
  const t = f.h.addTask(b.id, input('Target task'));
  f.h.approve(b.id);
  f.h.pause(false);
  const read = () => {
    const s = f.store.read();
    return {
      s,
      t: s.tasks.find((x) => x.id === t.id)!,
      dep: s.tasks.find((x) => x.id === dep.id)!,
    };
  };
  return { f, b, read, ids: { t: t.id, dep: dep.id } };
}

void test('taskProgress передаёт работу, пределы и продуктовые причины в workProgress', () => {
  reset();
  const { f, b, read, ids } = board();
  try {
    f.store.change('fixture', (s) => {
      s.team = { member: 'alice' };
      const x = s.tasks.find((y) => y.id === ids.t)!;
      x.assignee = 'bob';
      x.dependsOn = [ids.dep];
      x.attempt = 2;
      s.boards.find((y) => y.id === b.id)!.revisions.at(-1)!.status = 'accepted';
    });
    const { s, t } = read();
    const out = taskProgress(f.h, s, t, Date.now());
    assert.equal(calls.progress.length, 1);
    const call = calls.progress[0];
    assert.equal(call.work, t, 'работа — задача хоста');
    assert.equal(call.maxAttempts, f.h.config.maxAttempts);
    assert.equal(call.concurrency, f.h.config.concurrency);
    assert.equal(call.paused, false);
    assert.equal(call.activeRuns, 0);
    assert.deepEqual(call.hostReasons, ['inactive_revision', 'assigned_to_another_member']);
    assert.equal(call.statusOf(ids.dep), 'ready');
    assert.equal(call.statusOf('missing'), undefined);
    assert.deepEqual(out.reasons, [
      'inactive_revision',
      'dependencies_incomplete',
      'assigned_to_another_member',
    ]);
  } finally {
    f.cleanup();
  }
});

void test('taskProgress выдаёт подменённый ответ, а не свой пересчёт', () => {
  reset();
  const { f, read } = board();
  try {
    const { s, t } = read();
    assert.equal(
      taskProgress(f.h, s, t, Date.now()).eligible,
      true,
      'по настоящему состоянию задача выдаётся',
    );
    progressMode = {
      answer: { dependencies: ['SPY-DEP'], reasons: ['workers-busy'], eligible: false },
    };
    const out = taskProgress(f.h, s, t, Date.now());
    assert.deepEqual(out.reasons, ['workers_busy']);
    assert.deepEqual(out.dependencies, ['SPY-DEP']);
    assert.equal(out.eligible, false);
    progressMode = { answer: { dependencies: [], reasons: [], eligible: true } };
    f.store.change('fixture', (x) => {
      x.tasks.find((y) => y.id === t.id)!.status = 'failed';
    });
    const failed = read();
    assert.deepEqual(
      taskProgress(f.h, failed.s, failed.t, Date.now()).reasons,
      [],
      'сбой назвала бы только проекция',
    );
  } finally {
    f.cleanup();
  }
});

void test('taskProgress не подменяет отказ общей проекции', () => {
  reset();
  const { f, read } = board();
  try {
    const error = new Error('shared failure');
    progressMode = { error };
    const { s, t } = read();
    assert.throws(
      () => taskProgress(f.h, s, t, Date.now()),
      (e) => e === error,
    );
  } finally {
    f.cleanup();
  }
});

void test('taskChecks передаёт состояние задачи, эпизод и смену корпуса в nextAction', () => {
  reset();
  const { f, ids } = board();
  try {
    const recovery = {
      id: 'REC-1',
      property: 'p-0',
      basis: 'a'.repeat(64),
      runs: [],
      openedAt: '2026-01-01T00:00:00.000Z',
      status: 'awaiting-user' as const,
      calls: 1,
      reason: 'Нужно решение',
      history: [],
      version: 1,
    };
    f.store.change('fixture', (s) => {
      const x = s.tasks.find((y) => y.id === ids.t)!;
      x.status = 'failed';
      x.attempt = 2;
      x.recovery = recovery;
      x.hold = { operation: 'op-1', reason: 'Меняется контракт' };
    });
    const out = taskChecks(f.h, { taskId: ids.t });
    assert.equal(calls.next.length, 1);
    assert.deepEqual(calls.next[0], {
      status: 'failed',
      attempt: 2,
      maxAttempts: f.h.config.maxAttempts,
      hold: { operation: 'op-1', reason: 'Меняется контракт' },
      recovery,
      waitingAdoption: false,
    });
    assert.deepEqual(out.next, { actor: 'user', step: 'Нужно решение' });
    // Без эпизода и удержания — их нет и во входе.
    f.store.change('fixture', (s) => {
      const x = s.tasks.find((y) => y.id === ids.dep)!;
      x.status = 'failed';
      x.attempt = 1;
    });
    taskChecks(f.h, { taskId: ids.dep });
    assert.deepEqual(calls.next[1], {
      status: 'failed',
      attempt: 1,
      maxAttempts: f.h.config.maxAttempts,
      waitingAdoption: false,
    });
  } finally {
    f.cleanup();
  }
});

void test('taskChecks называет словами подменённый шаг, а не свой выбор ветки', () => {
  reset();
  const { f, ids } = board();
  try {
    f.store.change('fixture', (s) => {
      s.tasks.find((y) => y.id === ids.t)!.status = 'done';
    });
    nextMode = { answer: { actor: 'lead', action: 'review-plan', step: 'plan-review' } };
    assert.deepEqual(taskChecks(f.h, { taskId: ids.t }).next, {
      actor: 'lead',
      step: 'Черновик ждёт ревью плана.',
    });
    nextMode = { answer: { actor: 'controller', action: 'wait', step: 'held', detail: 'SPY-OP' } };
    assert.deepEqual(taskChecks(f.h, { taskId: ids.t }).next, {
      actor: 'controller',
      step: 'Выдачу удерживает операция SPY-OP.',
    });
  } finally {
    f.cleanup();
  }
});

void test('taskChecks не подменяет отказ общей проекции', () => {
  reset();
  const { f, ids } = board();
  try {
    const error = new Error('shared failure');
    nextMode = { error };
    assert.throws(
      () => taskChecks(f.h, { taskId: ids.t }),
      (e) => e === error,
    );
  } finally {
    f.cleanup();
  }
});
