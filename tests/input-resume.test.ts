// Продолжение после ответа без сессии ведущего (режим agent): сервер в такте
// цикла ведущего сам доводит цепочку input_context → input_review →
// input_target → input_apply теми же операциями и ревьюером. Отклонённое
// ревью, сбой ревью сверх предела, изменение требований и режим operator
// остаются людям и ведущему. Модели не вызываются: demo-исполнитель и
// управляемый reviewer ответа.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlled,
  inputDemos,
  inputFixture,
  untilQuestion,
  type InputFixture,
} from './input-fixture.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { AttentionService } from '../src/application/attention.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import {
  RESUME,
  RESUME_REVIEWS,
  resumeRecord,
  type ResumeRecord,
} from '../src/application/input-resume.ts';
import { resumeText } from '../src/core/input-labels.ts';
import type { AgentAdapter } from '../src/runner/adapters.ts';

after(() => inputDemos.close());

/** Ревью ответа (вызовы reviewer без задачи) из записанных подсказок. */
const reviews = (prompts: string[]) =>
  prompts.filter((p) => p.startsWith('review:') && p.includes('Independently review an answer'))
    .length;

async function question(f: InputFixture) {
  const { taskId, boardId } = f.askingTask();
  await untilQuestion(f, boardId);
  const [request] = f.service.list({ taskId }).requests;
  return { taskId, boardId, requestId: request.requestId, version: request.version };
}

const events = (f: InputFixture, type: string) =>
  f.store
    .allEvents()
    .filter((e) => e.type === type)
    .map((e) => (e as unknown as { data: Record<string, unknown> }).data);

test('Operator answers a critical question with no lead session: the server reviews and applies it, the task continues to done', async () => {
  const prompts: string[] = [];
  const runtimes = controlled({ critical: true, prompts });
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    assert.deepEqual(f.service.show({ requestId }).floors, ['declared']);
    // Задание доски ждёт ответа; сессии ведущего нет.
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await lead.tick();
    f.service.answerInTask(taskId, requestId, {
      text: 'Keep JSON as now.',
      optionId: 'json',
      expectedVersion: version,
    });
    // До такта: ответ принят, DevContour продолжает — ни ведущему, ни
    // оператору делать нечего.
    const pending = f.service.list({ taskId }).requests[0];
    assert.equal(pending.state, 'answer-saved');
    assert.deepEqual(pending.resume, { phase: 'pending', auto: true, trigger: 'operator' });
    assert.match(pending.next, /DevContour continues on the server/);
    assert.match(resumeText(pending.resume), /^Ответ принят — DevContour продолжает/);
    const cards = (await new AttentionService(f.store, f.h, { root: f.root }).active()).items;
    assert.equal(
      cards.find((c) => c.sourceKey === `input:${requestId}`),
      undefined,
      'идущий проход — не действие',
    );
    // Шаг ведущего — ждать (проход или живое задание доски), а не цепочка.
    const step = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(step.action, 'wait', JSON.stringify(step));
    assert.notEqual(step.code, 'apply-saved');
    if (step.code === 'apply-auto') assert.match(step.detail, /Do not run them yourself/);

    await lead.tick();
    const applied = f.service.list({ taskId }).requests[0];
    assert.equal(applied.state, 'applied-awaiting-claim', JSON.stringify(applied));
    assert.equal(applied.resume, undefined);
    assert.equal(reviews(prompts), 1, 'одно ревью ответа');
    const record = resumeRecord(f.h, requestId)!;
    assert.equal(record.phase, 'applied');
    assert.equal(record.trigger, 'operator');
    const log = events(f, 'input.resume');
    assert.deepEqual(
      log.map((e) => [e.phase, e.trigger]),
      [
        ['reviewing', 'operator'],
        ['applied', 'operator'],
      ],
    );
    assert.equal(log[0].authorRuntime, 'codex');
    // Применение — обычное событие ведущего (актёр agent).
    assert.equal(events(f, 'input.applied').length, 1);

    await f.scheduler.drain();
    await lead.tick();
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'done');
    assert.equal(reviews(prompts), 1, 'повторных ревью нет');
  } finally {
    await f.cleanup();
  }
});

