// Вопросы исполнителя через агентский API, CLI-актёров и маршруты панели:
// кто вправе ответить, снять и применить; повторы; изменение требований.
// Модели не вызываются: demo-исполнитель и управляемый reviewer ответа.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlled,
  inputDemos,
  inputFixture,
  prepared,
  untilQuestion,
  type InputFixture,
} from './input-fixture.ts';
import { AgentService } from '../src/application/agent.ts';
import { specDigest } from '../src/core/service.ts';
import { serve } from '../src/server/http.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { queueStopOf } from '../src/application/queue-stop.ts';
import { reviewLanguageInstructions } from '../src/application/hint-messages.ts';

after(() => inputDemos.close());

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return `${e.status ?? '-'}:${e.code ?? '-'}`;
  }
};

async function question(f: InputFixture) {
  const { taskId, boardId } = f.askingTask();
  await untilQuestion(f, boardId);
  const [request] = f.service.list({ taskId }).requests;
  return { taskId, boardId, requestId: request.requestId, version: request.version };
}

test('A critical question is answered and cancelled only by the operator; the lead and CLI --by host are refused', async () => {
  const f = await inputFixture(controlled({ critical: true }));
  try {
    const { requestId, version } = await question(f);
    const shown = f.service.show({ requestId });
    assert.deepEqual(shown.floors, ['declared']);
    assert.equal(shown.actor, 'operator');
    const agent = new AgentService(f.h, f.root);
    const answer = { requestId, text: 'Keep the API as is.', expectedVersion: version };
    assert.equal(
      await codeOf(() => agent.execute({ operation: 'input_answer', input: answer })),
      '403:OPERATOR_ANSWERS',
    );
    assert.equal(await codeOf(() => f.service.answer(answer, 'host')), '403:OPERATOR_ANSWERS');
    // R7-1: снять критический вопрос — то же право, что ответить.
    const cancel = { requestId, expectedVersion: version, reason: 'Not needed' };
    assert.equal(
      await codeOf(() => agent.execute({ operation: 'input_cancel', input: cancel })),
      '403:OPERATOR_ANSWERS',
    );
    assert.equal(await codeOf(() => f.service.cancel(cancel, 'host')), '403:OPERATOR_ANSWERS');
    // Актёр задаёт транспорт: поле actor во входе агентского API не принимается.
    assert.equal(
      await codeOf(() =>
        agent.execute({ operation: 'input_answer', input: { ...answer, actor: 'operator' } }),
      ),
      '400:-',
    );
    const saved = f.service.answer(answer, 'operator');
    assert.equal(saved.revision, 1);
    // Повтор того же ответа — тот же ответ, без новой версии.
    const again = f.service.answer({ ...answer, expectedVersion: saved.version }, 'operator');
    assert.equal(again.changed, false);
    assert.equal(again.revision, 1);
    assert.equal(f.service.show({ requestId }).answers.length, 1);
    assert.equal(
      (f.service.show({ requestId }).answers[0] as { actor: { kind: string } }).actor.kind,
      'operator',
    );
  } finally {
    await f.cleanup();
  }
});

