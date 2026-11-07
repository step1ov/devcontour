import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkJsonBytes } from 'devcontour-harness';
import { Store } from '../src/core/store.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { DiscussionService, type InboxRequest } from '../src/application/discussion.ts';
import { AgentService } from '../src/application/agent.ts';
import {
  devcontourHandoff,
  devcontourHandoffWithin,
  handoffResponse,
} from '../src/application/handoff.ts';
import { DISCUSSION_TEXT_BYTES } from '../src/core/discussion-model.ts';
import { repositorySchema } from '../src/core/model.ts';
import { hostNamespace } from '../src/harness/projection.ts';
import { CANDIDATE, MERGED, complete, config, fixture, input } from './helpers.ts';

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
      (e: Error & { status?: number; details?: { version?: number } }) =>
        e.status === 409 && e.details?.version === first.version,
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
        handoff.host.discussion?.requests.map((r) => r.excerpt),
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

test('D02-D: тред открывается с последних сообщений и листается назад без пропусков; 409 несёт код и версию', () => {
  const w = world();
  try {
    let version = 0;
    for (let i = 1; i <= 25; i++)
      version = w.d.post(
        {
          taskId: w.task.id,
          kind: 'note',
          text: 'Заметка ' + i,
          idempotencyKey: key(i),
          expectedVersion: version,
        },
        'operator',
      ).version;
    const latest = w.d.read({ taskId: w.task.id, latest: true, limit: 10 });
    assert.deepEqual(
      latest.messages.map((m) => m.text),
      Array.from({ length: 10 }, (_, i) => 'Заметка ' + (16 + i)),
    );
    const seen = [...latest.messages.map((m) => m.text)];
    let before = latest.previousCursor;
    while (before) {
      const page = w.d.read({ taskId: w.task.id, before, limit: 10 });
      seen.unshift(...page.messages.map((m) => m.text));
      before = page.previousCursor;
    }
    assert.deepEqual(
      seen,
      Array.from({ length: 25 }, (_, i) => 'Заметка ' + (i + 1)),
    );
    assert.throws(
      () =>
        w.d.post(
          {
            taskId: w.task.id,
            kind: 'note',
            text: 'x',
            idempotencyKey: key(99),
            expectedVersion: 0,
          },
          'operator',
        ),
      (e: Error & { details?: { code?: string; version?: number } }) =>
        e.details?.code === 'version-conflict' && e.details.version === version,
    );
  } finally {
    w.cleanup();
  }
});

let counter = 0;
/** Запись в тред задачи по его текущей версии; ключ — уникальный. */
function say(
  d: DiscussionService,
  taskId: string,
  text: string,
  options: {
    kind?: 'note' | 'change-request';
    author?: 'operator' | 'lead';
    replyTo?: string;
    supersedes?: string;
  } = {},
) {
  const version = d.read({ taskId, latest: true, limit: 1 }).version;
  return d.post(
    {
      taskId,
      kind: options.kind ?? 'change-request',
      text,
      idempotencyKey: key(++counter),
      expectedVersion: version,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.supersedes ? { supersedes: options.supersedes } : {}),
    },
    options.author ?? 'operator',
  ).message;
}

/** Все страницы очереди ведущего; каждая — в пределе `maxBytes`. */
function drain(d: DiscussionService, limit: number, maxBytes?: number) {
  const seen: InboxRequest[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = d.inbox({ limit, ...(cursor ? { cursor } : {}) }, maxBytes);
    assert.ok(page.requests.length > 0, 'страница с продолжением не пуста');
    assert.ok(page.requests.length <= limit);
    if (maxBytes) assert.ok(checkJsonBytes(page.requests, maxBytes).within);
    seen.push(...page.requests);
    assert.notEqual(page.nextCursor, cursor, 'курсор продвигается');
    cursor = page.nextCursor;
    assert.ok(++pages < 100, 'очередь листается до конца');
  } while (cursor);
  return seen;
}

/** Время идёт: метки ISO одной миллисекунды не упорядочены. */
function tick() {
  const until = Date.now() + 2;
  while (Date.now() < until);
}

