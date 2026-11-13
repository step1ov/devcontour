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
import { resumeBadge, resumeText } from '../src/core/input-labels.ts';
import { panelSummary } from '../src/application/panel.ts';
import { executionOf } from '../src/harness/execution.ts';
import type { AgentAdapter } from '../src/runner/adapters.ts';

after(() => inputDemos.close());

/** Такт цикла ведущего и окончание начатых им полётов прохода. */
const tick = async (lead: LeadRunner) => {
  await lead.tick();
  await lead.settled();
};

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
    await tick(lead);
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
    // (Код `apply-auto` без задания доски — во втором тесте.)
    const step = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(step.action, 'wait', JSON.stringify(step));
    assert.notEqual(step.code, 'apply-saved');

    await tick(lead);
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
    // Применение — событие ведущего (актёр agent) с происхождением: проход сервера.
    const journal = events(f, 'input.applied');
    assert.equal(journal.length, 1);
    assert.equal(journal[0].origin, 'server');
    assert.equal(journal[0].trigger, 'operator-answer');

    await f.scheduler.drain();
    await tick(lead);
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
    await tick(lead);
    f.service.answerInTask(taskId, requestId, {
      text: 'Return XML instead.',
      expectedVersion: version,
    });
    // Без задания доски шаг ведущего — ожидание прохода (apply-auto).
    const step = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(step.code, 'apply-auto', JSON.stringify(step));
    assert.equal(step.action, 'wait');
    assert.match(step.detail, /Do not run them yourself/);
    await tick(lead);
    const r = f.service.list({ taskId }).requests[0];
    assert.equal(r.state, 'review-rejected');
    assert.equal(r.actor, 'operator', 'исправляет оператор');
    assert.equal(resumeRecord(f.h, requestId)!.phase, 'rejected');
    assert.equal(events(f, 'input.resume')[0].authorRuntime, 'claude', 'автор — из утверждения');
    assert.equal(events(f, 'input.resume')[0].authorSource, 'task-approval');
    await tick(lead);
    assert.equal(reviews(prompts), 1, 'отклонённый ответ повторно не проверяется');

    approve = true;
    f.service.answerInTask(taskId, requestId, {
      text: 'Keep JSON as now.',
      optionId: 'json',
      expectedVersion: f.service.show({ requestId }).version,
    });
    assert.equal(f.service.list({ taskId }).requests[0].resume?.phase, 'pending');
    await tick(lead);
    // Новый ответ — новый проход: второй раунд ревью по новой ревизии.
    // (Исход раунда — правило движка: открытая находка прошлого раунда
    // должна быть закрыта ревьюером, fixture её не закрывает.)
    assert.equal(reviews(prompts), 2);
    const second = resumeRecord(f.h, requestId)!;
    assert.equal(second.revision, 2);
    assert.equal(second.reviews, 1);
    await tick(lead);
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
    await tick(lead);
    f.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    await tick(lead);
    let r = f.service.list({ taskId }).requests[0];
    assert.equal(r.resume?.phase, 'retry', JSON.stringify(r.resume));
    assert.equal(r.resume?.auto, true);
    assert.match(r.resume?.detail ?? '', /fixture reviewer is down/);
    // Пауза повтора: такт до её конца ревью не начинает.
    await tick(lead);
    assert.equal(calls, 1);
    const due = () =>
      f.store.atomic(() => {
        const rec = f.store.localRecord<ResumeRecord>(RESUME, undefined, requestId)!;
        f.store.saveLocal(RESUME, undefined, requestId, { ...rec, notBefore: 0 });
      });
    // Пауза повтора: 30 с, затем 60 с.
    const gap = () => {
      const rec = resumeRecord(f.h, requestId)!;
      return Math.round((rec.notBefore! - Date.parse(rec.at)) / 1000);
    };
    assert.equal(gap(), 30);
    for (let i = 1; i < RESUME_REVIEWS; i++) {
      due();
      await tick(lead);
      if (i === 1) assert.equal(gap(), 60);
    }
    assert.equal(calls, RESUME_REVIEWS);
    due();
    await tick(lead);
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

