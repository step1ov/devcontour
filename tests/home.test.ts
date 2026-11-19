import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { complete, fixture, input } from './helpers.ts';
import { approvePreparation, approveProductOnly } from './preparation-fixture.ts';
import { LARGE, amplifyHistory, completedDemo } from './large-history.ts';
import { demoPool } from './demo-pool.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Preparation } from '../src/core/preparation.ts';
import { attentionSources, type AttentionItem } from '../src/core/attention-model.ts';
import { AttentionService, type AttentionView } from '../src/application/attention.ts';
import { HOME_LIMITS, homeView, sectionOf, type HomeView } from '../src/application/home.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';

type Home = HomeView & { etag: string };
const QUESTION_SOURCES = new Set(['prep-question', 'input', 'stand-in', 'discussion-needs-answer']);

/** Разборы строки документа и полные чтения `Store.read` (см. read-path.test.ts). */
function countParses() {
  const proto = Store.prototype as unknown as {
    parseDocument: (this: Store, text: string) => unknown;
    read: (this: Store) => ReturnType<Store['read']>;
  };
  const original = proto.parseDocument;
  const read = proto.read;
  let parses = 0;
  let reads = 0;
  proto.parseDocument = function (this: Store, text: string) {
    parses++;
    return original.call(this, text);
  };
  proto.read = function (this: Store) {
    reads++;
    return read.call(this);
  };
  return {
    get parses() {
      return parses;
    },
    get reads() {
      return reads;
    },
    reset() {
      parses = reads = 0;
    },
    restore() {
      proto.parseDocument = original;
      proto.read = read;
    },
  };
}

/** Движок с доской, выполненной задачей, утверждённой подготовкой и вопросами. */
function engineWithPreparation(questions = 1) {
  const f = fixture();
  const board = f.h.createBoard('Чат', '', 'main');
  const first = f.h.addTask(board.id, input('Первая задача'));
  f.h.addTask(board.id, input('Вторая задача', [first.id]));
  f.h.approve(board.id);
  complete(f.h, first.id);
  const p = new Preparation(f.store);
  const changeId = approvePreparation(p);
  for (let i = 0; i < questions; i++)
    p.execute('preparation_question', {
      changeId,
      stage: i % 2 ? 'architecture' : 'product',
      add: [{ text: `Вопрос номер ${i}: нужна ли модерация ночью?`, options: ['да', 'нет'] }],
    });
  return { ...f, p, changeId };
}

const getter =
  (url: string) =>
  async (query = '') => {
    const response = await fetch(url + '/api/home' + query);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    return { text, body: JSON.parse(text) as Home };
  };

const card = (over: Partial<AttentionItem>): AttentionItem => ({
  id: 'x',
  sourceKey: 'queue',
  occurrenceId: 'o',
  sourceVersion: 'v',
  source: 'queue',
  category: 'technical',
  actor: 'operator',
  title: 'Карточка',
  reason: '',
  impact: { tasks: 0, waiting: 0, boards: [], taskIds: [] },
  since: '2026-11-19T00:00:00.000Z',
  subject: { kind: 'queue', id: 'q', href: '/?view=boards' },
  evidence: [],
  actions: [],
  state: { read: false, acknowledged: false, unread: true },
  ...over,
});

test('Home: every attention source maps to one section; a card section of its own wins', () => {
  const stage = (s: string) => `/?change=C-1&stage=${s}#questions-${s}`;
  const expected: Record<string, string> = {};
  for (const source of attentionSources) expected[source] = 'development';
  for (const source of attentionSources) {
    if (!source.startsWith('prep-')) {
      assert.equal(sectionOf(card({ source })), 'development', source);
      continue;
    }
    for (const [s, section] of [
      ['product', 'product'],
      ['architecture', 'architecture'],
      ['references', 'design'],
      ['concept', 'design'],
      ['design', 'design'],
    ])
      assert.equal(
        sectionOf(card({ source, subject: { kind: 'change', id: 'C-1', href: stage(s) } })),
        section,
        `${source} ${s}`,
      );
    // Ссылка без этапа (изменение целиком) — продукт.
    assert.equal(
      sectionOf(card({ source, subject: { kind: 'change', id: 'C-1', href: '/?change=C-1' } })),
      'product',
    );
  }
  // Раздел карточки (поле центра внимания) — единственный источник правды.
  const tagged = { ...card({ source: 'input' }), section: 'product' } as AttentionItem;
  assert.equal(sectionOf(tagged), 'product');
  const unknown = { ...card({ source: 'input' }), section: 'elsewhere' } as AttentionItem;
  assert.equal(sectionOf(unknown), 'development');
});