test('D02-D: страницы треда в байтовом пределе — вперёд и назад без пропусков', () => {
  const w = world();
  try {
    const texts = Array.from({ length: 12 }, (_, i) => `Заметка ${i + 1} ` + 'ж'.repeat(400));
    for (const t of texts) say(w.d, w.task.id, t, { kind: 'note' });
    const maxBytes = 3500;
    const forward: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = w.d.read(
        { taskId: w.task.id, limit: 50, ...(cursor ? { cursor } : {}) },
        maxBytes,
      );
      assert.ok(page.messages.length > 0);
      assert.ok(checkJsonBytes(page.messages, maxBytes).within, 'страница вперёд в пределе');
      forward.push(...page.messages.map((m) => m.text));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    assert.deepEqual(forward, texts);
    assert.ok(pages > 3, 'предел действительно режет страницы');
    const latest = w.d.read({ taskId: w.task.id, latest: true, limit: 50 }, maxBytes);
    assert.ok(checkJsonBytes(latest.messages, maxBytes).within, 'последняя страница в пределе');
    assert.equal(latest.messages.at(-1)?.text, texts.at(-1), 'последние записи — всегда');
    const backward = latest.messages.map((m) => m.text);
    let before = latest.previousCursor;
    while (before) {
      const page = w.d.read({ taskId: w.task.id, before, limit: 50 }, maxBytes);
      assert.ok(page.messages.length > 0);
      assert.ok(checkJsonBytes(page.messages, maxBytes).within, 'страница назад в пределе');
      backward.unshift(...page.messages.map((m) => m.text));
      before = page.previousCursor;
    }
    assert.deepEqual(backward, texts);
  } finally {
    w.cleanup();
  }
});

test('D02-D: очередь ведущего больше страницы даёт курсор; листание без повторов и пропусков', () => {
  const w = world();
  try {
    const three = [1, 2, 3].map((i) => say(w.d, w.task.id, 'Обращение ' + i).id);
    const first = w.d.inbox({ limit: 2 });
    assert.equal(first.requests.length, 2);
    assert.ok(first.nextCursor, 'остаток очереди — по курсору');
    assert.deepEqual(
      drain(w.d, 2).map((r) => r.id),
      three,
    );
    // Ровно предел — курсора нет.
    assert.equal(w.d.inbox({ limit: 3 }).nextCursor, undefined);
    // 30 обращений, страница по 20 и байтовый предел: каждое — один раз, по порядку.
    const other = w.h.addTask(w.board.id, input('Вторая задача'));
    const all = [...three];
    for (let i = 4; i <= 30; i++)
      all.push(say(w.d, i % 2 ? w.task.id : other.id, 'Обращение ' + i + ' ' + 'х'.repeat(100)).id);
    assert.deepEqual(
      drain(w.d, 20).map((r) => r.id),
      all,
    );
    assert.deepEqual(
      drain(w.d, 20, 3000).map((r) => r.id),
      all,
    );
  } finally {
    w.cleanup();
  }
});

test('D02-D: очередь ведущего в компонентном хранении — по всем компонентам, курсор без пропусков', () => {
  const f = fixture();
  let store: Store | undefined;
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const repos = ['product', 'library'].map((id) => {
      const path = join(f.root, id);
      mkdirSync(path);
      return repositorySchema.parse({ id, name: id, path, gates: f.h.config.gates });
    });
    store = new Store(join(workspace, 'state.sqlite'), repos);
    const h = new DevContour(
      store,
      config({ storage: 'component', workspaceRoot: workspace, repositories: repos }),
    );
    const d = new DiscussionService(h);
    const tasks = repos.map((r) => {
      const board = h.createBoard(`Board of ${r.id}`, '', r.id);
      return h.addTask(board.id, { ...input(`Task of ${r.id}`), repositoryId: r.id }).id;
    });
    // Все обращения в одном компоненте: курсор остатка есть.
    const posted: string[] = [];
    for (let i = 1; i <= 3; i++) {
      posted.push(say(d, tasks[0], 'Только product ' + i).id);
      tick();
    }
    assert.ok(d.inbox({ limit: 2 }).nextCursor, 'один компонент больше страницы — курсор есть');
    assert.deepEqual(
      drain(d, 2).map((r) => r.id),
      posted,
    );
    // Вперемешку по компонентам: общий порядок — по времени.
    for (let i = 1; i <= 7; i++) {
      posted.push(say(d, tasks[i % 2], 'Обращение ' + i).id);
      tick();
    }
    assert.deepEqual(
      drain(d, 2).map((r) => r.id),
      posted,
    );
    assert.deepEqual(
      drain(d, 3, 1200).map((r) => r.id),
      posted,
    );
  } finally {
    store?.close();
    f.cleanup();
  }
});

