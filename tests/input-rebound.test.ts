// Ответ на вопрос после изменения контракта (F39): задача перепривязана к
// новой редакции договора и утверждена заново — остановка продолжается тем
// же ответом (input_target без причины, input_apply переносит ответ). У
// вопроса с минимумами — только если перепривязку провела завершённая
// операция contract-change. Любое другое изменение постановки — тупик
// применения, и шаг (а при работающем сервере — и проход) называет реальный
// выход. Модели не вызываются: demo-исполнитель и управляемый reviewer ответа.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, type InputFixture } from './input-fixture.ts';
import { DEMO_ASK } from '../src/runner/adapters.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { specDigest } from '../src/core/service.ts';
import {
  reboundByOperation,
  reboundOnly,
  orderContentDigest,
  type ContractChangeTrace,
} from '../src/application/input-rebound.ts';
import { ContractChanges, type ContractChange } from '../src/runner/contract-change.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { reviewers } from './contract-change-fixture.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionOf } from '../src/harness/execution.ts';
import { repositories } from '../src/core/repositories.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { AttentionService } from '../src/application/attention.ts';

after(() => inputDemos.close());

const source = 'docs/contracts/artifact-format.md';
const otherSource = 'docs/contracts/other-format.md';

/** Ревью ответа (вызовы reviewer без задачи) из записанных подсказок. */
const reviews = (prompts: string[]) =>
  prompts.filter((p) => p.startsWith('review:') && p.includes('Independently review an answer'))
    .length;

/**
 * Задача с контрактом v1 (и, если нужно, вторым контрактом), остановленная
 * вопросом; ответ оператора сохранён. `floors` — вопрос о контракте (минимум
 * `declared`), иначе вопрос без минимумов, который решает ведущий.
 */
async function answeredQuestion(
  options: {
    floors?: boolean;
    second?: boolean;
    kind?: 'clarification' | 'requirement-change';
    prompts?: string[];
    paused?: boolean;
  } = {},
) {
  const runtimes = controlled({
    affects: options.floors === false ? [] : ['contract', 'acceptance'],
    ...(options.prompts ? { prompts: options.prompts } : {}),
  });
  const f = await inputFixture(runtimes);
  const boardId = f.h.createBoard('Contract question board').id;
  const v1 = f.h.contract('Artifact format', 'Version one.', undefined, undefined, source);
  const w1 = options.second
    ? f.h.contract('Other format', 'Other one.', undefined, undefined, otherSource)
    : undefined;
  const taskId = f.h.addTask(boardId, {
    title: 'Task bound to a contract asks',
    description: `An observable outcome that needs a decision ${DEMO_ASK}.`,
    role: f.store.read().tasks[0].role,
    acceptance: ['The artifact exists.'],
    contracts: w1 ? [v1.id, w1.id] : [v1.id],
  }).id;
  f.h.approve(boardId);
  f.h.pause(false);
  await f.scheduler.drain();
  if (options.paused !== false) f.h.pause(true);
  const [summary] = f.service.list({ taskId }).requests;
  assert.equal(summary.actor, options.floors === false ? 'lead' : 'operator');
  f.service.answer(
    {
      requestId: summary.requestId,
      text: 'Use JSON; the contract wording is amended.',
      optionId: 'json',
      expectedVersion: summary.version,
      ...(options.kind ? { kind: options.kind } : {}),
    },
    'operator',
  );
  return { f, runtimes, boardId, taskId, v1, w1, requestId: summary.requestId };
}

/** Новая редакция контракта v1 и перепривязка задачи к ней (как шаг rebind). */
function rebind(f: InputFixture, taskId: string, from: string) {
  const v2 = f.h.contract('Artifact format', 'Version two.', undefined, undefined, source);
  assert.deepEqual(f.h.rebind([taskId], [from], v2.id), [taskId]);
  return v2;
}

