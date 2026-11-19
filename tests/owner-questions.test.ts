import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import { approvePreparation, product } from './preparation-fixture.ts';
import { byKey, preparationFixture } from './attention-fixture.ts';
import { Preparation } from '../src/core/preparation.ts';
import { DomainError } from '../src/core/model.ts';
import { AttentionService, sectionOfCandidate } from '../src/application/attention.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { taskProgress } from '../src/application/context.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { reviewPlan } from '../src/runner/agent-control.ts';
import { questionHolds, questionSummary } from '../src/core/owner-questions.ts';
import { hrefs } from '../src/application/panel-links.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { specDigest, type DevContour } from '../src/core/service.ts';

// Вопросы владельцу по разделам (A1) и удержание черновиков (A2): модель,
// карточка центра внимания, пакет передачи контекста и отказ выпуска.

/** Отказ с кодом `QUESTION_PENDING` и вопросом. */
const pending = (questionId: string) => (error: unknown) => {
  assert.ok(error instanceof DomainError, String(error));
  assert.equal(error.status, 409);
  assert.equal(error.details?.code, 'QUESTION_PENDING');
  assert.equal(error.details?.questionId, questionId);
  return true;
};

test('Вопрос владельцу: раздел и этап, варианты с рекомендацией, отказы проверки', () => {
  const f = preparationFixture();
  try {
    const asked = f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [
        {
          text: 'Обещать ли пользователю экспорт истории?',
          section: 'product',
          choices: [
            { label: 'Да, в первом релизе', consequence: 'Ещё две задачи до релиза' },
            { label: 'Нет', consequence: 'Критерий приёмки убирается' },
          ],
          recommended: 1,
        },
        { text: 'Какой линтер ставить?', section: 'development' },
        { text: 'Палитра тёмной темы?', stage: 'references' },
      ],
    }) as unknown as { questions: { id: string; existing: boolean }[] };
    assert.equal(asked.questions.length, 3);
    const rows = f.store.read().preparation!.changes[0].questions;
    assert.deepEqual(
      rows.map((q) => [q.stage, q.section]),
      [
        ['product', 'product'],
        ['development', 'development'],
        ['references', 'design'],
      ],
    );
    assert.equal(rows[0].recommended, 1);
    assert.deepEqual(rows[0].origin, { kind: 'lead' });
    const refused = (add: unknown, re: RegExp) =>
      assert.throws(
        () => f.p.execute('preparation_question', { changeId: f.changeId, add: [add] }),
        re,
      );
    refused(
      { text: 'Несогласованный раздел', stage: 'product', section: 'development' },
      /Раздел development не соответствует этапу product/,
    );
    refused(
      { text: 'Рекомендация вне списка', choices: [{ label: 'А' }], recommended: 1 },
      /Рекомендованный вариант вне списка/,
    );
    refused(
      { text: 'Оба вида вариантов', options: ['А'], choices: [{ label: 'Б' }] },
      /либо choices, либо options/,
    );
    refused(
      { text: 'Удержание без задач', blocks: { taskIds: ['T-missing'] } },
      /Задачи не найдены: T-missing/,
    );
    // До setup черновиков нет: удерживать нечего.
    assert.equal(
      f.store.read().preparation!.changes[0].questions.length,
      3,
      'отказ ничего не пишет',
    );
    // Вопрос разработки не держит отправку этапа продукта; продуктовый держит.
    assert.equal(
      f.store
        .read()
        .preparation!.changes[0].questions.filter(
          (q) => q.status === 'open' && q.stage === 'product',
        ).length,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test('Вопрос владельцу: перенос по origin.ref идемпотентен, уточнение открытого — новая версия карточки', async () => {
  const f = preparationFixture();
  try {
    const origin = { kind: 'markdown', ref: 'QUEUE.md#row-4' };
    const first = f.p.execute('preparation_question', {
      changeId: f.changeId,
      section: 'architecture',
      add: [{ text: 'Как мерить бюджет времени?', origin, options: ['Повтор', 'По одной'] }],
    }) as unknown as { questions: { id: string; existing: boolean }[] };
    const again = f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Другой текст той же строки', origin }],
    }) as unknown as { questions: { id: string; existing: boolean }[] };
    assert.deepEqual(again.questions, [{ ...first.questions[0], existing: true }]);
    assert.equal(
      f.store.read().preparation!.changes[0].questions.length,
      1,
      'повтор не создаёт вопрос',
    );
    const id = first.questions[0].id;
    const key = `prep:q:${f.changeId}:${id}`;
    const before = byKey((await new AttentionService(f.store, undefined).active()).items, key)!;
    assert.equal(before.section, 'architecture');
    assert.match(before.subject.href, /stage=architecture#questions-architecture$/);
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      revise: [
        {
          id,
          choices: [
            { label: 'Повтор замера', consequence: 'Ещё одна калибровка' },
            { label: 'По одной' },
          ],
          recommended: 0,
        },
      ],
    });
    const after = byKey((await new AttentionService(f.store, undefined).active()).items, key)!;
    assert.equal(after.occurrenceId, before.occurrenceId, 'уточнение — то же появление');
    assert.notEqual(after.sourceVersion, before.sourceVersion, 'уточнение — новая версия');
    const action = after.actions.find((a) => a.id === 'answer');
    assert.ok(action && action.kind === 'domain');
    assert.deepEqual(action.choices, [
      { id: '0', label: 'Повтор замера', hint: 'Ещё одна калибровка', recommended: true },
      { id: '1', label: 'По одной' },
    ]);
    assert.match(action.prompt!, /Рекомендация ведущего: Повтор замера/);
    const q = f.store.read().preparation!.changes[0].questions[0];
    assert.deepEqual(q.options, [], 'choices заменили options');
    assert.ok(q.revisedAt);
    // Ответ владельца — вариант с карточки: индекс и его текст.
    await new AttentionService(f.store, undefined).act({
      sourceKey: key,
      occurrenceId: after.occurrenceId,
      expectedVersion: after.sourceVersion,
      action: 'answer',
      input: { optionId: '0' },
    });
    const answered = f.store.read().preparation!.changes[0].questions[0];
    assert.equal(answered.answer?.choice, 0);
    assert.equal(answered.answer?.text, 'Повтор замера');
    assert.throws(
      () =>
        f.p.execute('preparation_question', {
          changeId: f.changeId,
          revise: [{ id, why: 'поздно' }],
        }),
      /только открытый вопрос/,
    );
    const lead = byKey(
      (await new AttentionService(f.store, undefined).active()).items,
      `prep:qa:${f.changeId}:${id}`,
    )!;
    assert.equal(lead.section, 'architecture');
    assert.equal(lead.actor, 'lead');
    // Решение ведущего ссылается на то, что изменил ответ.
    f.p.execute('preparation_resolve', {
      changeId: f.changeId,
      questionId: id,
      statement: 'Повторяем замер после калибровки',
      rationale: 'Ответ владельца',
      refs: { adr: 'docs/adr/0004-budget.md' },
    });
    const record = f.store.read().preparation!.changes[0].decisions[0];
    assert.equal(record.stage, 'architecture', 'этап решения — этап вопроса');
    assert.deepEqual(record.refs, { adr: 'docs/adr/0004-budget.md' });
  } finally {
    f.cleanup();
  }
});

