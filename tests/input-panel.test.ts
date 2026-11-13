// Проекции карточки вопроса исполнителя (раунд 1, M1 и M2): отклонённое
// ревью ответа — своё состояние, подпись, вердикт и находки, применение —
// только с подтверждением; повтор скрыт, только пока задачу держит вопрос.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlled,
  inputDemos,
  inputFixture,
  untilQuestion,
  type InputFixture,
} from './input-fixture.ts';
import { heldByInput, inputStateLabels, inputStateOrder } from '../src/web/input-labels.ts';
import { panelTask } from '../src/application/panel.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { executionOf } from '../src/harness/execution.ts';

after(() => inputDemos.close());

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    const e = error as { status?: number; code?: string };
    return `${e.status ?? '-'}:${e.code ?? '-'}`;
  }
};

async function question(f: InputFixture) {
  const { taskId, boardId } = f.askingTask();
  await untilQuestion(f, boardId);
  const [r] = f.service.list({ taskId }).requests;
  return { taskId, requestId: r.requestId, version: r.version };
}

/** Ответ оператора, снимок и раунд ревью с заданным вердиктом. */
async function reviewed(f: InputFixture, requestId: string, text: string) {
  f.service.answer(
    { requestId, text, expectedVersion: f.service.show({ requestId }).version },
    'operator',
  );
  const context = await f.service.context({ requestId });
  const review = await f.service.review({
    requestId,
    contextDigest: context.contextDigest,
    authorRuntime: 'codex',
  });
  return { ...f.service.show({ requestId }), reviewNextStep: review.nextStep };
}

test('Labels follow the plan sequence; an answer-saved card names the context preparation as the next step', () => {
  assert.deepEqual(
    inputStateOrder.map((s) => inputStateLabels[s]),
    [
      'Нужен ответ',
      'Ответ сохранён — нужна подготовка и проверка контекста',
      'Контекст с ответом проверен',
      'Ответ применён, ждёт попытки',
      'Передано в новую попытку',
    ],
  );
  assert.equal(inputStateLabels['review-rejected'], 'Ревью отклонило ответ');
  assert.notEqual(inputStateLabels['review-rejected'], inputStateLabels['ready-to-apply']);
});

