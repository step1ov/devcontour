import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionService } from '../src/application/attention.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { AgentService } from '../src/application/agent.ts';
import { DomainError } from '../src/core/model.ts';
import type { AttentionItem } from '../src/core/attention-model.ts';
import { byKey } from './attention-fixture.ts';
import { config, fixture, input } from './helpers.ts';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { command } from '../src/runner/process.ts';

// Решения ведущего за владельца: запись ведущим, очередь подтверждения у
// владельца, подтверждение и отмена только владельцем, отмена — работа ведущего.

const key = (n: number) => 'stand-in-key-' + String(n).padStart(4, '0');
const refused = (status: number, code?: string) => (error: unknown) =>
  error instanceof DomainError &&
  error.status === status &&
  (code === undefined || error.details?.code === code);
const act = (item: AttentionItem, action: string, extra: Record<string, unknown> = {}) => ({
  sourceKey: item.sourceKey,
  occurrenceId: item.occurrenceId,
  expectedVersion: item.sourceVersion,
  action,
  ...extra,
});

function world() {
  const f = fixture();
  const board = f.h.createBoard('Decisions');
  const task = f.h.addTask(board.id, input('Экран заказа'));
  const d = new DiscussionService(f.h);
  const agent = new AgentService(f.h);
  const standIn = (n: number, extra: Record<string, unknown> = {}) =>
    agent.execute({
      operation: 'discussion_post',
      input: {
        taskId: task.id,
        kind: 'stand-in',
        text: 'Один заказ — одна позиция: самый короткий путь к первому экрану.',
        standIn: {
          question: 'Сколько позиций в одном заказе?',
          impact: 'Модель данных заказа и экран корзины.',
        },
        idempotencyKey: key(n),
        expectedVersion: d.read({ taskId: task.id, latest: true, limit: 1 }).version,
        ...extra,
      },
    }) as { message: { id: string } };
  return { ...f, board, task, d, agent, standIn };
}

test('F21: решение за владельца пишет только ведущий, с вопросом и влиянием', () => {
  const w = world();
  try {
    // Оператор не пишет решение «за себя»: его слово — заметка или обращение.
    assert.throws(
      () =>
        w.d.post(
          {
            taskId: w.task.id,
            kind: 'stand-in',
            text: 'Решение',
            standIn: { question: 'Вопрос', impact: 'Влияние' },
            idempotencyKey: key(1),
            expectedVersion: 0,
          },
          'operator',
        ),
      refused(403, 'lead-only'),
    );
    assert.throws(
      () =>
        w.d.post(
          {
            taskId: w.task.id,
            kind: 'stand-in',
            text: 'Без вопроса',
            idempotencyKey: key(2),
            expectedVersion: 0,
          },
          'lead',
        ),
      refused(400),
    );
    assert.throws(
      () =>
        w.d.post(
          {
            taskId: w.task.id,
            kind: 'note',
            text: 'Заметка',
            standIn: { question: 'Вопрос', impact: 'Влияние' },
            idempotencyKey: key(3),
            expectedVersion: 0,
          },
          'lead',
        ),
      refused(400),
    );
    const posted = w.standIn(4);
    const listed = w.d.standIns(10);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].message.id, posted.message.id);
    assert.equal(listed[0].message.author, 'lead');
    assert.equal(listed[0].message.standIn?.question, 'Сколько позиций в одном заказе?');
    assert.equal(listed[0].ruling, undefined);
    // Повтор под тем же ключом — та же запись.
    assert.equal(w.standIn(4).message.id, posted.message.id);
  } finally {
    w.cleanup();
  }
});

test('F21: подтверждать и отменять может только владелец — агентский API операции не имеет', () => {
  const w = world();
  try {
    const posted = w.standIn(1);
    const version = w.d.read({ taskId: w.task.id }).version;
    // Ведущий через службу — отказ до любой записи.
    for (const ruling of ['confirmed', 'reversed'])
      assert.throws(
        () =>
          w.d.rule(
            {
              messageId: posted.message.id,
              ruling,
              text: 'Взамен',
              idempotencyKey: key(2),
              expectedVersion: version,
            },
            'lead',
          ),
        refused(403, 'owner-only'),
      );
    // Поле решения владельца в записи ведущего — ошибка схемы, не решение.
    assert.throws(() =>
      w.agent.execute({
        operation: 'discussion_post',
        input: {
          taskId: w.task.id,
          kind: 'note',
          text: 'Подтверждаю за владельца',
          replyTo: posted.message.id,
          ruling: 'confirmed',
          idempotencyKey: key(3),
          expectedVersion: version,
        },
      }),
    );
    // Операции решения нет в каталоге агентского API.
    assert.throws(() =>
      w.agent.execute({
        operation: 'discussion_rule' as 'discussion_post',
        input: { messageId: posted.message.id, ruling: 'confirmed' },
      }),
    );
    // Ведущий видит карточку владельца в attention_list, но действий у агента нет.
    const service = new AttentionService(w.store, w.h);
    const lead = service.agentList({ actor: 'operator' });
    const card = lead.items.find((i) => i.source === 'stand-in');
    assert.ok(card, 'карточка решения за владельца видна ведущему');
    assert.equal(card.actor, 'operator');
    assert.equal(w.d.standIns(10).length, 1, 'решение всё ещё ждёт владельца');
    assert.equal(w.d.read({ taskId: w.task.id }).messages.length, 1);
  } finally {
    w.cleanup();
  }
});