test('D02-D/E: длинное обращение не гасит handoff и не стопорит очередь; ответ записи ограничен', () => {
  const w = world();
  try {
    const long = say(w.d, w.task.id, 'a'.repeat(9000));
    const small = say(w.d, w.task.id, 'Короткое обращение');
    const block = devcontourHandoff(w.h).host.discussion;
    assert.deepEqual(
      block?.requests.map((r) => r.id),
      [long.id, small.id],
    );
    assert.equal(block?.requests[0].truncated, true);
    assert.equal(block?.requests[0].textBytes, 9000);
    // Управляющие символы — отказ: иначе запись не поместилась бы в страницу.
    assert.throws(() => say(w.d, w.task.id, '\u0001'.repeat(100)), /управляющие символы/);
    // Самый «тяжёлый» допустимый текст: каждый символ экранируется в JSON.
    const agent = new AgentService(w.h);
    const version = w.d.read({ taskId: w.task.id, latest: true, limit: 1 }).version;
    const heavy = '"'.repeat(DISCUSSION_TEXT_BYTES);
    const reply = agent.execute({
      operation: 'discussion_post',
      input: {
        taskId: w.task.id,
        kind: 'change-request',
        text: heavy,
        idempotencyKey: key(9000),
        expectedVersion: version,
      },
    }) as { message: { id: string; text: string }; textTruncated?: boolean; version: number };
    assert.equal(reply.textTruncated, true, 'ответ записи — выдержка, запись сохранена');
    assert.ok(reply.message.text.length < heavy.length);
    const inbox = agent.execute({ operation: 'discussion_inbox', input: {} }) as {
      requests: InboxRequest[];
      nextCursor?: string;
    };
    assert.deepEqual(
      inbox.requests.map((r) => r.id),
      [long.id, small.id, reply.message.id],
    );
    assert.equal(inbox.nextCursor, undefined);
    // Полный текст читается ведущим без 413.
    const page = agent.execute({
      operation: 'discussion_read',
      input: { taskId: w.task.id, latest: true, limit: 50 },
    }) as { messages: { id: string; text: string }[]; previousCursor?: string };
    assert.equal(page.messages.at(-1)?.text, heavy);
    let before = page.previousCursor;
    while (before)
      before = (
        agent.execute({ operation: 'discussion_read', input: { taskId: w.task.id, before } }) as {
          previousCursor?: string;
        }
      ).previousCursor;
    // Очередь с маленьким пределом всё равно продвигается: первая запись — всегда.
    assert.deepEqual(
      drain(w.d, 5, 400).map((r) => r.id),
      [long.id, small.id, reply.message.id],
    );
  } finally {
    w.cleanup();
  }
});

test('D02-D: handoff в байтовом пределе — обращения не выводят ответ за предел; больше пяти — курсор', () => {
  const w = world();
  try {
    for (let i = 1; i <= 6; i++) say(w.d, w.task.id, `Обращение ${i}: ` + 'щ'.repeat(320));
    const full = devcontourHandoff(w.h).host.discussion;
    assert.equal(full?.requests.length, 5);
    assert.ok(full?.nextCursor, 'шестое обращение — по курсору');
    assert.deepEqual(
      new DiscussionService(w.h)
        .inbox({ cursor: full.nextCursor })
        .requests.map((r) => r.excerpt.slice(0, 12)),
      ['Обращение 6:'],
    );
    for (const format of ['json', 'md'] as const)
      for (const bytes of [6000, 7000, 9000]) {
        const { value } = devcontourHandoffWithin(w.h, {}, { bytes, format });
        const size = Buffer.byteLength(JSON.stringify(handoffResponse(value, format)));
        assert.ok(size <= bytes, `${format} ${bytes}: ответ ${size} байт`);
        assert.ok(value.host.discussion, 'обращения названы хотя бы отметкой');
      }
    const md = devcontourHandoffWithin(w.h, {}, { bytes: 6000, format: 'md' }).value;
    assert.match(
      handoffResponse(md, 'md').markdown ?? '',
      /discussion_inbox/,
      'остаток обращений назван в Markdown',
    );
  } finally {
    w.cleanup();
  }
});