test('Home: counts equal the attention counts; questions per section with recommended options', async () => {
  const f = engineWithPreparation(2);
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const { body: home } = await getter(app.url)();
    const attention = (await (await fetch(app.url + '/api/attention')).json()) as AttentionView;
    assert.equal(home.attention.active, attention.counts.active);
    assert.equal(home.attention.unread, attention.counts.unread);
    const sections = Object.values(home.attention.bySection);
    assert.equal(
      sections.reduce((n, s) => n + s.operator + s.lead, 0),
      attention.counts.active,
    );
    assert.equal(
      sections.reduce((n, s) => n + s.operator, 0),
      attention.counts.byActor.operator.active,
    );
    assert.equal(
      sections.reduce((n, s) => n + s.unread, 0),
      attention.items.filter((i) => i.state.unread).length,
    );
    assert.deepEqual(home.sections.development.waitsOn.operator, attention.counts.byActor.operator);
    assert.deepEqual(home.sections.development.waitsOn.lead, attention.counts.byActor.lead);
    const asked = attention.items.filter(
      (i) => i.actor === 'operator' && QUESTION_SOURCES.has(i.source),
    ).length;
    const { product, architecture, design, development } = home.sections;
    assert.equal(
      product.questions.open +
        architecture.questions.open +
        design.questions.open +
        development.questions.open,
      asked,
    );
    assert.equal(product.questions.open, 1);
    assert.equal(architecture.questions.open, 1);
    assert.match(product.questions.items[0].title, /Вопрос номер 0/);
    assert.equal(product.questions.items[0].kind, 'prep-question');
    assert.match(product.questions.items[0].href, /stage=product#questions-product$/);

    // Ответ уходит из «открытых» в «ждёт решения ведущего» своего раздела.
    const q = f.store.view().preparation!.changes[0].questions.find((x) => x.stage === 'product')!;
    f.p.answer({ changeId: f.changeId, questionId: q.id, text: 'да' });
    const { body: answered } = await getter(app.url)();
    assert.equal(answered.sections.product.questions.open, 0);
    assert.equal(answered.sections.product.questions.answeredPendingLead, 1);
    assert.equal(answered.sections.architecture.questions.open, 1);

    // Подготовка утверждена: этапы, факты и шаги дизайна.
    assert.equal(product.state, 'approved');
    assert.equal(product.decidedBy, 'operator');
    assert.ok(product.facts.some((x) => x.label === 'Фичи' && Number(x.value) > 0));
    assert.ok(product.facts.length <= HOME_LIMITS.facts);
    assert.equal(architecture.state, 'approved');
    assert.ok(architecture.facts.some((x) => x.label === 'Контракты'));
    assert.equal(design.state, 'approved');
    assert.deepEqual(
      design.design!.steps.map((s) => s.state),
      ['approved', 'approved', 'approved'],
    );
    assert.equal(home.shell, 'development');
    assert.equal(home.change!.id, f.changeId);
    assert.equal(development.boards.live + development.boards.accepted >= 1, true);
    assert.match(development.href, /^\/\?view=boards&tab=kanban/);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('Home: recommended option and stand-in/discussion kinds come from the card', () => {
  const view: AttentionView = {
    revision: 1,
    generatedAt: '2026-11-19T00:00:00.000Z',
    engineConnected: false,
    lead: { present: false, lastActivityAt: null },
    counts: {
      active: 3,
      unread: 3,
      byActor: { operator: { active: 3, unread: 3 }, lead: { active: 0, unread: 0 } },
    },
    items: [
      card({
        id: 'a',
        source: 'input',
        category: 'question',
        title: 'Исполнитель спрашивает',
        actions: [
          {
            id: 'answer',
            kind: 'domain',
            label: 'Ответить',
            choices: [
              { id: '0', label: 'Первый' },
              { id: '1', label: 'Второй', recommended: true },
            ],
          },
        ],
      }),
      card({ id: 'b', source: 'stand-in', category: 'decision' }),
      card({ id: 'c', source: 'discussion-needs-answer', category: 'question' }),
    ],
  };
  const f = fixture();
  try {
    const home = homeView({
      state: f.store.view(),
      h: undefined,
      attention: view,
      revision: 1,
      now: 0,
    });
    const q = home.sections.development.questions;
    assert.deepEqual(
      q.items.map((i) => [i.kind, i.recommended]),
      [
        ['input', 'Второй'],
        ['stand-in', undefined],
        ['discussion', undefined],
      ],
    );
    assert.equal(q.open, 3);
    assert.equal(q.more, false);
  } finally {
    f.cleanup();
  }
});

/** Сервер без движка на базе подготовки; `connect` — подключение контура. */
async function bootstrapServer(connect: () => Promise<undefined>) {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-home-'));
  const store = new Store(join(root, 'state.sqlite'));
  const app = await serve(undefined, undefined, { port: 0, bootstrap: { store, connect } });
  return {
    store,
    app,
    get: getter(app.url),
    async close() {
      await app.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Home: before setup — bootstrap and preparation only, without an engine', async () => {
  const s = await bootstrapServer(() => Promise.resolve(undefined));
  try {
    const { body: empty } = await s.get();
    assert.equal(empty.shell, 'bootstrap');
    assert.equal(empty.engineConnected, false);
    assert.equal(empty.change, undefined);
    assert.equal(empty.sections.product.state, 'absent');
    assert.equal(empty.sections.product.href, '/?stage=product');
    assert.equal(empty.sections.development.state, 'not-allowed');
    assert.ok(empty.sections.development.blocker);
    assert.equal(empty.sections.development.runningTotal, 0);
    assert.deepEqual(empty.sections.development.jobs, {
      running: 0,
      waiting: 0,
      failed: 0,
      top: [],
    });

    // Постановка утверждена, архитектура ещё нет: разработка не разрешена.
    approveProductOnly(new Preparation(s.store));
    const { body: product } = await s.get();
    assert.equal(product.shell, 'preparation');
    assert.equal(product.sections.product.state, 'approved');
    assert.equal(product.sections.architecture.state, 'absent');
    assert.equal(product.sections.design.state, 'absent');
    assert.equal(product.sections.design.href.includes('stage=references'), true);
    assert.equal(product.sections.development.state, 'not-allowed');
    assert.match(product.sections.architecture.href, /stage=architecture$/);
    assert.ok(!product.sections.architecture.facts.some((x) => x.label === 'Контракты'));
  } finally {
    await s.close();
  }
});

test('Home: the whole chain approved and the engine failing to connect — setting up, startupError capped', async () => {
  const s = await bootstrapServer(() =>
    Promise.reject(new Error('Нет конфигурации: ' + 'x'.repeat(1000))),
  );
  try {
    approvePreparation(new Preparation(s.store));
    // Отказ подключения записывается асинхронно: ждём первый.
    let home = (await s.get()).body;
    for (let i = 0; i < 50 && !home.startupError; i++) {
      await new Promise((r) => setTimeout(r, 20));
      home = (await s.get()).body;
    }
    assert.equal(home.shell, 'preparation');
    assert.equal(home.engineConnected, false);
    assert.match(home.startupError!, /^Нет конфигурации/);
    assert.ok(home.startupError!.length <= HOME_LIMITS.startupError);
    assert.equal(home.sections.development.state, 'setting-up');
    assert.match(home.sections.development.blocker!, /^Нет конфигурации/);
    assert.equal(home.sections.design.state, 'approved');
  } finally {
    await s.close();
  }
});

test('Home: development without preparation and without runs', async () => {
  const f = fixture();
  const board = f.h.createBoard('Доска', '', 'main');
  f.h.addTask(board.id, input('Черновик'));
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const { body: home } = await getter(app.url)();
    assert.equal(home.shell, 'development');
    assert.equal(home.change, undefined);
    assert.equal(home.sections.product.state, 'absent');
    assert.equal(home.sections.design.state, 'absent');
    // Контракты движка — архитектура и без подготовки.
    assert.deepEqual(home.sections.architecture.facts, [{ label: 'Контракты', value: 0 }]);
    const dev = home.sections.development;
    assert.deepEqual(dev.runningNow, []);
    assert.equal(dev.runningTotal, 0);
    assert.equal(dev.queue.drafts, 1);
    assert.equal(dev.queue.paused, true);
    assert.equal(dev.state, 'paused');
    assert.deepEqual(dev.boards.byPhase, { draft: 1 });
    assert.equal(dev.boards.top[0].id, board.id);
    assert.equal(dev.href, `/?tab=kanban&board=${board.id}`);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('Home: questions are capped with more; etag stays, ?etag answers unchanged, an answer changes it; one computation over 10 polls', async () => {
  const f = engineWithPreparation(9);
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const get = getter(app.url);
    const { body: first, text } = await get();
    const product = first.sections.product.questions;
    assert.equal(product.open, 5);
    assert.equal(product.items.length, HOME_LIMITS.questions);
    assert.equal(product.more, true);
    assert.equal(first.sections.architecture.questions.open, 4);
    assert.ok(Buffer.byteLength(text) < HOME_LIMITS.bytes);

    const computed = app.projections.homes.computations;
    for (let i = 0; i < 10; i++) {
      const { body } = await get(i % 2 ? '' : '?etag=' + first.etag);
      if (i % 2) assert.equal(body.etag, first.etag);
      else assert.deepEqual(body, { unchanged: true, etag: first.etag });
    }
    assert.equal(app.projections.homes.computations, computed, 'ten polls, no new computation');
    assert.equal(computed, 1);

    // Запись без перемены главной: пересчёт, метка прежняя.
    f.store.atomic(() => f.store.saveLocal('home-test', undefined, 'k', { at: 1 }));
    assert.deepEqual((await get('?etag=' + first.etag)).body, {
      unchanged: true,
      etag: first.etag,
    });
    assert.equal(app.projections.homes.computations, 2);

    // Ответ оператора — новая метка.
    const q = f.store.view().preparation!.changes[0].questions.find((x) => x.status === 'open')!;
    f.p.answer({ changeId: f.changeId, questionId: q.id, text: 'да' });
    const { body: changed } = await get('?etag=' + first.etag);
    assert.notEqual(changed.etag, first.etag);
    assert.equal(
      changed.sections.product.questions.open + changed.sections.architecture.questions.open,
      8,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('Home: over a computed attention view the home projection parses nothing and calls no Store.read', async () => {
  const f = engineWithPreparation(2);
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  const count = countParses();
  try {
    f.store.atomic(() => f.store.saveLocal('home-test', undefined, 'k', { at: 2 }));
    await fetch(app.url + '/api/attention');
    count.reset();
    await getter(app.url)();
    assert.equal(count.parses, 0);
    assert.equal(count.reads, 0);
    // Чистое вычисление над снимком — тоже.
    const service = new AttentionService(f.store, f.h);
    const attention = service.view({}, new Map());
    count.reset();
    homeView({ state: f.store.view(), h: f.h, attention, revision: 0, now: Date.now() });
    assert.equal(count.parses, 0);
    assert.equal(count.reads, 0);
  } finally {
    count.restore();
    await app.close();
    f.cleanup();
  }
});

const histories = demoPool(completedDemo);
after(() => histories.close());

test('Home: on a large history the response stays bounded; per-revision cost is recorded', async (t) => {
  const seed = await histories.acquire();
  const root = dirname(seed.root);
  amplifyHistory(seed.root, LARGE);
  const store = new Store(join(root, 'data', 'state.sqlite'));
  const h = new DevContour(store, loadConfig(join(root, 'data', 'config.json')));
  const app = await serve(h, new Scheduler(h, join(root, 'data')), { port: 0 });
  try {
    const p = new Preparation(store);
    p.execute('preparation_create', { title: 'Большая история' });
    const status = p.status();
    if (!status.enabled) throw new Error('preparation');
    for (let i = 0; i < 12; i++)
      p.execute('preparation_question', {
        changeId: status.activeChangeId!,
        stage: 'product',
        add: [{ text: `Длинный вопрос ${i}: ` + 'текст '.repeat(200), why: 'почему '.repeat(80) }],
      });
    const get = getter(app.url);
    const { text } = await get();
    const bytes = Buffer.byteLength(text);
    assert.ok(bytes < HOME_LIMITS.bytes, `${bytes} bytes`);

    // Пересчёт на новую ревизию: центр внимания и главная (запрос целиком)
    // и одна главная над готовым центром внимания (homeView).
    const samples: { request: number; home: number }[] = [];
    const service = new AttentionService(store, h);
    for (let i = 0; i < 5; i++) {
      store.atomic(() => store.saveLocal('home-bench', undefined, 'k', { at: i }));
      let started = performance.now();
      await get();
      const request = performance.now() - started;
      const attention = service.view({}, new Map());
      const state = store.view();
      started = performance.now();
      homeView({ state, h, attention, revision: store.revision(), now: Date.now() });
      samples.push({ request, home: performance.now() - started });
    }
    const median = (k: 'request' | 'home') =>
      samples.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    const { tasks, runs, boards } = store.view();
    t.diagnostic(
      `home bench: tasks ${tasks.length}, runs ${runs.length}, boards ${boards.length}, body ${bytes} B; ` +
        `per revision median: request ${median('request').toFixed(1)} ms, homeView ${median('home').toFixed(1)} ms`,
    );
    // Цель — меньше 50 мс на ревизию; предел щедрый (общий CI).
    assert.ok(median('home') < 500, `homeView ${median('home').toFixed(0)} ms`);
    // Повтор той же ревизии — из кэша.
    const started = performance.now();
    await get();
    t.diagnostic(`home warm request ${(performance.now() - started).toFixed(1)} ms`);
  } finally {
    await app.close();
    store.close();
    seed.release();
  }
});
