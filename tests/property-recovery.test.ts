import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { CheckCorpus } from '../src/core/check-store.ts';
import {
  check,
  checkProject,
  fixture,
  knap,
  reach,
  rejection,
  removeRoot,
} from './check-fixture.ts';

const zero = (v: number) => JSON.stringify({ items: [{ w: 0, v }], cap: 0 });
const weak = () => ({ 'check.mjs': check(120, { zeroWeights: false }) });
type F = Awaited<ReturnType<typeof fixture>>;

/** Детерминированный ведущий: решение задаёт тест, вызовы считаются. */
function lead(decide: (r: AgentRequest) => unknown) {
  const calls: AgentRequest[] = [];
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute(r) {
      calls.push(r);
      return Promise.resolve({ data: decide(r), log: 'fixture lead', command: ['lead'] });
    },
  });
  return { calls, runtimes: { codex: make('codex'), claude: make('claude') } };
}
const decision = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  reason: 'Два отказа по одному свойству на нулевых весах.',
  evidence: ['оба контрпримера содержат предмет нулевого веса'],
  hypothesis: null,
  plan: null,
  cases: null,
  proposal: null,
  conflict: null,
  ...extra,
});

function addTask(
  f: F,
  board: string,
  title: string,
  properties = ['knapsack-optimal'],
  dependsOn: string[] = [],
) {
  return f.h.addTask(board, {
    title,
    description: 'Оптимум рюкзака по договору проверки.',
    role: 'backend',
    contracts: [f.contract!.id],
    acceptance: ['AC-optimal'],
    writePaths: ['src/'],
    properties,
    dependsOn,
  });
}
const task = (f: F, id: string) => f.store.read().tasks.find((t) => t.id === id)!;
const runs = (f: F, id: string) => f.store.read().runs.filter((r) => r.taskId === id);

/** Сервер: такты ведущего и планировщика без участия человека. */
async function serve(f: F, runner: LeadRunner, done: () => boolean, max = 40) {
  for (let i = 0; i < max && !done(); i++) {
    await runner.tick();
    await f.scheduler.drain();
  }
}