test('D02-E: секрет в обращении скрыт в handoff, даже на границе выдержки', () => {
  const SECRET = 'okapi-discussion-secret-4815162342';
  const previous = process.env.DC_DISCUSSION_SECRET;
  process.env.DC_DISCUSSION_SECRET = SECRET;
  const f = fixture();
  try {
    const h = new DevContour(
      f.store,
      config({
        checkoutRoot: f.h.config.checkoutRoot,
        environment: { inherit: [], values: {}, secrets: { API_TOKEN: 'DC_DISCUSSION_SECRET' } },
      }),
    );
    const board = h.createBoard('Secret discussion');
    const task = h.addTask(board.id, input('Задача с секретом'));
    const d = new DiscussionService(h);
    // Секрет пересекает границу выдержки handoff (600 байт JSON).
    say(d, task.id, 'a'.repeat(590) + SECRET + ' хвост');
    say(d, task.id, 'Токен ' + SECRET + ' в начале');
    const text = JSON.stringify(handoffResponse(devcontourHandoff(h), 'md'));
    assert.ok(text.includes('Токен'), 'текст обращения в handoff есть');
    assert.ok(!text.includes(SECRET.slice(0, 8)), 'ни секрета, ни его начала');
  } finally {
    if (previous === undefined) delete process.env.DC_DISCUSSION_SECRET;
    else process.env.DC_DISCUSSION_SECRET = previous;
    f.cleanup();
  }
});

test('D02-C: исправленное обращение уходит из очереди; в очереди — последняя версия', () => {
  const w = world();
  try {
    const first = say(w.d, w.task.id, 'Добавить поле');
    const second = say(w.d, w.task.id, 'Добавить два поля', { supersedes: first.id });
    assert.deepEqual(
      w.d.inbox({}).requests.map((r) => [r.id, r.supersedes]),
      [[second.id, first.id]],
    );
    // Исправить уже исправленное нельзя: история линейна.
    assert.throws(
      () => say(w.d, w.task.id, 'Ветка', { supersedes: first.id }),
      (e: Error & { details?: { code?: string } }) => e.details?.code === 'already-superseded',
    );
    // Обработать прежнюю версию нельзя.
    const version = w.d.read({ taskId: w.task.id, latest: true, limit: 1 }).version;
    assert.throws(
      () =>
        w.d.resolve({
          requestId: first.id,
          outcome: 'rejected',
          reason: 'Нет',
          idempotencyKey: key(800),
          expectedVersion: version,
        }),
      (e: Error & { details?: { code?: string } }) => e.details?.code === 'request-superseded',
    );
    // Исправление заметкой — отзыв обращения.
    say(w.d, w.task.id, 'Отзываю: уже не нужно', { kind: 'note', supersedes: second.id });
    assert.deepEqual(w.d.inbox({}).requests, []);
  } finally {
    w.cleanup();
  }
});