test('A lead answer is the lead own chain; requirement changes and operator mode are not driven', async () => {
  const prompts: string[] = [];
  const runtimes = controlled({ prompts });
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    f.service.answer(
      { requestId, text: 'Keep JSON.', optionId: 'json', expectedVersion: version },
      'lead',
    );
    await tick(lead);
    await tick(lead);
    const r = f.service.list({ taskId }).requests[0];
    assert.equal(r.resume, undefined, 'свой ответ ведущий доводит сам');
    assert.equal(r.next, 'input_context, then input_review, input_target, input_apply');
    assert.equal(reviews(prompts), 0);

    // Изменение требований от оператора — новая постановка: проход его не ведёт.
    f.service.answerInTask(taskId, requestId, {
      text: 'Return XML: change the acceptance.',
      kind: 'requirement-change',
      expectedVersion: f.service.show({ requestId }).version,
    });
    await tick(lead);
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
    await tick(lead);
    g.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    await tick(lead);
    const r = g.service.list({ taskId }).requests[0];
    assert.equal(r.state, 'answer-saved');
    assert.equal(r.resume, undefined, 'режим operator моделей сам не вызывает');
    assert.equal(reviews(prompts), 0);
  } finally {
    await g.cleanup();
  }
});

test('An operator pause holds the pass with no model call; the board names the phase; lifting the pause continues', async () => {
  const prompts: string[] = [];
  const runtimes = controlled({ critical: true, prompts });
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    f.h.pause(true);
    f.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    await tick(lead);
    await tick(lead);
    const r = f.service.list({ taskId }).requests[0];
    assert.equal(r.state, 'answer-saved');
    assert.deepEqual(r.resume, {
      phase: 'paused',
      auto: true,
      trigger: 'operator',
      detail: 'operator',
    });
    assert.match(resumeText(r.resume), /^Ответ принят — продолжу после снятия паузы/);
    assert.equal(reviews(prompts), 0, 'на паузе оператора моделей нет');
    // Доска: метка фазы прохода вместо «Ждёт ответа».
    const summary = panelSummary(f.h, f.root, { board: boardId }) as unknown as {
      tasks: { id: string; inputResume?: { phase: string } }[];
    };
    assert.equal(summary.tasks.find((t) => t.id === taskId)?.inputResume?.phase, 'paused');
    assert.equal(resumeBadge(r.resume), 'Ответ принят: после паузы');

    f.h.pause(false);
    await tick(lead);
    assert.equal(reviews(prompts), 1);
    assert.equal(f.service.list({ taskId }).requests[0].state, 'applied-awaiting-claim');
  } finally {
    await f.cleanup();
  }
});

test('Any pause holds the pass first: a runtime pause with a due retry calls no reviewer', async () => {
  const base = controlled({ critical: true });
  let calls = 0;
  const runtimes: Record<string, AgentAdapter> = {
    ...base,
    demo: {
      ...base.demo,
      execute: (request) => {
        if (request.review && !request.task?.id) {
          calls++;
          return Promise.reject(new Error('fixture quota exhausted'));
        }
        return base.demo.execute(request);
      },
    } satisfies AgentAdapter,
  };
  const f = await inputFixture(runtimes);
  try {
    // Без задания доски: паузы снимает только тест (цикл задания снял бы
    // паузу остановки сам).
    const { taskId, requestId, version } = await question(f);
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    f.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    await tick(lead);
    assert.equal(calls, 1);
    for (const reason of ['runtime', 'reconfigure', 'shutdown'] as const) {
      f.store.change('fixture.pause', (s) => {
        s.paused = true;
        s.pauseReason = reason;
      });
      f.store.atomic(() => {
        const rec = f.store.localRecord<ResumeRecord>(RESUME, undefined, requestId)!;
        f.store.saveLocal(RESUME, undefined, requestId, { ...rec, notBefore: 0 });
      });
      await tick(lead);
      await tick(lead);
      const r = f.service.list({ taskId }).requests[0];
      assert.equal(r.resume?.phase, 'paused', reason);
      assert.equal(r.resume?.detail, reason);
      assert.equal(calls, 1, `на паузе ${reason} ревьюер не вызывается`);
    }
  } finally {
    await f.cleanup();
  }
});

