import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import { failureFingerprint, repairPolicy, type FailureKind } from '../src/core/failure.ts';
import { repairDecision } from '../src/core/repair.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import type { DevContour } from '../src/core/service.ts';

/** Довести задачу до падения с заданным классом и вернуть её id. */
function breakTask(h: DevContour, taskId: string, kind: FailureKind, message: string) {
  h.pause(false);
  const run = h.claim('test')!;
  assert.equal(run.taskId, taskId);
  h.fail(run.id, run.token, message, false, kind);
  return run;
}

test('Отпечаток отказа совпадает у одинаковых причин и расходится у разных', () => {
  // Сообщения одной и той же причины отличаются идентификаторами прогона,
  // SHA и временем. Если считать их разными, предел одинаковых повторов не
  // сработает никогда, и цикл будет чинить одно и то же до бюджета.
  const first = failureFingerprint(
    'gate',
    'candidate/typecheck: 3 ошибки в /tmp/devcontour-a1b2c3/worktrees/R-7 at 2026-09-24T10:00:00Z',
  );
  const second = failureFingerprint(
    'gate',
    'candidate/typecheck: 5 ошибки в /tmp/devcontour-f9e8d7/worktrees/R-12 at 2026-09-24T11:30:00Z',
  );
  assert.equal(first, second);
  assert.notEqual(first, failureFingerprint('gate', 'candidate/lint: неиспользуемый импорт'));
  // Отпечаток консервативен: при разном тексте он различает, даже если причина
  // могла быть той же. Ошибиться в эту сторону значит разрешить лишний повтор,
  // ограниченный пределом класса; ошибиться в другую — остановить цикл там, где
  // исполнитель как раз продвинулся.
  // Класс входит в отпечаток: одинаковый текст с разным классом — разные случаи.
  assert.notEqual(first, failureFingerprint('review', 'candidate/typecheck: 3 ошибки'));
});

test('Класс отказа и его отпечаток переживают запись: решение принимается по состоянию', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    breakTask(f.h, t.id, 'gate', 'candidate/typecheck: 3 ошибки');

    const stored = f.store.read();
    assert.equal(stored.tasks[0].failureKind, 'gate');
    assert.equal(stored.runs[0].failureKind, 'gate');
    // Один и тот же отпечаток на прогоне и на задаче: по прогонам считаются
    // повторы, по задаче принимается решение, и разойтись они не должны.
    assert.equal(stored.tasks[0].failureFingerprint, stored.runs[0].failureFingerprint);
  } finally {
    f.cleanup();
  }
});

test('Каждый класс отказа получает разрешённое действие, а не общий отказ в диагностике', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const options = { budgetLeft: 6, maxAttempts: 3 };

    for (const kind of ['gate', 'review', 'empty-result', 'timeout', 'merge'] as const) {
      breakTask(f.h, t.id, kind, `Отказ класса ${kind}`);
      const s = f.store.read();
      const decision = repairDecision(s, s.tasks, options)!;
      assert.equal(decision.action, 'retry', `${kind} должен чиниться повтором`);
      assert.equal(decision.action === 'retry' && decision.kind, kind);
      f.h.retry(t.id);
      // Бюджет попыток задачи тратится настоящими попытками; между проверками
      // классов он сбрасывается, иначе сработает не проверяемый здесь предел.
      f.store.change('test.reset', (state) => {
        state.tasks[0].attempt = 0;
        state.runs = [];
        return {};
      });
    }

    // Провайдер отказал всем: повтор потратит бюджет на причину вне контура.
    breakTask(f.h, t.id, 'provider-auth', 'Credit balance too low');
    const refused = f.store.read();
    const stop = repairDecision(refused, refused.tasks, options)!;
    assert.equal(stop.action, 'stop');
    assert.match(stop.reason, /кредитов|авторизован/);
  } finally {
    f.cleanup();
  }
});

