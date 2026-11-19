// Маршрут contract-change отклонённого ответа (F83): ответ на вопрос о
// контракте — последовательный выбор, единственный конфликт которого —
// явная поправка закреплённого контракта. Ревью называет маршрут правилом
// находки `contract-change:<ID>`; вопрос переходит в состояние
// `contract-change-required` — ход ведущего, а не повторный ответ
// оператора. После перепривязки операцией contract-change и нового
// утверждения тот же ответ проходит ревью на новой редакции без нового
// ответа. Модели не вызываются: demo-исполнитель и управляемый reviewer.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, type InputFixture } from './input-fixture.ts';
import { DEMO_ASK, type AgentAdapter } from '../src/runner/adapters.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { AttentionService } from '../src/application/attention.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { executionOf } from '../src/harness/execution.ts';
import { repositories } from '../src/core/repositories.ts';
import type { ContractChangeTrace } from '../src/application/input-rebound.ts';
import type { ContractChange } from '../src/runner/contract-change.ts';
import {
  RESUME,
  RESUME_DRIVER,
  RESUME_REVIEWS,
  resumeRecord,
} from '../src/application/input-resume.ts';

after(() => inputDemos.close());

const source = 'docs/contracts/artifact-format.md';

type Finding = { severity: 'blocking' | 'note'; message: string; rule?: string };
type Decide = (prompt: string) => { approve: boolean; findings: Finding[] };

/**
 * Reviewer ответа без модели: вердикт решает `decide` по тексту запроса;
 * прежние открытые находки он закрывает (протокол требует назвать каждую).
 * `prompts` — запросы ревью ответа по порядку.
 */
function reviewer(decide: Decide, prompts: string[], affects: string[]) {
  const base = controlled({ affects });
  const review: AgentAdapter['execute'] = (request) => {
    prompts.push(request.prompt);
    const block = request.prompt.split('\n\n').find((p) => p.startsWith('Previous open findings'));
    const previous = block
      ? (JSON.parse(block.slice(block.indexOf('['))) as { id: string }[]).map((f) => ({
          id: f.id,
          status: 'closed' as const,
          basis: 'Fixture: the contract revision changed',
        }))
      : [];
    const verdict = decide(request.prompt);
    return Promise.resolve({
      data: {
        execution: { commands: [], noCommandsReason: 'Fixture review of an answer' },
        approved: verdict.approve,
        summary: verdict.approve ? 'Fixture: the answer clarifies' : 'Fixture: rejected',
        discoveries: [],
        findings: verdict.findings,
        previous,
      },
      log: 'Fixture only; no provider called',
      command: ['fixture'],
    });
  };
  const answerReview = (adapter: AgentAdapter): AgentAdapter => ({
    ...adapter,
    execute: (request) =>
      request.review && !request.task?.id ? review(request) : adapter.execute(request),
  });
  return {
    ...base,
    demo: answerReview(base.demo),
    codex: answerReview(base.codex),
    claude: answerReview(base.claude),
  };
}

/** ID редакций договора задачи: `v1` — при вопросе, `next` — после перепривязки. */
type Pins = { v1: string; next?: string };

/**
 * Маршрут к контракту v1, пока задача привязана ровно к нему; одобрение —
 * только на основании ровно с новой редакцией `next`; иное основание —
 * обычное отклонение (ошибка фикстуры видна, а не спрятана одобрением).
 */
const routeWhileBound =
  (pins: Pins): Decide =>
  (prompt) =>
    prompt.includes(`"contracts":["${pins.v1}"]`)
      ? {
          approve: false,
          findings: [
            {
              severity: 'blocking',
              message: 'The chosen option amends the pinned contract',
              rule: `contract-change:${pins.v1}`,
            },
          ],
        }
      : pins.next && prompt.includes(`"contracts":["${pins.next}"]`)
        ? { approve: true, findings: [] }
        : {
            approve: false,
            findings: [{ severity: 'blocking', message: 'Fixture: unexpected review basis' }],
          };