test('Author runtime: task approval before the board job, journaled with its source; unknown in live mode — needs-lead; the reviewer is another vendor', async () => {
  const runtimes = controlled({ critical: true });
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    const task = () => f.store.read().tasks.find((t) => t.id === taskId)!;
    const { resumeAuthor } = await import('../src/application/input-resume.ts');
    const { technicalReviewer } = await import('../src/harness/policy.ts');
    // Без утверждения ведущим и задания: в учебном режиме — учебный ревьюер,
    // в живом — ведущий нужен (автор не угадывается по чужим доскам).
    assert.deepEqual(resumeAuthor(f.h, task(), boardId), { runtime: 'codex', source: 'demo' });
    const live = { ...f.h.config, mode: 'local' } as typeof f.h.config;
    const inLive = <T>(fn: () => T) => {
      const config = f.h.config as { mode: string };
      const mode = config.mode;
      config.mode = 'local';
      try {
        return fn();
      } finally {
        config.mode = mode;
      }
    };
    assert.equal(
      inLive(() => resumeAuthor(f.h, task(), boardId)),
      undefined,
    );
    const other = f.askingTask('Other board');
    new LeadWorkflow(f.h).start({ kind: 'board', id: other.boardId, authorRuntime: 'claude' });
    assert.equal(
      inLive(() => resumeAuthor(f.h, task(), boardId)),
      undefined,
      'задание другой доски автора не решает',
    );
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'claude' });
    assert.deepEqual(resumeAuthor(f.h, task(), boardId), {
      runtime: 'claude',
      source: 'board-job',
    });
    f.store.change('fixture.approval', (s) => {
      s.tasks.find((t) => t.id === taskId)!.approval = { actor: 'agent', authorRuntime: 'codex' };
    });
    const author = resumeAuthor(f.h, task(), boardId)!;
    assert.deepEqual(author, { runtime: 'codex', source: 'task-approval' });
    // Правило вендора живой политики: ревьюер — другой рантайм, чем автор.
    for (const runtime of ['codex', 'claude'] as const)
      assert.notEqual(technicalReviewer(live, 'plan', runtime)?.runtime, runtime);

    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    f.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    await tick(lead);
    const started = events(f, 'input.resume').find((e) => e.phase === 'reviewing')!;
    assert.equal(started.authorRuntime, 'codex');
    assert.equal(started.authorSource, 'task-approval');
    assert.deepEqual(resumeRecord(f.h, requestId)!.author, author);
  } finally {
    await f.cleanup();
  }
});