test('Agent mode: the lead answers a floor-free question and applies; the panel apply is refused; a repeated review is one round', async () => {
  const f = await inputFixture(controlled());
  const app = await serve(f.h, f.scheduler, { port: 0 });
  try {
    const { taskId, requestId } = await question(f);
    const p = await prepared(f, requestId, 'lead');
    // Повтор ревью того же снимка — тот же раунд без вызова модели.
    const again = await f.service.review({
      requestId,
      contextDigest: p.context.contextDigest,
      authorRuntime: 'codex',
    });
    assert.equal(again.round, p.review.round);
    const post = (path: string, body: unknown) =>
      fetch(app.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
        body: JSON.stringify(body),
      });
    const panel = await post(`/api/tasks/${taskId}/input/${requestId}/apply`, {
      expectedVersion: p.target.version,
    });
    assert.equal(panel.status, 409);
    assert.match(((await panel.json()) as { error: string }).error, /ведущий агент/);
    // Чужая задача — 404.
    assert.equal(
      (
        await post(`/api/tasks/OTHER/input/${requestId}/cancel`, {
          expectedVersion: 1,
          reason: 'x x',
        })
      ).status,
      404,
    );
    const agent = new AgentService(f.h, f.root);
    const applied = agent.execute({ operation: 'input_apply', input: p.apply });
    assert.equal(applied.applied, true);
    const view = (await (await fetch(app.url + `/api/tasks/${taskId}/input`)).json()) as {
      current: { state: string; question: { question: string } };
    };
    assert.equal(view.current.state, 'applied-awaiting-claim');
    assert.match(view.current.question.question, /Demo fixture/);
    // Список без текста вопроса и ответа.
    const listed = JSON.stringify(agent.execute({ operation: 'input_list', input: { taskId } }));
    assert.equal(listed.includes('Demo fixture'), false);
    assert.equal(listed.includes('Use JSON as now'), false);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test('Operator mode: the lead reviews, the lead apply is refused, the operator applies in the panel', async () => {
  const f = await inputFixture(controlled(), { approvalMode: 'operator' });
  const app = await serve(f.h, f.scheduler, { port: 0 });
  try {
    const { taskId, requestId, version } = await question(f);
    assert.equal(f.service.show({ requestId }).actor, 'operator');
    const agent = new AgentService(f.h, f.root);
    // В режиме оператора ведущий не отвечает и на вопрос без минимумов.
    assert.equal(
      await codeOf(() =>
        agent.execute({
          operation: 'input_answer',
          input: { requestId, text: 'Use JSON as now.', expectedVersion: version },
        }),
      ),
      '403:OPERATOR_ANSWERS',
    );
    const post = (path: string, body: unknown) =>
      fetch(app.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
        body: JSON.stringify(body),
      });
    const answered = await post(`/api/tasks/${taskId}/input/${requestId}/answer`, {
      text: 'Use JSON as now.',
      optionId: 'json',
      expectedVersion: version,
    });
    assert.equal(answered.status, 200, await answered.clone().text());
    // Без ревью снимка панель применить не может.
    const early = await post(`/api/tasks/${taskId}/input/${requestId}/apply`, {
      expectedVersion: version + 1,
    });
    assert.equal(early.status, 409);
    const context = await agent.run({ operation: 'input_context', input: { requestId } });
    await new (await import('../src/application/input.ts')).InputService(
      f.h,
      f.root,
      controlled(),
    ).review({
      requestId,
      contextDigest: context.contextDigest as string,
      authorRuntime: 'codex',
    });
    const target = agent.execute({
      operation: 'input_target',
      input: { requestId, contextDigest: context.contextDigest },
    }) as { version: number; targetDigest: string; answerDigest: string; problems: string[] };
    assert.deepEqual(target.problems, []);
    assert.equal(
      await codeOf(() =>
        agent.execute({
          operation: 'input_apply',
          input: {
            requestId,
            answerDigest: target.answerDigest,
            expectedVersion: target.version,
            contextDigest: context.contextDigest,
            targetDigest: target.targetDigest,
          },
        }),
      ),
      '409:APPROVAL_REQUIRED',
    );
    const applied = await post(`/api/tasks/${taskId}/input/${requestId}/apply`, {
      expectedVersion: target.version,
    });
    assert.equal(applied.status, 200, await applied.clone().text());
    assert.equal(((await applied.json()) as { applied: boolean }).applied, true);
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'ready');
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test('A requirement-change answer is not applied; supersede waits for a new spec of the task; a late answer is refused', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    const answered = f.service.answer(
      {
        requestId,
        text: 'Change the acceptance: produce YAML.',
        kind: 'requirement-change',
        expectedVersion: version,
      },
      'operator',
    );
    assert.match(
      answered.nextStep,
      /reopen and respecify the task.*input_supersede with the same task/,
    );
    const context = await f.service.context({ requestId });
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    assert.ok(target.problems.some((p) => /изменение требований/.test(p)));
    assert.equal(
      await codeOf(() =>
        f.service.apply(
          {
            requestId,
            answerDigest: answered.answerDigest,
            expectedVersion: answered.version,
            contextDigest: context.contextDigest,
            targetDigest: target.targetDigest!,
          },
          'lead',
        ),
      ),
      '400:INVALID_INPUT',
    );
    const supersede = {
      requestId,
      expectedVersion: answered.version,
      reason: 'Requirement changed',
    };
    assert.equal(
      await codeOf(() => f.service.supersede({ ...supersede, successorTaskId: 'T-NOPE' }, 'lead')),
      '404:-',
    );
    // Пока постановка прежняя, замена не освобождает задачу — ни преемником
    // той же доски (старше или новее вопроса), ни самой задачей.
    const older = f.plainTask(boardId, 'Older sibling');
    f.store.change('test.older', (s) => {
      s.tasks.find((t) => t.id === older)!.createdAt = '2000-01-01T00:00:00.000Z';
    });
    const newer = f.plainTask(boardId, 'Successor with YAML');
    for (const successorTaskId of [older, newer, taskId])
      assert.equal(
        await codeOf(() => f.service.supersede({ ...supersede, successorTaskId }, 'lead')),
        '409:SPEC_UNCHANGED',
      );
    assert.equal(f.service.show({ requestId }).lifecycle, 'answered');
    // Изменение требований — новая постановка самой задачи: черновик,
    // правка, утверждение; тогда вопрос заменяется (ответ можно перенести).
    f.h.pause(true);
    f.h.reopen(taskId, 'The answer changes the acceptance of this task');
    const draft = f.store.read().tasks.find((t) => t.id === taskId)!;
    f.h.editTask(
      taskId,
      {
        title: draft.title,
        description: draft.description + ' Produce YAML.',
        role: draft.role,
        acceptance: draft.acceptance,
        dependsOn: draft.dependsOn,
      },
      specDigest(draft),
    );
    f.h.approve(boardId, [taskId]);
    const closed = f.service.supersede({ ...supersede, successorTaskId: taskId }, 'lead');
    assert.equal(closed.lifecycle, 'superseded');
    assert.equal(closed.carry, true);
    // Поздний ответ после замены не принимается.
    assert.equal(
      await codeOf(() =>
        f.service.answer(
          { requestId, text: 'Late answer', expectedVersion: closed.version },
          'operator',
        ),
      ),
      '409:NOT_READY',
    );
  } finally {
    await f.cleanup();
  }
});

test('Handoff and queue: host.next names who answers and the apply chain; the full answer never reaches the report, events or handoff', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, requestId, version } = await question(f);
    const handoff = () => devcontourHandoff(f.h, {});
    const pending = handoff();
    assert.equal(pending.host.next?.action, 'answer-input', JSON.stringify(pending.host.next));
    assert.equal(pending.host.next?.input?.requestId, requestId);
    assert.match(pending.host.next.detail, /input_answer/);
    assert.ok(pending.pack.inputs?.some((i) => i.requestId === requestId));
    assert.equal(queueStopOf(f.h).inputsWaiting, 1);
    const tail = 'UNIQUE-TAIL-' + 'z'.repeat(20);
    const text = 'Use JSON as now. ' + 'x'.repeat(600) + tail;
    f.service.answer({ requestId, text, optionId: 'json', expectedVersion: version }, 'operator');
    const answered = handoff();
    assert.equal(answered.host.next?.action, 'apply-input', JSON.stringify(answered.host.next));
    assert.match(answered.host.next.detail, /input_context, input_review/);
    // Ответ целиком — только в show; пакет, отчёт и журнал — без него.
    assert.equal(JSON.stringify(answered).includes(tail), false);
    assert.equal(JSON.stringify(f.store.allEvents()).includes(tail), false);
    const report = new AgentService(f.h, f.root).execute({ operation: 'value_report', input: {} });
    assert.equal(JSON.stringify(report).includes(tail), false);
    assert.equal(
      (f.service.show({ requestId }).answers.at(-1) as { text: string }).text.endsWith(tail),
      true,
    );
    void taskId;
  } finally {
    await f.cleanup();
  }
});