test('AC24: two substantive failures on one property with different messages and inputs forbid a third claim; the property never comes from the message text', async () => {
  const p = await checkProject(weak());
  const f = await fixture(p, {
    reviewer: (_r, calls) => ({
      ...rejection({
        property: 'knapsack-optimal',
        input: zero(calls.review),
        expected: String(calls.review),
        actual: '0',
      }),
      summary:
        calls.review === 1
          ? 'Нули не учитываются'
          : 'Совсем другой текст про reach-complete и границы',
    }),
  });
  try {
    f.write('src/knap.mjs', knap.zeroWeight);
    const board = f.h.createBoard('Recovery');
    const t = addTask(f, board.id, 'Knapsack');
    f.h.approve(board.id);
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(task(f, t.id).recovery, undefined, 'после одного отказа эпизода нет');
    assert.deepEqual(runs(f, t.id)[0].properties, ['knapsack-optimal']);
    f.h.retry(t.id);
    await f.scheduler.drain();
    const r = task(f, t.id).recovery!;
    assert.equal(r.status, 'awaiting-lead');
    assert.equal(r.property, 'knapsack-optimal');
    assert.deepEqual(
      r.runs,
      runs(f, t.id).map((x) => x.id),
    );
    // Попытки остались, но третья выдача запрещена до решения.
    assert.ok(task(f, t.id).attempt < f.h.config.maxAttempts);
    f.h.retry(t.id);
    assert.equal(f.h.claim('probe'), undefined);
    assert.equal(runs(f, t.id).length, 2);
    // Текст ревью упоминал reach-complete, но свойство отказа — из входа находки.
    assert.ok(runs(f, t.id).every((x) => !x.properties?.includes('reach-complete')));
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC25: an infrastructure failure between failures neither counts nor resets, two findings of one run count once, and properties are not glued together', async () => {
  const p = await checkProject(weak());
  let mode: 'reject-twice' | 'approve' | 'reject-reach' = 'reject-twice';
  const f = await fixture(p, {
    config: { maxAttempts: 5 },
    reviewer: () =>
      mode === 'approve'
        ? undefined
        : mode === 'reject-reach'
          ? rejection({
              property: 'reach-complete',
              input: '{"weights":[0],"cap":0}',
              expected: '[0]',
              actual: '[]',
            })
          : {
              approved: false,
              summary: 'Два замечания одного прогона',
              findings: [1, 2].map((v) => ({
                severity: 'blocking',
                message: 'Нулевой вес ' + v,
                reproduction: {
                  property: 'knapsack-optimal',
                  input: zero(v),
                  expected: String(v),
                  actual: '0',
                  command: null,
                  executed: false,
                  run: null,
                },
              })),
            },
  });
  try {
    f.write('src/knap.mjs', knap.zeroWeight);
    f.write('src/reach.mjs', reach.correct);
    const board = f.h.createBoard('Recovery');
    const t = addTask(f, board.id, 'Knapsack', ['knapsack-optimal', 'reach-complete']);
    f.h.approve(board.id);
    f.h.pause(false);
    await f.scheduler.drain(); // отказ 1 по knapsack: две находки одного прогона
    assert.equal(task(f, t.id).recovery, undefined, 'две находки одного прогона — один отказ');
    // Отказ окружения: исполнитель не дошёл до кандидата.
    const original = f.scheduler.runtimes.demo.execute.bind(f.scheduler.runtimes.demo);
    f.scheduler.runtimes.demo.execute = () => Promise.reject(new Error('socket hang up'));
    f.h.retry(t.id);
    await f.scheduler.drain();
    assert.equal(runs(f, t.id).at(-1)!.failureKind, 'environment');
    assert.equal(task(f, t.id).recovery, undefined);
    f.scheduler.runtimes.demo.execute = original;
    // Отказ окружения остановил выдачу; восстановление снимает эту причину.
    f.h.pause(false);
    // Второй содержательный отказ по knapsack: окружение между ними не в счёт.
    f.h.retry(t.id);
    await f.scheduler.drain();
    const r = task(f, t.id).recovery;
    assert.ok(r, 'отказы 1 и 3 по knapsack идут подряд');
    assert.equal(r.property, 'knapsack-optimal');
    const all = runs(f, t.id);
    assert.deepEqual(r.runs, [all[0].id, all[2].id]);
    // Два содержательных отказа подряд по разным свойствам не склеиваются.
    const other = addTask(f, f.h.createBoard('Independent').id, 'Two properties', [
      'knapsack-optimal',
      'reach-complete',
    ]);
    f.h.approve(f.store.read().boards.at(-1)!.id);
    mode = 'reject-twice';
    await f.scheduler.drain();
    mode = 'reject-reach';
    f.h.retry(other.id);
    await f.scheduler.drain();
    assert.deepEqual(
      runs(f, other.id).map((x) => x.properties),
      [['knapsack-optimal'], ['reach-complete']],
    );
    assert.equal(task(f, other.id).recovery, undefined);
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC26: in agent mode the server finishes the narrow route without a chat or a technical click — by added cases and by a new hypothesis', async () => {
  for (const route of ['add-cases', 'new-approach'] as const) {
    const p = await checkProject(weak());
    const f = await fixture(p, {
      config: { repairBudget: 4 },
      reviewer: (_r, calls) =>
        calls.review <= 2
          ? rejection({
              property: 'knapsack-optimal',
              input: zero(calls.review + 4),
              expected: String(calls.review + 4),
              actual: '0',
            })
          : undefined,
    });
    const l = lead((r) => {
      assert.match(r.prompt, /"property": "knapsack-optimal"/);
      return route === 'add-cases'
        ? decision('add-cases', {
            cases: [
              { input: zero(9), expected: '9' },
              { input: zero(11), expected: null },
            ],
          })
        : decision('new-approach', {
            hypothesis: 'Предметы нулевого веса нужно брать всегда: они не тратят вместимость.',
            plan: 'Проверить корпус и семейство с нулевыми весами.',
          });
    });
    const runner = new LeadRunner(f.h, p.root, l.runtimes);
    try {
      f.write('src/knap.mjs', knap.zeroWeight);
      const board = f.h.createBoard('Autonomous ' + route);
      const t = addTask(f, board.id, 'Knapsack');
      runner.workflow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
      // Исполнитель «исправляется» только после решения ведущего.
      const original = f.scheduler.runtimes.demo.execute.bind(f.scheduler.runtimes.demo);
      f.scheduler.runtimes.demo.execute = (r) => {
        if (!r.review && /Lead decision/.test(r.prompt)) f.write('src/knap.mjs', knap.correct);
        return original(r);
      };
      await serve(
        f,
        runner,
        () =>
          task(f, t.id).status === 'done' &&
          f.store.read().boards[0].revisions.at(-1)!.status === 'accepted',
      );
      const done = task(f, t.id);
      assert.equal(
        done.status,
        'done',
        `${route}: ${done.failure} ${JSON.stringify(done.recovery)}`,
      );
      assert.equal(l.calls.length, 1, 'один разбор ведущего');
      assert.equal(l.calls[0].purpose, 'recovery');
      assert.equal(runs(f, t.id).length, 3, 'два отказа и один разрешённый повтор');
      const history = done.recoveryHistory!.at(-1)!;
      assert.equal(history.decision!.action, route);
      assert.equal(history.status, 'closed');
      if (route === 'add-cases') {
        const suite = new CheckCorpus(f.h).all()[0];
        assert.equal(Object.keys(suite.cases).length, 2, 'оба случая подтверждены эталоном');
        assert.equal(done.checkVersion?.number, suite.versions.at(-1)!.number);
      } else assert.match(f.calls.prompts.at(-1)!, /Hypothesis: Предметы нулевого веса/);
      // Вызов ведущего учтён в телеметрии.
      const usage = f.h.store.localRecords('usage', 'main');
      assert.ok(Object.values(usage).some((u) => JSON.stringify(u).includes('property-recovery')));
      assert.equal(f.store.read().boards[0].revisions.at(-1)!.status, 'accepted');
    } finally {
      await runner.stop();
      await f.close();
      await removeRoot(p.root);
    }
  }
});

test('AC27: a restart, a duplicate or re-registered workflow and a repeated failure after the decision never buy a free call or an endless retry', async () => {
  const p = await checkProject(weak());
  const f = await fixture(p, {
    reviewer: (_r, calls) =>
      rejection({
        property: 'knapsack-optimal',
        input: zero(calls.review + 2),
        expected: String(calls.review + 2),
        actual: '0',
      }),
  });
  const l = lead(() =>
    decision('new-approach', { hypothesis: 'Брать нулевые веса.', plan: 'Корпус.' }),
  );
  const runner = new LeadRunner(f.h, p.root, l.runtimes);
  try {
    f.write('src/knap.mjs', knap.zeroWeight);
    const board = f.h.createBoard('Restart');
    const t = addTask(f, board.id, 'Knapsack');
    const job = runner.workflow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    await runner.tick(); // ревью плана
    await runner.tick(); // выдача
    await f.scheduler.drain();
    f.h.retry(t.id);
    await f.scheduler.drain();
    const opened = task(f, t.id).recovery!;
    assert.equal(opened.status, 'awaiting-lead');
    // Прежний процесс учёл разбор и умер до ответа модели.
    f.h.recoveryReserve(t.id, opened.id);
    assert.equal(task(f, t.id).recovery?.status, 'analyzing');
    await runner.tick();
    const after = task(f, t.id).recovery!;
    assert.equal(after.status, 'awaiting-user');
    assert.match(after.reason!, /прерван/);
    assert.equal(l.calls.length, 0, 'вызов после рестарта не повторён');
    // Повторная регистрация того же входа и повтор стадии бюджета не дают.
    const again = runner.workflow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    assert.equal(again.key, job.key);
    runner.workflow.retry(job.key, job.owner);
    await runner.tick();
    assert.equal(l.calls.length, 0);
    assert.equal(runner.workflow.get(job.key, job.owner).status, 'failed');
    // Повторная резервация того же эпизода — тоже без вызова.
    f.h.store.change('test.reopen', (s) => {
      s.tasks.find((x) => x.id === t.id)!.recovery!.status = 'awaiting-lead';
    });
    const refused = f.h.recoveryReserve(t.id, opened.id);
    assert.equal(refused.status, 'awaiting-user');
    assert.match(refused.reason!, /уже использован/);
    // Ручное решение: один разрешённый повтор; повторный провал — остановка.
    const current = task(f, t.id).recovery!;
    const decided = f.h.recoveryDecide(
      t.id,
      current.id,
      {
        action: 'new-approach',
        reason: 'Решение ведущего через API после прерванного разбора.',
        evidence: [],
        hypothesis: 'Брать нулевые веса.',
        plan: 'Корпус и генератор.',
        source: { kind: 'operator' },
        decidedAt: new Date().toISOString(),
      },
      current.version,
    );
    assert.equal(decided.status, 'retry');
    // Устаревшая версия записи не применяется.
    assert.throws(
      () =>
        f.h.recoveryDecide(
          t.id,
          current.id,
          { ...decided.decision!, source: { kind: 'operator' } },
          current.version,
        ),
      /изменился/,
    );
    f.h.retry(t.id);
    await f.scheduler.drain();
    const stopped = task(f, t.id).recovery!;
    assert.equal(stopped.status, 'stopped');
    assert.match(stopped.reason!, /Повторный отказ по свойству knapsack-optimal/);
    const attempts = task(f, t.id).attempt;
    if (task(f, t.id).status === 'failed' && attempts < f.h.config.maxAttempts) f.h.retry(t.id);
    assert.equal(f.h.claim('probe'), undefined, 'бесконечного повтора нет');
    assert.equal(task(f, t.id).attempt, attempts, 'сброса попыток нет');
    assert.ok(stopped.history.some((h) => h.event === 'interrupted'));
    assert.equal(l.calls.length, 0);
  } finally {
    await runner.stop();
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC28: a human pause, a cancellation, operator mode and a product conflict are never bypassed; independent tasks keep running', async () => {
  const p = await checkProject(weak());
  const f = await fixture(p, {
    reviewer: (r, calls) =>
      r.prompt.includes('Knapsack chain')
        ? rejection({
            property: 'knapsack-optimal',
            input: zero(calls.review + 2),
            expected: String(calls.review + 2),
            actual: '0',
          })
        : undefined,
  });
  const l = lead(() =>
    decision('clarify-obligation', { conflict: 'Нулевой вес не описан в области входов' }),
  );
  const runner = new LeadRunner(f.h, p.root, l.runtimes);
  try {
    f.write('src/knap.mjs', knap.zeroWeight);
    f.write('src/reach.mjs', reach.correct);
    const board = f.h.createBoard('Conflict');
    const blocked = addTask(f, board.id, 'Knapsack chain');
    const independent = addTask(f, board.id, 'Reach sums', ['reach-complete']);
    // Независимая задача пишет только свою реализацию.
    const original = f.scheduler.runtimes.demo.execute.bind(f.scheduler.runtimes.demo);
    f.scheduler.runtimes.demo.execute = async (r) => {
      if (r.review || r.task.id !== independent.id) return original(r);
      await writeFile(join(r.cwd, 'src/reach.mjs'), reach.correct);
      return { data: { completed: true, summary: 'ok', discoveries: [] }, log: '', command: [] };
    };
    const job = runner.workflow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    await runner.tick();
    await runner.tick();
    await f.scheduler.drain();
    f.h.retry(blocked.id);
    await f.scheduler.drain();
    assert.equal(
      task(f, blocked.id).recovery?.status,
      'awaiting-lead',
      JSON.stringify(runs(f, blocked.id).map((x) => [x.failureKind, x.properties, x.error])),
    );
    // Пауза человека после старта работы: разбор её не обходит.
    f.h.pause(true);
    await runner.tick();
    assert.equal(l.calls.length, 0);
    assert.equal(f.store.read().paused, true);
    // Operator mode: никаких автоматических вызовов.
    f.h.pause(false);
    f.h.config.approvalMode = 'operator';
    await runner.tick();
    assert.equal(l.calls.length, 0);
    f.h.config.approvalMode = 'agent';
    // Конфликт продуктового смысла — решение пользователя.
    // Причина остановки названа в работе; ведущий повторяет стадию явно.
    assert.match(runner.workflow.get(job.key, job.owner).error ?? '', /снятия паузы человеком/);
    runner.workflow.retry(job.key, job.owner);
    await runner.tick();
    assert.equal(l.calls.length, 1);
    const r = task(f, blocked.id).recovery!;
    assert.equal(r.status, 'awaiting-user');
    assert.match(r.reason!, /Нулевой вес не описан/);
    // Независимая задача той же доски выполнена, хотя первая ждёт решения.
    assert.equal(task(f, independent.id).status, 'done', task(f, independent.id).failure);
    assert.equal(f.h.claim('probe'), undefined);
    // Отмена человеком не превращается в повтор.
    f.h.cancel(blocked.id, 'Отменено пользователем до решения');
    await runner.tick();
    assert.equal(task(f, blocked.id).status, 'cancelled');
    assert.equal(l.calls.length, 1);
  } finally {
    await runner.stop();
    await f.close();
    await removeRoot(p.root);
  }
});
