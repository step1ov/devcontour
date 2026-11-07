import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionService } from '../src/application/attention.ts';
import { fixture, input } from './helpers.ts';
import { DomainError } from '../src/core/model.ts';

// Регресс стоимости чтения: отменённые задачи без ждущих — история
// перепланирования, а не решения. Чтение и действие не должны расти с их
// числом. Пределы щедрые (общий CI, параллельные процессы); прежний код
// тратил на этот стенд секунды на каждое чтение и держал блокировку записи
// столько же при отметке и действии.

test('400 задач, 200 отменённых: чтение, отметка и действие укладываются в щедрый предел', async () => {
  const f = fixture();
  try {
    for (let b = 0; b < 8; b++) {
      const board = f.h.createBoard('Board ' + b);
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) ids.push(f.h.addTask(board.id, input(`Task ${b}-${i}`)).id);
      f.h.approve(board.id);
      for (let i = 0; i < 50; i += 2) f.h.cancel(ids[i], 'replanned', 'operator');
    }
    f.h.pause(true);
    const service = new AttentionService(f.store, f.h);
    await service.active();
    let started = performance.now();
    const view = await service.active();
    const read = performance.now() - started;
    assert.ok(read < 1000, `active() took ${read.toFixed(0)} ms`);
    const queue = view.items.find((i) => i.sourceKey === 'queue')!;
    started = performance.now();
    await service.mark({
      marks: [
        {
          sourceKey: queue.sourceKey,
          occurrenceId: queue.occurrenceId,
          version: queue.sourceVersion,
          kind: 'read',
        },
      ],
    });
    const marked = performance.now() - started;
    assert.ok(marked < 1000, `mark() took ${marked.toFixed(0)} ms`);
    started = performance.now();
    await service.act({
      sourceKey: queue.sourceKey,
      occurrenceId: queue.occurrenceId,
      expectedVersion: queue.sourceVersion,
      action: 'resume',
    });
    const acted = performance.now() - started;
    assert.ok(acted < 1000, `act() took ${acted.toFixed(0)} ms`);
  } finally {
    f.cleanup();
  }
});

test('Под блокировкой записи отметка и действие не пересчитывают другие источники', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('One task'));
    f.h.approve(b.id);
    f.h.pause(true);
    // Считаются только вызовы внутри транзакции записи: карточка ответа
    // действия строится полной проекцией после неё (влияние как в GET).
    let calls = 0;
    let locked = false;
    const atomic = f.store.atomic.bind(f.store);
    f.store.atomic = <T>(action: () => T): T => {
      locked = true;
      try {
        return atomic(action);
      } finally {
        locked = false;
      }
    };
    const service = new AttentionService(f.store, f.h, {
      sources: [{ id: 'preview', collect: () => (locked && calls++, []) }],
    });
    const queue = (await service.active()).items.find((i) => i.sourceKey === 'queue')!;
    const ref = {
      sourceKey: queue.sourceKey,
      occurrenceId: queue.occurrenceId,
    };
    await service.mark({ marks: [{ ...ref, version: queue.sourceVersion, kind: 'read' }] });
    await service.act({ ...ref, expectedVersion: queue.sourceVersion, action: 'resume' });
    assert.equal(calls, 0, 'другие источники не пересчитывались');
  } finally {
    f.cleanup();
  }
});

/**
 * Чтение и отметка карточки задачи на стенде с 21+ кандидатами диагноза.
 * Отметка держит блокировку записи только на запись строки: время каждой
 * транзакции `store.atomic` измеряется отдельно.
 */
