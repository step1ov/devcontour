// Диагностика хоста поверх общих проекций harness (OP-DIAG-01..04):
// корни цепочки, причины невыдачи, следующий шаг и причина остановки
// очереди. Здесь — наблюдаемое поведение на настоящем установленном пакете
// (AC09–AC13), доказательство делегирования через подмену модулей в
// отдельных процессах (AC02/AC03) и браузерная чистота подпути projections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chainRoots,
  type ChainRoot,
  type ChainRootCode,
  type ChainWork,
} from 'devcontour-harness/projections';
import { chainBlockers, queueStopReason } from '../src/core/work-status.ts';
import { AgentContext, taskProgress } from '../src/application/context.ts';
import { taskChecks } from '../src/application/checks.ts';
import type { DevContourState, Task } from '../src/core/model.ts';
import { fixture, input } from './helpers.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const task = (
  id: string,
  status: Task['status'],
  dependsOn: string[] = [],
  extra: Partial<Task> = {},
) => ({ id, title: 'Задача ' + id, status, dependsOn, attempt: 0, ...extra });
type Row = ReturnType<typeof task>;

// Те же входы для общей проекции: работа без продуктовых полей.
const works = (rows: Row[]): ChainWork[] =>
  rows.map((t) => ({
    id: t.id,
    status: t.status,
    dependsOn: t.dependsOn,
    attempt: t.attempt,
    ...(t.activeRunId ? { activeRunId: t.activeRunId } : {}),
    ...(t.hold ? { hold: t.hold } : {}),
    ...(t.budgetBlock ? { budgetBlock: { reason: t.budgetBlock.reason } } : {}),
  }));

// Договор слов панели для кодов корня — выписан буквально, не из хоста.
const expectedTexts: Record<ChainRootCode, (detail?: string) => [string, string]> = {
  'failed-exhausted': () => [
    'сбой, бюджет попыток исчерпан',
    'ведущий устраняет причину и повторяет со сбросом бюджета',
  ],
  failed: () => ['сбой', 'повтор назначит восстановление или ведущий'],
  draft: () => ['план не утверждён', 'ревью и утверждение плана'],
  cancelled: () => ['отменена', 'перепланировать зависимые задачи'],
  held: (detail) => [`удержана: ${detail}`, 'дождаться завершения операции'],
  'budget-blocked': (detail) => [
    detail!,
    'осознанно поднять предел в budgets или задать политику onUnknown',
  ],
  'attempts-exhausted': () => ['исчерпан бюджет попыток', 'повтор со сбросом бюджета'],
};

/** Ответ хоста и общей проекции на одни входы; хост — слова над ответом harness. */
function compare(rows: Row[], maxAttempts = 3) {
  const host = chainBlockers(rows, maxAttempts);
  const shared = chainRoots(works(rows), maxAttempts);
  assert.deepEqual(
    host.map((b) => [b.taskId, b.waiting]),
    shared.map((r) => [r.workId, r.waiting]),
    'корни и счётчики хоста — ответ harness в том же порядке',
  );
  assert.deepEqual(
    host.map((b) => [b.reason, b.next]),
    shared.map((r) => expectedTexts[r.code](r.detail)),
  );
  assert.deepEqual(
    host.map((b) => b.title),
    shared.map((r) => 'Задача ' + r.workId),
  );
  return { host, shared };
}
const machine = (shared: ChainRoot[]) =>
  shared.map((r) => [r.workId, r.code, r.actor, r.action, r.detail ?? null]);

test('AC09: корень цепочки один, ждущие считаются один раз; хост — ответ chainRoots', () => {
  const chain = compare([
    task('root', 'failed', [], { attempt: 3 }),
    task('a', 'ready', ['root']),
    task('b', 'ready', ['a']),
    task('c', 'ready', ['b']),
    task('done', 'done'),
    task('free', 'ready', ['done']),
    task('alone', 'ready'),
  ]);
  assert.equal(chain.host.length, 1);
  assert.equal(chain.host[0].taskId, 'root');
  assert.equal(chain.host[0].waiting, 3);
  assert.deepEqual(machine(chain.shared), [
    ['root', 'failed-exhausted', 'user', 'reset-attempts', null],
  ]);

  // Ромб: d ждёт b и c, обе ждут упавший r — d засчитан один раз.
  const diamond = compare([
    task('r', 'failed', [], { attempt: 1 }),
    task('b', 'ready', ['r']),
    task('c', 'ready', ['r']),
    task('d', 'ready', ['b', 'c']),
  ]);
  assert.deepEqual(
    diamond.host.map((b) => [b.taskId, b.waiting]),
    [['r', 3]],
  );
  assert.deepEqual(machine(diamond.shared), [['r', 'failed', 'controller', 'retry', null]]);
});