test('Operator mode: an approved round is ready to apply; a rejected round has its own state with verdict and findings, and applies only with confirmation', async () => {
  const verdict = { approve: true };
  const f = await inputFixture(controlled({ verdict }), { approvalMode: 'operator' });
  try {
    const { taskId, requestId } = await question(f);
    const approved = await reviewed(f, requestId, 'Use JSON as now.');
    assert.equal(approved.state, 'ready-to-apply');
    assert.equal(inputStateLabels[approved.state], 'Контекст с ответом проверен');
    assert.equal(approved.reviews.at(-1)?.approved, true);
    // Исправленный ответ, который ревью отклоняет.
    verdict.approve = false;
    const rejected = await reviewed(f, requestId, 'Produce YAML instead.');
    assert.equal(rejected.state, 'review-rejected');
    assert.equal(inputStateLabels[rejected.state], 'Ревью отклонило ответ');
    assert.equal(rejected.actor, 'operator');
    assert.match(rejected.next, /explicit confirmation/);
    const last = rejected.reviews.at(-1) as {
      approved: boolean;
      summary: string;
      findings?: { severity: string; message: string }[];
    };
    assert.equal(last.approved, false);
    assert.match(last.summary, /changes the spec/);
    assert.deepEqual(last.findings, [
      { severity: 'blocking', message: 'Ответ меняет утверждённую приёмку' },
    ]);
    assert.match(devcontourHandoff(f.h, {}).host.next?.detail ?? '', /rejected/);
    // Без подтверждения панель не применяет отклонённый ответ.
    const expectedVersion = rejected.version;
    assert.equal(
      await codeOf(() => f.service.applyInTask(taskId, requestId, { expectedVersion })),
      '409:REVIEW_REJECTED',
    );
    assert.equal(f.service.show({ requestId }).lifecycle, 'answered');
    const seen = (rejected.reviews.at(-1) as { round: number }).round;
    // Пока оператор читал раунд, ведущий провёл ещё один (тоже отклонён):
    // подтверждение прежнего раунда не применяет новый.
    const context = await f.service.context({ requestId });
    const again = await f.service.review({
      requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    assert.equal(again.round, seen + 1);
    assert.equal(
      await codeOf(() =>
        f.service.applyInTask(taskId, requestId, { expectedVersion, confirmRejectedRound: seen }),
      ),
      '409:REVIEW_REJECTED',
    );
    // CLI оператора — то же правило: без подтверждения раунда отказ.
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    const raw = {
      requestId,
      answerDigest: context.answerDigest,
      expectedVersion,
      contextDigest: context.contextDigest,
      targetDigest: target.targetDigest!,
    };
    assert.equal(await codeOf(() => f.service.apply(raw, 'operator')), '409:REVIEW_REJECTED');
    assert.equal(
      await codeOf(() => f.service.apply(raw, 'operator', { confirmRejectedRound: seen })),
      '409:REVIEW_REJECTED',
    );
    // Раунд «из будущего» — тоже не подтверждение показанного.
    assert.equal(
      await codeOf(() =>
        f.service.applyInTask(taskId, requestId, {
          expectedVersion,
          confirmRejectedRound: again.round + 1,
        }),
      ),
      '409:REVIEW_REJECTED',
    );
    // Другой процесс записал новый отклонённый раунд в момент применения:
    // проверка в транзакции видит его и отказывает.
    const { store } = executionOf(f.h);
    const host = store.host.bind(store);
    let raced = false;
    store.host = ((kind: string, fn: Parameters<typeof host>[1]) => {
      if (kind === 'input.applied' && !raced) {
        raced = true;
        const [entry] = store
          .read((v) => v.locals('reviews'))
          .filter((r) => r.value.subject === 'input-' + requestId && r.value.round === again.round);
        f.store.atomic(() =>
          f.store.saveLocal('reviews', undefined, entry.key + '-next', {
            ...entry.value,
            id: entry.value.id + '-next',
            round: again.round + 1,
          }),
        );
      }
      return host(kind, fn);
    }) as typeof store.host;
    assert.equal(
      await codeOf(() =>
        f.service.applyInTask(taskId, requestId, {
          expectedVersion,
          confirmRejectedRound: again.round,
        }),
      ),
      '409:REVIEW_REJECTED',
    );
    store.host = host;
    assert.equal(f.service.show({ requestId }).lifecycle, 'answered');
    const applied = f.service.applyInTask(taskId, requestId, {
      expectedVersion,
      confirmRejectedRound: again.round + 1,
    });
    assert.equal(applied.applied, true);
  } finally {
    await f.cleanup();
  }
});

test('Agent mode: a rejected round is review-rejected, not "needs preparation"', async () => {
  const f = await inputFixture(controlled({ verdict: { approve: false } }));
  try {
    const { requestId } = await question(f);
    const rejected = await reviewed(f, requestId, 'Produce YAML instead.');
    assert.equal(rejected.state, 'review-rejected');
    assert.equal(rejected.actor, 'lead');
    // Вопрос без минимумов решает ведущий: шаг ревью — его маршрут.
    assert.match(rejected.reviewNextStep, /input_supersede/);
  } finally {
    await f.cleanup();
  }
});

test('Agent mode, critical question: after a rejected review the next actor is the operator', async () => {
  const f = await inputFixture(controlled({ verdict: { approve: false }, critical: true }));
  try {
    const { requestId } = await question(f);
    const rejected = await reviewed(f, requestId, 'Produce YAML instead.');
    assert.equal(rejected.state, 'review-rejected');
    assert.equal(rejected.actor, 'operator');
    assert.match(rejected.next, /operator/);
    // F38: шаг результата ревью — тот же, что у input_show: маршрут
    // оператора, без операций ведущего (input_supersede — только оператору).
    assert.equal(rejected.reviewNextStep, rejected.next);
    assert.doesNotMatch(rejected.reviewNextStep, /input_supersede|reopen and respecify/);
  } finally {
    await f.cleanup();
  }
});

test('Retry is hidden only while a question holds the task: after the operator cancels it, the task is retryable', async () => {
  const f = await inputFixture(controlled(), { approvalMode: 'operator' });
  try {
    const { taskId, requestId, version } = await question(f);
    const card = () => panelTask(f.h, taskId, {}).task;
    assert.equal(card().failureKind, 'needs-input');
    assert.equal(heldByInput(card()), true);
    f.service.cancelInTask(taskId, requestId, {
      expectedVersion: version,
      reason: 'Not needed any more',
    });
    // Класс отказа прежний, но вопрос задачу больше не держит: повтор виден и работает.
    assert.equal(card().failureKind, 'needs-input');
    assert.equal(heldByInput(card()), false);
    f.h.retry(taskId, undefined, 'operator');
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'ready');
  } finally {
    await f.cleanup();
  }
});