/** Задача с контрактом v1, остановленная вопросом о контракте; ответ оператора сохранён. */
async function answered(
  options: {
    decide?: (pins: Pins) => Decide;
    approvalMode?: 'agent' | 'operator';
    affects?: string[];
    paused?: boolean;
  } = {},
) {
  const prompts: string[] = [];
  const pins: Pins = { v1: '' };
  const affects = options.affects ?? ['contract', 'acceptance'];
  const runtimes = reviewer((options.decide ?? routeWhileBound)(pins), prompts, affects);
  const f = await inputFixture(
    runtimes,
    options.approvalMode ? { approvalMode: options.approvalMode } : {},
  );
  const boardId = f.h.createBoard('Contract route board').id;
  const v1 = f.h.contract('Artifact format', 'Version one.', undefined, undefined, source);
  pins.v1 = v1.id;
  const taskId = f.h.addTask(boardId, {
    title: 'Task bound to a contract asks',
    description: `An observable outcome that needs a decision ${DEMO_ASK}.`,
    role: f.store.read().tasks[0].role,
    acceptance: ['The artifact exists.'],
    contracts: [v1.id],
  }).id;
  f.h.approve(boardId);
  f.h.pause(false);
  await f.scheduler.drain();
  if (options.paused !== false) f.h.pause(true);
  const [summary] = f.service.list({ taskId }).requests;
  f.service.answer(
    {
      requestId: summary.requestId,
      text: 'Use the second option; the contract wording is amended.',
      optionId: 'json',
      expectedVersion: summary.version,
    },
    'operator',
  );
  return { f, runtimes, prompts, pins, boardId, taskId, v1, requestId: summary.requestId };
}

async function review(f: InputFixture, requestId: string) {
  const context = await f.service.context({ requestId });
  const result = await f.service.review({
    requestId,
    contextDigest: context.contextDigest,
    authorRuntime: 'codex',
  });
  return { context, result };
}

/** Новая редакция контракта и перепривязка задачи к ней (как шаг rebind). */
function rebind(f: InputFixture, taskId: string, from: string, pins?: Pins) {
  const v2 = f.h.contract('Artifact format', 'Version two.', undefined, undefined, source);
  assert.deepEqual(f.h.rebind([taskId], [from], v2.id), [taskId]);
  if (pins) pins.next = v2.id;
  return v2;
}

/** След операции изменения контракта (поля, которые читают F39 и маршрут). */
function operation(
  f: InputFixture,
  taskId: string,
  contractId: string | undefined,
  status: ContractChange['status'],
  id = 'CC-route',
  file = source,
) {
  const all = repositories(f.h.config);
  const owner = all.some((r) => r.id === 'main') ? 'main' : all[0].id;
  const record: ContractChangeTrace & Partial<ContractChange> = {
    id,
    key: `${owner}:${file}`,
    owner,
    proposal: { title: file === source ? 'Artifact format' : 'Other format', file },
    status,
    ...(contractId ? { contractId } : {}),
    rebound: contractId ? [taskId] : [],
    held: [taskId],
    boards: [],
    history: [],
    step: 0,
    startedAt: new Date().toISOString(),
    ...(['completed', 'abandoned', 'stale'].includes(status)
      ? { finishedAt: new Date().toISOString() }
      : {}),
  };
  f.store.atomic(() => f.store.saveLocal('contract-change', owner, id, record));
}

const cardOf = async (f: InputFixture, requestId: string) =>
  (await new AttentionService(f.store, f.h, { root: f.root }).active()).items.find(
    (i) => i.sourceKey === `input:${requestId}`,
  );

/** Шаг пакета передачи при идущей очереди: на паузе человека пакет называет паузу. */
const handoffStep = (f: InputFixture) => {
  f.h.pause(false);
  try {
    return devcontourHandoff(f.h, {}).host.next!;
  } finally {
    f.h.pause(true);
  }
};

const answers = (f: InputFixture, requestId: string) =>
  executionOf(f.h).engine.inputRequest(requestId).answers.length;

