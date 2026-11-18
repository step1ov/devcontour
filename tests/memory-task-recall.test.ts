// F55: запрос памяти задачи укладывается в лимиты memory_recall при любой
// допустимой задаче (описание до 12 000 символов, до 30 контрактов), и такая
// задача выполняется, а не падает до работы ошибкой схемы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_RECALL_LIMITS,
  ProjectMemory,
  memoryInputs,
  taskRecall,
} from '../src/application/memory.ts';
import { TASK_LIMITS } from '../src/core/model.ts';
import { input } from './helpers.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters } from '../src/runner/adapters.ts';
import { runtimeFixture } from './runner-fixture.ts';

// 12 000 символов различных слов: склейка заведомо больше лимита запроса.
const longDescription = (head: string) => {
  let text = head;
  for (let i = 0; text.length < 11_990; i++) text += ` term${i}`;
  return text.slice(0, 12_000);
};

test('taskRecall: запрос и сущности максимальной задачи проходят схему memory_recall', () => {
  const task = {
    title: 'Keyboard fix KeyboardMarker',
    description: longDescription('DescriptionHeadMarker opens the form.'),
    contracts: Array.from({ length: TASK_LIMITS.contracts }, (_, i) => `C-${i}`),
  };
  assert.ok((task.title + ' ' + task.description).length > MEMORY_RECALL_LIMITS.query);
  const recall = taskRecall(task);
  // Та же схема, что у recall: прежняя склейка здесь падала too_big.
  const parsed = memoryInputs.memory_recall.parse(recall);
  assert.ok(parsed.query.length <= MEMORY_RECALL_LIMITS.query);
  assert.ok(
    parsed.query.length > MEMORY_RECALL_LIMITS.query - 20,
    'запрос заполнен, а не обрезан до пустого',
  );
  // Слова заголовка и начала описания — первыми, без повторов.
  const terms = parsed.query.split(' ');
  assert.deepEqual(terms.slice(0, 4), [
    'keyboard',
    'fix',
    'keyboardmarker',
    'descriptionheadmarker',
  ]);
  assert.equal(new Set(terms).size, terms.length);
  assert.deepEqual(parsed.entities, task.contracts.slice(0, MEMORY_RECALL_LIMITS.entities));
});

test('taskRecall: короткая задача — все её слова и все контракты', () => {
  const recall = taskRecall({
    title: 'Add form',
    description: 'Add the form, form only.',
    contracts: ['C-1'],
  });
  assert.equal(recall.query, 'add form the only');
  assert.deepEqual(recall.entities, ['C-1']);
});

test('F55: задача с описанием 12 000 символов выполняется и получает память проекта', async () => {
  const f = await runtimeFixture();
  let scheduler: Scheduler | undefined;
  try {
    f.h.pause(true);
    const board = f.h.createBoard('Длинная постановка');
    const task = f.h.addTask(board.id, {
      ...input('Long task'),
      description: longDescription('RecallHeadMarker opens the form.'),
    });
    assert.ok((task.title + ' ' + task.description).length > MEMORY_RECALL_LIMITS.query);
    f.h.approve(board.id);
    const record = new ProjectMemory(f.h).retain({
      repositoryId: 'main',
      kind: 'fact',
      subject: 'recallheadmarker',
      text: 'RecallHeadMarker knowledge',
      sources: ['README.md'],
    });
    const prompts: string[] = [];
    scheduler = new Scheduler(f.h, f.root, {
      ...adapters,
      demo: {
        ...adapters.demo,
        execute: async (request) => {
          if (request.task.id === task.id && !request.review) prompts.push(request.prompt);
          return adapters.demo.execute(request);
        },
      },
    });
    await scheduler.init();
    f.h.pause(false);
    await scheduler.drain();
    const run = f.store.read().runs.find((r) => r.taskId === task.id)!;
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.deepEqual(run.memory!.ids, [record.id]);
    assert.ok(prompts.some((p) => p.includes('RecallHeadMarker knowledge')));
  } finally {
    await scheduler?.stop();
    await f.cleanup();
  }
});