/**
 * След операции изменения контракта — те поля записи `contract-change`,
 * которые читает проверка F39 (статус, новая редакция, перепривязанные и
 * удержанные задачи, начало и конец). Тип записи — настоящий
 * `ContractChange`: переименование поля ломает компиляцию теста. Сквозной
 * сценарий с настоящей операцией — тест «a real contract-change operation».
 */
function operation(
  f: InputFixture,
  taskId: string,
  contractId: string,
  status: 'completed' | 'running' | 'failed' | 'abandoned',
  id = 'CC-fixture',
) {
  const owner = repositories(f.h.config)[0].id;
  const record: ContractChangeTrace & Partial<ContractChange> = {
    id,
    key: `${owner}:${source}`,
    owner,
    status,
    contractId,
    rebound: [taskId],
    held: [taskId],
    boards: [],
    history: [],
    step: 0,
    startedAt: new Date().toISOString(),
    ...(status === 'completed' || status === 'abandoned'
      ? { finishedAt: new Date().toISOString() }
      : {}),
  };
  f.store.atomic(() => f.store.saveLocal('contract-change', owner, id, record));
}

/** Снимок с ответом, раунд ревью и цель. */
async function reviewed(f: InputFixture, requestId: string) {
  const context = await f.service.context({ requestId });
  const review = await f.service.review({
    requestId,
    contextDigest: context.contextDigest,
    authorRuntime: 'codex',
  });
  assert.equal(review.approved, true);
  const target = f.service.target({ requestId, contextDigest: context.contextDigest });
  return { context, target };
}

const applyInput = (f: InputFixture, requestId: string, r: Awaited<ReturnType<typeof reviewed>>) =>
  f.service.apply(
    {
      requestId,
      answerDigest: r.target.answerDigest!,
      expectedVersion: r.target.version,
      contextDigest: r.context.contextDigest,
      targetDigest: r.target.targetDigest!,
    },
    'lead',
  );

const lifecycle = (f: InputFixture, requestId: string) => {
  const r = executionOf(f.h).engine.inputRequest(requestId);
  return [r.lifecycle, r.version] as const;
};

test('F39: a question with floors — after a completed contract-change rebinding and re-approval the same answer is applied and delivered', async () => {
  const { f, boardId, taskId, v1, requestId } = await answeredQuestion();
  try {
    const v2 = rebind(f, taskId, v1.id);
    f.h.approve(boardId, [taskId]);
    operation(f, taskId, v2.id, 'completed');
    const r = await reviewed(f, requestId);
    assert.deepEqual(r.target.problems, []);
    assert.equal((r.target as { rebound?: boolean }).rebound, true);
    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'ready-to-apply');
    assert.equal(shown.moved, undefined);
    const applied = applyInput(f, requestId, r);
    assert.equal(applied.applied, true);
    assert.equal((applied as { rebound?: boolean }).rebound, true);
    assert.equal(applied.lifecycle, 'superseded');
    assert.equal(f.service.show({ requestId }).state, 'applied-awaiting-claim');
    // Ответ уходит в следующую попытку задачи с новой редакцией контракта.
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(f.service.show({ requestId }).state, 'delivered');
    const task = f.store.read().tasks.find((t) => t.id === taskId)!;
    assert.deepEqual(task.contracts, [v2.id]);
    assert.notEqual(task.failureKind, 'needs-input');
  } finally {
    await f.cleanup();
  }
});

test('F39: a question with floors — a rebinding without a completed contract-change is not a continuation; a running operation waits', async () => {
  const { f, boardId, taskId, v1, requestId } = await answeredQuestion();
  try {
    const v2 = rebind(f, taskId, v1.id);
    f.h.approve(boardId, [taskId]);
    // Операция ещё идёт: остановка ждёт её, а не названа тупиком.
    operation(f, taskId, v2.id, 'running');
    assert.equal(f.service.show({ requestId }).moved, undefined);
    // Операции нет (брошена): ручная перепривязка — та же форма, но ответ
    // оператора на редакцию, которую он не видел, не переносится.
    operation(f, taskId, v2.id, 'abandoned');
    const r = await reviewed(f, requestId);
    assert.equal((r.target as { rebound?: boolean }).rebound, undefined);
    assert.ok(
      r.target.problems.some((p) => p.startsWith('работа уже не в исходной остановке')),
      r.target.problems.join('; '),
    );
    const shown = f.service.show({ requestId });
    assert.equal(shown.moved, true);
    assert.equal(shown.actor, 'operator');
    assert.match(shown.next, /operator cancels it in the panel/);
    assert.match(shown.next, /then the lead carries the answer/);
    assert.throws(() => applyInput(f, requestId, r), /Постановка работы изменилась после вопроса/);
    assert.deepEqual(lifecycle(f, requestId)[0], 'answered');
  } finally {
    await f.cleanup();
  }
});