test('F21: подтверждение с карточки снимает её, решение окончательно', async () => {
  const w = world();
  try {
    const posted = w.standIn(1);
    const service = new AttentionService(w.store, w.h);
    const card = byKey((await service.active()).items, `discussion:si:${posted.message.id}`)!;
    assert.ok(card);
    assert.equal(card.actor, 'operator');
    assert.equal(card.category, 'decision');
    assert.deepEqual(
      card.actions.filter((a) => a.kind === 'domain').map((a) => a.id),
      ['confirm', 'reverse'],
    );
    assert.match(card.reason, /одна позиция/);
    const done = await service.act(act(card, 'confirm'));
    assert.equal(done.resolved, true);
    assert.equal(w.d.standIns(10).length, 0);
    const [ruled] = w.d.standIns(10, true);
    assert.equal(ruled.ruling?.ruling, 'confirmed');
    assert.equal(ruled.ruling?.author, 'operator');
    assert.equal(ruled.ruling?.kind, 'note');
    // Подтверждение не становится работой ведущего.
    assert.equal(w.d.inbox({}).requests.length, 0);
    // История центра — решённая карточка.
    const history = service.history({});
    assert.ok(history.items.some((i) => i.sourceKey === card.sourceKey));
    // Повтор с карточки — уже решено; повторное решение — 409.
    await assert.rejects(service.act(act(card, 'confirm')), refused(409, 'attention-resolved'));
    const version = w.d.read({ taskId: w.task.id }).version;
    assert.throws(
      () =>
        w.d.rule(
          {
            messageId: posted.message.id,
            ruling: 'reversed',
            text: 'Передумал',
            idempotencyKey: key(9),
            expectedVersion: version,
          },
          'operator',
        ),
      refused(409, 'already-ruled'),
    );
    // Решённое владельцем решение ведущий не исправляет.
    assert.throws(
      () => w.standIn(10, { supersedes: posted.message.id, text: 'Другое решение' }),
      refused(409, 'already-ruled'),
    );
  } finally {
    w.cleanup();
  }
});

test('F21: отмена владельцем — обращение в очереди ведущего с вариантом взамен', async () => {
  const w = world();
  try {
    const posted = w.standIn(1);
    const service = new AttentionService(w.store, w.h);
    const card = byKey((await service.active()).items, `discussion:si:${posted.message.id}`)!;
    // Отмена без варианта взамен — отказ.
    await assert.rejects(service.act(act(card, 'reverse', { input: {} })), refused(400));
    const done = await service.act(
      act(card, 'reverse', {
        input: { text: 'В заказе несколько позиций, порядок задаю я.' },
        idempotencyKey: key(2),
      }),
    );
    assert.equal(done.resolved, true);
    const [ruled] = w.d.standIns(10, true);
    assert.equal(ruled.ruling?.ruling, 'reversed');
    assert.equal(ruled.ruling?.kind, 'change-request');
    // Отмена видна ведущему как работа: очередь обращений и его карточка.
    const inbox = w.d.inbox({});
    assert.equal(inbox.requests.length, 1);
    assert.equal(inbox.requests[0].id, ruled.ruling?.id);
    assert.match(inbox.requests[0].excerpt, /Взамен: В заказе несколько позиций/);
    assert.match(inbox.requests[0].excerpt, /Сколько позиций в одном заказе/);
    const lead = service.agentList({});
    assert.ok(
      lead.items.some((i) => i.source === 'discussion-request' && i.subject.id === w.task.id),
    );
    // Решение владельца не исправляется (и из панели).
    assert.throws(
      () =>
        w.d.post(
          {
            taskId: w.task.id,
            kind: 'change-request',
            text: 'Исправленная отмена',
            supersedes: ruled.ruling!.id,
            idempotencyKey: key(3),
            expectedVersion: w.d.read({ taskId: w.task.id }).version,
          },
          'operator',
        ),
      refused(409, 'ruling-final'),
    );
    // Ведущий обрабатывает отмену обычным discussion_resolve.
    w.agent.execute({
      operation: 'discussion_resolve',
      input: {
        requestId: ruled.ruling?.id,
        outcome: 'rejected',
        reason: 'Нужна новая постановка задачи; заведу её отдельно.',
        idempotencyKey: key(4),
        expectedVersion: w.d.read({ taskId: w.task.id }).version,
      },
    });
    assert.equal(w.d.inbox({}).requests.length, 0);
  } finally {
    w.cleanup();
  }
});

