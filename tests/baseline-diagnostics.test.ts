// Характеристика host-диагностики остановок: корневые блокеры цепочки,
// причина остановки очереди и ограничители строк проекций. Фиксирует
// наблюдаемые поля, которые должны сохраниться после перехода на общие
// операции harness с host mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainBlockers, queueStopReason } from '../src/core/work-status.ts';
import { DIAGNOSTIC, SHORT, clip, short } from '../src/application/bounded.ts';
import type { Task } from '../src/core/model.ts';

const task = (
  id: string,
  status: Task['status'],
  dependsOn: string[] = [],
  extra: Partial<Task> = {},
) => ({ id, title: 'Задача ' + id, status, dependsOn, attempt: 0, ...extra });

test('Baseline chainBlockers: failed root with exhausted attempts blocks three ready dependents once', () => {
  const blockers = chainBlockers(
    [
      task('root', 'failed', [], { attempt: 3 }),
      task('a', 'ready', ['root']),
      task('b', 'ready', ['a']),
      task('c', 'ready', ['b']),
      task('done', 'done'),
      task('free', 'ready', ['done']),
      task('alone', 'ready'),
    ],
    3,
  );
  assert.deepEqual(blockers, [
    {
      taskId: 'root',
      title: 'Задача root',
      reason: 'сбой, бюджет попыток исчерпан',
      next: 'ведущий устраняет причину и повторяет со сбросом бюджета',
      waiting: 3,
    },
  ]);
});

test('Baseline chainBlockers: a dependent reached by two paths is counted once; two roots are separate', () => {
  // Ромб: d ждёт b и c, обе ждут упавший корень r.
  const diamond = chainBlockers(
    [
      task('r', 'failed', [], { attempt: 1 }),
      task('b', 'ready', ['r']),
      task('c', 'ready', ['r']),
      task('d', 'ready', ['b', 'c']),
    ],
    3,
  );
  assert.deepEqual(
    diamond.map((b) => [b.taskId, b.reason, b.next, b.waiting]),
    [['r', 'сбой', 'повтор назначит восстановление или ведущий', 3]],
  );
  // Два корня у одного потомка: каждый корень считает его один раз.
  const two = chainBlockers(
    [task('r1', 'draft'), task('r2', 'cancelled'), task('x', 'ready', ['r1', 'r2'])],
    3,
  );
  assert.deepEqual(
    two.map((b) => [b.taskId, b.waiting]),
    [
      ['r1', 1],
      ['r2', 1],
    ],
  );
});

test('Baseline chainBlockers: each root kind has its own reason and next step', () => {
  const blockers = chainBlockers(
    [
      task('draft', 'draft'),
      task('cancelled', 'cancelled'),
      task('held', 'ready', [], { hold: { operation: 'op', reason: 'Меняется контракт X' } }),
      task('budget', 'ready', [], {
        attempt: 1,
        budgetBlock: { reason: 'Превышен предел стоимости', at: '2026-01-01T00:00:00.000Z' },
      }),
      task('budget-exhausted', 'ready', [], {
        attempt: 3,
        budgetBlock: { reason: 'Превышен предел стоимости', at: '2026-01-01T00:00:00.000Z' },
      }),
      task('exhausted', 'ready', [], { attempt: 3 }),
      ...['draft', 'cancelled', 'held', 'budget', 'budget-exhausted', 'exhausted'].map((id) =>
        task('w-' + id, 'ready', [id]),
      ),
    ],
    3,
  );
  assert.deepEqual(
    blockers.map((b) => [b.taskId, b.reason, b.next, b.waiting]),
    [
      ['draft', 'план не утверждён', 'ревью и утверждение плана', 1],
      ['cancelled', 'отменена', 'перепланировать зависимые задачи', 1],
      ['held', 'удержана: Меняется контракт X', 'дождаться завершения операции', 1],
      [
        'budget',
        'Превышен предел стоимости',
        'осознанно поднять предел в budgets или задать политику onUnknown',
        1,
      ],
      ['budget-exhausted', 'исчерпан бюджет попыток', 'повтор со сбросом бюджета', 1],
      ['exhausted', 'исчерпан бюджет попыток', 'повтор со сбросом бюджета', 1],
    ],
  );
});

