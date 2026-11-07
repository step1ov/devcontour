// Ответ на вопрос исполнителя сообщением обсуждения (D02 + D03): одна
// транзакция, текст ответа — один раз в запросе harness, повтор по ключу,
// исправление ответа, поздний ответ — история, сообщения в manifest снимка.
// Модели не вызываются: demo-исполнитель и управляемый reviewer.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlled,
  inputDemos,
  inputFixture,
  untilQuestion,
  type InputFixture,
} from './input-fixture.ts';
import { AgentService } from '../src/application/agent.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { serve } from '../src/server/http.ts';
import { executionOf } from '../src/harness/execution.ts';
import { inputManifestOf, inputSourceId } from 'devcontour-harness';
import { taskOwner } from '../src/core/sync-state.ts';

after(() => inputDemos.close());

async function question(f: InputFixture) {
  const { taskId, boardId } = f.askingTask();
  await untilQuestion(f, boardId);
  const [r] = f.service.list({ taskId }).requests;
  return { taskId, requestId: r.requestId, version: r.version };
}

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    const e = error as { status?: number; details?: { code?: string }; code?: string };
    return `${e.status ?? '-'}:${e.details?.code ?? e.code ?? '-'}`;
  }
};

const rawRow = (f: InputFixture, taskId: string, id: string) => {
  const task = f.store.read().tasks.find((t) => t.id === taskId)!;
  return f.store.discussionById(taskOwner(task), id) as Record<string, unknown>;
};

test('D03-K: the lead answers through discussion_post; the message id is the messageRef, the text lives only in the request, a repeat is the same answer', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, requestId, version } = await question(f);
    const agent = new AgentService(f.h, f.root);
    const post = {
      taskId,
      kind: 'answer',
      text: 'Use JSON as now.',
      input: { requestId, expectedVersion: version, optionId: 'json' },
      idempotencyKey: 'answer-key-0001',
      expectedVersion: 0,
    };
    const first = agent.execute({ operation: 'discussion_post', input: post }) as {
      message: { id: string; kind: string; input: { revision: number; answerDigest: string } };
    };
    const request = f.service.show({ requestId });
    assert.equal(request.lifecycle, 'answered');
    const answer = request.answers.at(-1) as {
      messageRef?: string;
      actor: { kind: string };
      digest: string;
    };
    assert.equal(answer.messageRef, first.message.id);
    assert.equal(answer.actor.kind, 'lead');
    assert.equal(first.message.input.answerDigest, answer.digest);
    // Канонический текст — только в запросе: запись обсуждения без текста,
    // чтение подставляет его по версии ответа.
    assert.equal('text' in rawRow(f, taskId, first.message.id), false);
    const page = new DiscussionService(f.h).read({ taskId });
    const shown = page.messages.find((m) => m.id === first.message.id)!;
    assert.equal(shown.text, 'Use JSON as now.');
    assert.equal(shown.kind, 'answer');
    // Повтор по ключу — то же сообщение и тот же ответ.
    const again = agent.execute({ operation: 'discussion_post', input: post }) as {
      message: { id: string };
    };
    assert.equal(again.message.id, first.message.id);
    assert.equal(f.service.show({ requestId }).answers.length, 1);
    // Журнал — только идентификаторы.
    const event = f.store.events().findLast((e) => e.type === 'discussion.posted')!;
    assert.equal(JSON.stringify(event.data).includes('Use JSON'), false);
  } finally {
    await f.cleanup();
  }
});