test('AC09/AC10: каждый код корня — свои слова и свой исполнитель; корни различимы', () => {
  const rows = [
    task('fx', 'failed', [], { attempt: 3 }),
    task('f', 'failed', [], { attempt: 1 }),
    task('draft', 'draft'),
    task('cancelled', 'cancelled'),
    task('held', 'ready', [], { hold: { operation: 'op', reason: 'Меняется контракт X' } }),
    task('budget', 'ready', [], {
      attempt: 1,
      budgetBlock: { reason: 'Превышен предел стоимости', at: '2026-01-01T00:00:00.000Z' },
    }),
    task('exhausted', 'ready', [], { attempt: 3 }),
  ];
  const all = [...rows, ...rows.map((r) => task('w-' + r.id, 'ready', [r.id]))];
  const { host, shared } = compare(all);
  assert.deepEqual(machine(shared), [
    ['fx', 'failed-exhausted', 'user', 'reset-attempts', null],
    ['f', 'failed', 'controller', 'retry', null],
    ['draft', 'draft', 'lead', 'review-plan', null],
    ['cancelled', 'cancelled', 'lead', 'replan-dependents', null],
    ['held', 'held', 'controller', 'wait', 'Меняется контракт X'],
    ['budget', 'budget-blocked', 'user', 'raise-budget', 'Превышен предел стоимости'],
    ['exhausted', 'attempts-exhausted', 'user', 'reset-attempts', null],
  ]);
  assert.deepEqual(
    host.map((b) => [b.taskId, b.reason, b.next]),
    [
      [
        'fx',
        'сбой, бюджет попыток исчерпан',
        'ведущий устраняет причину и повторяет со сбросом бюджета',
      ],
      ['f', 'сбой', 'повтор назначит восстановление или ведущий'],
      ['draft', 'план не утверждён', 'ревью и утверждение плана'],
      ['cancelled', 'отменена', 'перепланировать зависимые задачи'],
      ['held', 'удержана: Меняется контракт X', 'дождаться завершения операции'],
      [
        'budget',
        'Превышен предел стоимости',
        'осознанно поднять предел в budgets или задать политику onUnknown',
      ],
      ['exhausted', 'исчерпан бюджет попыток', 'повтор со сбросом бюджета'],
    ],
  );
  // Удержание, бюджет, черновик и отмена не сливаются ни по коду, ни по словам.
  assert.equal(new Set(shared.map((r) => r.code)).size, shared.length);
  assert.equal(new Set(host.map((b) => b.reason + '|' + b.next)).size, host.length);
  // Бюджетный блок при исчерпанных попытках — исчерпание, а не бюджет.
  const both = compare([
    task('bx', 'ready', [], {
      attempt: 3,
      budgetBlock: { reason: 'Превышен предел стоимости', at: '2026-01-01T00:00:00.000Z' },
    }),
    task('w', 'ready', ['bx']),
  ]);
  assert.deepEqual(machine(both.shared), [
    ['bx', 'attempts-exhausted', 'user', 'reset-attempts', null],
  ]);
});

test('AC10: идущая и свободная готовая работа — не корень и не сбой', () => {
  const { host, shared } = compare([
    task('running', 'running'),
    task('claimed', 'ready', [], { activeRunId: 'run-1' }),
    task('free', 'ready', [], { attempt: 2 }),
    task('w1', 'ready', ['running']),
    task('w2', 'ready', ['claimed']),
    task('w3', 'ready', ['free']),
  ]);
  assert.deepEqual(host, []);
  assert.deepEqual(shared, []);
  // Тот же свободный предшественник при пределе 2 — уже исчерпание, а не «сбой».
  const { host: tight } = compare(
    [task('free', 'ready', [], { attempt: 2 }), task('w', 'ready', ['free'])],
    2,
  );
  assert.deepEqual(
    tight.map((b) => b.reason),
    ['исчерпан бюджет попыток'],
  );
});