async function bounded(f: ReturnType<typeof fixture>, label: string, limitMs = 1500) {
  f.h.pause(true);
  const service = new AttentionService(f.store, f.h);
  await service.active();
  const started = performance.now();
  const view = await service.active();
  const read = performance.now() - started;
  const work = view.items.find((i) => i.source === 'work');
  assert.ok(work, `${label}: карточка задачи есть`);
  const atomic = f.store.atomic.bind(f.store);
  let locked = 0;
  f.store.atomic = <T>(action: () => T): T => {
    const t0 = performance.now();
    try {
      return atomic(action);
    } finally {
      locked = Math.max(locked, performance.now() - t0);
    }
  };
  const markStarted = performance.now();
  await service.mark({
    marks: [
      {
        sourceKey: work.sourceKey,
        occurrenceId: work.occurrenceId,
        version: work.sourceVersion,
        kind: 'read',
      },
    ],
  });
  const marked = performance.now() - markStarted;
  f.store.atomic = atomic;
  assert.ok(read < limitMs, `${label}: active() took ${read.toFixed(0)} ms`);
  assert.ok(marked < limitMs, `${label}: mark(work) took ${marked.toFixed(0)} ms`);
  assert.ok(locked < 200, `${label}: mark held the write lock ${locked.toFixed(0)} ms`);
}

/** Независимые задачи до 400, из них `failed` упали. */
function failedTasks(f: ReturnType<typeof fixture>, failed: number, total = 400) {
  const board = f.h.createBoard('Board');
  for (let i = 0; i < total; i++) f.h.addTask(board.id, input(`Task ${i}`));
  f.h.approve(board.id);
  f.h.pause(false);
  for (let i = 0; i < failed; i++) {
    const run = f.h.claim('test')!;
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
  }
}

/** `pairs` отменённых корней, каждого ждёт открытая задача; остальное до 400 — свободные. */
function cancelledRoots(f: ReturnType<typeof fixture>, pairs: number, free = 400 - 2 * pairs) {
  const board = f.h.createBoard('Pairs');
  const roots: string[] = [];
  for (let i = 0; i < pairs; i++) {
    const root = f.h.addTask(board.id, input(`Root ${i}`)).id;
    f.h.addTask(board.id, input(`Dependent ${i}`, [root]));
    roots.push(root);
  }
  for (let i = 0; i < free; i++) f.h.addTask(board.id, input(`Free ${i}`));
  f.h.approve(board.id);
  for (const root of roots) f.h.cancel(root, 'replanned', 'operator');
}

test('200 задач, 21 упавшая: чтение и отметка карточки задачи в щедром пределе', async () => {
  const f = fixture();
  try {
    failedTasks(f, 21, 200);
    await bounded(f, 'D21');
  } finally {
    f.cleanup();
  }
});

test('400 задач, 21 отменённый корень с ждущими: чтение и отметка в щедром пределе', async () => {
  const f = fixture();
  try {
    cancelledRoots(f, 21);
    await bounded(f, 'B21');
  } finally {
    f.cleanup();
  }
});

test('Цепочка глубиной 100 и 21 отменённый корень: чтение и отметка в щедром пределе', async () => {
  const f = fixture();
  try {
    const chain = f.h.createBoard('Chain');
    let previous = f.h.addTask(chain.id, input('Chain 0')).id;
    for (let i = 1; i < 100; i++)
      previous = f.h.addTask(chain.id, input(`Chain ${i}`, [previous])).id;
    f.h.approve(chain.id);
    cancelledRoots(f, 21, 0);
    await bounded(f, 'C21');
  } finally {
    f.cleanup();
  }
});

test('400 задач, 100 отменённых корней: чтение и отметка в щедром пределе', async () => {
  const f = fixture();
  try {
    cancelledRoots(f, 100);
    await bounded(f, 'B100');
  } finally {
    f.cleanup();
  }
});

test('Действие, которого у источника нет, отклоняется до пересчёта источника', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const service = new AttentionService(f.store, f.h, {
      sources: [{ id: 'work', collect: () => (calls++, []) }],
    });
    await assert.rejects(
      service.act({
        sourceKey: 'work:T-1',
        occurrenceId: 'run-1',
        expectedVersion: 'v',
        action: 'retry',
      }),
      (e: unknown) => e instanceof DomainError && e.status === 400,
    );
    assert.equal(calls, 0);
  } finally {
    f.cleanup();
  }
});