test('Reviews run as flights: the lead tick does not wait for them; at most two at once of three answers', async () => {
  const base = controlled({ critical: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started = 0;
  const runtimes: Record<string, AgentAdapter> = {
    ...base,
    demo: {
      ...base.demo,
      execute: async (request) => {
        if (request.review && !request.task?.id) {
          started++;
          await gate;
        }
        return base.demo.execute(request);
      },
    } satisfies AgentAdapter,
  };
  const f = await inputFixture(runtimes);
  try {
    const qs = [await question(f), await question(f), await question(f)];
    new LeadWorkflow(f.h).start({ kind: 'board', id: qs[0].boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    for (const q of qs)
      f.service.answerInTask(q.taskId, q.requestId, {
        text: 'Keep JSON.',
        expectedVersion: q.version,
      });
    // Такт возвращается, пока ревью ждут reviewer; третье — после них.
    await lead.tick();
    for (let i = 0; i < 50 && started < 2; i++) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 3; i++) await lead.tick();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(started, 2, 'не больше двух ревью одновременно');
    release();
    await lead.settled();
    for (let i = 0; i < 3; i++) await tick(lead);
    assert.equal(started, 3);
    for (const q of qs)
      assert.equal(
        f.service.list({ taskId: q.taskId }).requests[0].state,
        'applied-awaiting-claim',
      );
  } finally {
    release();
    await f.cleanup();
  }
});

test('Active attempts on the board: the pass waits by a read-only check, one journal entry, then applies', async () => {
  const prompts: string[] = [];
  const runtimes = controlled({ critical: true, prompts });
  const f = await inputFixture(runtimes);
  const { InputService } = await import('../src/application/input.ts');
  const proto = InputService.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'activeInGraph')!;
  let active = true;
  // Идущая попытка доски — подмена чтения (настоящая попытка demo кончается сразу).
  Object.defineProperty(proto, 'activeInGraph', {
    configurable: true,
    value(this: InstanceType<typeof InputService>, taskId: string) {
      return active
        ? [{ id: 'R-fixture', taskId }]
        : (original.value as (id: string) => unknown[]).call(this, taskId);
    },
  });
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    f.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    const applies = () => events(f, 'input.applied').length;
    for (let i = 0; i < 5; i++) await tick(lead);
    assert.equal(f.service.list({ taskId }).requests[0].resume?.phase, 'waiting-active');
    assert.equal(applies(), 0, 'перепроверка — без применения и журнала');
    assert.equal(events(f, 'input.resume').filter((e) => e.phase === 'waiting-active').length, 1);
    assert.equal(reviews(prompts), 1);
    // Попытки кончились: срок перепроверки подошёл — ответ применяется.
    active = false;
    (lead.resumer as unknown as { rechecks: Map<string, unknown> }).rechecks.clear();
    f.store.atomic(() => f.store.saveLocal('fixture', undefined, 'bump', Date.now()));
    await tick(lead);
    assert.equal(f.service.list({ taskId }).requests[0].state, 'applied-awaiting-claim');
    assert.equal(applies(), 1);
    assert.equal(reviews(prompts), 1, 'повторного ревью нет');
  } finally {
    Object.defineProperty(proto, 'activeInGraph', original);
    await f.cleanup();
  }
});

test('A leftover reviewing record at the limit stops the pass with a lead card; without the server heartbeat the lead chain is back', async () => {
  const runtimes = controlled({ critical: true });
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    // Процесс трижды обрывался посреди ревью: запись — «идёт», срок истёк.
    const answered = f.service.answerInTask(taskId, requestId, {
      text: 'Keep JSON.',
      expectedVersion: version,
    });
    const digest = f.service.show({ requestId }).answers.at(-1)!.digest;
    f.store.atomic(() =>
      f.store.saveLocal(RESUME, undefined, requestId, {
        requestId,
        taskId,
        answerDigest: digest,
        revision: 1,
        trigger: 'operator',
        phase: 'reviewing',
        reviews: RESUME_REVIEWS,
        at: new Date(0).toISOString(),
        leaseUntil: 0,
      } satisfies ResumeRecord),
    );
    assert.ok(answered.messageId);
    await tick(lead);
    const r = f.service.list({ taskId }).requests[0];
    // Прерванное ревью на пределе — остановка прохода, а не «идёт» навсегда.
    assert.equal(r.resume?.phase, 'failed');
    assert.equal(r.resume?.auto, false);
    assert.match(r.next, /could not review the answer automatically/);
    const card = (await new AttentionService(f.store, f.h, { root: f.root }).active()).items.find(
      (c) => c.sourceKey === `input:${requestId}`,
    );
    assert.ok(card, 'карточка ведущего на пределе');
    // Сервер ушёл (отметка снята): цепочку снова ведёт ведущий.
    lead.halt();
    const after = f.service.list({ taskId }).requests[0];
    assert.equal(after.resume, undefined);
    assert.equal(after.next, 'input_context, then input_review, input_target, input_apply');
  } finally {
    await f.cleanup();
  }
});