test('F83: a review that names the contract route makes the question the lead’s contract-change step; the operator card closes and the same answer goes through after the rebinding', async () => {
  const { f, prompts, pins, boardId, taskId, v1, requestId } = await answered();
  try {
    const { result } = await review(f, requestId);
    assert.equal(result.approved, false);
    assert.equal((result as { route?: string }).route, 'contract-change');
    assert.deepEqual((result as { contracts?: string[] }).contracts, [v1.id]);
    assert.match(result.nextStep, /contract-change --file/);
    // Правило находки названо в запросе reviewer только для вопроса о контракте.
    assert.match(prompts[0], /rule "contract-change:<contract id>"/);

    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'contract-change-required');
    assert.equal(shown.actor, 'lead');
    assert.deepEqual(
      shown.route?.contracts.map((c) => [c.id, c.source]),
      [[v1.id, source]],
    );
    assert.match(shown.next, /the operator does not answer again/);
    assert.match(shown.next, /only a completed contract-change operation/);
    assert.equal(f.service.list({ state: 'contract-change-required' }).requests.length, 1);

    // Карточка — ведущего, без «Ответить»: оператор не отвечает заново.
    const card = (await cardOf(f, requestId))!;
    assert.equal(card.actor, 'lead');
    assert.ok(!card.actions.some((a) => a.id === 'answer' || a.id === 'apply'));
    assert.match(card.title, /принят: нужно изменение контракта — ведёт ведущий/);
    assert.match(card.reason, /поправка закреплённого контракта «Artifact format»/);

    const step = handoffStep(f);
    assert.equal(step.code, 'contract-change-required');
    assert.equal(step.action, 'apply-input');
    assert.equal(step.input?.actor, 'lead');
    assert.deepEqual(step.params, {
      contracts: [v1.id],
      files: [source],
      operator: false,
      server: true,
      floors: true,
    });
    assert.match(step.detail, /devcontour contract-change --file proposal\.json/);

    // Ведущий меняет контракт: перепривязка, утверждение, завершённая операция.
    const v2 = rebind(f, taskId, v1.id, pins);
    f.h.approve(boardId, [taskId]);
    operation(f, taskId, v2.id, 'completed');
    assert.equal(f.service.show({ requestId }).state, 'answer-saved');
    const again = await review(f, requestId);
    assert.equal(again.result.approved, true);
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes(`"contracts":["${v2.id}"]`), 'второе ревью — на новой редакции');
    const target = f.service.target({ requestId, contextDigest: again.context.contextDigest });
    assert.deepEqual(target.problems, []);
    assert.equal((target as { rebound?: boolean }).rebound, true);
    const applied = f.service.apply(
      {
        requestId,
        answerDigest: target.answerDigest!,
        expectedVersion: target.version,
        contextDigest: again.context.contextDigest,
        targetDigest: target.targetDigest!,
      },
      'lead',
    );
    assert.equal(applied.applied, true);
    assert.equal(answers(f, requestId), 1, 'оператор не отвечал заново');
  } finally {
    await f.cleanup();
  }
});

test('F83: with a running server the pass stops at the contract route without another review, and after the completed operation reviews and applies the same answer itself', async () => {
  const { f, runtimes, prompts, pins, boardId, taskId, v1, requestId } = await answered({
    paused: false,
  });
  try {
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    const ticks = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await lead.tick();
        await lead.settled();
      }
    };
    await ticks(3);
    assert.equal(prompts.length, 1, 'проход провёл одно ревью');
    const summary = f.service.list({ taskId }).requests[0];
    assert.equal(summary.state, 'contract-change-required');
    assert.equal(summary.resume, undefined, 'маршрут — не фаза прохода');
    assert.equal(summary.actor, 'lead');
    await ticks(2);
    assert.equal(prompts.length, 1, 'до изменения контракта ревью не повторяется');
    // Предел ревью прохода исчерпан прежними попытками по старому основанию:
    // ревью на новой редакции — новое основание, а не повтор.
    const record = resumeRecord(f.h, requestId)!;
    assert.equal(record.phase, 'rejected');
    f.store.atomic(() =>
      f.store.saveLocal(RESUME, undefined, requestId, { ...record, reviews: RESUME_REVIEWS }),
    );
    const digestBefore = executionOf(f.h).engine.inputRequest(requestId).answers[0].digest;

    // Перепривязка идёт (операция не завершена): ход ведущего, без ревью.
    const v2 = rebind(f, taskId, v1.id, pins);
    operation(f, taskId, v2.id, 'running');
    const waiting = f.service.show({ requestId });
    assert.equal(waiting.state, 'contract-change-required');
    assert.equal(waiting.route?.waiting, true);
    assert.deepEqual(waiting.route?.operation, { id: 'CC-route', status: 'running' });
    assert.match(waiting.next, /contract-change CC-route is running/);
    await ticks(2);
    assert.equal(prompts.length, 1, 'ожидание операции ревью не вызывает');

    f.h.approve(boardId, [taskId]);
    operation(f, taskId, v2.id, 'completed');
    await ticks(3);
    assert.equal(prompts.length, 2, 'проход сам проверил тот же ответ на новой редакции');
    assert.ok(prompts[1].includes(`"contracts":["${v2.id}"]`), 'ревью на новой редакции');
    const applied = f.store
      .allEvents()
      .filter((e) => e.type === 'input.applied')
      .map((e) => (e as unknown as { data: Record<string, unknown> }).data)
      .filter((d) => d.requestId === requestId);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].origin, 'server');
    assert.ok(
      ['applied-awaiting-claim', 'delivered'].includes(f.service.show({ requestId }).state),
    );
    const after = executionOf(f.h).engine.inputRequest(requestId);
    assert.equal(after.answers.length, 1);
    assert.equal(after.answers[0].digest, digestBefore, 'применён тот же ответ');
  } finally {
    await f.cleanup();
  }
});