test('Ответ владельца: вариант без текста, свой текст, вариант вне списка — отказ', () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [
        { text: 'Вопрос с вариантами', choices: [{ label: 'А' }, { label: 'Б' }] },
        { text: 'Вопрос без вариантов' },
      ],
    });
    const [a, b] = f.store.read().preparation!.changes[0].questions;
    const operator = new Preparation(f.store, 'operator');
    assert.throws(
      () => operator.answer({ changeId: f.changeId, questionId: a.id, choice: 5 }),
      /Такого варианта/,
    );
    assert.throws(
      () => operator.answer({ changeId: f.changeId, questionId: b.id }),
      /Введите ответ или выберите вариант/,
    );
    operator.answer({ changeId: f.changeId, questionId: a.id, choice: 1, text: 'Б, но позже' });
    operator.answer({ changeId: f.changeId, questionId: b.id, text: 'Свой ответ' });
    const [qa, qb] = f.store.read().preparation!.changes[0].questions;
    assert.deepEqual([qa.answer?.choice, qa.answer?.text], [1, 'Б, но позже']);
    assert.deepEqual([qb.answer?.choice, qb.answer?.text], [undefined, 'Свой ответ']);
  } finally {
    f.cleanup();
  }
});

test('Центр внимания: раздел у каждой карточки, фильтр раздела и counts.bySection', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [
        { text: 'Продуктовый вопрос', section: 'product' },
        { text: 'Вопрос разработки', section: 'development' },
        { text: 'Ещё продуктовый', section: 'product' },
      ],
    });
    const service = new AttentionService(f.store, undefined);
    const all = await service.active();
    assert.deepEqual(all.counts.bySection, {
      product: { operator: 2, lead: 0, unread: 2 },
      architecture: { operator: 0, lead: 0, unread: 0 },
      design: { operator: 0, lead: 0, unread: 0 },
      development: { operator: 1, lead: 0, unread: 1 },
    });
    const product = await service.active({ section: 'product' });
    assert.equal(product.items.length, 2);
    assert.ok(product.items.every((i) => i.section === 'product'));
    assert.deepEqual(
      product.counts.bySection,
      all.counts.bySection,
      'счёт разделов — без фильтра раздела',
    );
    // Раздел источников без своего поля: этап по ключу, движок — разработка.
    assert.equal(
      sectionOfCandidate({ source: 'prep-stage', sourceKey: 'prep:stage:PC-1:concept' }),
      'design',
    );
    assert.equal(
      sectionOfCandidate({ source: 'prep-rework', sourceKey: 'prep:rework:PC-1:architecture' }),
      'architecture',
    );
    assert.equal(
      sectionOfCandidate({ source: 'quick', sourceKey: 'quick:PC-1:connection' }),
      'product',
    );
    assert.equal(sectionOfCandidate({ source: 'input', sourceKey: 'input:IR-1' }), 'development');
    assert.equal(sectionOfCandidate({ source: 'board', sourceKey: 'board:B-1' }), 'development');
  } finally {
    f.cleanup();
  }
});