test('A lead apply of its own answer carries no server origin', async () => {
  const runtimes = controlled();
  const f = await inputFixture(runtimes);
  try {
    const { taskId, requestId, version } = await question(f);
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    f.service.answer(
      { requestId, text: 'Keep JSON.', optionId: 'json', expectedVersion: version },
      'lead',
    );
    await tick(lead);
    assert.equal(f.service.list({ taskId }).requests[0].resume, undefined);
    // Применение ведущим — без происхождения прохода сервера.
    const context = await f.service.context({ requestId });
    await f.service.review({
      requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    const leadApplied = f.service.apply(
      {
        requestId,
        answerDigest: context.answerDigest,
        expectedVersion: target.version,
        contextDigest: context.contextDigest,
        targetDigest: target.targetDigest!,
      },
      'lead',
    );
    assert.equal(leadApplied.applied, true);
    const own = events(f, 'input.applied');
    assert.equal(own.length, 1);
    assert.equal(own[0].origin, undefined);
    assert.equal(own[0].trigger, undefined);
  } finally {
    await f.cleanup();
  }
});

test('A held review lease: the pass waits by a read-only check with no record or journal, then reviews once', async () => {
  const prompts: string[] = [];
  const runtimes = controlled({ critical: true, prompts });
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    // Ревью этого ответа ведёт ведущий (аренда другого процесса).
    f.store.atomic(() =>
      f.store.saveLocal('input-review-lease', undefined, requestId, {
        token: 'fixture-lead',
        startedAt: new Date().toISOString(),
        leaseUntil: Date.now() + 600_000,
      }),
    );
    f.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    for (let i = 0; i < 5; i++) await tick(lead);
    assert.equal(reviews(prompts), 0);
    assert.equal(events(f, 'input.resume').length, 0, 'журнал — только о настоящем ревью');
    assert.equal(resumeRecord(f.h, requestId), undefined);
    // Аренда снята, срок перепроверки подошёл: одно ревью и применение.
    f.store.atomic(() => f.store.deleteLocal('input-review-lease', undefined, requestId));
    (lead.resumer as unknown as { rechecks: Map<string, unknown> }).rechecks.clear();
    await tick(lead);
    assert.equal(reviews(prompts), 1);
    assert.equal(f.service.list({ taskId }).requests[0].state, 'applied-awaiting-claim');
  } finally {
    await f.cleanup();
  }
});

test('A new operator answer during a running review: the old answer is not applied, the new one gets its own pass', async () => {
  const prompts: string[] = [];
  const base = controlled({ critical: true, prompts });
  let release!: () => void;
  let gate = new Promise<void>((resolve) => (release = resolve));
  const runtimes: Record<string, AgentAdapter> = {
    ...base,
    demo: {
      ...base.demo,
      execute: async (request) => {
        if (request.review && !request.task?.id) await gate;
        return base.demo.execute(request);
      },
    } satisfies AgentAdapter,
  };
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId, requestId, version } = await question(f);
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await tick(lead);
    f.service.answerInTask(taskId, requestId, { text: 'First answer.', expectedVersion: version });
    await lead.tick();
    for (let i = 0; i < 50 && resumeRecord(f.h, requestId)?.phase !== 'reviewing'; i++)
      await new Promise((r) => setTimeout(r, 20));
    f.service.answerInTask(taskId, requestId, {
      text: 'Second answer.',
      optionId: 'json',
      expectedVersion: f.service.show({ requestId }).version,
    });
    release();
    await lead.settled();
    gate = Promise.resolve();
    for (let i = 0; i < 3; i++) await tick(lead);
    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'applied-awaiting-claim', JSON.stringify(shown.resume));
    const second = shown.answers.at(-1)!;
    assert.equal(second.revision, 2);
    assert.equal(shown.target?.answerDigest, second.digest, 'применён второй ответ');
    assert.equal(events(f, 'input.applied').length, 1);
    assert.equal(resumeRecord(f.h, requestId)!.revision, 2);
  } finally {
    release();
    await f.cleanup();
  }
});