test('F39: a question the lead decides — a manual rebinding of one of two contracts is enough', async () => {
  const { f, boardId, taskId, v1, w1, requestId } = await answeredQuestion({
    floors: false,
    second: true,
  });
  try {
    const v2 = rebind(f, taskId, v1.id);
    f.h.approve(boardId, [taskId]);
    assert.deepEqual(f.store.read().tasks.find((t) => t.id === taskId)!.contracts, [v2.id, w1!.id]);
    const r = await reviewed(f, requestId);
    assert.deepEqual(r.target.problems, []);
    assert.equal((r.target as { rebound?: boolean }).rebound, true);
    const applied = applyInput(f, requestId, r);
    assert.equal(applied.applied, true);
    assert.equal(applied.lifecycle, 'superseded');
  } finally {
    await f.cleanup();
  }
});

test('F39: a spec changed beyond the rebinding stays a dead end even after a completed operation; the step names the operator exit', async () => {
  const { f, boardId, taskId, v1, requestId } = await answeredQuestion();
  try {
    const v2 = rebind(f, taskId, v1.id);
    operation(f, taskId, v2.id, 'completed');
    const task = () => f.store.read().tasks.find((t) => t.id === taskId)!;
    // Черновик после перепривязки: ждёт утверждения, тупиком не назван.
    assert.equal(f.service.show({ requestId }).moved, undefined);
    f.h.editTask(
      taskId,
      {
        title: 'Task bound to a contract asks, with a changed title',
        description: task().description,
        role: task().role,
        acceptance: task().acceptance,
        dependsOn: task().dependsOn,
        contracts: task().contracts,
      },
      specDigest(task()),
    );
    f.h.approve(boardId, [taskId]);
    const r = await reviewed(f, requestId);
    assert.ok(
      r.target.problems.some((p) => p.startsWith('работа уже не в исходной остановке')),
      r.target.problems.join('; '),
    );
    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'context-review');
    assert.equal(shown.moved, true);
    assert.equal(shown.actor, 'operator');
    assert.doesNotMatch(shown.next, /^input_target/);
    // Пауза оператора — свой шаг пакета; без неё пакет называет вопрос.
    f.h.pause(false);
    const step = devcontourHandoff(f.h, {}).host.next!;
    f.h.pause(true);
    assert.equal(step.code, 'apply-moved');
    assert.equal(step.action, 'operator');
    assert.deepEqual(step.params, { operatorAnswers: true });
    assert.throws(() => applyInput(f, requestId, r), /Постановка работы изменилась после вопроса/);
  } finally {
    await f.cleanup();
  }
});