test('D03-K: the panel answer is a discussion message; a correction supersedes it with revision 2; an applied answer is not corrected', async () => {
  const f = await inputFixture(controlled());
  const app = await serve(f.h, f.scheduler, { port: 0 });
  try {
    const { taskId, requestId, version } = await question(f);
    const postAnswer = (body: unknown) =>
      fetch(`${app.url}/api/tasks/${taskId}/input/${requestId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
        body: JSON.stringify(body),
      });
    const first = await postAnswer({
      text: 'Use JSON.',
      expectedVersion: version,
      idempotencyKey: 'panel-key-0001',
    });
    assert.equal(first.status, 200, await first.clone().text());
    const { messageId, delivered } = (await first.json()) as {
      messageId: string;
      delivered: boolean;
    };
    assert.equal(delivered, true);
    const thread = () => new DiscussionService(f.h).read({ taskId }).messages;
    assert.equal(thread().find((m) => m.id === messageId)?.author, 'operator');
    const second = await postAnswer({
      text: 'Use JSON and pretty-print it.',
      expectedVersion: f.service.show({ requestId }).version,
      idempotencyKey: 'panel-key-0002',
      supersedes: messageId,
    });
    assert.equal(second.status, 200, await second.clone().text());
    const correction = (await second.json()) as { messageId: string; input: { revision: number } };
    assert.equal(correction.input.revision, 2);
    const fixed = thread().find((m) => m.id === correction.messageId)!;
    assert.equal(fixed.supersedes, messageId);
    assert.equal(fixed.text, 'Use JSON and pretty-print it.');
    const answers = f.service.show({ requestId }).answers as { messageRef?: string }[];
    assert.deepEqual(
      answers.map((a) => a.messageRef),
      [messageId, correction.messageId],
    );
    // Применённый ответ не исправляется: изменение — обращение к ведущему.
    const context = await f.service.context({ requestId });
    await f.service.review({
      requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    f.service.apply(
      {
        requestId,
        answerDigest: context.answerDigest,
        expectedVersion: target.version,
        contextDigest: context.contextDigest,
        targetDigest: target.targetDigest!,
      },
      'lead',
    );
    const late = await postAnswer({
      text: 'Actually YAML.',
      expectedVersion: f.service.show({ requestId }).version,
      idempotencyKey: 'panel-key-0003',
      supersedes: correction.messageId,
    });
    assert.equal(late.status, 409);
    assert.match(((await late.json()) as { error: string }).error, /change-request/);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test('D03-C: a late answer after cancel is kept as discussion history; the request stays cancelled and nothing resumes', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, requestId, version } = await question(f);
    f.service.cancel(
      { requestId, expectedVersion: version, reason: 'Not needed any more' },
      'operator',
    );
    const runs = f.store.read().runs.filter((r) => r.taskId === taskId).length;
    const result = new DiscussionService(f.h).post(
      {
        taskId,
        kind: 'answer',
        text: 'Late: use JSON.',
        input: { requestId, expectedVersion: version + 1 },
        idempotencyKey: 'late-key-0001',
        expectedVersion: 0,
      },
      'operator',
    ) as { message: { id: string; text: string; input?: unknown }; delivered?: boolean };
    assert.equal(result.delivered, false);
    assert.deepEqual(result.message.input, { requestId, accepted: false, lifecycle: 'cancelled' });
    // Текста в запросе нет: история хранит его сама.
    assert.equal(rawRow(f, taskId, result.message.id).text, 'Late: use JSON.');
    const request = f.service.show({ requestId });
    assert.equal(request.lifecycle, 'cancelled');
    assert.equal(request.answers.length, 0);
    await f.scheduler.drain();
    assert.equal(f.store.read().runs.filter((r) => r.taskId === taskId).length, runs);
    assert.equal(f.service.show({ requestId }).lifecycle, 'cancelled');
  } finally {
    await f.cleanup();
  }
});

test('The lead answer rule holds through discussion_post: a critical question is refused 403 and nothing is written', async () => {
  const f = await inputFixture(controlled({ critical: true }));
  try {
    const { taskId, requestId, version } = await question(f);
    const before = new DiscussionService(f.h).read({ taskId }).version;
    assert.equal(
      await codeOf(() =>
        new AgentService(f.h, f.root).execute({
          operation: 'discussion_post',
          input: {
            taskId,
            kind: 'answer',
            text: 'Change the API.',
            input: { requestId, expectedVersion: version },
            idempotencyKey: 'lead-critical-01',
            expectedVersion: before,
          },
        }),
      ),
      '403:OPERATOR_ANSWERS',
    );
    assert.equal(new DiscussionService(f.h).read({ taskId }).version, before);
    assert.equal(f.service.show({ requestId }).answers.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('D03-K: the snapshot manifest lists the answer message and selected messages; editing the discussion later does not change the pinned bytes', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, requestId, version } = await question(f);
    const discussion = new DiscussionService(f.h);
    const note = discussion.post(
      {
        taskId,
        kind: 'note',
        text: 'Context: the consumer reads JSON only.',
        idempotencyKey: 'note-key-00001',
        expectedVersion: 0,
      },
      'operator',
    );
    const answered = discussion.post(
      {
        taskId,
        kind: 'answer',
        text: 'Use JSON as now.',
        input: { requestId, expectedVersion: version },
        idempotencyKey: 'answer-key-0002',
        expectedVersion: 0,
      },
      'operator',
    );
    const context = await f.service.context({ requestId, messageIds: [note.message.id] });
    const { store } = executionOf(f.h);
    const snapshot = () =>
      store.read((v) => v.local('context-snapshots', '@workspace', context.contextDigest))!;
    const source = snapshot().sources.find((s) => s.id === inputSourceId(requestId))!;
    const manifest = inputManifestOf(source)!;
    assert.deepEqual(manifest.messages, [
      { id: note.message.id, revision: note.message.seq, digest: note.message.payloadDigest },
      {
        id: answered.message.id,
        revision: answered.message.seq,
        digest: answered.message.payloadDigest,
      },
    ]);
    // Текст заметки в снимок не входит.
    assert.equal(JSON.stringify(snapshot()).includes('consumer reads JSON only'), false);
    const pinned = JSON.stringify(snapshot());
    // Правка заметки — новое сообщение; снимок по digest прежний, повтор
    // снимка с тем же выбором — тот же digest.
    discussion.post(
      {
        taskId,
        kind: 'note',
        text: 'Context: the consumer reads JSON and YAML.',
        supersedes: note.message.id,
        idempotencyKey: 'note-key-00002',
        expectedVersion: discussion.read({ taskId }).version,
      },
      'operator',
    );
    assert.equal(JSON.stringify(snapshot()), pinned);
    const again = await f.service.context({ requestId, messageIds: [note.message.id] });
    assert.equal(again.contextDigest, context.contextDigest);
    // Чужое сообщение — отказ.
    assert.equal(
      await codeOf(() =>
        f.service.context({ requestId, messageIds: ['DM-00000000-0000-4000-8000-000000000000'] }),
      ),
      '404:-',
    );
  } finally {
    await f.cleanup();
  }
});