test('A shutdown abort during a review gives the attempt back', async () => {
  const base = controlled({ critical: true });
  let entered = false;
  const runtimes: Record<string, AgentAdapter> = {
    ...base,
    demo: {
      ...base.demo,
      execute: async (request) => {
        if (request.review && !request.task?.id) {
          entered = true;
          await new Promise<void>((_, reject) =>
            request.signal.addEventListener('abort', () => reject(new Error('aborted'))),
          );
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
    await tick(lead);
    f.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
    await lead.tick();
    for (let i = 0; i < 100 && !entered; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(entered);
    assert.equal(resumeRecord(f.h, requestId)!.reviews, 1, 'учтено до вызова');
    await lead.stop();
    const rec = resumeRecord(f.h, requestId)!;
    assert.equal(rec.phase, 'failed');
    assert.equal(rec.reviews, 0, 'обрыв без раунда не считается');
    assert.equal(f.service.list({ taskId }).requests[0].resume, undefined, 'сервера нет');
  } finally {
    await f.cleanup();
  }
});

/**
 * Применение устаревает до выдачи (движок, `staleTargets`): запрос снова
 * `answered`, без цели, с причиной. В fixture причину не вызвать без смены
 * политики исполнения, поэтому тест пишет ровно ту запись, что движок.
 */
function staleApplied(f: InputFixture, requestId: string, reason: 'policy' | 'context') {
  const { store, engine } = executionOf(f.h);
  const r = engine.inputRequest(requestId);
  const owner = f.store.read().tasks.find((t) => t.id === r.workId)!.repositoryId;
  const { target, ...rest } = r;
  store.transact('run.context', (tx) =>
    tx.putLocal('input-requests', owner, r.id, {
      ...rest,
      lifecycle: 'answered',
      stale: { targetDigest: target!.digest, reason, at: new Date().toISOString() },
      version: r.version + 1,
    }),
  );
}

for (const reason of ['policy', 'context'] as const)
  test(`A stale apply (${reason}): the approved round of the same answer covers it; no second paid review, no counted attempt`, async () => {
    const prompts: string[] = [];
    const runtimes = controlled({ critical: true, prompts });
    const f = await inputFixture(runtimes);
    try {
      const { taskId, boardId, requestId, version } = await question(f);
      new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
      const lead = new LeadRunner(f.h, f.root, runtimes);
      await tick(lead);
      // Пауза ведущего держит выдачу, но не проход: ответ применяется, попытки нет.
      f.h.pause(true, 'operator', 'lead');
      f.service.answerInTask(taskId, requestId, { text: 'Keep JSON.', expectedVersion: version });
      await tick(lead);
      assert.equal(f.service.list({ taskId }).requests[0].state, 'applied-awaiting-claim');
      assert.equal(reviews(prompts), 1);
      staleApplied(f, requestId, reason);
      assert.equal(f.service.show({ requestId }).state, 'stale');
      await tick(lead);
      await tick(lead);
      const after = f.service.show({ requestId });
      assert.equal(after.state, 'applied-awaiting-claim', JSON.stringify(after.resume));
      // `policy`: раунд покрывает ответ — ревью не нужно. `context`: снимок
      // строится заново, но он тот же — раунд повторно используется, вызова
      // модели нет, и попытка ревью не засчитана.
      assert.equal(reviews(prompts), 1, 'второго вызова ревьюера нет');
      assert.equal(resumeRecord(f.h, requestId)!.reviews, 1);
      assert.equal(events(f, 'input.applied').length, 2);
    } finally {
      await f.cleanup();
    }
  });