/** Workspace после setup: утверждённая подготовка, доска с черновиками. */
function heldFixture() {
  const f = fixture();
  const p = new Preparation(f.store);
  const changeId = approvePreparation(p);
  const board = f.h.createBoard('Разработка');
  const free = f.h.addTask(board.id, { ...input('Свободный черновик'), featureId: 'member-block' });
  const held = f.h.addTask(board.id, { ...input('Ждёт владельца'), featureId: 'member-block' });
  return { ...f, p, changeId, board, free, held };
}

const ask = (p: Preparation, changeId: string, blocks: string[]) =>
  (
    p.execute('preparation_question', {
      changeId,
      add: [
        {
          text: 'Обещаем ли алгоритм подбора?',
          section: 'product',
          choices: [{ label: 'Обещаем' }, { label: 'Убираем из постановки' }],
          recommended: 1,
          blocks: { taskIds: blocks },
        },
      ],
    }) as unknown as { questions: { id: string }[] }
  ).questions[0].id;

const answer = (f: { store: DevContour['store'] }, changeId: string, questionId: string) =>
  new Preparation(f.store, 'operator').answer({ changeId, questionId, choice: 1 });

test('Удержание: черновик вопроса вне ревью плана, утверждение и workflow_start — 409 QUESTION_PENDING', async () => {
  const f = heldFixture();
  try {
    const qid = ask(f.p, f.changeId, [f.held.id]);
    assert.deepEqual([...questionHolds(f.store.read()).keys()], [f.held.id]);
    const s = f.store.read();
    assert.ok(
      taskProgress(
        f.h,
        s,
        s.tasks.find((t) => t.id === f.held.id)!,
        Date.now(),
      ).reasons.includes('owner_question_pending'),
    );
    assert.ok(
      !taskProgress(
        f.h,
        s,
        s.tasks.find((t) => t.id === f.free.id)!,
        Date.now(),
      ).reasons.includes('owner_question_pending'),
    );
    assert.throws(() => f.h.approve(f.board.id), pending(qid));
    assert.throws(() => f.h.approve(f.board.id, [f.held.id]), pending(qid));
    assert.throws(
      () => new LeadWorkflow(f.h).start({ kind: 'board', id: f.board.id, authorRuntime: 'codex' }),
      pending(qid),
    );
    // Ревью плана отказывает до модели: адаптеров нет, вызова не было бы.
    await assert.rejects(
      reviewPlan(f.h, f.root, f.board.id, 'codex', {} as never, undefined, [f.held.id]),
      pending(qid),
    );
    // Подсказка плана: удержанный черновик вне области ревью, назван в plan.questions.
    let next = devcontourHandoff(f.h).host;
    const card = byKey(
      (await new AttentionService(f.store, f.h).active()).items,
      `prep:q:${f.changeId}:${qid}`,
    )!;
    assert.deepEqual(
      card.impact.taskIds,
      [f.held.id],
      'карточка вопроса покрывает удержанный черновик',
    );
    assert.equal(card.section, 'product');
    assert.deepEqual(next.questions?.open, {
      product: 1,
      architecture: 0,
      design: 0,
      development: 0,
    });
    assert.equal(next.questions?.held, 1);
    // Свободный черновик выпускается без удержанного.
    f.h.approve(f.board.id, [f.free.id]);
    next = devcontourHandoff(f.h).host;
    // Осталась только удержанная работа: ожидание владельца, а не решение о плане.
    assert.equal(next.next?.action, 'wait');
    assert.equal(next.next?.code, 'owner-question-pending');
    assert.match(next.next.detail, /waits on the owner/);
    // Правка удержанного черновика его не выпускает (корень класса F80).
    const t = f.store.read().tasks.find((x) => x.id === f.held.id)!;
    f.h.editTask(
      f.held.id,
      {
        repositoryId: t.repositoryId,
        role: t.role,
        title: t.title,
        description: 'Уточнённая постановка до ответа',
        dependsOn: t.dependsOn,
        acceptance: t.acceptance,
        featureId: 'member-block',
      },
      specDigest(t),
    );
    assert.throws(() => f.h.approve(f.board.id, [f.held.id]), pending(qid));
    // Ответ владельца: удержание до решения ведущего, шаг owner-answer.
    answer(f, f.changeId, qid);
    assert.throws(() => f.h.approve(f.board.id, [f.held.id]), pending(qid));
    const host = devcontourHandoff(f.h).host;
    assert.equal(host.next?.code, 'owner-answer');
    assert.equal(host.next?.decision, 'question');
    assert.deepEqual(host.next?.question, { id: qid, changeId: f.changeId, section: 'product' });
    assert.match(host.next.detail, /preparation_resolve/);
    assert.equal(host.questions?.answered.length, 1);
    assert.deepEqual(
      { ...host.questions.answered[0], text: undefined },
      {
        id: qid,
        changeId: f.changeId,
        section: 'product',
        stage: 'product',
        text: undefined,
        answer: 'Убираем из постановки',
        choice: 'Убираем из постановки',
        blocks: [f.held.id],
      },
    );
    // Решение ведущего снимает удержание: черновик выпускается.
    f.p.execute('preparation_resolve', {
      changeId: f.changeId,
      questionId: qid,
      statement: 'Алгоритм подбора не обещаем',
      rationale: 'Ответ владельца',
      refs: { taskIds: [f.held.id], boardId: f.board.id },
    });
    assert.equal(questionHolds(f.store.read()).size, 0);
    assert.equal(devcontourHandoff(f.h).host.questions, undefined, 'вопросов больше нет');
    f.h.approve(f.board.id, [f.held.id]);
    assert.equal(f.store.read().tasks.find((x) => x.id === f.held.id)!.status, 'ready');
  } finally {
    f.cleanup();
  }
});

