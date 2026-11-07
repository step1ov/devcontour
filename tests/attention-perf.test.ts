import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionService } from '../src/application/attention.ts';
import { fixture, input } from './helpers.ts';

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

test('Отметка и действие перепроверяют только источник своей карточки, не всю проекцию', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('One task'));
    f.h.approve(b.id);
    f.h.pause(true);
    let calls = 0;
    const service = new AttentionService(f.store, f.h, {
      sources: [{ id: 'preview', collect: () => (calls++, []) }],
    });
    const queue = (await service.active()).items.find((i) => i.sourceKey === 'queue')!;
    assert.equal(calls, 1);
    calls = 0;
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