test('F39: a carry that does not happen rolls the supersede back — busy graph and a stale target leave the question answered', async () => {
  const { f, boardId, taskId, v1, requestId } = await answeredQuestion({ floors: false });
  const { engine } = executionOf(f.h);
  const original = engine.carryInput.bind(engine);
  try {
    rebind(f, taskId, v1.id);
    f.h.approve(boardId, [taskId]);
    const r = await reviewed(f, requestId);
    const before = lifecycle(f, requestId);
    assert.equal(before[0], 'answered');
    // Идущие попытки графа: перенос отвечает carried: false — замена
    // откатывается вместе с ним.
    engine.carryInput = ((id: string) => ({
      carried: false,
      changed: false,
      request: engine.inputRequest(id),
      active: [{ id: 'R-fixture', workId: taskId }],
    })) as unknown as typeof engine.carryInput;
    const busy = applyInput(f, requestId, r);
    assert.equal(busy.applied, false);
    assert.deepEqual((busy as { active?: unknown }).active, [{ id: 'R-fixture', workId: taskId }]);
    assert.equal(busy.lifecycle, 'answered');
    assert.equal(busy.version, before[1]);
    assert.deepEqual(lifecycle(f, requestId), before);
    // Ошибка переноса после замены (цель устарела): замена тоже откатывается.
    engine.carryInput = original;
    assert.throws(
      () =>
        f.service.apply(
          {
            requestId,
            answerDigest: r.target.answerDigest!,
            expectedVersion: r.target.version,
            contextDigest: r.context.contextDigest,
            targetDigest: '0'.repeat(64),
          },
          'lead',
        ),
      /Основание переноса изменилось/,
    );
    assert.deepEqual(lifecycle(f, requestId), before);
    // Верная цель — перенос проходит.
    assert.equal(applyInput(f, requestId, r).applied, true);
  } finally {
    engine.carryInput = original;
    await f.cleanup();
  }
});

test('F39: a requirement-change answer does not take the rebinding path', async () => {
  const { f, boardId, taskId, v1, requestId } = await answeredQuestion({
    floors: false,
    kind: 'requirement-change',
  });
  try {
    rebind(f, taskId, v1.id);
    f.h.approve(boardId, [taskId]);
    const r = await reviewed(f, requestId);
    assert.equal((r.target as { rebound?: boolean }).rebound, undefined);
    assert.ok(r.target.problems.length > 0);
    assert.throws(() => applyInput(f, requestId, r));
    assert.equal(lifecycle(f, requestId)[0], 'answered');
  } finally {
    await f.cleanup();
  }
});

test('F39: with a running server a moved stop stops the pass with the real actor — no review call, no apply step for the lead', async () => {
  const prompts: string[] = [];
  const { f, runtimes, boardId, taskId, v1, requestId } = await answeredQuestion({
    prompts,
    paused: false,
  });
  try {
    // Перепривязка вручную (без операции) и правка заголовка, задача утверждена.
    rebind(f, taskId, v1.id);
    const task = () => f.store.read().tasks.find((t) => t.id === taskId)!;
    f.h.editTask(
      taskId,
      {
        title: 'Task bound to a contract asks, respecified',
        description: task().description,
        role: task().role,
        acceptance: task().acceptance,
        dependsOn: task().dependsOn,
        contracts: task().contracts,
      },
      specDigest(task()),
    );
    f.h.approve(boardId, [taskId]);
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    for (let i = 0; i < 3; i++) {
      await lead.tick();
      await lead.settled();
    }
    const before = reviews(prompts);
    const summary = f.service.list({ taskId }).requests[0];
    assert.equal(summary.state, 'answer-saved');
    assert.equal(summary.moved, true);
    assert.deepEqual(summary.resume, {
      phase: 'moved',
      auto: false,
      trigger: 'operator',
      detail: 'operator',
    });
    assert.equal(summary.actor, 'operator');
    assert.match(summary.next, /operator cancels it in the panel/);
    const step = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(step.code, 'apply-moved');
    assert.equal(step.action, 'operator');
    assert.equal(step.input?.actor, 'operator');
    // Оператор видит карточку с реальным выходом.
    const card = (await new AttentionService(f.store, f.h, { root: f.root }).active()).items.find(
      (i) => i.sourceKey === `input:${requestId}`,
    )!;
    assert.equal(card.actor, 'operator');
    assert.match(card.reason, /Снять вопрос/);
    await lead.tick();
    await lead.settled();
    assert.equal(reviews(prompts), before, 'проход ревью не вызывает');
    assert.equal(reviews(prompts), 0);
  } finally {
    await f.cleanup();
  }
});

