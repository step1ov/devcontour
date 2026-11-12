// Решения за владельца, которые записывает сам инструмент: ведущий ответил
// на вопрос исполнителя изменением требований или принял допущение
// follow-up. Запись — в транзакции ответа, от автора `runtime`: ведущий не
// занимает её ключ и не исправляет её. Модели не вызываются:
// demo-исполнитель и управляемый reviewer.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { DomainError } from '../src/core/model.ts';
import { executionOf } from '../src/harness/execution.ts';

after(() => inputDemos.close());

test('F21: ответ ведущего изменением требований записывает одно решение за владельца на вопрос', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [r] = f.service.list({ taskId }).requests;
    const d = new DiscussionService(f.h);
    // Ведущий занимает будущие ключи записи заранее — запись это не останавливает:
    // ключи автора runtime ему недоступны.
    for (const key of [`si-${r.requestId}-r1`, `si-${r.requestId}-r2`])
      d.post(
        {
          taskId,
          kind: 'note',
          text: 'Заметка под ключом инструмента',
          idempotencyKey: key,
          expectedVersion: d.read({ taskId }).version,
        },
        'lead',
      );
    // Уточнение ведущего решением за владельца не считается.
    const clarified = f.service.answer(
      { requestId: r.requestId, text: 'Use JSON as now.', expectedVersion: r.version },
      'lead',
    );
    assert.equal(d.standIns(10).length, 0);
    const changed = f.service.answer(
      {
        requestId: r.requestId,
        text: 'Change the acceptance: produce YAML.',
        kind: 'requirement-change',
        expectedVersion: clarified.version,
      },
      'lead',
    );
    const [stand] = d.standIns(10);
    assert.ok(stand, 'решение за владельца записано инструментом');
    assert.equal(stand.message.taskId, taskId);
    assert.equal(stand.message.author, 'runtime');
    assert.match(
      stand.message.text,
      /изменением требований: Change the acceptance: produce YAML\./,
    );
    assert.equal(
      stand.message.standIn?.question,
      f.service.show({ requestId: r.requestId }).question.question,
    );
    assert.match(stand.message.standIn?.impact ?? '', /Постановка и результат задачи/);
    // Ведущий не переписывает запись инструмента.
    assert.throws(
      () =>
        d.post(
          {
            taskId,
            kind: 'stand-in',
            text: 'Мягче',
            standIn: { question: 'Вопрос', impact: 'Влияние' },
            supersedes: stand.message.id,
            idempotencyKey: 'lead-rewrite-0001',
            expectedVersion: d.read({ taskId }).version,
          },
          'lead',
        ),
      (e: unknown) => e instanceof DomainError && e.status === 403,
    );
    // Тот же ответ повторно — без второй записи.
    const again = f.service.answer(
      {
        requestId: r.requestId,
        text: 'Change the acceptance: produce YAML.',
        kind: 'requirement-change',
        expectedVersion: changed.version,
      },
      'lead',
    );
    assert.equal(d.standIns(10, true).length, 1);
    // Другая версия изменения требований заменяет нерешённую запись: одна карточка.
    f.service.answer(
      {
        requestId: r.requestId,
        text: 'Change the acceptance: produce TOML.',
        kind: 'requirement-change',
        expectedVersion: again.version,
      },
      'lead',
    );
    const pending = d.standIns(10);
    assert.equal(pending.length, 1);
    assert.match(pending[0].message.text, /produce TOML/);
    assert.equal(pending[0].message.supersedes, stand.message.id);
    // Изменение требований оператором — его собственное решение.
    const current = f.service.show({ requestId: r.requestId });
    f.service.answer(
      {
        requestId: r.requestId,
        text: 'Produce CSV instead.',
        kind: 'requirement-change',
        expectedVersion: current.version,
      },
      'operator',
    );
    assert.equal(d.standIns(10).length, 1);
    assert.match(d.standIns(10)[0].message.text, /produce TOML/);
  } finally {
    await f.cleanup();
  }
});

test('F21: ведущий принимает допущение follow-up — решение за владельца в той же транзакции', async () => {
  const f = await inputFixture(controlled({ assume: true }), {
    edit: (raw) => (raw.inputPolicy = { threshold: 11 }),
  });
  try {
    const board = f.h.createBoard('Autonomous board');
    const taskId = f.plainTask(board.id, 'Autonomous task');
    const otherId = f.plainTask(board.id, 'Second autonomous task');
    f.h.approve(board.id);
    f.h.pause(false);
    await f.scheduler.drain();
    const followUps = f.service
      .list()
      .requests.filter((r) => r.kind === 'follow-up' && r.state === 'awaiting-answer');
    const own = followUps.find((r) => r.taskId === taskId);
    const other = followUps.find((r) => r.taskId === otherId);
    assert.ok(own && other, JSON.stringify(followUps.map((r) => r.taskId)));
    const d = new DiscussionService(f.h);
    // Ключ записи занят ведущим заранее — закрытие всё равно записывает решение.
    d.post(
      {
        taskId,
        kind: 'note',
        text: 'Заметка под ключом инструмента',
        idempotencyKey: `si-${own.requestId}-accepted`,
        expectedVersion: d.read({ taskId }).version,
      },
      'lead',
    );
    f.service.cancel(
      { requestId: own.requestId, expectedVersion: own.version, reason: 'assumption accepted' },
      'lead',
    );
    const recorded = d.standIns(50).filter((s) => s.message.taskId === taskId);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].message.author, 'runtime');
    assert.match(
      recorded[0].message.text,
      /Ведущий принял допущение исполнителя: .*assumption accepted/,
    );
    // Закрытие follow-up оператором — его решение, записи нет.
    f.service.cancel(
      { requestId: other.requestId, expectedVersion: other.version, reason: 'operator accepted' },
      'operator',
    );
    assert.equal(d.standIns(50).filter((s) => s.message.taskId === otherId).length, 0);
  } finally {
    await f.cleanup();
  }
});

