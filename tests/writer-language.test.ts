// Вопросы исполнителя и попутные находки читает оператор в русской панели:
// запрос writer называет язык этих текстов, запрос reviewer — нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devcontourHooks, OPERATOR_LANGUAGE_NOTE } from '../src/harness/hooks.ts';
import { fixture, input } from './helpers.ts';

test('Заметки хоста: writer получает язык вопросов оператору и находок, reviewer — нет', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const task = f.h.addTask(b.id, input('Root task'));
    const hooks = devcontourHooks(f.h);
    const notes = async (review: boolean) =>
      (await hooks.notes?.({
        work: { id: task.id },
        attempt: { id: 'run-1' },
        review,
      } as never)) ?? [];
    const writer = await notes(false);
    assert.ok(writer.includes(OPERATOR_LANGUAGE_NOTE), writer.join('\n'));
    assert.match(OPERATOR_LANGUAGE_NOTE, /question to the operator.*in Russian/s);
    assert.match(OPERATOR_LANGUAGE_NOTE, /discovery/);
    const reviewer = await notes(true);
    assert.equal(reviewer.includes(OPERATOR_LANGUAGE_NOTE), false);
  } finally {
    f.cleanup();
  }
});