test('F39: with a running server the pass itself applies the answer after a completed contract-change rebinding', async () => {
  const prompts: string[] = [];
  const { f, runtimes, boardId, taskId, v1, requestId } = await answeredQuestion({
    prompts,
    paused: false,
  });
  try {
    const v2 = rebind(f, taskId, v1.id);
    f.h.approve(boardId, [taskId]);
    operation(f, taskId, v2.id, 'completed');
    new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    for (let i = 0; i < 3; i++) {
      await lead.tick();
      await lead.settled();
    }
    assert.equal(reviews(prompts), 1);
    assert.deepEqual(lifecycle(f, requestId)[0], 'superseded');
    const applied = f.store
      .allEvents()
      .filter((e) => e.type === 'input.applied')
      .map((e) => (e as unknown as { data: Record<string, unknown> }).data);
    assert.equal(applied.at(-1)?.origin, 'server');
    assert.ok(
      ['applied-awaiting-claim', 'delivered'].includes(f.service.show({ requestId }).state),
    );
  } finally {
    await f.cleanup();
  }
});

test('F39: the rebinding check is exact — another contract or an unrelated edit is not a rebinding', async () => {
  const { f, taskId, requestId } = await answeredQuestion();
  try {
    const v2 = f.h.contract('Artifact format', 'Version two.', undefined, undefined, source);
    const other = f.h.contract('Other format', 'Unrelated.', undefined, undefined, 'docs/other.md');
    const { engine, store } = executionOf(f.h);
    const request = engine.inputRequest(requestId);
    const origin = request.originBasis.contentDigest!;
    const order = engine.read((v) => v.work(taskId)!.order);
    const contracts = store.read((v) => store.stateOf(v).contracts);
    assert.equal(orderContentDigest(order), origin, 'the formula is the engine one');
    const swap = (id: string, digest: string) => ({ ...order, contracts: [{ id, digest }] });
    assert.equal(reboundOnly(order, contracts, origin), false, 'unchanged is not a rebinding');
    assert.equal(reboundOnly(swap(v2.id, v2.digest), contracts, origin), true);
    assert.equal(reboundOnly(swap(other.id, other.digest), contracts, origin), false);
    assert.equal(
      reboundOnly({ ...swap(v2.id, v2.digest), title: 'Changed' }, contracts, origin),
      false,
    );
    // Обратное направление (новая редакция при вопросе, прежняя сейчас) — не преемник.
    assert.equal(reboundOnly(order, contracts, orderContentDigest(swap(v2.id, v2.digest))), false);
  } finally {
    await f.cleanup();
  }
});