test('F21: исправленное решение — в очереди только последняя версия, решение по старой — 409', () => {
  const w = world();
  try {
    const first = w.standIn(1);
    const second = w.standIn(2, {
      supersedes: first.message.id,
      text: 'Один заказ — до трёх позиций.',
    });
    const listed = w.d.standIns(10);
    assert.deepEqual(
      listed.map((r) => r.message.id),
      [second.message.id],
    );
    // Исправление сохраняет вид: решение за владельца не становится заметкой.
    assert.throws(
      () =>
        w.agent.execute({
          operation: 'discussion_post',
          input: {
            taskId: w.task.id,
            kind: 'note',
            text: 'Теперь заметка',
            supersedes: second.message.id,
            idempotencyKey: key(3),
            expectedVersion: w.d.read({ taskId: w.task.id }).version,
          },
        }),
      refused(400),
    );
    assert.throws(
      () =>
        w.d.rule(
          {
            messageId: first.message.id,
            ruling: 'confirmed',
            idempotencyKey: key(4),
            expectedVersion: w.d.read({ taskId: w.task.id }).version,
          },
          'operator',
        ),
      refused(409, 'stand-in-superseded'),
    );
    const ok = w.d.rule(
      {
        messageId: second.message.id,
        ruling: 'confirmed',
        text: 'Да, до трёх.',
        idempotencyKey: key(5),
        expectedVersion: w.d.read({ taskId: w.task.id }).version,
      },
      'operator',
    );
    assert.equal(ok.message.ruling, 'confirmed');
    assert.equal(ok.message.text, 'Да, до трёх.');
    assert.equal(w.d.standIns(10).length, 0);
  } finally {
    w.cleanup();
  }
});

test('F21: CLI — список ждущих решений, подтверждение и отмена владельцем, без --by host', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-stand-in-')));
  const data = join(root, 'data');
  try {
    await mkdir(data);
    await writeFile(join(data, 'config.json'), JSON.stringify(config()));
    const h = new DevContour(new Store(join(data, 'state.sqlite')), config());
    const ids: string[] = [];
    try {
      const board = h.createBoard('Decisions');
      const task = h.addTask(board.id, input('Экран заказа'));
      const d = new DiscussionService(h);
      for (const n of [1, 2])
        ids.push(
          d.post(
            {
              taskId: task.id,
              kind: 'stand-in',
              text: `Решение ${n}`,
              standIn: { question: `Вопрос ${n}`, impact: `Влияние ${n}` },
              idempotencyKey: key(n),
              expectedVersion: d.read({ taskId: task.id }).version,
            },
            'lead',
          ).message.id,
        );
    } finally {
      h.store.close();
    }
    const cli = (...args: string[]) =>
      command(['node', '--import', 'tsx', 'src/cli.ts', ...args, '--data', data], process.cwd());
    const listed = await cli('decisions');
    assert.equal(listed.code, 0, listed.stderr);
    const rows = JSON.parse(listed.stdout) as {
      messageId: string;
      state: string;
      question: string;
    }[];
    assert.deepEqual(
      rows.map((r) => [r.messageId, r.state, r.question]),
      [
        [ids[0], 'unconfirmed', 'Вопрос 1'],
        [ids[1], 'unconfirmed', 'Вопрос 2'],
      ],
    );
    // Ведущий не выдаёт себя за владельца флагом --by.
    const host = await cli('decision-confirm', '--message', ids[0], '--by', 'host');
    assert.notEqual(host.code, 0);
    assert.match(host.stderr, /только владелец/);
    const noText = await cli('decision-reverse', '--message', ids[1]);
    assert.notEqual(noText.code, 0);
    assert.equal((await cli('decision-confirm', '--message', ids[0])).code, 0);
    const reversed = await cli('decision-reverse', '--message', ids[1], '--text', 'Иначе');
    assert.equal(reversed.code, 0, reversed.stderr);
    assert.equal((JSON.parse((await cli('decisions')).stdout) as unknown[]).length, 0);
    const all = JSON.parse((await cli('decisions', '--all')).stdout) as { state: string }[];
    assert.deepEqual(
      all.map((r) => r.state),
      ['confirmed', 'reversed'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