/** Подменяет запись решения за владельца на время `fn`: сбой или пропуск. */
async function withRecord<T>(
  replacement: DiscussionService['recordStandIn'],
  fn: () => T | Promise<T>,
) {
  // Дескриптор, а не метод: прототип восстанавливается как был.
  const proto = DiscussionService.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'recordStandIn')!;
  Object.defineProperty(proto, 'recordStandIn', { ...original, value: replacement });
  try {
    return await fn();
  } finally {
    Object.defineProperty(proto, 'recordStandIn', original);
  }
}

test('F21: сбой записи решения откатывает ответ ведущего, повтор дописывает пропущенную запись', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [r] = f.service.list({ taskId }).requests;
    const d = new DiscussionService(f.h);
    const change = {
      requestId: r.requestId,
      text: 'Change the acceptance: produce YAML.',
      kind: 'requirement-change' as const,
      expectedVersion: r.version,
    };
    // Сбой записи — ответа нет: одна транзакция.
    await withRecord(
      () => {
        throw new Error('forced stand-in failure');
      },
      () => assert.throws(() => f.service.answer(change, 'lead'), /forced stand-in failure/),
    );
    const untouched = f.service.show({ requestId: r.requestId });
    assert.equal(untouched.answers.length, 0);
    assert.equal(untouched.version, r.version);
    assert.equal(d.standIns(10, true).length, 0);
    // Запись пропущена (как в прежней версии без транзакции) — повтор того же
    // ответа её дописывает.
    await withRecord(
      () => undefined,
      () => f.service.answer(change, 'lead'),
    );
    assert.equal(f.service.show({ requestId: r.requestId }).answers.length, 1);
    assert.equal(d.standIns(10).length, 0);
    f.service.answer(change, 'lead');
    assert.equal(f.service.show({ requestId: r.requestId }).answers.length, 1);
    assert.equal(d.standIns(10).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('F21: follow-up — сбой записи откатывает закрытие; закрытие с другой причиной и вызов оператора не пишут решение', async () => {
  const f = await inputFixture(controlled({ assume: true }), {
    edit: (raw) => (raw.inputPolicy = { threshold: 11 }),
  });
  try {
    const board = f.h.createBoard('Autonomous board');
    const first = f.plainTask(board.id, 'First autonomous task');
    const second = f.plainTask(board.id, 'Second autonomous task');
    f.h.approve(board.id);
    f.h.pause(false);
    await f.scheduler.drain();
    const open = f.service
      .list()
      .requests.filter((r) => r.kind === 'follow-up' && r.state === 'awaiting-answer');
    const a = open.find((r) => r.taskId === first);
    const b = open.find((r) => r.taskId === second);
    assert.ok(a && b);
    const d = new DiscussionService(f.h);
    const accept = {
      requestId: a.requestId,
      expectedVersion: a.version,
      reason: 'assumption accepted',
    };
    await withRecord(
      () => {
        throw new Error('forced stand-in failure');
      },
      () => assert.throws(() => f.service.cancel(accept, 'lead'), /forced stand-in failure/),
    );
    assert.equal(f.service.show({ requestId: a.requestId }).lifecycle, 'pending');
    // Пропуск записи, затем повтор того же закрытия — запись дописана.
    await withRecord(
      () => undefined,
      () => f.service.cancel(accept, 'lead'),
    );
    assert.equal(f.service.show({ requestId: a.requestId }).lifecycle, 'cancelled');
    assert.equal(d.standIns(50).filter((s) => s.message.taskId === first).length, 0);
    f.service.cancel(accept, 'lead');
    assert.equal(d.standIns(50).filter((s) => s.message.taskId === first).length, 1);
    // Follow-up закрыт движком с другой причиной (как при отмене задачи) —
    // ни вызов оператора, ни закрытие ведущего с иной причиной не пишут
    // «допущение принято».
    executionOf(f.h).engine.cancelInput(
      b.requestId,
      { by: 'lead', reason: 'Поручение отменено' },
      b.version,
    );
    const closed = f.service.show({ requestId: b.requestId });
    f.service.cancel(
      { requestId: b.requestId, expectedVersion: closed.version, reason: 'operator closes' },
      'operator',
    );
    f.service.cancel(
      { requestId: b.requestId, expectedVersion: closed.version, reason: 'assumption accepted' },
      'lead',
    );
    assert.equal(d.standIns(50).filter((s) => s.message.taskId === second).length, 0);
  } finally {
    await f.cleanup();
  }
});