test('F83: an abandoned or stale contract-change returns the question to the operator as a rejected answer with the reason', async () => {
  for (const status of ['abandoned', 'stale'] as const) {
    const { f, requestId, taskId } = await answered();
    try {
      await review(f, requestId);
      assert.equal(f.service.show({ requestId }).state, 'contract-change-required');
      operation(f, taskId, undefined, 'failed');
      const failed = f.service.show({ requestId });
      assert.equal(failed.state, 'contract-change-required', 'упавшую операцию продолжают');
      assert.match(failed.next, /--abandon, which returns the question to the operator/);
      operation(f, taskId, undefined, status);
      const shown = f.service.show({ requestId });
      assert.equal(shown.state, 'review-rejected', status);
      assert.equal(shown.actor, 'operator');
      assert.ok(shown.problems?.some((p) => p.includes(`CC-route не доведено (${status})`)));
      const card = (await cardOf(f, requestId))!;
      assert.equal(card.actor, 'operator');
      assert.ok(card.actions.some((a) => a.id === 'answer'));
    } finally {
      await f.cleanup();
    }
  }
});

test('F83: the route is deterministic — a contract not on the task, a mixed finding or a question without contract stays an ordinary rejection', async () => {
  const cases: { name: string; affects?: string[]; decide: (pins: Pins) => Decide }[] = [
    {
      name: 'чужой контракт',
      decide: () => () => ({
        approve: false,
        findings: [
          { severity: 'blocking', message: 'Amends another', rule: 'contract-change:C-x' },
        ],
      }),
    },
    {
      name: 'смешанные находки',
      decide: (pins) => () => ({
        approve: false,
        findings: [
          {
            severity: 'blocking',
            message: 'Amends the pinned',
            rule: `contract-change:${pins.v1}`,
          },
          { severity: 'blocking', message: 'Also changes the acceptance' },
        ],
      }),
    },
    {
      name: 'вопрос не о контракте',
      affects: ['acceptance'],
      decide: (pins) => () => ({
        approve: false,
        findings: [
          {
            severity: 'blocking',
            message: 'Amends the pinned',
            rule: `contract-change:${pins.v1}`,
          },
        ],
      }),
    },
  ];
  for (const c of cases) {
    const { f, prompts, requestId } = await answered({
      decide: c.decide,
      ...(c.affects ? { affects: c.affects } : {}),
    });
    try {
      const { result } = await review(f, requestId);
      assert.equal((result as { route?: string }).route, undefined, c.name);
      const shown = f.service.show({ requestId });
      assert.equal(shown.state, 'review-rejected', c.name);
      assert.equal(shown.route, undefined, c.name);
      if (c.affects)
        assert.doesNotMatch(
          prompts[0],
          /Contract route:/,
          'без правила для вопроса не о контракте',
        );
    } finally {
      await f.cleanup();
    }
  }
});