test('Operator mode handoff: a floor-free question is still answered by the operator; after the answer the lead prepares and the operator applies', async () => {
  const f = await inputFixture(controlled(), { approvalMode: 'operator' });
  try {
    const { requestId, version } = await question(f);
    const pending = devcontourHandoff(f.h, {});
    assert.equal(pending.host.next?.action, 'answer-input');
    assert.match(pending.host.next.detail, /operator's answer/);
    f.service.answer({ requestId, text: 'Use JSON.', expectedVersion: version }, 'operator');
    const answered = devcontourHandoff(f.h, {});
    assert.equal(answered.host.next?.action, 'apply-input');
    assert.match(answered.host.next.detail, /operator applies in the panel/);
  } finally {
    await f.cleanup();
  }
});

test('input_review warns when attempts of the task graph are running: apply will wait for them', async () => {
  const f = await inputFixture(controlled());
  try {
    const { boardId, requestId } = await question(f);
    const p = await prepared(f, requestId, 'lead');
    assert.equal(p.review.approved, true);
    assert.equal('warning' in p.review, false, 'в графе ничего не идёт — без предупреждения');
    // Другая задача той же доски выдана и идёт.
    const other = f.plainTask(boardId, 'Running neighbour');
    f.h.approve(boardId);
    // Выдача — от контура, который ведёт очередь, без её выполнения.
    const run = f.h.claim(f.scheduler.owner);
    assert.equal(run?.taskId, other);
    const again = (await new AgentService(f.h, f.root).run({
      operation: 'input_review',
      input: { requestId, contextDigest: p.context.contextDigest, authorRuntime: 'codex' },
    })) as { round: number; activeAttempts?: unknown; warning: string };
    // Повтор того же снимка — тот же раунд без вызова модели, но с предупреждением.
    assert.equal(again.round, p.review.round);
    assert.deepEqual(again.activeAttempts, [{ id: run.id, taskId: other }]);
    assert.match(again.warning, /идут попытки/);
    assert.match(again.warning, new RegExp(run.id));
    // Предупреждение верно: применение ждёт идущую попытку графа.
    const target = f.service.target({ requestId, contextDigest: p.context.contextDigest });
    const applied = new AgentService(f.h, f.root).execute({
      operation: 'input_apply',
      input: { ...p.apply, expectedVersion: target.version, targetDigest: target.targetDigest },
    });
    assert.equal(applied.applied, false);
    assert.deepEqual(applied.active, [{ id: run.id, workId: other }]);
  } finally {
    await f.cleanup();
  }
});

test('Ревью ответа исполнителю: с hintLocale ru ревьюер пишет текст по-русски, без него и с en промпт байтово прежний', async () => {
  const [line] = reviewLanguageInstructions('ru');
  // Ревьюер ответа записывает промпт и отказывает: ревью не закрепляется, и
  // каждый вызов — тот же раунд того же снимка; меняется только язык.
  const prompts: string[] = [];
  const runtimes = controlled();
  const demo = runtimes.demo;
  runtimes.demo = {
    ...demo,
    execute: (request) => {
      if (!request.review || request.task?.id) return demo.execute(request);
      prompts.push(request.prompt);
      return Promise.reject(new Error('Fixture reviewer refuses; no provider called'));
    },
  };
  const f = await inputFixture(runtimes);
  try {
    const { requestId, version } = await question(f);
    f.service.answer(
      { requestId, text: 'Use JSON as now.', optionId: 'json', expectedVersion: version },
      'lead',
    );
    const { contextDigest } = await f.service.context({ requestId });
    const at = async (locale?: 'en' | 'ru') => {
      if (locale) f.h.config.hintLocale = locale;
      else delete f.h.config.hintLocale;
      const before = prompts.length;
      await assert.rejects(f.service.review({ requestId, contextDigest, authorRuntime: 'codex' }));
      assert.equal(prompts.length, before + 1, 'ревью ответа записано фикстурой');
      const prompt = prompts.at(-1)!;
      assert.ok(
        prompt.startsWith(`Independently review an answer to the writer's question ${requestId}`),
      );
      return prompt;
    };
    const none = await at();
    const en = await at('en');
    const ru = await at('ru');
    assert.equal(en, none);
    assert.ok(!none.includes('Language:'));
    assert.ok(ru.includes(line + '\n\n'), 'указание языка в промпте');
    assert.equal(ru.replace(line + '\n\n', ''), en);
  } finally {
    await f.cleanup();
  }
});