test('Without a board job the task approval names the author; a rejected review stops the pass for the operator, a new answer restarts it', async () => {
  let approve = false;
  const prompts: string[] = [];
  const approving = controlled({ critical: true, prompts });
  const rejecting = controlled({ critical: true, prompts, verdict: { approve: false } });
  // Ревью ответа ведёт reviewer demo-политики: вердикт переключается тестом.
  const runtimes: Record<string, AgentAdapter> = {
    ...approving,
    demo: {
      ...approving.demo,
      execute: (request) => (approve ? approving : rejecting).demo.execute(request),
    } satisfies AgentAdapter,
  };
  const f = await inputFixture(runtimes);
  try {
    const { taskId, requestId, version } = await question(f);
    // Утверждение ведущим называет рантайм автора (как у review-plan).
    f.store.change('fixture.approval', (s) => {
      s.tasks.find((t) => t.id === taskId)!.approval = { actor: 'agent', authorRuntime: 'claude' };
    });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await lead.tick();
    f.service.answerInTask(taskId, requestId, {
      text: 'Return XML instead.',
      expectedVersion: version,
    });
    await lead.tick();
    const r = f.service.list({ taskId }).requests[0];
    assert.equal(r.state, 'review-rejected');
    assert.equal(r.actor, 'operator', 'исправляет оператор');
    assert.equal(resumeRecord(f.h, requestId)!.phase, 'rejected');
    assert.equal(events(f, 'input.resume')[0].authorRuntime, 'claude', 'автор — из утверждения');
    await lead.tick();
    assert.equal(reviews(prompts), 1, 'отклонённый ответ повторно не проверяется');

    approve = true;
    f.service.answerInTask(taskId, requestId, {
      text: 'Keep JSON as now.',
      optionId: 'json',
      expectedVersion: f.service.show({ requestId }).version,
    });
    assert.equal(f.service.list({ taskId }).requests[0].resume?.phase, 'pending');
    await lead.tick();
    // Новый ответ — новый проход: второй раунд ревью по новой ревизии.
    // (Исход раунда — правило движка: открытая находка прошлого раунда
    // должна быть закрыта ревьюером, fixture её не закрывает.)
    assert.equal(reviews(prompts), 2);
    const second = resumeRecord(f.h, requestId)!;
    assert.equal(second.revision, 2);
    assert.equal(second.reviews, 1);
    await lead.tick();
    assert.equal(reviews(prompts), 2, 'исход второго ответа повторно не проверяется');
  } finally {
    await f.cleanup();
  }
});

test('A failing review is retried with back-off and stops after the limit: the lead is named with the cause', async () => {
  const base = controlled({ critical: true });
  let calls = 0;
  const runtimes: Record<string, AgentAdapter> = {
    ...base,
    demo: {
      ...base.demo,
      execute: (request) => {
        if (request.review && !request.task?.id) {
          calls++;
          return Promise.reject(new Error('fixture reviewer is down'));
        }
        return base.demo.execute(request);
      },
    } satisfies AgentAdapter,
  };
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await lead.tick();
    f.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    await lead.tick();
    let r = f.service.list({ taskId }).requests[0];
    assert.equal(r.resume?.phase, 'retry', JSON.stringify(r.resume));
    assert.equal(r.resume?.auto, true);
    assert.match(r.resume?.detail ?? '', /fixture reviewer is down/);
    // Пауза повтора: такт до её конца ревью не начинает.
    await lead.tick();
    assert.equal(calls, 1);
    const due = () =>
      f.store.atomic(() => {
        const rec = f.store.localRecord<ResumeRecord>(RESUME, undefined, requestId)!;
        f.store.saveLocal(RESUME, undefined, requestId, { ...rec, notBefore: 0 });
      });
    for (let i = 1; i < RESUME_REVIEWS; i++) {
      due();
      await lead.tick();
    }
    assert.equal(calls, RESUME_REVIEWS);
    due();
    await lead.tick();
    assert.equal(calls, RESUME_REVIEWS, 'сверх предела вызова нет');
    r = f.service.list({ taskId }).requests[0];
    assert.equal(r.resume?.phase, 'failed');
    assert.equal(r.resume?.auto, false);
    assert.match(r.next, /could not review the answer automatically/);
    const step = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(step.action, 'apply-input');
    assert.equal(step.code, 'apply-auto');
    // Карточка ведущего называет остановку прохода.
    const card = (await new AttentionService(f.store, f.h, { root: f.root }).active()).items.find(
      (c) => c.sourceKey === `input:${requestId}`,
    );
    assert.ok(card);
    assert.match(card.title, /DevContour не может продолжить сам/);
    assert.match(card.reason, /DevContour не смог проверить ответ/);
  } finally {
    await f.cleanup();
  }
});

test('A lead answer waits for the grace period; requirement changes and operator mode are not driven', async () => {
  const prompts: string[] = [];
  const runtimes = controlled({ prompts });
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await lead.tick();
    f.service.answer(
      { requestId, text: 'Keep JSON.', optionId: 'json', expectedVersion: version },
      'lead',
    );
    await lead.tick();
    const r = f.service.list({ taskId }).requests[0];
    assert.equal(r.resume?.phase, 'grace');
    assert.equal(r.resume?.trigger, 'lead');
    assert.equal(reviews(prompts), 0, 'живой ведущий доводит свой ответ сам');
    assert.match(resumeText(r.resume), /Ответ ведущего принят/);

    // Изменение требований — новая постановка: проход его не ведёт.
    f.service.answer(
      {
        requestId,
        text: 'Return XML: change the acceptance.',
        kind: 'requirement-change',
        expectedVersion: f.service.show({ requestId }).version,
      },
      'lead',
    );
    await lead.tick();
    const changed = f.service.list({ taskId }).requests[0];
    assert.equal(changed.resume?.phase, 'needs-lead');
    assert.equal(changed.resume?.detail, 'requirement-change');
    assert.equal(reviews(prompts), 0);
  } finally {
    await f.cleanup();
  }
  const g = await inputFixture(runtimes, { approvalMode: 'operator' });
  try {
    const { taskId, requestId, version } = await question(g);
    const lead = new LeadRunner(g.h, g.root, runtimes);
    await lead.tick();
    g.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    await lead.tick();
    const r = g.service.list({ taskId }).requests[0];
    assert.equal(r.state, 'answer-saved');
    assert.equal(r.resume, undefined, 'режим operator моделей сам не вызывает');
    assert.equal(reviews(prompts), 0);
  } finally {
    await g.cleanup();
  }
});