test('F83: in approvalMode operator the route is the lead’s too — no apply over the review; after the rebinding the lead reviews and the operator applies the same answer', async () => {
  const { f, pins, boardId, taskId, v1, requestId } = await answered({
    approvalMode: 'operator',
  });
  try {
    const { result } = await review(f, requestId);
    assert.equal((result as { route?: string }).route, 'contract-change');
    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'contract-change-required');
    assert.equal(shown.actor, 'lead');
    assert.match(shown.next, /the operator applies the answer in the panel/);
    const card = (await cardOf(f, requestId))!;
    assert.equal(card.actor, 'lead');
    assert.ok(!card.actions.some((a) => a.id === 'apply'), 'нет «Применить вопреки ревью»');
    const step = handoffStep(f);
    assert.equal(step.code, 'contract-change-required');
    assert.equal((step.params as { operator?: boolean }).operator, true);
    assert.equal((step.params as { server?: true }).server, undefined);
    // Применение к прежней редакции — отказ даже с подтверждением раунда.
    assert.throws(
      () =>
        f.service.applyInTask(taskId, requestId, {
          expectedVersion: shown.version,
          confirmRejectedRound: shown.round,
        }),
      (e: Error & { code?: string }) =>
        e.code === 'CONTRACT_CHANGE_REQUIRED' || /поправка закреплённого контракта/.test(e.message),
    );

    const v2 = rebind(f, taskId, v1.id, pins);
    f.h.approve(boardId, [taskId]);
    operation(f, taskId, v2.id, 'completed');
    assert.equal(f.service.show({ requestId }).state, 'answer-saved');
    const again = await review(f, requestId);
    assert.equal(again.result.approved, true);
    assert.equal(f.service.show({ requestId }).state, 'ready-to-apply');
    const applied = f.service.applyInTask(taskId, requestId, {
      expectedVersion: f.service.show({ requestId }).version,
    });
    assert.equal(applied.applied, true);
    assert.equal(answers(f, requestId), 1);
  } finally {
    await f.cleanup();
  }
});

test('F83: a new answer does not inherit the route of the previous one; an operation of another contract is not the route operation', async () => {
  const { f, pins, boardId, taskId, v1, requestId } = await answered();
  try {
    await review(f, requestId);
    // Операция другого договора, удерживающая задачу, маршрут не касается.
    operation(f, taskId, undefined, 'abandoned', 'CC-other', 'docs/contracts/other-format.md');
    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'contract-change-required');
    assert.equal(shown.route?.operation, undefined);
    // Перепривязка ждёт операции: маршрут держится для того же ответа.
    const v2 = rebind(f, taskId, v1.id, pins);
    operation(f, taskId, v2.id, 'running');
    assert.equal(f.service.show({ requestId }).route?.waiting, true);
    // Оператор передумал и ответил иначе из карточки задачи: новый ответ
    // маршрута не наследует.
    const now = f.service.show({ requestId });
    f.service.answerInTask(taskId, requestId, {
      text: 'Keep the current behaviour; no contract change.',
      expectedVersion: now.version,
    });
    const renewed = f.service.show({ requestId });
    assert.notEqual(renewed.state, 'contract-change-required');
    assert.equal(renewed.route, undefined);
    void boardId;
  } finally {
    await f.cleanup();
  }
});

test('F83: after an abandoned operation in approvalMode operator the answer still cannot be applied to the old revision', async () => {
  const { f, taskId, requestId } = await answered({ approvalMode: 'operator' });
  try {
    await review(f, requestId);
    operation(f, taskId, undefined, 'abandoned');
    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'review-rejected');
    assert.equal(shown.actor, 'operator');
    const card = (await cardOf(f, requestId))!;
    assert.ok(!card.actions.some((a) => a.id === 'apply'), 'нет «Применить вопреки ревью»');
    const last = shown.reviews.at(-1)!;
    const target = f.service.target({ requestId, contextDigest: last.contextDigest! });
    assert.ok(target.problems.some((p) => p.includes('поправка закреплённого контракта')));
    assert.throws(
      () =>
        f.service.applyInTask(taskId, requestId, {
          expectedVersion: shown.version,
          confirmRejectedRound: shown.round,
        }),
      /поправка закреплённого контракта/,
    );
  } finally {
    await f.cleanup();
  }
});

test('F83: a route that names a contract not pinned to the task stays a rejection after the task changes too', async () => {
  const { f, pins, taskId, v1, requestId } = await answered({
    decide: () => () => ({
      approve: false,
      findings: [{ severity: 'blocking', message: 'Amends another', rule: 'contract-change:C-x' }],
    }),
  });
  try {
    await review(f, requestId);
    assert.equal(f.service.show({ requestId }).state, 'review-rejected');
    const v2 = rebind(f, taskId, v1.id, pins);
    operation(f, taskId, v2.id, 'running');
    const shown = f.service.show({ requestId });
    assert.notEqual(shown.state, 'contract-change-required');
    assert.equal(shown.route, undefined);
  } finally {
    await f.cleanup();
  }
});