test('Baseline chainBlockers: active work, free ready work and unknown or done dependencies are not roots', () => {
  const blockers = chainBlockers(
    [
      ...(['running', 'verifying', 'reviewing', 'integrating'] as const).map((s) => task(s, s)),
      task('claimed', 'ready', [], { activeRunId: 'run-1' }),
      task('eligible', 'ready', [], { attempt: 2 }),
      task('w1', 'ready', ['running', 'verifying', 'reviewing', 'integrating']),
      task('w2', 'ready', ['claimed', 'eligible']),
      task('w3', 'ready', ['missing']),
      task('fin', 'done'),
      task('w4', 'ready', ['fin']),
      // Не готовые потомки сами ничего не ждут в смысле панели.
      task('draft-child', 'draft', ['eligible']),
    ],
    3,
  );
  assert.deepEqual(blockers, []);
  // Предел попыток — параметр: с maxAttempts=2 та же eligible становится корнем.
  assert.deepEqual(
    chainBlockers(
      [task('eligible', 'ready', [], { attempt: 2 }), task('w', 'ready', ['eligible'])],
      2,
    ).map((b) => [b.taskId, b.reason]),
    [['eligible', 'исчерпан бюджет попыток']],
  );
  // Умолчание maxAttempts = 3.
  assert.deepEqual(
    chainBlockers([task('f', 'failed', [], { attempt: 3 }), task('w', 'ready', ['f'])]).map(
      (b) => b.reason,
    ),
    ['сбой, бюджет попыток исчерпан'],
  );
});

test('Baseline chainBlockers: the walk passes through waiting ready tasks to the real root', () => {
  // a готова, но сама ждёт упавшую f; корнем названа f, не a.
  const blockers = chainBlockers(
    [
      task('f', 'failed', [], { attempt: 1 }),
      task('a', 'ready', ['f']),
      task('b', 'ready', ['a']),
      task('cycle-1', 'ready', ['cycle-2']),
      task('cycle-2', 'ready', ['cycle-1']),
    ],
    3,
  );
  assert.deepEqual(
    blockers.map((b) => [b.taskId, b.waiting]),
    [['f', 2]],
  );
});

test('Baseline queueStopReason: only a runtime pause names the newest scheduler error', () => {
  const events = [
    { id: 3, type: 'scheduler.error', data: { error: 'TaskFailure: База прогонов отстала' } },
    { id: 7, type: 'task.updated', data: {} },
    { id: 5, type: 'scheduler.error', data: { error: 'Error: свежая причина' } },
    { id: 1, type: 'scheduler.error', data: { error: 'старая' } },
  ];
  assert.equal(queueStopReason({ paused: true }, events), 'свежая причина');
  assert.equal(queueStopReason({ paused: true, pauseReason: 'runtime' }, events), 'свежая причина');
  assert.equal(queueStopReason({ paused: true, pauseReason: 'operator' }, events), undefined);
  assert.equal(queueStopReason({ paused: false }, events), undefined);
  assert.equal(queueStopReason({}, events), undefined);
  assert.equal(queueStopReason({ paused: true }, []), undefined);
  assert.equal(
    queueStopReason({ paused: true }, [{ id: 1, type: 'scheduler.error', data: {} }]),
    undefined,
  );
  assert.equal(
    queueStopReason({ paused: true }, [
      { id: 2, type: 'scheduler.error', data: { error: 'TaskFailure: TaskFailure: x' } },
    ]),
    'TaskFailure: x',
    'снимается только один префикс',
  );
});

test('Baseline short/clip: defaults 300/2000 JS code units, ellipsis on truncation, nested token removed', () => {
  assert.equal(SHORT, 300);
  assert.equal(DIAGNOSTIC, 2000);
  assert.equal(short(undefined), undefined);
  assert.equal(short(''), '');
  assert.equal(short('a'.repeat(300)), 'a'.repeat(300));
  assert.equal(short('a'.repeat(301)), 'a'.repeat(300) + '…');
  assert.equal(short('abcdef', 3), 'abc…');
  // Единица длины — code unit JS: суррогатная пара может разделиться.
  assert.equal(short('😀😀', 3), '😀\ud83d…');
  assert.equal(short('привет мир', 6), 'привет…');

  const long = 'x'.repeat(2001);
  const value = {
    token: 'secret-owner-token',
    error: long,
    count: 5,
    ok: true,
    none: null,
    missing: undefined,
    list: [long, 1, { token: 't', note: 'short' }],
    nested: { deep: { token: 'y', text: long } },
  };
  const clipped = clip(value);
  assert.deepEqual(clipped, {
    error: 'x'.repeat(2000) + '…',
    count: 5,
    ok: true,
    none: null,
    missing: undefined,
    list: ['x'.repeat(2000) + '…', 1, { note: 'short' }],
    nested: { deep: { text: 'x'.repeat(2000) + '…' } },
  });
  assert.equal(value.token, 'secret-owner-token', 'исходный объект не изменён');
  assert.deepEqual(clip({ a: 'abcdef', b: ['abcdef'] }, 2), { a: 'ab…', b: ['ab…'] });
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip(42), 42);
  // Ограничивается каждая строка, а не размер всего объекта.
  const many = clip(Array.from({ length: 100 }, () => 'y'.repeat(2000)));
  assert.equal(JSON.stringify(many).length > 65536, true);
});