test('D02-C: «нужен ответ» — цикл: ответ оператора возвращает обращение ведущему до новой обработки', () => {
  const w = world();
  try {
    const request = say(w.d, w.task.id, 'Сделать экспорт');
    tick();
    const later = say(w.d, w.task.id, 'Другое обращение');
    const resolve = (outcome: string, idem: number) =>
      w.d.resolve({
        requestId: request.id,
        outcome,
        reason: outcome === 'needs-answer' ? 'В каком формате?' : 'Не будем',
        idempotencyKey: key(idem),
        expectedVersion: w.d.read({ taskId: w.task.id, latest: true, limit: 1 }).version,
      });
    const asked = resolve('needs-answer', 700).message;
    assert.deepEqual(
      w.d.inbox({}).requests.map((r) => r.id),
      [later.id],
    );
    // Заметка без ответа на запрос — не возвращает.
    say(w.d, w.task.id, 'Просто заметка', { kind: 'note' });
    assert.deepEqual(
      w.d.inbox({}).requests.map((r) => r.id),
      [later.id],
    );
    tick();
    const answer = say(w.d, w.task.id, 'В CSV', { kind: 'note', replyTo: asked.id });
    const inbox = w.d.inbox({}).requests;
    assert.deepEqual(
      inbox.map((r) => r.id),
      [later.id, request.id],
      'ответ возвращает обращение в конец очереди',
    );
    assert.deepEqual(inbox[1].reopened, { dispositionId: asked.id, answerId: answer.id });
    // Ответ видит и handoff.
    assert.equal(
      devcontourHandoff(w.h).host.discussion?.requests.find((r) => r.id === request.id)?.reopened
        ?.answerId,
      answer.id,
    );
    const rejected = resolve('rejected', 701);
    assert.deepEqual(
      w.d.inbox({}).requests.map((r) => r.id),
      [later.id],
    );
    // Повтор той же обработки — прежняя запись; вторая окончательная — отказ.
    assert.equal(
      w.d.resolve({
        requestId: request.id,
        outcome: 'rejected',
        reason: 'Не будем',
        idempotencyKey: key(701),
        expectedVersion: 0,
      }).message.id,
      rejected.message.id,
    );
    assert.throws(
      () => resolve('needs-answer', 702),
      (e: Error & { details?: { code?: string } }) => e.details?.code === 'already-resolved',
    );
  } finally {
    w.cleanup();
  }
});

test('D02: некорректный курсор очереди — 400; длинный текст — 413; ревизия без доски — 400', () => {
  const w = world();
  try {
    for (const cursor of [
      'bnVsbA',
      Buffer.from('[1]').toString('base64url'),
      Buffer.from('{"main":-1}').toString('base64url'),
      '!!!',
    ])
      assert.throws(
        () => w.d.inbox({ cursor }),
        (e: Error & { status?: number }) => e.status === 400,
        cursor,
      );
    assert.throws(
      () => say(w.d, w.task.id, 'я'.repeat(DISCUSSION_TEXT_BYTES / 2 + 1)),
      (e: Error & { status?: number }) => e.status === 413,
    );
    const request = say(w.d, w.task.id, '  пробелы сохраняются  ');
    assert.equal(request.text, '  пробелы сохраняются  ');
    assert.throws(
      () =>
        w.d.resolve({
          requestId: request.id,
          outcome: 'rejected',
          reason: 'Нет',
          refs: { revision: 1 },
          idempotencyKey: key(900),
          expectedVersion: 1,
        }),
      (e: Error & { status?: number }) => e.status === 400,
    );
  } finally {
    w.cleanup();
  }
});

test('R01: заметка и обращение во время идущей попытки не меняют попытку, её token, задачу и очередь', () => {
  const w = world();
  try {
    w.h.approve(w.board.id);
    w.h.pause(false);
    const run = w.h.claim('test')!;
    assert.equal(run.taskId, w.task.id);
    const before = w.store.read();
    const events = w.store.allEvents();
    // Локальные записи исполнения (вызовы, ревью, ключи попыток, вопросы…).
    const engineLocals = () =>
      Object.values(hostNamespace).map((ns) => [ns, w.store.localEntries(ns)]);
    const locals = engineLocals();
    const note = w.d.post(
      {
        taskId: w.task.id,
        kind: 'note',
        text: 'Заметка, пока исполнитель работает',
        idempotencyKey: key(1),
        expectedVersion: 0,
      },
      'operator',
    );
    w.d.post(
      {
        taskId: w.task.id,
        kind: 'change-request',
        text: 'Добавьте ещё один случай в критерий',
        idempotencyKey: key(2),
        expectedVersion: note.version,
      },
      'operator',
    );
    const after = w.store.read();
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.runs, before.runs);
    assert.deepEqual(after.boards, before.boards);
    assert.deepEqual(after.leader, before.leader);
    assert.equal(after.paused, before.paused);
    // Журнал: прежние события на месте, новые — только две записи обсуждения,
    // ни одного события исполнения; локальные записи исполнения те же.
    const journal = w.store.allEvents();
    assert.deepEqual(journal.slice(0, events.length), events);
    assert.deepEqual(
      journal.slice(events.length).map((e) => e.type),
      ['discussion.posted', 'discussion.posted'],
    );
    assert.deepEqual(engineLocals(), locals);
    // Попытка продолжается прежним token: запись обсуждения не перехватила
    // и не перезапустила исполнение.
    w.h.heartbeat(run.id, run.token);
    w.h.phase(run.id, run.token, 'integrating', {
      candidateSha: CANDIDATE,
      integrationSha: MERGED,
    });
    assert.equal(w.store.read().runs.length, 1);
    assert.equal(w.store.read().runs[0].id, run.id);
  } finally {
    w.cleanup();
  }
});

