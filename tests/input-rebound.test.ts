// Ответ на вопрос о контракте после изменения контракта (F39): задача
// перепривязана к новой редакции договора и утверждена заново — остановка
// продолжается тем же ответом (input_target без причины, input_apply
// переносит ответ). Любое другое изменение постановки — по-прежнему тупик
// применения, и шаг называет реальный выход. Модели не вызываются:
// demo-исполнитель и управляемый reviewer ответа.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, type InputFixture } from './input-fixture.ts';
import { DEMO_ASK } from '../src/runner/adapters.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { specDigest } from '../src/core/service.ts';
import { reboundOnly, orderContentDigest } from '../src/application/input-rebound.ts';
import { executionOf } from '../src/harness/execution.ts';

after(() => inputDemos.close());

const source = 'docs/contracts/artifact-format.md';

/** Задача с контрактом v1, остановленная вопросом о контракте; ответ оператора сохранён. */
async function answeredContractQuestion() {
  const f = await inputFixture(controlled({ affects: ['contract', 'acceptance'] }));
  const boardId = f.h.createBoard('Contract question board').id;
  const v1 = f.h.contract('Artifact format', 'Version one.', undefined, undefined, source);
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
  f.h.pause(true);
  const [summary] = f.service.list({ taskId }).requests;
  assert.equal(summary.actor, 'operator', 'a contract question has a floor');
  f.service.answer(
    {
      requestId: summary.requestId,
      text: 'Use JSON; the contract wording is amended.',
      optionId: 'json',
      expectedVersion: summary.version,
    },
    'operator',
  );
  return { f, boardId, taskId, v1, requestId: summary.requestId };
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

test('F39: after a contract-change rebinding and re-approval the same answer is applied and reaches the next attempt', async () => {
  const { f, boardId, taskId, v1, requestId } = await answeredContractQuestion();
  try {
    const v2 = f.h.contract('Artifact format', 'Version two.', undefined, undefined, source);
    assert.deepEqual(f.h.rebind([taskId], [v1.id], v2.id), [taskId]);
    f.h.approve(boardId, [taskId]);
    const { context, target } = await reviewed(f, requestId);
    assert.deepEqual(target.problems, []);
    assert.equal((target as { rebound?: boolean }).rebound, true);
    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'ready-to-apply');
    assert.equal((shown as { moved?: boolean }).moved, undefined);
    const applied = f.service.apply(
      {
        requestId,
        answerDigest: target.answerDigest!,
        expectedVersion: target.version,
        contextDigest: context.contextDigest,
        targetDigest: target.targetDigest!,
      },
      'lead',
    );
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

test('F39: a spec changed beyond the contract rebinding stays a dead end for input_apply, and the step names the operator exit', async () => {
  const { f, boardId, taskId, v1, requestId } = await answeredContractQuestion();
  try {
    const v2 = f.h.contract('Artifact format', 'Version two.', undefined, undefined, source);
    f.h.rebind([taskId], [v1.id], v2.id);
    const task = () => f.store.read().tasks.find((t) => t.id === taskId)!;
    // Черновик после перепривязки: ждёт утверждения, тупиком не назван.
    assert.equal((f.service.show({ requestId }) as { moved?: boolean }).moved, undefined);
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
    const { context, target } = await reviewed(f, requestId);
    assert.ok(
      target.problems.some((p) => p.startsWith('работа уже не в исходной остановке')),
      target.problems.join('; '),
    );
    assert.equal((target as { rebound?: boolean }).rebound, undefined);
    const shown = f.service.show({ requestId });
    assert.equal(shown.state, 'context-review');
    assert.equal(shown.moved, true);
    assert.equal(shown.actor, 'operator');
    assert.match(shown.next, /operator cancels it in the panel/);
    assert.doesNotMatch(shown.next, /^input_target/);
    // Пауза оператора — свой шаг пакета; без неё пакет называет вопрос.
    f.h.pause(false);
    const step = devcontourHandoff(f.h, {}).host.next!;
    f.h.pause(true);
    assert.equal(step.code, 'apply-moved');
    assert.equal(step.action, 'operator');
    assert.deepEqual(step.params, { operatorAnswers: true });
    assert.equal(step.input?.actor, 'operator');
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
          'lead',
        ),
      /Постановка работы изменилась после вопроса/,
    );
    assert.equal(f.service.show({ requestId }).state, 'context-review');
  } finally {
    await f.cleanup();
  }
});

test('F39: the rebinding check is exact — another contract or an unrelated edit is not a rebinding', async () => {
  const { f, taskId, v1, requestId } = await answeredContractQuestion();
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
    // Редакция v1 → v2 в обратную сторону — не преемник.
    const back = reboundOnly(order, contracts, orderContentDigest(swap(v2.id, v2.digest)));
    assert.equal(back, false);
    void v1;
  } finally {
    await f.cleanup();
  }
});
