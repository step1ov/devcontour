import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { complete, fixture, input } from './helpers.ts';
import {
  approveArchitectureOnly,
  approvePreparation,
  approveProductOnly,
  approveStage,
  architecture,
  references,
} from './preparation-fixture.ts';
import { LARGE, amplifyHistory, completedDemo } from './large-history.ts';
import { demoPool } from './demo-pool.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Preparation } from '../src/core/preparation.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import {
  attentionSections,
  attentionSources,
  type AttentionItem,
} from '../src/core/attention-model.ts';
import { AttentionService, type AttentionView } from '../src/application/attention.ts';
import { HOME_LIMITS, homeView, sectionOf, type HomeView } from '../src/application/home.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';

type Home = HomeView & { etag: string };
const zeroSections = () =>
  Object.fromEntries(
    attentionSections.map((s) => [s, { operator: 0, lead: 0, unread: 0 }]),
  ) as AttentionView['counts']['bySection'];

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
  section: 'development',
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

test('Home: the section of a card is its own section from the attention center', () => {
  for (const source of attentionSources)
    for (const section of attentionSections)
      assert.equal(sectionOf(card({ source, section })), section, `${source} ${section}`);
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
      attention.items.filter((i) => i.actor === 'operator' && i.state.unread).length,
    );
    // Разделы — `counts.bySection` центра внимания, не свой подсчёт.
    assert.deepEqual(home.attention.bySection, attention.counts.bySection);
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

test('Home: section questions agree with /api/questions/summary — answers waiting for the lead, held drafts, recommended option, revision', async () => {
  const f = engineWithPreparation(0);
  const board = f.h.createBoard('Отложенное', '', 'main');
  const draft = f.h.addTask(board.id, input('Черновик под вопросом'));
  f.p.execute('preparation_question', {
    changeId: f.changeId,
    add: [
      {
        text: 'Какая палитра у тёмной темы?',
        section: 'design',
        choices: [{ label: 'Тёплая' }, { label: 'Холодная', consequence: 'Пересчёт токенов' }],
        recommended: 1,
        blocks: { taskIds: [draft.id] },
      },
      { text: 'Нужен ли экспорт истории?', section: 'product', options: ['да', 'нет'] },
      { text: 'Какой линтер ставить?', section: 'development' },
    ],
  });
  const product = f.store
    .view()
    .preparation!.changes[0].questions.find((q) => q.section === 'product')!;
  f.p.answer({ changeId: f.changeId, questionId: product.id, text: 'да' });
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const { body: home } = await getter(app.url)();
    const summary = (await (await fetch(app.url + '/api/questions/summary')).json()) as {
      revision: number;
      sections: Record<
        string,
        {
          open: number;
          answeredPendingLead: number;
          blockedTasks: number;
          items: { id: string; recommended?: string }[];
        }
      >;
    };
    assert.equal(summary.revision, home.revision);
    for (const section of attentionSections) {
      const own = home.sections[section].questions;
      assert.equal(own.answeredPendingLead, summary.sections[section].answeredPendingLead, section);
      assert.equal(own.blockedTasks, summary.sections[section].blockedTasks, section);
    }
    assert.equal(home.sections.product.questions.answeredPendingLead, 1);
    assert.equal(home.sections.design.questions.blockedTasks, 1);
    assert.equal(home.sections.design.questions.open, summary.sections.design.open);
    assert.equal(home.sections.design.questions.items[0].recommended, 'Холодная');
    assert.equal(summary.sections.design.items[0].recommended, 'Холодная');
    assert.equal(home.sections.development.questions.open >= 1, true);
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
      bySection: zeroSections(),
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

test('Home: a stale "design not applicable" is not reported as not applicable', async () => {
  const s = await bootstrapServer(() => Promise.resolve(undefined));
  try {
    const p = new Preparation(s.store);
    const changeId = approveArchitectureOnly(p);
    p.execute('preparation_references', {
      changeId,
      expectedDigest: null,
      reason: 'Интерфейс не затронут',
      content: { ...references, applicable: false, reason: 'Изменение без интерфейса' },
    });
    approveStage(p, changeId, 'references');
    const { body: skipped } = await s.get();
    assert.equal(skipped.sections.design.state, 'not-applicable');
    assert.deepEqual(
      skipped.sections.design.design!.steps.map((x) => x.state),
      ['approved', 'not-applicable', 'not-applicable'],
    );
    // Новая архитектура утверждена: отказ от дизайна относится к прежней.
    const view = p.status(changeId);
    if (!view.enabled) throw new Error('preparation');
    p.execute('preparation_architecture', {
      changeId,
      expectedDigest: view.current!.architecture!.digest,
      reason: 'Вторая архитектура',
      content: { ...architecture, summary: architecture.summary + ' Уточнено.' },
    });
    approveStage(p, changeId, 'architecture');
    const { body: stale } = await s.get();
    assert.equal(stale.sections.design.state, 'stale');
    assert.equal(stale.sections.design.design!.steps[0].state, 'stale');
    assert.match(stale.sections.design.href, /stage=references$/);
  } finally {
    await s.close();
  }
});

test('Home: before setup one approved change is enough to set up, and development links to the stage', async () => {
  const s = await bootstrapServer(() => Promise.resolve(undefined));
  try {
    const p = new Preparation(s.store);
    approvePreparation(p);
    p.execute('preparation_create', { title: 'Второе изменение' });
    const { body } = await s.get();
    assert.equal(body.change!.title, 'Второе изменение');
    assert.equal(body.sections.product.state, 'absent');
    assert.equal(body.sections.development.state, 'setting-up');
    assert.match(body.sections.development.href, /^\/\?change=[^&]+&stage=development$/);
  } finally {
    await s.close();
  }
});

test('Home: a running queue held by a failed task is blocked, not idle', async () => {
  const f = fixture();
  const board = f.h.createBoard('Доска', '', 'main');
  const first = f.h.addTask(board.id, input('Первая'));
  f.h.addTask(board.id, input('Зависимая', [first.id]));
  f.h.approve(board.id);
  f.store.change('test.failed', (s) => {
    s.tasks.find((t) => t.id === first.id)!.status = 'failed';
  });
  f.h.pause(false);
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const dev = (await getter(app.url)()).body.sections.development;
    assert.equal(dev.queue.paused, false);
    assert.equal(dev.queue.ready, 0);
    assert.equal(dev.state, 'blocked');
    assert.match(dev.blocker!, /ошибкой: 1/);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('Home: a failed job of an accepted board is settled; a truncated attention marks every section incomplete', () => {
  const f = fixture();
  const board = f.h.createBoard('Доска', '', 'main');
  const other = f.h.createBoard('Другая', '', 'main');
  const job = (id: string, status: string, startedAt: string) =>
    ({
      kind: 'board',
      id,
      key: id,
      stage: 1,
      status,
      startedAt,
      attempts: 1,
      history: [],
    }) as never;
  const list = mock.method(LeadWorkflow.prototype, 'list', (owner?: string) =>
    owner
      ? []
      : [
          job(board.id, 'running', '2026-11-19T00:00:00.000Z'),
          job(board.id, 'failed', '2026-11-19T01:00:00.000Z'),
          job(other.id, 'failed', '2026-11-19T00:00:00.000Z'),
        ],
  );
  try {
    const attention: AttentionView = {
      revision: 1,
      generatedAt: '2026-11-19T00:00:00.000Z',
      engineConnected: true,
      lead: { present: false, lastActivityAt: null },
      counts: {
        active: 201,
        unread: 0,
        byActor: { operator: { active: 201, unread: 0 }, lead: { active: 0, unread: 0 } },
        bySection: zeroSections(),
      },
      items: [],
      truncated: { count: 201 },
    };
    const at = () =>
      homeView({ state: f.store.view(), h: f.h, attention, revision: 1, now: Date.now() });
    // Последнее задание доски — упавшее; прежнее идущее им сменено.
    let jobs = at().sections.development.jobs;
    assert.deepEqual([jobs.running, jobs.failed], [0, 2]);
    f.store.change('test.accepted', (s) => {
      s.boards.find((b) => b.id === board.id)!.revisions.at(-1)!.status = 'accepted';
    });
    const home = at();
    jobs = home.sections.development.jobs;
    assert.deepEqual([jobs.failed, jobs.top.map((j) => j.id)], [1, [other.id]]);
    for (const section of Object.values(home.sections)) assert.equal(section.questions.more, true);
    // Очередь идёт, выдавать нечего, задание ведущего остановлено окончательно.
    f.h.pause(false);
    const stopped = at().sections.development;
    assert.equal(stopped.state, 'blocked');
    assert.match(stopped.blocker!, /остановлены: 1/);
    assert.equal(home.attention.truncated, 201);
  } finally {
    list.mock.restore();
    f.cleanup();
  }
});

test('Home: a running attempt is shown; a write during the attention computation recomputes both on one version', async () => {
  const f = fixture();
  const board = f.h.createBoard('Доска', '', 'main');
  const task = f.h.addTask(board.id, input('Идущая задача'));
  f.h.approve(board.id);
  f.h.pause(false);
  const run = f.h.claim('test')!;
  assert.equal(run.taskId, task.id);
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  const proto = AttentionService.prototype as unknown as {
    view: (this: AttentionService, ...args: Parameters<AttentionService['view']>) => AttentionView;
  };
  const original = proto.view;
  let writes = 0;
  const view = mock.method(
    AttentionService.prototype,
    'view',
    function (this: AttentionService, ...args: Parameters<AttentionService['view']>) {
      const value = original.apply(this, args);
      // Первая проекция центра внимания устаревает сразу: запись другого
      // клиента между ней и снимком главной.
      if (!writes++)
        f.store.atomic(() => f.store.saveLocal('home-race', undefined, 'k', { at: 1 }));
      return value;
    },
  );
  try {
    const { body } = await getter(app.url)();
    view.mock.restore();
    assert.equal(writes, 2, 'attention computed again for the new version');
    assert.equal(body.revision, f.store.revision());
    const dev = body.sections.development;
    assert.equal(dev.state, 'running');
    assert.equal(dev.runningTotal, 1);
    assert.equal(dev.runningNow[0].taskId, task.id);
    assert.equal(dev.runningNow[0].attempt, run.attempt);
    assert.match(dev.runningNow[0].href, /task=/);
    assert.equal(dev.boards.top[0].phase, 'running');
  } finally {
    view.mock.restore();
    await app.close();
    f.cleanup();
  }
});