test('Удержание: только черновики; снятие вопроса выпускает; план называет удержанные вне ревью', () => {
  const f = heldFixture();
  try {
    f.h.approve(f.board.id, [f.free.id]);
    assert.throws(() => ask(f.p, f.changeId, [f.free.id]), /Удержать можно только черновики/);
    const extra = f.h.addTask(f.board.id, { ...input('Ещё черновик'), featureId: 'member-block' });
    const qid = ask(f.p, f.changeId, [f.held.id]);
    const plan = devcontourHandoff(f.h).host.next;
    assert.equal(plan?.decision, 'plan');
    assert.deepEqual(plan?.plan?.questions, [{ id: f.held.id, questionId: qid }]);
    assert.deepEqual(plan?.plan?.review, [extra.id], 'удержанный черновик вне области ревью');
    assert.match(plan.detail, /wait on an owner question/);
    f.p.execute('preparation_question', { changeId: f.changeId, withdraw: [qid] });
    assert.equal(questionHolds(f.store.read()).size, 0);
    f.h.approve(f.board.id, [f.held.id]);
  } finally {
    f.cleanup();
  }
});

test('Сводка вопросов по разделам: счёт, удержанные, записи и HTTP /api/questions/summary', async () => {
  const f = heldFixture();
  try {
    const held = ask(f.p, f.changeId, [f.held.id]);
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Какой линтер?', section: 'development', links: { boardIds: [f.board.id] } }],
    });
    answer(f, f.changeId, held);
    const sections = questionSummary(f.store.read(), hrefs.preparation);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(sections).map(([k, v]) => [
          k,
          [v.open, v.answeredPendingLead, v.blockedTasks, v.items.length],
        ]),
      ),
      {
        product: [0, 1, 1, 1],
        architecture: [0, 0, 0, 0],
        design: [0, 0, 0, 0],
        development: [1, 0, 0, 1],
      },
    );
    assert.equal(sections.product.items[0].recommended, 'Убираем из постановки');
    assert.deepEqual(sections.product.items[0].blocks, [f.held.id]);
    assert.deepEqual(sections.development.items[0].links, { boardIds: [f.board.id] });
    const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
    try {
      const before = f.store.revision();
      const response = await fetch(app.url + '/api/questions/summary');
      assert.equal(response.status, 200);
      const body = (await response.json()) as { sections: typeof sections; revision: number };
      assert.deepEqual(body.sections, JSON.parse(JSON.stringify(sections)));
      assert.equal(f.store.revision(), before, 'чтение ничего не пишет');
    } finally {
      await app.close();
    }
  } finally {
    f.cleanup();
  }
});