test('AC10: упавшая задача не выдаётся; принятой и отменённой повтор не предлагается', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Failed task'));
    const done = f.h.addTask(b.id, input('Done task'));
    const cancelled = f.h.addTask(b.id, input('Cancelled task'));
    f.h.approve(b.id);
    const set = (attempt: number) =>
      f.store.change('fixture', (s) => {
        const x = s.tasks.find((y) => y.id === t.id)!;
        x.status = 'failed';
        x.attempt = attempt;
        s.tasks.find((y) => y.id === done.id)!.status = 'done';
        s.tasks.find((y) => y.id === cancelled.id)!.status = 'cancelled';
      });
    const progress = () => {
      const s = f.store.read();
      return taskProgress(
        f.h,
        s,
        s.tasks.find((x) => x.id === t.id)!,
      );
    };
    set(1);
    assert.deepEqual(progress().reasons, ['failure_requires_diagnosis']);
    assert.equal(progress().eligible, false);
    set(3);
    assert.deepEqual(progress().reasons, ['attempts_exhausted']);
    assert.equal(progress().eligible, false);
    assert.deepEqual(taskChecks(f.h, { taskId: done.id }).next, {
      actor: null,
      step: 'Задача принята.',
    });
    assert.deepEqual(taskChecks(f.h, { taskId: cancelled.id }).next, {
      actor: null,
      step: 'Задача отменена.',
    });
  } finally {
    f.cleanup();
  }
});

test('AC11: причина остановки очереди — только у паузы рантайма и только по свежей ошибке', () => {
  const errors = [
    { id: 4, type: 'scheduler.error', data: { error: 'TaskFailure: средняя' } },
    { id: 9, type: 'scheduler.error', data: { error: 'Error: самая свежая' } },
    { id: 12, type: 'task.updated', data: { error: 'Error: не ошибка планировщика' } },
    { id: 2, type: 'scheduler.error', data: { error: 'старая' } },
  ];
  assert.equal(queueStopReason({ paused: true, pauseReason: 'operator' }, errors), undefined);
  assert.equal(queueStopReason({ paused: true, pauseReason: 'runtime' }, errors), 'самая свежая');
  assert.equal(queueStopReason({ paused: true }, errors), 'самая свежая');
  assert.equal(
    queueStopReason({ paused: true }, [
      { id: 1, type: 'scheduler.error', data: { error: 'Error: Error: двойной' } },
    ]),
    'Error: двойной',
    'снимается один префикс',
  );
  assert.equal(
    queueStopReason({ paused: true }, [
      { id: 3, type: 'scheduler.error', data: { error: 'TaskFailure: свежая' } },
    ]),
    'свежая',
  );
  // Свежая ошибка без текста: старая за причину не выдаётся.
  assert.equal(
    queueStopReason({ paused: true, pauseReason: 'runtime' }, [
      { id: 1, type: 'scheduler.error', data: { error: 'Error: старая с текстом' } },
      { id: 5, type: 'scheduler.error', data: {} },
    ]),
    undefined,
  );
  assert.equal(
    queueStopReason({ paused: true }, [
      { id: 5, type: 'scheduler.error', data: undefined },
      { id: 1, type: 'scheduler.error', data: { error: 'старая' } },
    ]),
    undefined,
  );
  assert.equal(queueStopReason({ paused: false, pauseReason: 'runtime' }, errors), undefined);
  assert.equal(queueStopReason({}, errors), undefined);
});