test('R01: изменение AC по обращению — обычная корректировка; прежние ревизия, результат и доказательства сохранены', async () => {
  const w = world();
  try {
    w.h.approve(w.board.id);
    const run = complete(w.h, w.task.id);
    w.h.accept(w.board.id, MERGED);
    const before = w.store.read();
    const revision = structuredClone(before.boards[0].revisions[0]);
    const doneTask = structuredClone(before.tasks.find((t) => t.id === w.task.id)!);
    const doneRun = structuredClone(before.runs.find((r) => r.id === run.id)!);
    assert.ok(doneRun.evidence.length > 0);
    const request = w.d.post(
      {
        taskId: w.task.id,
        kind: 'change-request',
        text: 'Критерий: результат проверяется и для пустого ввода',
        idempotencyKey: key(1),
        expectedVersion: 0,
      },
      'operator',
    );
    // Обращение само ничего не меняет: ни задачи, ни ревизии.
    assert.deepEqual(w.store.read().tasks, before.tasks);
    assert.deepEqual(w.store.read().boards, before.boards);
    // Ведущий вносит изменение обычной корректировкой доски.
    await new Promise((r) => setTimeout(r, 5));
    const corrected = w.h.correct(w.board.id, [w.task.id], 'Критерий дополнен пустым вводом');
    const replacementId = corrected.replacements[w.task.id];
    const draft = w.store.read().tasks.find((t) => t.id === replacementId)!;
    w.h.editTask(
      replacementId,
      {
        title: draft.title,
        description: draft.description,
        role: draft.role,
        dependsOn: draft.dependsOn,
        acceptance: [...draft.acceptance, 'Пустой ввод тоже проверен.'],
      },
      specDigest(draft),
    );
    const done = w.d.resolve({
      requestId: request.message.id,
      outcome: 'accepted',
      reason: 'Внесено ревизией 2',
      refs: { boardId: w.board.id, revision: 2 },
      idempotencyKey: key(2),
      expectedVersion: request.version,
    });
    assert.deepEqual(done.message.disposition, {
      outcome: 'accepted',
      refs: { boardId: w.board.id, revision: 2 },
    });
    assert.deepEqual(w.d.inbox({}).requests, []);
    const after = w.store.read();
    // Прежняя принятая ревизия, задача, попытка и её доказательства не тронуты.
    assert.deepEqual(after.boards[0].revisions[0], revision);
    assert.equal(after.boards[0].revisions[1].number, 2);
    assert.deepEqual(
      after.tasks.find((t) => t.id === w.task.id),
      doneTask,
    );
    assert.deepEqual(
      after.runs.find((r) => r.id === run.id),
      doneRun,
    );
    assert.equal(after.runs.length, 1, 'обращение и корректировка не запускают попыток');
    const replacement = after.tasks.find((t) => t.id === replacementId)!;
    assert.equal(replacement.supersedes, w.task.id);
    assert.equal(replacement.status, 'draft');
    assert.deepEqual(replacement.acceptance, [
      ...doneTask.acceptance,
      'Пустой ввод тоже проверен.',
    ]);
  } finally {
    w.cleanup();
  }
});
