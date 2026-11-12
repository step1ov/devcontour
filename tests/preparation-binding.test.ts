import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Preparation, assertTaskPreparation, developmentBinding } from '../src/core/preparation.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { DevContour } from '../src/core/service.ts';
import { Workspace } from '../src/core/workspace.ts';
import { preparationStore } from '../src/runner/start.ts';
import { AttentionService } from '../src/application/attention.ts';
import { byKey } from './attention-fixture.ts';
import { complete, fixture, input, MERGED } from './helpers.ts';
import {
  approveDesign,
  approveProductOnly,
  approveStage,
  architecture,
  product,
} from './preparation-fixture.ts';

type Brief = typeof product;
type Criteria = Brief['features'][number]['acceptance'];
const early = 'Блокировку можно снять досрочно.';
// Исходная постановка: у блокировки два критерия первого релиза.
const base: Brief = {
  ...product,
  features: product.features.map((f) =>
    f.id === 'member-block'
      ? { ...f, acceptance: [...f.acceptance, { releaseId: 'r1', text: early }] }
      : f,
  ),
};
const withCriteria = (brief: Brief, featureId: string, map: (a: Criteria) => Criteria): Brief => ({
  ...brief,
  features: brief.features.map((f) =>
    f.id === featureId ? { ...f, acceptance: map(f.acceptance) } : f,
  ),
});
// Перенос критерия в более поздний существующий релиз: меняется только
// распределение, не то, что строится.
const moved = withCriteria(base, 'member-block', (list) =>
  list.map((a) => (a.text === early ? { ...a, releaseId: 'r2' } : a)),
);
// Изменён текст критерия: вход архитектуры и дизайна другой.
const rescoped = withCriteria(base, 'member-block', (list) =>
  list.map((a, i) => (i ? a : { ...a, text: 'Блокировка имеет срок действия.' })),
);

function view(p: Preparation) {
  const s = p.status();
  if (!s.enabled || !s.current) throw new Error('Missing preparation');
  return s;
}
const pending = (p: Preparation) => view(p).current!.binding.pendingProduct;
function approveWith(p: Preparation, content: Brief) {
  p.execute('preparation_create', { title: 'Модерация чата' });
  const changeId = view(p).activeChangeId!;
  p.execute('preparation_product', {
    changeId,
    expectedDigest: null,
    reason: 'Первичная постановка',
    content,
  });
  approveStage(p, changeId, 'product');
  p.execute('preparation_architecture', {
    changeId,
    expectedDigest: null,
    reason: 'Первая архитектура',
    content: architecture,
  });
  approveStage(p, changeId, 'architecture');
  approveDesign(p, changeId);
  return changeId;
}
function plan(f: { h: DevContour; store: DevContour['store'] }) {
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
const latestDigest = (p: Preparation) =>
  p.store.read().preparation!.changes[0].product.at(-1)!.digest;
const saveProduct = (p: Preparation, changeId: string, content: Brief) =>
  p.execute('preparation_product', {
    changeId,
    expectedDigest: latestDigest(p),
    reason: 'Перенос объёма',
    content,
  });
const submitProduct = (p: Preparation, changeId: string) =>
  p.execute('preparation_submit', {
    changeId,
    stage: 'product',
    expectedDigest: latestDigest(p),
  });

test('Черновики и редакции на согласовании не останавливают разработку; утверждение ждёт остановки', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approveWith(p, base);
    const bound = developmentBinding(f.store.read(), changeId)!;
    const { boardId, one } = plan(f);
    f.h.pause(false);
    assert.equal(f.h.claim('test')!.taskId, one);
    // Задача в работе: черновик и отправка доступны и не меняют привязку.
    saveProduct(p, changeId, rescoped);
    assert.deepEqual(developmentBinding(f.store.read(), changeId), bound);
    const s = view(p);
    assert.equal(s.developmentReady, true);
    assert.equal(s.phase, 'development');
    assert.equal(s.current!.binding.productNumber, 1);
    assert.equal(s.current!.binding.productDigest, bound.productDigest);
    assert.equal(s.current!.binding.fresh.architecture, true);
    const first = pending(p)!;
    assert.deepEqual(
      [first.number, first.status, first.keepsChain, first.changes],
      [2, 'draft', false, []],
    );
    // Планирование видит утверждённую версию рядом с черновиком.
    assert.equal(s.current!.product!.number, 2);
    assert.equal(s.current!.boundProduct!.number, 1);
    submitProduct(p, changeId);
    assert.deepEqual(developmentBinding(f.store.read(), changeId), bound);
    // Ещё один черновик поверх редакции на согласовании.
    saveProduct(p, changeId, moved);
    assert.deepEqual(developmentBinding(f.store.read(), changeId), bound);
    assert.equal(pending(p)!.number, 3);
    assert.equal(pending(p)!.keepsChain, true);
    assert.deepEqual(pending(p)!.changes, [
      `критерий «${early}» (member-block) перенесён из r1 в r2`,
    ]);
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
    // Утверждение меняет привязку — даже перенос между релизами ждёт остановки.
    submitProduct(p, changeId);
    assert.throws(
      () =>
        p.decide({
          changeId,
          stage: 'product',
          expectedDigest: latestDigest(p),
          decision: 'approve',
          comment: '',
        }),
      /остановите выдачу/,
    );
    assert.equal(pending(p)!.status, 'in-review');
  } finally {
    f.cleanup();
  }
});