test('AC11: следующий шаг по сбою зависит от остатка попыток; бюджетный корень — решение человека', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Failed task'));
    f.h.approve(b.id);
    const fail = (attempt: number) =>
      f.store.change('fixture', (s) => {
        const x = s.tasks.find((y) => y.id === t.id)!;
        x.status = 'failed';
        x.attempt = attempt;
      });
    fail(1);
    assert.deepEqual(taskChecks(f.h, { taskId: t.id }).next, {
      actor: 'controller',
      step: 'Повтор в пределах бюджета попыток.',
    });
    fail(f.h.config.maxAttempts);
    assert.deepEqual(taskChecks(f.h, { taskId: t.id }).next, {
      actor: 'user',
      step: 'Попытки исчерпаны: сброс — решение человека с причиной.',
    });
  } finally {
    f.cleanup();
  }
  const rows = [
    task('budget', 'ready', [], {
      attempt: 1,
      budgetBlock: { reason: 'Превышен предел стоимости', at: '2026-01-01T00:00:00.000Z' },
    }),
    task('w', 'ready', ['budget']),
  ];
  const { host, shared } = compare(rows);
  assert.deepEqual(
    host.map((x) => x.reason),
    ['Превышен предел стоимости'],
  );
  assert.deepEqual(
    shared.map((r) => [r.actor, r.action]),
    [['user', 'raise-budget']],
  );
});

test('Восстановление: закрытый эпизод идёт к ветке сбоя; текст разбора зависит от approvalMode', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Recovery task'));
    f.h.approve(b.id);
    const episode = (status: 'closed' | 'awaiting-lead') =>
      f.store.change('fixture', (s) => {
        const x = s.tasks.find((y) => y.id === t.id)!;
        x.status = 'failed';
        x.attempt = 1;
        x.recovery = {
          id: 'REC-1',
          property: 'p-0',
          basis: 'a'.repeat(64),
          runs: [],
          openedAt: '2026-01-01T00:00:00.000Z',
          status,
          calls: 1,
          history: [],
          version: 1,
        };
      });
    episode('closed');
    assert.deepEqual(taskChecks(f.h, { taskId: t.id }).next, {
      actor: 'controller',
      step: 'Повтор в пределах бюджета попыток.',
    });
    episode('awaiting-lead');
    f.h.config.approvalMode = 'agent';
    assert.deepEqual(taskChecks(f.h, { taskId: t.id }).next, {
      actor: 'lead',
      step: 'Ограниченный разбор ведущего по свойству p-0: сервер вызовет его сам в пределах бюджета.',
    });
    f.h.config.approvalMode = 'operator';
    assert.deepEqual(taskChecks(f.h, { taskId: t.id }).next, {
      actor: 'lead',
      step: 'Разбор свойства p-0: решение ведущего через recovery_decide (operator mode автоматически не вызывает модель).',
    });
  } finally {
    f.cleanup();
  }
});

/** Активная совместная проверка workspace с заданным сроком lease. */
function verification(s: DevContourState, leaseUntil: number) {
  s.changeSets.push({
    id: 'CHG-lease',
    title: 'lease',
    description: '',
    boardIds: [],
    createdAt: new Date().toISOString(),
    verifications: [
      {
        id: 'V-lease',
        token: 'verification-lease-token-000001',
        leaseUntil,
        startedAt: new Date().toISOString(),
        status: 'active',
        policyDigest: 'a'.repeat(64),
        specDigest: 'b'.repeat(64),
        tasks: [],
        boards: [],
        evidence: [],
      },
    ],
  });
}