test('Одна и та же причина чинится до предела, затем цикл останавливается без новой гипотезы', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const options = { budgetLeft: 20, maxAttempts: 10 };
    const message = 'candidate/typecheck: та же ошибка';

    // Предел класса — это число автоматических починок: столько же отказов
    // подряд ещё чинятся, следующий останавливает цикл.
    for (let i = 0; i < repairPolicy.gate.repeats; i++) {
      breakTask(f.h, t.id, 'gate', message);
      const s = f.store.read();
      assert.equal(repairDecision(s, s.tasks, options)!.action, 'retry');
      f.h.retry(t.id);
    }
    // Тот же отпечаток сверх предела: у исполнителя нет новой гипотезы, и
    // повторять дальше значит платить за один и тот же ответ.
    breakTask(f.h, t.id, 'gate', message);
    const exhausted = f.store.read();
    const decision = repairDecision(exhausted, exhausted.tasks, options)!;
    assert.equal(decision.action, 'stop');
    assert.match(decision.reason, /одна и та же причина/);

    // Другая причина того же класса — новая гипотеза, и она чинится.
    // Бюджет попыток задачи проверяется отдельным тестом; здесь он сброшен,
    // чтобы правило одинаковых отпечатков проверялось само по себе.
    f.store.change('test.reset', (state) => {
      state.tasks[0].attempt = 0;
      return {};
    });
    f.h.retry(t.id);
    breakTask(f.h, t.id, 'gate', 'candidate/lint: другая ошибка');
    const fresh = f.store.read();
    assert.equal(repairDecision(fresh, fresh.tasks, options)!.action, 'retry');
  } finally {
    f.cleanup();
  }
});

test('Отмена человеком не превращается в повтор, даже когда рядом есть чинимая задача', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const broken = f.h.addTask(b.id, input());
    const cancelled = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    breakTask(f.h, broken.id, 'gate', 'candidate/typecheck: ошибка');
    f.h.cancel(cancelled.id);

    const s = f.store.read();
    const decision = repairDecision(s, s.tasks, { budgetLeft: 6, maxAttempts: 3 })!;
    assert.equal(decision.action, 'stop');
    assert.equal(decision.taskId, cancelled.id);
    assert.match(decision.reason, /Отмена не превращается в повтор/);
  } finally {
    f.cleanup();
  }
});

test('Бюджет восстановлений и бюджет попыток задачи останавливают цикл каждый своей причиной', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    breakTask(f.h, t.id, 'gate', 'candidate/typecheck: ошибка');
    const s = f.store.read();

    const spent = repairDecision(s, s.tasks, { budgetLeft: 0, maxAttempts: 3 })!;
    assert.equal(spent.action, 'stop');
    assert.match(spent.reason, /бюджет автоматических восстановлений/);

    // Потолок попыток задачи снимается только сбросом, а сброс означает
    // «причина устранена снаружи» — этого цикл не знает и утверждать не вправе.
    const capped = repairDecision(s, s.tasks, { budgetLeft: 6, maxAttempts: 1 })!;
    assert.equal(capped.action, 'stop');
    assert.match(capped.reason, /сбросом/);
  } finally {
    f.cleanup();
  }
});

test('Ведущий цикл чинит упавшую задачу сам и учитывает это в одной транзакции', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    breakTask(f.h, t.id, 'gate', 'candidate/typecheck: ошибка');

    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    const claimed = flow.claim(job.key, job.owner)!;
    // Вторая стадия: план уже проверен, задачи исполняются.
    f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));
    const running = flow.get(job.key, job.owner);

    const runner = new LeadRunner(f.h, f.root);
    const waiting = await runner.execute(running, new AbortController().signal);

    assert.equal(waiting, true, 'цикл ждёт результата назначенного повтора');
    assert.equal(f.store.read().tasks[0].status, 'ready');
    assert.equal(f.store.read().tasks[0].failure, undefined);
    assert.equal(flow.get(job.key, job.owner).repairs, 1);
    assert.ok(
      flow.get(job.key, job.owner).history.some((h) => h.event === 'repair:gate'),
      'решение видно в истории работы',
    );

    // Так стадию завершает настоящий цикл: ожидание возвращает попытку стадии
    // и снимает запись о захвате. Снять при этом решение о восстановлении
    // значило бы стереть единственный след того, что цикл сделал сам.
    flow.finish(running, waiting);
    const after = flow.get(job.key, job.owner);
    assert.equal(after.stage, 1, 'ожидание не продвигает стадию');
    assert.equal(after.attempts, 0, 'ожидание не тратит попытку стадии');
    assert.deepEqual(
      after.history.map((h) => h.event),
      ['repair:gate'],
    );
    assert.equal(after.repairs, 1);
  } finally {
    f.cleanup();
  }
});

test('Исчерпанный класс останавливает работу с причиной, которую видит человек', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    breakTask(f.h, t.id, 'provider-auth', 'Credit balance too low');

    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    const claimed = flow.claim(job.key, job.owner)!;
    f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));
    const running = flow.get(job.key, job.owner);

    const runner = new LeadRunner(f.h, f.root);
    await assert.rejects(
      () => runner.execute(running, new AbortController().signal),
      /кредитов|авторизован/,
    );
    // Задача осталась упавшей: остановка не маскирует причину сменой статуса.
    assert.equal(f.store.read().tasks[0].status, 'failed');
    assert.equal(flow.get(job.key, job.owner).repairs, undefined);
  } finally {
    f.cleanup();
  }
});