test('Ответ по индексу варианта ложится только на показанную редакцию вопроса', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [
        { text: 'Публичный профиль?', choices: [{ label: 'Закрытый' }, { label: 'Открытый' }] },
        { text: 'Прежний вопрос с options', options: ['Да', 'Нет'] },
      ],
    });
    const status = f.p.status(f.changeId) as unknown as {
      current: { questions: { id: string; version: string }[] };
    };
    const [shown, legacy] = status.current.questions;
    // Уточнение меняет порядок вариантов: прежний индекс 0 значил бы другое.
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      revise: [{ id: shown.id, choices: [{ label: 'Открытый' }, { label: 'Закрытый' }] }],
    });
    const operator = new Preparation(f.store, 'operator');
    assert.throws(
      () =>
        operator.answer({
          changeId: f.changeId,
          questionId: shown.id,
          choice: 0,
          expectedVersion: shown.version,
        }),
      (e: unknown) => e instanceof DomainError && e.details?.code === 'question-stale',
    );
    assert.equal(f.store.read().preparation!.changes[0].questions[0].status, 'open');
    // Ответ одним вариантом, без текста; у прежней строки — вариант options.
    operator.answer({
      changeId: f.changeId,
      questionId: legacy.id,
      choice: 1,
      expectedVersion: legacy.version,
    });
    const saved = f.store.read().preparation!.changes[0].questions[1];
    assert.deepEqual(saved.answer && [saved.answer.choice, saved.answer.text], [1, 'Нет']);

    // Карточка: уточнение между проверкой и записью отклоняет сама запись.
    const key = `prep:q:${f.changeId}:${shown.id}`;
    const card = byKey((await new AttentionService(f.store, undefined).active()).items, key)!;
    const racing = new AttentionService(f.store, undefined, {
      afterCheck: (a) => {
        f.p.execute('preparation_question', {
          changeId: f.changeId,
          revise: [{ id: shown.id, choices: [{ label: 'Закрытый' }, { label: 'Открытый' }] }],
        });
        return a;
      },
    });
    await assert.rejects(
      racing.act({
        sourceKey: key,
        occurrenceId: card.occurrenceId,
        expectedVersion: card.sourceVersion,
        action: 'answer',
        input: { optionId: '0' },
      }),
      /уточнён после показа/,
    );
    assert.equal(f.store.read().preparation!.changes[0].questions[0].status, 'open');
  } finally {
    f.cleanup();
  }
});