test('F83: the apply transaction itself refuses an operator apply over the route, even with the rejected round confirmed', async () => {
  const { f, taskId, requestId } = await answered({ approvalMode: 'operator' });
  try {
    const { context } = await review(f, requestId);
    operation(f, taskId, undefined, 'abandoned');
    const shown = f.service.show({ requestId });
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    assert.ok(target.targetDigest, 'цель есть: отказ — правило маршрута, а не нехватка цели');
    assert.throws(
      () =>
        f.service.apply(
          {
            requestId,
            answerDigest: target.answerDigest!,
            expectedVersion: target.version,
            contextDigest: context.contextDigest,
            targetDigest: target.targetDigest!,
          },
          'operator',
          { confirmRejectedRound: shown.round },
        ),
      (e: Error & { code?: string }) => e.code === 'CONTRACT_CHANGE_REQUIRED',
    );
    assert.equal(executionOf(f.h).engine.inputRequest(requestId).lifecycle, 'answered');
  } finally {
    await f.cleanup();
  }
});

test('F83: an operation abandoned after the rebinding returns the question to the operator with the reason, not to a silent re-review', async () => {
  const { f, pins, taskId, v1, requestId } = await answered();
  try {
    await review(f, requestId);
    const v2 = rebind(f, taskId, v1.id, pins);
    operation(f, taskId, v2.id, 'running');
    assert.equal(f.service.show({ requestId }).route?.waiting, true);
    operation(f, taskId, v2.id, 'abandoned');
    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'review-rejected');
    assert.equal(shown.actor, 'operator');
    assert.ok(shown.problems?.some((p) => p.includes('CC-route не доведено (abandoned)')));
  } finally {
    await f.cleanup();
  }
});

test('F83: after the rebinding only an earlier redaction counts as the routed contract — a later unpinned one does not become a route', async () => {
  let v3 = '';
  const { f, taskId, v1, requestId } = await answered({
    decide: () => () => ({
      approve: false,
      findings: [{ severity: 'blocking', message: 'Amends v3', rule: `contract-change:${v3}` }],
    }),
  });
  try {
    const v2 = f.h.contract('Artifact format', 'Version two.', undefined, undefined, source);
    v3 = f.h.contract('Artifact format', 'Version three.', undefined, undefined, source).id;
    await review(f, requestId);
    assert.equal(f.service.show({ requestId }).state, 'review-rejected');
    assert.deepEqual(f.h.rebind([taskId], [v1.id], v2.id), [taskId]);
    operation(f, taskId, v2.id, 'running');
    const shown = f.service.show({ requestId });
    assert.notEqual(shown.state, 'contract-change-required');
    assert.equal(shown.route, undefined);
  } finally {
    await f.cleanup();
  }
});

test('F83: only a validated route exempts earlier server-pass reviews from the limit; an ordinary rejection keeps it', async () => {
  for (const valid of [true, false]) {
    const { f, pins, boardId, taskId, v1, requestId } = await answered({
      paused: false,
      ...(valid
        ? {}
        : {
            decide: (p: Pins) => (prompt: string) =>
              prompt.includes(`"contracts":["${p.v1}"]`)
                ? {
                    approve: false,
                    findings: [
                      {
                        severity: 'blocking' as const,
                        message: 'Amends another',
                        rule: 'contract-change:C-x',
                      },
                    ],
                  }
                : { approve: true, findings: [] },
          }),
    });
    try {
      await review(f, requestId);
      const answer = executionOf(f.h).engine.inputRequest(requestId).answers[0];
      f.store.atomic(() => {
        f.store.saveLocal(RESUME, undefined, requestId, {
          requestId,
          taskId,
          answerDigest: answer.digest,
          revision: answer.revision,
          trigger: 'operator',
          author: { runtime: 'codex', source: 'task-approval' },
          phase: 'rejected',
          reviews: RESUME_REVIEWS,
          at: new Date().toISOString(),
        });
        f.store.saveLocal(RESUME, undefined, RESUME_DRIVER, { leaseUntil: Date.now() + 60_000 });
      });
      const v2 = rebind(f, taskId, v1.id, pins);
      f.h.approve(boardId, [taskId]);
      operation(f, taskId, v2.id, 'completed');
      const summary = f.service.list({ taskId }).requests[0];
      assert.equal(summary.state, 'answer-saved', String(valid));
      assert.equal(summary.resume?.phase, valid ? 'pending' : 'failed', String(valid));
    } finally {
      await f.cleanup();
    }
  }
});