test('F39: a real contract-change operation started before the question (drain window) rebinds, re-approves and lets the same answer through', async () => {
  const runtimes = controlled({ affects: ['contract', 'acceptance'] });
  const f = await inputFixture(runtimes);
  try {
    const repo = f.h.config.repository;
    const sh = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: repo })
        .toString()
        .trim();
    const write = (text: string) => {
      mkdirSync(join(repo, 'docs/contracts'), { recursive: true });
      writeFileSync(join(repo, source), `# Artifact format\n\n${text}\n`);
      sh('add', source);
      sh('commit', '-qm', text);
    };
    write('Version one.');
    const proposal = { title: 'Artifact format', file: source };
    const calls: string[] = [];
    // AI-согласование (ревью контракта и плана) — только в local mode:
    // ревьюеры — фикстуры, исполнитель задачи остаётся demo.
    const local = async <T>(run: () => Promise<T>) => {
      f.h.config.mode = 'local';
      try {
        return await run();
      } finally {
        f.h.config.mode = 'demo';
      }
    };
    await local(() => reviewContract(f.h, f.root, proposal, 'codex', reviewers(calls)));
    const v1 = f.store.read().contracts.at(-1)!;
    const boardId = f.h.createBoard('Contract question board').id;
    const taskId = f.h.addTask(boardId, {
      title: 'Task bound to a contract asks',
      description: `An observable outcome that needs a decision ${DEMO_ASK}.`,
      role: f.store.read().tasks[0].role,
      acceptance: ['The artifact exists.'],
      contracts: [v1.id],
    }).id;
    f.h.approve(boardId);
    write('Version two.');
    // База прогонов догоняет рабочую ветку: иначе очередь не выдаст попытку.
    await updateBase(f.h.config, f.root);
    // Операция начата до вопроса: попытка, которую она дождётся, ещё впереди.
    const changes = new ContractChanges(f.h, f.root, reviewers(calls));
    const started = (await changes.start(proposal, 'codex')) as { operation: ContractChange };
    assert.ok(started.operation, JSON.stringify(started));
    f.h.pause(false);
    await f.scheduler.drain();
    f.h.pause(true);
    const [summary] = f.service.list({ taskId }).requests;
    assert.equal(summary.actor, 'operator');
    assert.ok(summary.floors.length > 0, 'вопрос с минимумами');
    const requestId = summary.requestId;
    const asked = executionOf(f.h).engine.inputRequest(requestId).createdAt;
    assert.ok(started.operation.startedAt < asked, 'операция начата до вопроса');
    f.service.answer(
      {
        requestId,
        text: 'Use JSON; the contract wording is amended.',
        optionId: 'json',
        expectedVersion: summary.version,
      },
      'operator',
    );
    const done = await local(() => changes.advance(started.operation.id));
    assert.equal(done.status, 'completed', done.error);
    assert.deepEqual(done.rebound, [taskId], 'задача вопроса перепривязана операцией');
    const task = f.store.read().tasks.find((t) => t.id === taskId)!;
    assert.deepEqual(task.contracts, [done.contractId]);
    assert.notEqual(task.status, 'draft', 'шаг plan утвердил задачу заново');
    const r = await reviewed(f, requestId);
    assert.deepEqual(r.target.problems, []);
    assert.equal((r.target as { rebound?: boolean }).rebound, true);
    const applied = applyInput(f, requestId, r);
    assert.equal(applied.applied, true);
    assert.equal(applied.lifecycle, 'superseded');
  } finally {
    await f.cleanup();
  }
});

test('F39: the operation is matched by its rebinding moment, not its start — before the question it does not count', () => {
  const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
  const op = (rebindMinute: number): ContractChangeTrace => ({
    id: 'CC-unit',
    status: 'completed',
    contractId: 'C-new',
    rebound: ['T-unit'],
    held: ['T-unit'],
    startedAt: at(0),
    finishedAt: at(30),
    history: [
      { at: at(0), step: 'start', event: 'queued' },
      { at: at(rebindMinute), step: 'rebind', event: 'done' },
    ],
  });
  const changes = [{ id: 'C-new', from: 'C-old' }];
  // Вопрос в 10: операция начата раньше, перепривязка в 20 — после вопроса.
  assert.equal(reboundByOperation(changes, [op(20)], 'T-unit', at(10)), 'yes');
  // Перепривязка в 5 — до вопроса: ответ на неё не отвечал.
  assert.equal(reboundByOperation(changes, [op(5)], 'T-unit', at(10)), 'no');
});

test('F39: a failed operation keeps the stop waiting and names itself with the way out; once abandoned the stop is moved', async () => {
  const { f, boardId, taskId, v1, requestId } = await answeredQuestion();
  try {
    const v2 = rebind(f, taskId, v1.id);
    f.h.approve(boardId, [taskId]);
    operation(f, taskId, v2.id, 'failed', 'CC-failed');
    const r = await reviewed(f, requestId);
    assert.equal((r.target as { rebound?: boolean }).rebound, undefined);
    assert.ok(
      r.target.problems.some(
        (p) =>
          p.includes('упавшую операцию изменения контракта CC-failed') && p.includes('--abandon'),
      ),
      r.target.problems.join('; '),
    );
    const shown = f.service.show({ requestId });
    assert.equal(shown.moved, undefined);
    assert.match(shown.next, /CC-failed/);
    assert.throws(() => applyInput(f, requestId, r));
    operation(f, taskId, v2.id, 'abandoned', 'CC-failed');
    assert.equal(f.service.show({ requestId }).moved, true);
  } finally {
    await f.cleanup();
  }
});