test('Отправка этапа: держит только открытый вопрос своего этапа, не вопрос разработки', () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: null,
      reason: 'Первичная постановка',
      content: product,
    });
    const digest = f.store.read().preparation!.changes[0].product.at(-1)!.digest;
    const submit = () =>
      f.p.execute('preparation_submit', {
        changeId: f.changeId,
        stage: 'product',
        expectedDigest: digest,
      });
    const asked = f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Вопрос продукта', section: 'product' }],
    }) as unknown as { questions: { id: string }[] };
    assert.throws(submit, /открытые вопросы этапа: 1/);
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      withdraw: [asked.questions[0].id],
      add: [{ text: 'Вопрос разработки', section: 'development' }],
    });
    submit();
    assert.equal(f.store.read().preparation!.changes[0].product.at(-1)!.status, 'in-review');
  } finally {
    f.cleanup();
  }
});

test('Удержание: карточка плана оператора меняет версию при снятии вопроса; режим operator называет owner-answer', async () => {
  const f = heldFixture();
  try {
    f.h.config.approvalMode = 'operator';
    const qid = ask(f.p, f.changeId, [f.held.id]);
    const key = `plan:${f.board.id}`;
    const before = byKey((await new AttentionService(f.store, f.h).active()).items, key)!;
    assert.match(before.reason, /Ждут решения владельца и не утверждаются/);
    f.p.execute('preparation_question', { changeId: f.changeId, withdraw: [qid] });
    const after = byKey((await new AttentionService(f.store, f.h).active()).items, key)!;
    assert.notEqual(after.sourceVersion, before.sourceVersion, 'область утверждения изменилась');
    await assert.rejects(
      new AttentionService(f.store, f.h).act({
        sourceKey: key,
        occurrenceId: before.occurrenceId,
        expectedVersion: before.sourceVersion,
        action: 'approve',
      }),
      /изменилась/,
    );
    assert.equal(f.store.read().tasks.find((t) => t.id === f.held.id)!.status, 'draft');
    // Ответ владельца в режиме operator — шаг ведущего, не общий шаг оператора.
    f.h.approve(f.board.id, [f.free.id]);
    const other = f.h.addTask(f.board.id, {
      ...input('Ещё удержанный'),
      featureId: 'member-block',
    });
    const second = ask(f.p, f.changeId, [other.id]);
    answer(f, f.changeId, second);
    const next = devcontourHandoff(f.h).host.next;
    assert.equal(next?.code, 'owner-answer');
    assert.equal(next?.question?.id, second);
  } finally {
    f.cleanup();
  }
});

