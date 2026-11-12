import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Preparation, assertTaskPreparation, developmentBinding } from '../src/core/preparation.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { complete, fixture, input, MERGED } from './helpers.ts';
import {
  approvePreparation,
  approveProductOnly,
  approveStage,
  architecture,
  product,
} from './preparation-fixture.ts';

// Перенос критерия журнала в более поздний релиз: меняется только
// распределение по релизам, не то, что строится.
const releaseOnly = {
  ...product,
  releases: [
    product.releases[0],
    {
      id: 'r3',
      version: '0.3.0',
      title: 'Журнал позже',
      goal: 'Журнал решений — в третьем релизе.',
    },
  ],
  features: product.features.map((f) => ({
    ...f,
    acceptance: f.acceptance.map((a) => (a.releaseId === 'r2' ? { ...a, releaseId: 'r3' } : a)),
  })),
};
// Изменён текст критерия: вход архитектуры и дизайна другой.
const rescoped = {
  ...product,
  features: product.features.map((f, i) =>
    i ? f : { ...f, acceptance: [{ releaseId: 'r1', text: 'Блокировка имеет срок действия.' }] },
  ),
};

function plan(f: ReturnType<typeof fixture>) {
  const { boardId } = f.h.importPlan({
    title: 'Release',
    description: 'Цель: Release',
    tasks: [
      { ...input('Task one'), featureId: 'member-block', key: 'one', dependsOn: [], contracts: [] },
      {
        ...input('Task two'),
        featureId: 'moderation-log',
        key: 'two',
        dependsOn: [],
        contracts: [],
      },
    ],
  });
  f.h.approve(boardId);
  const [one, two] = f.store.read().tasks;
  return { boardId, one: one.id, two: two.id };
}
const saveProduct = (p: Preparation, changeId: string, content: typeof product) =>
  p.execute('preparation_product', {
    changeId,
    expectedDigest: p.store.read().preparation!.changes[0].product.at(-1)!.digest,
    reason: 'Перенос объёма',
    content,
  });
const view = (p: Preparation) => {
  const s = p.status();
  if (!s.enabled || !s.current) throw new Error('Missing preparation');
  return s;
};

test('Черновик и редакция на согласовании не останавливают разработку изменения', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approvePreparation(p);
    const bound = developmentBinding(f.store.read(), changeId)!;
    const { boardId, one } = plan(f);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, one);
    // Задача в работе: черновик и отправка на согласование доступны и не
    // меняют привязку.
    saveProduct(p, changeId, rescoped);
    assert.deepEqual(developmentBinding(f.store.read(), changeId), bound);
    let s = view(p);
    assert.equal(s.developmentReady, true);
    assert.equal(s.phase, 'development');
    assert.deepEqual(s.current!.binding.pendingProduct, {
      number: 2,
      status: 'draft',
      keepsChain: false,
    });
    assert.equal(s.current!.binding.productNumber, 1);
    assert.equal(s.current!.binding.fresh.architecture, true);
    approveStageSubmitOnly(p, changeId);
    assert.deepEqual(developmentBinding(f.store.read(), changeId), bound);
    new LeadWorkflow(f.h).input('board', boardId);
    for (const t of f.store.read().tasks) assertTaskPreparation(f.store.read(), t);
    // Новая редакция архитектуры поверх утверждённой тоже не останавливает работу.
    p.execute('preparation_architecture', {
      changeId,
      expectedDigest: f.store.read().preparation!.changes[0].architecture.at(-1)!.digest,
      reason: 'Уточнение решений',
      content: { ...architecture, summary: architecture.summary + ' Уточнено.' },
    });
    assert.deepEqual(developmentBinding(f.store.read(), changeId), bound);
    // Утверждение меняет привязку — оно по-прежнему ждёт остановки выдачи.
    assert.throws(
      () =>
        p.decide({
          changeId,
          stage: 'product',
          expectedDigest: f.store.read().preparation!.changes[0].product.at(-1)!.digest,
          decision: 'request-changes',
          comment: 'Оставить прежний критерий',
        }),
      /остановите выдачу/,
    );
    s = view(p);
    assert.equal(s.current!.binding.pendingProduct.status, 'in-review');
  } finally {
    f.cleanup();
  }
});

function approveStageSubmitOnly(p: Preparation, changeId: string) {
  const expectedDigest = p.store.read().preparation!.changes[0].product.at(-1)!.digest;
  p.execute('preparation_submit', { changeId, stage: 'product', expectedDigest });
}

