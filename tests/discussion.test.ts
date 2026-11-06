import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { AgentService } from '../src/application/agent.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { DISCUSSION_TEXT_BYTES } from '../src/core/discussion-model.ts';
import { fixture, input } from './helpers.ts';

const key = (n: number) => 'idem-key-' + String(n).padStart(4, '0');

function world() {
  const f = fixture();
  const board = f.h.createBoard('Discussion');
  const task = f.h.addTask(board.id, input('Задача с обсуждением'));
  return { ...f, board, task, d: new DiscussionService(f.h) };
}

test('D02-A: повтор, две вкладки и повтор после timeout не дублируют; конфликт версии — 409', () => {
  const w = world();
  try {
    const note = { taskId: w.task.id, kind: 'note', text: 'Первая заметка', expectedVersion: 0 };
    const first = w.d.post({ ...note, idempotencyKey: key(1) }, 'operator');
    // Повтор того же запроса — та же запись, версия не растёт.
    const again = w.d.post({ ...note, idempotencyKey: key(1) }, 'operator');
    assert.equal(again.message.id, first.message.id);
    assert.equal(w.d.read({ taskId: w.task.id }).messages.length, 1);
    // Другой payload под тем же ключом — отказ.
    assert.throws(
      () => w.d.post({ ...note, text: 'Другое', idempotencyKey: key(1) }, 'operator'),
      /Ключ запроса уже использован/,
    );
    // Вторая вкладка с устаревшей версией — конфликт, текст на клиенте не теряется.
    assert.throws(
      () => w.d.post({ ...note, text: 'Из второй вкладки', idempotencyKey: key(2) }, 'operator'),
      (e: Error & { status?: number; version?: number }) =>
        e.status === 409 && e.version === first.version,
    );
    const second = w.d.post(
      {
        ...note,
        text: 'Из второй вкладки',
        idempotencyKey: key(2),
        expectedVersion: first.version,
      },
      'operator',
    );
    assert.equal(second.message.seq > first.message.seq, true);
    // Ключ принадлежит автору: тот же ключ у ведущего — другая запись.
    const lead = w.d.post(
      { ...note, text: 'Ведущий', idempotencyKey: key(1), expectedVersion: second.version },
      'lead',
    );
    assert.notEqual(lead.message.id, first.message.id);
    assert.equal(lead.message.author, 'lead');
  } finally {
    w.cleanup();
  }
});

test('D02-B: заметка и обращение не меняют задачу, согласования, очередь и попытки', () => {
  const w = world();
  try {
    const before = w.store.read();
    const spec = specDigest(before.tasks[0]);
    const note = w.d.post(
      {
        taskId: w.task.id,
        kind: 'note',
        text: 'Заметка',
        idempotencyKey: key(1),
        expectedVersion: 0,
      },
      'operator',
    );
    w.d.post(
      {
        taskId: w.task.id,
        kind: 'change-request',
        text: 'Нужно ещё одно поле',
        idempotencyKey: key(2),
        expectedVersion: note.version,
      },
      'operator',
    );
    const after = w.store.read();
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.boards, before.boards);
    assert.deepEqual(after.runs, before.runs);
    assert.equal(after.paused, before.paused);
    assert.equal(specDigest(after.tasks[0]), spec);
    // Основание записи — постановка на момент записи.
    assert.equal(note.message.basis.specDigest, spec);
  } finally {
    w.cleanup();
  }
});

test('D02-C: обращение, его обработка и новая ревизия прослеживаются; чтение — не обработка', async () => {
  const w = world();
  try {
    const request = w.d.post(
      {
        taskId: w.task.id,
        kind: 'change-request',
        text: 'Изменить критерий',
        idempotencyKey: key(1),
        expectedVersion: 0,
      },
      'operator',
    );
    // Прочитано, но не обработано — остаётся во входящих ведущего.
    w.d.read({ taskId: w.task.id });
    assert.deepEqual(
      w.d.inbox({}).requests.map((r) => r.id),
      [request.message.id],
    );
    // Принятие без ссылки на новую работу — отказ.
    assert.throws(
      () =>
        w.d.resolve({
          requestId: request.message.id,
          outcome: 'accepted',
          reason: 'Принято',
          idempotencyKey: key(2),
          expectedVersion: request.version,
        }),
      /ссылается на ревизию/,
    );
    // Задача старше обращения — изменение ещё не внесено.
    assert.throws(
      () =>
        w.d.resolve({
          requestId: request.message.id,
          outcome: 'accepted',
          reason: 'Принято',
          refs: { taskIds: [w.task.id] },
          idempotencyKey: key(2),
          expectedVersion: request.version,
        }),
      /старше обращения/,
    );
    // Новая работа — строго позже обращения.
    await new Promise((r) => setTimeout(r, 5));
    const next = w.h.addTask(w.board.id, input('Новая постановка по обращению'));
    const done = w.d.resolve({
      requestId: request.message.id,
      outcome: 'accepted',
      reason: 'Внесено новой задачей',
      refs: { taskIds: [next.id] },
      idempotencyKey: key(2),
      expectedVersion: request.version,
    });
    assert.equal(done.message.kind, 'disposition');
    assert.equal(done.message.replyTo, request.message.id);
    assert.equal(done.message.author, 'lead');
    assert.deepEqual(w.d.inbox({}).requests, []);
    // Исходная задача не переписана.
    assert.equal(
      w.store.read().tasks.find((t) => t.id === w.task.id)!.title,
      'Задача с обсуждением',
    );
    // Отменённая задача принимает историческую заметку и не возобновляется.
    w.h.cancel(w.task.id, 'Больше не нужна', 'operator');
    w.d.post(
      {
        taskId: w.task.id,
        kind: 'note',
        text: 'Историческая заметка',
        idempotencyKey: key(3),
        expectedVersion: done.version,
      },
      'operator',
    );
    assert.equal(w.store.read().tasks.find((t) => t.id === w.task.id)!.status, 'cancelled');
  } finally {
    w.cleanup();
  }
});