test('Удержание: повтор workflow_start действующего задания возвращает его', () => {
  const f = heldFixture();
  try {
    const workflow = new LeadWorkflow(f.h);
    const job = workflow.start({ kind: 'board', id: f.board.id, authorRuntime: 'codex' });
    const qid = ask(f.p, f.changeId, [f.held.id]);
    const again = workflow.start({ kind: 'board', id: f.board.id, authorRuntime: 'codex' });
    assert.equal(again.key, job.key);
    assert.ok(qid);
  } finally {
    f.cleanup();
  }
});

test('Вопросы владельцу: учётные данные в URL под маской в сводке и пакете передачи', () => {
  const f = heldFixture();
  try {
    const leaked = 'https://alice:synthetic-pass@example.invalid/repo.git';
    const qid = (
      f.p.execute('preparation_question', {
        changeId: f.changeId,
        add: [
          {
            text: `Можно ли зеркалить ${leaked}?`,
            choices: [{ label: `Да, ${leaked}` }, { label: 'Нет' }],
            recommended: 0,
          },
        ],
      }) as unknown as { questions: { id: string }[] }
    ).questions[0].id;
    const summary = JSON.stringify(questionSummary(f.store.read(), hrefs.preparation));
    assert.doesNotMatch(summary, /synthetic-pass/);
    new Preparation(f.store, 'operator').answer({
      changeId: f.changeId,
      questionId: qid,
      choice: 0,
    });
    const host = JSON.stringify(devcontourHandoff(f.h).host);
    assert.doesNotMatch(host, /synthetic-pass/);
    assert.match(host, /\[REDACTED\]@example\.invalid/);
  } finally {
    f.cleanup();
  }
});

test('Удержание: новый вход доски — новое задание, удержание его отклоняет; доска без задания не прячется за ожиданием', () => {
  const f = heldFixture();
  try {
    const workflow = new LeadWorkflow(f.h);
    workflow.start({ kind: 'board', id: f.board.id, authorRuntime: 'codex' });
    const qid = ask(f.p, f.changeId, [f.held.id]);
    // Новый черновик меняет вход доски: прежнее задание не тот же вход.
    f.h.addTask(f.board.id, { ...input('Новый черновик'), featureId: 'member-block' });
    assert.throws(
      () => workflow.start({ kind: 'board', id: f.board.id, authorRuntime: 'codex' }),
      pending(qid),
    );
    // Вторая доска с утверждённым планом и без задания: её шаг — раньше ожидания владельца.
    const other = heldFixture();
    try {
      const q2 = ask(other.p, other.changeId, [other.held.id]);
      other.h.approve(other.board.id, [other.free.id]);
      const b2 = other.h.createBoard('Вторая доска');
      other.h.addTask(b2.id, { ...input('Готовая работа'), featureId: 'member-block' });
      other.h.approve(b2.id);
      const next = devcontourHandoff(other.h).host.next;
      assert.notEqual(next?.code, 'owner-question-pending');
      assert.equal(next?.boardId === other.board.id && next.action === 'wait', false);
      assert.ok(q2);
    } finally {
      other.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('Решение: ссылка на изменение контракта без проверки движка отклоняется; удержание остаётся', () => {
  const f = heldFixture();
  try {
    const qid = ask(f.p, f.changeId, [f.held.id]);
    answer(f, f.changeId, qid);
    assert.throws(
      () =>
        f.p.execute('preparation_resolve', {
          changeId: f.changeId,
          questionId: qid,
          statement: 'Решено через изменение контракта',
          rationale: 'Ответ владельца',
          refs: { contractChangeId: 'CC-missing' },
        }),
      /агентский API/,
    );
    const checked = new Preparation(f.store, 'lead', () => false);
    assert.throws(
      () =>
        checked.execute('preparation_resolve', {
          changeId: f.changeId,
          questionId: qid,
          statement: 'Решено через изменение контракта',
          rationale: 'Ответ владельца',
          refs: { contractChangeId: 'CC-missing', productRevision: 1 },
        }),
      /Изменение контракта не найдено: CC-missing/,
    );
    assert.equal(questionHolds(f.store.read()).size, 1);
  } finally {
    f.cleanup();
  }
});
