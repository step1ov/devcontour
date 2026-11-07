import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AttentionService } from '../src/application/attention.ts';
import { dumpDatabase, preparationFixture } from './attention-fixture.ts';

// D04-E: чтение центра внимания не пишет ни строк, ни событий, ни ревизии.

test('Запись источника внутри чтения падает и ничего не оставляет (структурная защита GET)', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', { changeId: f.changeId, add: [{ text: 'Вопрос?' }] });
    const path = join(f.root, 'state.sqlite');
    const before = dumpDatabase(path);
    const revision = f.store.revision();
    const writing = new AttentionService(f.store, undefined, {
      sources: [
        {
          id: 'prep-question',
          collect: (ctx) => {
            ctx.store.atomic(() => ctx.store.saveLocal('attention', undefined, 'leak', { v: 1 }));
            return [];
          },
        },
      ],
    });
    await assert.rejects(writing.active());
    assert.equal(f.store.revision(), revision);
    assert.equal(dumpDatabase(path), before);
    // Без записывающего источника чтение работает и тоже ничего не меняет.
    const view = await new AttentionService(f.store, undefined).active();
    assert.equal(view.items.length, 1);
    assert.equal(view.revision, revision);
    assert.equal(dumpDatabase(path), before);
  } finally {
    f.cleanup();
  }
});