test('D02-D: сообщения переживают перезапуск; страницы по cursor без пропусков; handoff даёт обращения', () => {
  const w = world();
  try {
    let version = 0;
    for (let i = 1; i <= 7; i++)
      version = w.d.post(
        {
          taskId: w.task.id,
          kind: i === 7 ? 'change-request' : 'note',
          text: 'Сообщение ' + i,
          idempotencyKey: key(i),
          expectedVersion: version,
        },
        'operator',
      ).version;
    // Перезапуск: новое соединение с тем же файлом.
    const path = join(w.root, 'state.sqlite');
    w.store.close();
    const store = new Store(path);
    try {
      const h = new DevContour(store, w.h.config);
      const d = new DiscussionService(h);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = d.read({ taskId: w.task.id, limit: 3, ...(cursor ? { cursor } : {}) });
        seen.push(...page.messages.map((m) => m.text));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(
        seen,
        Array.from({ length: 7 }, (_, i) => 'Сообщение ' + (i + 1)),
      );
      const handoff = devcontourHandoff(h);
      assert.deepEqual(
        handoff.host.discussion?.requests.map((r) => r.text),
        ['Сообщение 7'],
      );
    } finally {
      store.close();
      w.store.close = () => {};
    }
  } finally {
    w.cleanup();
  }
});

test('D02-E: предел текста — явный отказ; текст не попадает в события; ссылки только своей задачи', () => {
  const w = world();
  try {
    assert.throws(
      () =>
        w.d.post(
          {
            taskId: w.task.id,
            kind: 'note',
            text: 'я'.repeat(DISCUSSION_TEXT_BYTES / 2 + 1),
            idempotencyKey: key(1),
            expectedVersion: 0,
          },
          'operator',
        ),
      /больше 16384 байт/,
    );
    const html = '<img src=x onerror=alert(1)> secret-token-123';
    const posted = w.d.post(
      { taskId: w.task.id, kind: 'note', text: html, idempotencyKey: key(2), expectedVersion: 0 },
      'operator',
    );
    // Текст хранится как есть (UI выводит его текстом), но журнал — только идентификаторы.
    assert.equal(posted.message.text, html);
    const events = w.store.events().filter((e) => e.type === 'discussion.posted');
    assert.equal(events.length, 1);
    assert.doesNotMatch(JSON.stringify(events), /secret-token|onerror/);
    // Ссылка на сообщение другой задачи — отказ.
    const other = w.h.addTask(w.board.id, input('Другая задача'));
    assert.throws(
      () =>
        w.d.post(
          {
            taskId: other.id,
            kind: 'note',
            text: 'Ответ не туда',
            replyTo: posted.message.id,
            idempotencyKey: key(3),
            expectedVersion: 0,
          },
          'operator',
        ),
      /другой задачи/,
    );
    // Исправить чужое сообщение нельзя.
    assert.throws(
      () =>
        w.d.post(
          {
            taskId: w.task.id,
            kind: 'note',
            text: 'Правка',
            supersedes: posted.message.id,
            idempotencyKey: key(4),
            expectedVersion: posted.version,
          },
          'lead',
        ),
      /своё сообщение/,
    );
  } finally {
    w.cleanup();
  }
});

test('D02: агентские операции — автор lead, чтение только чтение, поле author не принимается', () => {
  const w = world();
  try {
    const agent = new AgentService(w.h);
    const posted = agent.execute({
      operation: 'discussion_post',
      input: {
        taskId: w.task.id,
        kind: 'note',
        text: 'От ведущего',
        idempotencyKey: key(1),
        expectedVersion: 0,
      },
    }) as { message: { author: string } };
    assert.equal(posted.message.author, 'lead');
    assert.throws(() =>
      agent.execute({
        operation: 'discussion_post',
        input: {
          taskId: w.task.id,
          kind: 'note',
          text: 'Подмена',
          author: 'operator',
          idempotencyKey: key(2),
          expectedVersion: 1,
        },
      }),
    );
    const page = agent.execute({ operation: 'discussion_read', input: { taskId: w.task.id } }) as {
      messages: unknown[];
      storage: string;
    };
    assert.equal(page.messages.length, 1);
    assert.equal(page.storage, 'local');
  } finally {
    w.cleanup();
  }
});