test('Возвращённая на доработку редакция постановки не останавливает разработку', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approveWith(p, base);
    const bound = developmentBinding(f.store.read(), changeId)!;
    saveProduct(p, changeId, rescoped);
    submitProduct(p, changeId);
    p.decide({
      changeId,
      stage: 'product',
      expectedDigest: latestDigest(p),
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
    const changeId = approveWith(p, base);
    const before = developmentBinding(f.store.read(), changeId)!;
    const { boardId, one, two } = plan(f);
    complete(f.h, one);
    saveProduct(p, changeId, moved);
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
    assert.equal(s.current!.boundProduct, undefined);
    assert.deepEqual(s.current!.binding.fresh, {
      architecture: true,
      references: true,
      concept: true,
      design: true,
    });
    // Выполненная задача и задача в очереди сохраняют свои digests и проходят.
    const state = f.store.read();
    assert.equal(
      state.tasks.find((t) => t.id === one)!.preparation!.productDigest,
      before.productDigest,
    );
    for (const t of state.tasks) assertTaskPreparation(state, t);
    complete(f.h, two);
    // Явный прежний digest во входе новой задачи — устаревшая привязка.
    assert.throws(
      () =>
        f.h.addTask(boardId, {
          ...input('Task late'),
          featureId: 'member-block',
          preparation: { changeId, productDigest: before.productDigest },
        }),
      /устарела/,
    );
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

test('ChangeSet проверяется и принимается с задачами, привязанными к прежней версии того же объёма', () => {
  const f = fixture();
  f.h.config.workspaceGates = [{ ...f.h.config.gates[0], repositoryId: 'main', artifacts: [] }];
  const h = new DevContour(f.store, f.h.config),
    p = new Preparation(f.store);
  try {
    const changeId = approveWith(p, base);
    const old = developmentBinding(f.store.read(), changeId)!.productDigest;
    const { boardId, one, two } = plan({ h, store: f.store });
    complete(h, one);
    complete(h, two);
    saveProduct(p, changeId, moved);
    approveStage(p, changeId, 'product');
    assert.ok(f.store.read().tasks.every((t) => t.preparation!.productDigest === old));
    const w = new Workspace(h);
    const c = w.create({
      title: 'Joint result',
      description: 'Совместная проверка',
      boardIds: [boardId],
    });
    const v = w.start(c.id);
    w.manifest(c.id, v.token, { main: { sha: 'b'.repeat(40), tree: 'd'.repeat(40) } });
    w.evidence(c.id, v.token, {
      gate: 'test',
      passed: true,
      command: ['fixture'],
      exitCode: 0,
      log: 'fixture',
      digest: 'e'.repeat(64),
      summary: 'Deterministic protocol fixture',
      artifacts: [],
    });
    w.finish(c.id, v.token);
    assert.equal(w.accept(c.id).status, 'accepted');
    // Контроль: после изменения объёма проверка тех же задач отказывает.
    const next = w.create({
      title: 'Joint result again',
      description: 'Совместная проверка',
      boardIds: [boardId],
      supersedes: c.id,
    });
    saveProduct(p, changeId, rescoped);
    approveStage(p, changeId, 'product');
    assert.throws(() => w.start(next.id), /архитектуру|не связана/);
  } finally {
    f.cleanup();
  }
});

test('Цепочку сохраняет только перенос критериев между прежними релизами', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approveWith(p, base);
    const keeps = (content: Brief) => {
      saveProduct(p, changeId, content);
      return pending(p)!.keepsChain;
    };
    assert.equal(keeps(moved), true);
    // Редакция на согласовании, поверх которой сохранён новый черновик, больше
    // не решается.
    submitProduct(p, changeId);
    const orphan = latestDigest(p);
    assert.equal(keeps(moved), true);
    assert.throws(
      () =>
        p.decide({
          changeId,
          stage: 'product',
          expectedDigest: orphan,
          decision: 'approve',
          comment: '',
        }),
      /Версия изменилась/,
    );
    // Порядок критериев внутри фичи.
    assert.equal(keeps(withCriteria(base, 'member-block', (list) => [...list].reverse())), false);
    // Критерий переходит в другую фичу.
    assert.equal(
      keeps(
        withCriteria(
          withCriteria(base, 'member-block', (list) => list.filter((a) => a.text !== early)),
          'moderation-log',
          (list) => [...list, { releaseId: 'r1', text: early }],
        ),
      ),
      false,
    );
    // Цель релиза — свободный текст и вход архитектуры.
    assert.equal(
      keeps({
        ...base,
        releases: base.releases.map((r, i) =>
          i ? r : { ...r, goal: r.goal + ' Работает офлайн.' },
        ),
      }),
      false,
    );
    assert.deepEqual(pending(p)!.changes, ['у релиза r1 изменены: цель']);
    // Переименованный релиз.
    const renamed: Brief = {
      ...base,
      releases: base.releases.map((r) => (r.id === 'r2' ? { ...r, id: 'r9' } : r)),
      features: base.features.map((f) => ({
        ...f,
        acceptance: f.acceptance.map((a) => (a.releaseId === 'r2' ? { ...a, releaseId: 'r9' } : a)),
      })),
    };
    assert.equal(keeps(renamed), false);
    assert.ok(pending(p)!.changes!.includes('добавлен релиз r9'));
    assert.ok(pending(p)!.changes!.includes('удалён релиз r2'));
    // Добавленный релиз с перенесённым в него критерием.
    const later = withCriteria(base, 'member-block', (list) =>
      list.map((a) => (a.text === early ? { ...a, releaseId: 'r3' } : a)),
    );
    assert.equal(
      keeps({
        ...later,
        releases: [
          ...later.releases,
          { id: 'r3', version: '0.3.0', title: 'Третий релиз', goal: 'Досрочное снятие позже.' },
        ],
      }),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('Возврат к прежнему объёму: P1 → P2 (объём) → P3 (= P1) оживляет цепочку P1', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approveWith(p, base);
    const first = developmentBinding(f.store.read(), changeId)!;
    plan(f);
    saveProduct(p, changeId, rescoped);
    approveStage(p, changeId, 'product');
    assert.throws(() => developmentBinding(f.store.read(), changeId), /архитектуру/);
    saveProduct(p, changeId, base);
    assert.equal(pending(p)!.keepsChain, true);
    approveStage(p, changeId, 'product');
    const revived = developmentBinding(f.store.read(), changeId)!;
    assert.deepEqual(
      { ...revived, productDigest: undefined },
      { ...first, productDigest: undefined },
    );
    // Задачи, привязанные к P1, снова действуют: P1 утверждена и того же объёма.
    for (const t of f.store.read().tasks) assertTaskPreparation(f.store.read(), t);
  } finally {
    f.cleanup();
  }
});

test('Перенос критерия в релиз с выполненной работой называется в форме решения', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approveWith(p, base);
    const { one, two } = plan(f);
    complete(f.h, one);
    complete(f.h, two);
    assert.equal(view(p).current!.releases.find((r) => r.id === 'r2')!.readiness, 'done');
    saveProduct(p, changeId, moved);
    const impact = pending(p)!;
    assert.equal(impact.warnings.length, 1);
    assert.match(impact.warnings[0], /переносится в релиз r2, где работа/);
  } finally {
    f.cleanup();
  }
});

test('Проекция показывает утверждённую версию, черновик — отдельным файлом', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-projection-'));
  const store = preparationStore(join(root, '.devcontour-local'));
  try {
    const p = new Preparation(store);
    const changeId = approveWith(p, base);
    const dir = join(root, 'docs', 'changes', store.read().preparation!.changes[0].key);
    assert.equal(existsSync(join(dir, 'product.draft.md')), false);
    saveProduct(p, changeId, rescoped);
    const bound = readFileSync(join(dir, 'product.md'), 'utf8');
    assert.match(bound, /Разработка идёт по утверждённой версии 1\. Версия 2 \(черновик агента\)/);
    assert.match(bound, /Версия 1 · утверждено/);
    assert.doesNotMatch(bound, /Блокировка имеет срок действия/);
    const draft = readFileSync(join(dir, 'product.draft.md'), 'utf8');
    assert.match(draft, /Не планируйте по этому файлу/);
    assert.match(draft, /Блокировка имеет срок действия/);
    assert.match(
      readFileSync(join(root, 'docs', 'changes', 'README.md'), 'utf8'),
      /v1 · утверждено \(действует\); v2 · черновик агента/,
    );
    // Черновик архитектуры поверх утверждённой — так же.
    p.execute('preparation_architecture', {
      changeId,
      expectedDigest: store.read().preparation!.changes[0].architecture.at(-1)!.digest,
      reason: 'Уточнение решений',
      content: { ...architecture, summary: architecture.summary + ' Уточнено.' },
    });
    assert.match(
      readFileSync(join(dir, 'architecture.md'), 'utf8'),
      /Разработка идёт по утверждённой версии 1/,
    );
    assert.match(readFileSync(join(dir, 'architecture.draft.md'), 'utf8'), /Уточнено\./);
    // После решения черновик действует, файл черновика — отсылка к действующему.
    approveStage(p, changeId, 'product');
    assert.match(readFileSync(join(dir, 'product.md'), 'utf8'), /Блокировка имеет срок действия/);
    assert.match(readFileSync(join(dir, 'product.draft.md'), 'utf8'), /Неутверждённой версии/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Без утверждённой архитектуры новая версия постановки не обещает сохранить цепочку', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approveProductOnly(p);
    saveProduct(p, changeId, { ...product, outcome: product.outcome + ' Уточнено.' });
    assert.equal(pending(p)!.keepsChain, undefined);
    assert.equal(view(p).phase, 'architecture');
  } finally {
    f.cleanup();
  }
});

test('Изменение объёма постановки по-прежнему требует заново утвердить архитектуру и дизайн', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approveWith(p, base);
    const { one } = plan(f);
    saveProduct(p, changeId, rescoped);
    assert.equal(pending(p)!.keepsChain, false);
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
    // Новая архитектура строится по новой постановке и сразу актуальна.
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

test('Карточка центра внимания говорит, что сделает утверждение версии постановки', async () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const changeId = approveWith(p, base);
    const reason = async () =>
      byKey(
        (await new AttentionService(f.store, undefined).active()).items,
        `prep:stage:${changeId}:product`,
      )!.reason;
    saveProduct(p, changeId, moved);
    submitProduct(p, changeId);
    assert.match(await reason(), /архитектура и дизайн остаются в силе/);
    assert.match(await reason(), /перенесён из r1 в r2/);
    saveProduct(p, changeId, rescoped);
    submitProduct(p, changeId);
    assert.match(await reason(), /архитектуру и дизайн нужно утвердить заново/);
  } finally {
    f.cleanup();
  }
});