test('AC12: точный порядок причин — продуктовые до общих, назначение и операция workspace после', () => {
  // Решение Q2: порядок [...до, ...общие, ...после] — намеренное отличие от
  // прежнего перемешанного перечня; здесь он закреплён полностью.
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const busy = f.h.addTask(b.id, input('Busy task'));
    const t = f.h.addTask(b.id, input('Guarded task', [busy.id]));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('owner')!;
    assert.equal(run.taskId, busy.id);
    f.h.config.concurrency = 1;
    const now = Date.now();
    f.store.change('fixture', (s) => {
      s.team = { member: 'alice' };
      const x = s.tasks.find((y) => y.id === t.id)!;
      x.assignee = 'bob';
      x.attempt = f.h.config.maxAttempts;
      s.paused = true;
      verification(s, now + 60_000);
    });
    const s = f.store.read();
    const target = s.tasks.find((x) => x.id === t.id)!;
    const shared = [
      'dependencies_incomplete',
      'attempts_exhausted',
      'queue_paused',
      'workers_busy',
    ];
    const after = ['assigned_to_another_member', 'workspace_operation_active'];
    const progress = taskProgress(f.h, s, target, now);
    assert.deepEqual(progress.reasons, [...shared, ...after]);
    assert.deepEqual(progress.dependencies, [busy.id]);
    assert.equal(progress.eligible, false);

    // Неактивная ревизия — первой среди общих и последующих.
    const inactive = structuredClone(s);
    inactive.boards.find((x) => x.id === b.id)!.revisions.at(-1)!.status = 'accepted';
    assert.deepEqual(taskProgress(f.h, inactive, target, now).reasons, [
      'inactive_revision',
      ...shared,
      ...after,
    ]);
    // Продукт не согласован: подготовка есть, привязки у задачи нет — самая первая причина.
    const prepared = structuredClone(inactive);
    prepared.preparation = { id: 'workspace-preparation', changes: [] };
    assert.deepEqual(taskProgress(f.h, prepared, target, now).reasons, [
      'product_approval_required',
      'inactive_revision',
      ...shared,
      ...after,
    ]);
  } finally {
    f.cleanup();
  }
});

test('AC12: продуктовые ограничители выдачи не обходятся — claim не выдаёт задачу', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Guarded task'));
    f.h.approve(b.id);
    f.h.pause(false);
    const reasons = () => {
      const s = f.store.read();
      return taskProgress(
        f.h,
        s,
        s.tasks.find((x) => x.id === t.id)!,
      );
    };
    const refused = (label: string) => {
      assert.equal(f.h.claim('owner'), undefined, label);
      assert.equal(f.store.read().runs.length, 0, label);
      assert.equal(reasons().eligible, false, label);
    };
    // Чужое назначение.
    f.store.change('fixture', (s) => {
      s.team = { member: 'alice' };
      s.tasks.find((x) => x.id === t.id)!.assignee = 'bob';
    });
    assert.deepEqual(reasons().reasons, ['assigned_to_another_member']);
    refused('чужое назначение');
    // Неактивная ревизия.
    f.store.change('fixture', (s) => {
      s.tasks.find((x) => x.id === t.id)!.assignee = 'alice';
      s.boards.find((x) => x.id === b.id)!.revisions.at(-1)!.status = 'accepted';
    });
    assert.deepEqual(reasons().reasons, ['inactive_revision']);
    refused('неактивная ревизия');
    // Продукт не согласован.
    f.store.change('fixture', (s) => {
      s.boards.find((x) => x.id === b.id)!.revisions.at(-1)!.status = 'active';
      s.preparation = { id: 'workspace-preparation', changes: [] };
    });
    assert.deepEqual(reasons().reasons, ['product_approval_required']);
    refused('продукт не согласован');
    // Ограничители сняты — та же задача выдаётся: отказ был именно от них.
    f.store.change('fixture', (s) => {
      delete s.preparation;
    });
    assert.equal(reasons().eligible, true);
    assert.equal(f.h.claim('owner')?.taskId, t.id);
  } finally {
    f.cleanup();
  }
});