test('Возвращённая на доработку редакция постановки не останавливает разработку', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approvePreparation(p);
    const bound = developmentBinding(f.store.read(), changeId)!;
    saveProduct(p, changeId, rescoped);
    approveStageSubmitOnly(p, changeId);
    p.decide({
      changeId,
      stage: 'product',
      expectedDigest: f.store.read().preparation!.changes[0].product.at(-1)!.digest,
      decision: 'request-changes',
      comment: 'Оставить прежний критерий',
    });
    assert.deepEqual(developmentBinding(f.store.read(), changeId), bound);
    const { one } = plan(f);
    f.h.pause(false);
    assert.equal(f.h.claim('test')!.taskId, one);
  } finally {
    f.cleanup();
  }
});

test('Перенос критерия между релизами: одно утверждение, цепочка и работа в полёте сохраняются', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approvePreparation(p);
    const before = developmentBinding(f.store.read(), changeId)!;
    const { boardId, one, two } = plan(f);
    complete(f.h, one);
    saveProduct(p, changeId, releaseOnly);
    assert.equal(view(p).current!.binding.pendingProduct!.keepsChain, true);
    approveStage(p, changeId, 'product');
    const after = developmentBinding(f.store.read(), changeId)!;
    // Новая постановка действует; архитектура и дизайн — прежние утверждённые.
    assert.notEqual(after.productDigest, before.productDigest);
    assert.deepEqual(
      { ...after, productDigest: undefined },
      { ...before, productDigest: undefined },
    );
    const s = view(p);
    assert.equal(s.phase, 'development');
    assert.equal(s.current!.binding.productNumber, 2);
    assert.equal(s.current!.binding.pendingProduct, undefined);
    assert.deepEqual(s.current!.binding.fresh, {
      architecture: true,
      references: true,
      concept: true,
      design: true,
    });
    assert.deepEqual(
      s.current!.releases.map((r) => r.id),
      ['r1', 'r3'],
    );
    // Выполненная задача и задача в очереди сохраняют свои digests и проходят.
    const state = f.store.read();
    assert.equal(
      state.tasks.find((t) => t.id === one)!.preparation!.productDigest,
      before.productDigest,
    );
    for (const t of state.tasks) assertTaskPreparation(state, t);
    complete(f.h, two);
    f.h.accept(boardId, MERGED);
    assert.equal(f.store.read().boards[0].revisions[0].status, 'accepted');
    // Новая работа привязывается к новой постановке.
    f.h.importPlan(
      {
        title: 'Stage two',
        description: 'Цель: Stage two',
        tasks: [
          {
            ...input('Task three'),
            featureId: 'member-block',
            key: 'three',
            dependsOn: [],
            contracts: [],
          },
        ],
      },
      boardId,
    );
    const three = f.store.read().tasks.find((t) => t.title === 'Task three')!;
    assert.equal(three.preparation!.productDigest, after.productDigest);
  } finally {
    f.cleanup();
  }
});

test('Изменение объёма постановки по-прежнему требует заново утвердить архитектуру и дизайн', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approvePreparation(p);
    const { one } = plan(f);
    saveProduct(p, changeId, rescoped);
    assert.equal(view(p).current!.binding.pendingProduct!.keepsChain, false);
    approveStage(p, changeId, 'product');
    assert.throws(() => developmentBinding(f.store.read(), changeId), /архитектуру/);
    const s = view(p);
    assert.equal(s.phase, 'architecture');
    assert.equal(s.current!.binding.fresh.architecture, false);
    const state = f.store.read();
    assert.throws(
      () =>
        assertTaskPreparation(
          state,
          state.tasks.find((t) => t.id === one)!,
        ),
      /архитектуру/,
    );
    // Прежняя архитектура не отправляется на согласование под новой постановкой.
    p.execute('preparation_architecture', {
      changeId,
      expectedDigest: state.preparation!.changes[0].architecture.at(-1)!.digest,
      reason: 'Под новую постановку',
      content: architecture,
    });
    assert.equal(view(p).current!.binding.fresh.architecture, true);
  } finally {
    f.cleanup();
  }
});

test('Без утверждённой архитектуры новая версия постановки не обещает сохранить цепочку', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approveProductOnly(p);
    saveProduct(p, changeId, releaseOnly);
    assert.deepEqual(view(p).current!.binding.pendingProduct, { number: 2, status: 'draft' });
    assert.equal(view(p).phase, 'architecture');
  } finally {
    f.cleanup();
  }
});