test('AC13: чтения диагностики на границе lease не меняют состояние и не раскрывают владение', () => {
  const f = fixture();
  try {
    const api = new AgentContext(f.h);
    const b = f.h.createBoard('Board');
    const claimed = f.h.addTask(b.id, input('Claimed task'));
    const waiting = f.h.addTask(b.id, input('Waiting task', [claimed.id]));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('secret-owner')!;
    assert.equal(run.taskId, claimed.id);
    const lease = Date.now() + 3_600_000;
    f.store.change('fixture', (s) => verification(s, lease));

    const state = () => JSON.stringify(f.store.read());
    const before = {
      state: state(),
      events: f.store.events().length,
      runs: f.store.read().runs.length,
      attempts: f.store.read().tasks.map((t) => [t.id, t.attempt]),
    };
    const outputs: unknown[] = [];
    for (let k = 0; k < 3; k++) {
      const s = f.store.read();
      const t = s.tasks.find((x) => x.id === waiting.id)!;
      const at = taskProgress(f.h, s, t, lease);
      const inside = taskProgress(f.h, s, t, lease - 1);
      assert.equal(at.reasons.includes('workspace_operation_active'), false, 'now = leaseUntil');
      assert.equal(inside.reasons.includes('workspace_operation_active'), true, 'leaseUntil-1');
      outputs.push(
        at,
        inside,
        taskProgress(
          f.h,
          s,
          s.tasks.find((x) => x.id === claimed.id)!,
          lease,
        ),
        taskChecks(f.h, { taskId: waiting.id }),
        taskChecks(f.h, { taskId: claimed.id }),
        api.execute('task_briefing', { taskId: waiting.id }),
        api.execute('task_briefing', { taskId: claimed.id }),
        api.execute('project_context', {}),
      );
    }
    assert.equal(state(), before.state);
    assert.equal(f.store.events().length, before.events);
    assert.equal(f.store.read().runs.length, before.runs);
    assert.deepEqual(
      f.store.read().tasks.map((t) => [t.id, t.attempt]),
      before.attempts,
    );
    const text = JSON.stringify(outputs);
    assert.equal(text.includes(run.token), false);
    assert.equal(text.includes('secret-owner'), false);
    assert.equal(text.includes('verification-lease-token'), false);
  } finally {
    f.cleanup();
  }
});

/** Файл наблюдения границы в отдельном процессе: подмена модулей требует флага. */
function spy(name: string, minPass: number) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--disable-warning=ExperimentalWarning',
      '--import',
      'tsx',
      '--test',
      '--test-reporter=spec',
      join('tests/fixtures/shared-boundary', name),
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 240_000 },
  );
  const out = result.stdout + result.stderr;
  assert.equal(result.status, 0, out);
  const pass = Number(/^ℹ pass (\d+)$/m.exec(out)?.[1] ?? -1);
  assert.ok(pass >= minPass, `pass ${pass} < ${minPass}\n${out}`);
  assert.match(out, /^ℹ fail 0$/m, out);
}

test('AC02/AC03: chainBlockers и queueStopReason — ответ общей проекции без своей замены', () => {
  spy('diagnostics-projections.spy.ts', 6);
});

test('AC02/AC03: taskProgress и следующий шаг taskChecks — ответ общей проекции без своей замены', () => {
  spy('diagnostics-root.spy.ts', 6);
});

test('Подпуть devcontour-harness/projections чист для браузера и в панели нужен только work-status', () => {
  const builtins = new Set(builtinModules);
  const pkg = join(root, 'node_modules/devcontour-harness/lib/projections/index.js');
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const ref = m[1];
      assert.ok(ref.startsWith('.'), `${relative(root, file)}: внешний импорт ${ref}`);
      assert.ok(!ref.startsWith('node:') && !builtins.has(ref), `${file}: ${ref}`);
      visit(join(dirname(file), ref));
    }
    assert.doesNotMatch(text, /\brequire\s*\(/, file);
  };
  visit(pkg);
  assert.ok(seen.size > 1, 'обход прошёл по модулям проекций');

  const web = new Set<string>();
  const walk = (file: string) => {
    if (web.has(file)) return;
    web.add(file);
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(/^(?!import type)[^\n]*from '((?:\.{1,2}|@)\/[^']+)'/gm)) {
      const ref = m[1];
      const path = ref.startsWith('@/') ? join('src/web', ref.slice(2)) : join(dirname(file), ref);
      if (/\.(ts|tsx)$/.test(path)) walk(path);
    }
  };
  for (const entry of readdirSync(join(root, 'src/web'), { recursive: true }) as string[])
    if (/\.(ts|tsx)$/.test(entry)) walk(join('src/web', entry));
  assert.ok(web.has('src/core/work-status.ts'), 'панель доходит до work-status');
  const users = [...web].filter((f) =>
    /^(?!import type)[^\n]*from 'devcontour-harness\/projections'/m.test(
      readFileSync(join(root, f), 'utf8'),
    ),
  );
  assert.deepEqual(users, ['src/core/work-status.ts']);
});
