import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, fixture, input } from './helpers.ts';
import { approvePreparation } from './preparation-fixture.ts';
import type { AuditEvent, DevContourState } from '../src/core/model.ts';
import type { ProductView } from '../src/core/product-map.ts';
import { Preparation } from '../src/core/preparation.ts';
import { AttentionService, type AttentionView } from '../src/application/attention.ts';
import {
  HOME_LIMITS,
  attemptsOf,
  budgetOf,
  coverageOf,
  gatesOf,
  homeSlowView,
  homeView,
  loadOf,
  type HomeView,
} from '../src/application/home.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { harnessVersion } from '../src/harness/index.ts';

// Плитки «Ход работ» и «Исполнение» главной (S4): агрегаты по снимку версии
// и медленный ярус (карта продукта, проверки за сутки, бюджеты, расход).

type Run = DevContourState['runs'][number];
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** Попытка с нужными полями; остальное рядом с отчётом не читается. */
const run = (over: Partial<Run> & { id: string }): Run =>
  ({
    taskId: 'T-1',
    attempt: 1,
    status: 'succeeded',
    phase: 'done',
    startedAt: at(HOUR),
    leaseUntil: 0,
    evidence: [],
    ...over,
  }) as Run;
const evidence = (gate: string, passed: boolean, extra: Record<string, unknown> = {}) =>
  ({ gate, passed, kind: 'test', phase: 'candidate', ...extra }) as unknown as Run['evidence'][0];

const emptyAttention: AttentionView = {
  revision: 1,
  generatedAt: at(0),
  engineConnected: true,
  lead: { present: false, lastActivityAt: null },
  counts: {
    active: 0,
    unread: 0,
    byActor: { operator: { active: 0, unread: 0 }, lead: { active: 0, unread: 0 } },
  },
  items: [],
};

test('Home harness: attempts of the last 24 h by failure kind; a long tail folds into other', () => {
  const kinds = ['z0', 'z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7', 'z8', 'z9'];
  const runs = [
    run({
      id: 'old',
      status: 'failed',
      failureKind: 'gate',
      startedAt: at(25 * HOUR),
    }),
    run({ id: 'ok', status: 'succeeded' }),
    run({ id: 'cancel', status: 'cancelled' }),
    run({ id: 'gone', status: 'expired', failureKind: 'environment' }),
    run({ id: 'raw', status: 'failed' }),
    ...[0, 1, 2].map((i) => run({ id: `g${i}`, status: 'failed', failureKind: 'gate' })),
    ...kinds.map((k) => run({ id: k, status: 'failed', failureKind: k as Run['failureKind'] })),
  ];
  const a = attemptsOf(runs, NOW);
  // Старше суток — вне окна; отменённая — не сбой; истёкшая — сбой.
  assert.equal(a.total, runs.length - 1);
  assert.equal(a.failed, 1 + 1 + 3 + kinds.length);
  assert.equal(a.byKind.gate, 3);
  assert.equal(a.byKind.environment, 1);
  assert.equal(a.byKind.unknown, 1);
  const shown = Object.keys(a.byKind).filter((k) => k !== 'other');
  assert.equal(shown.length, HOME_LIMITS.failureKinds);
  // Сумма по классам равна числу сбоев: хвост не теряется.
  assert.equal(
    Object.values(a.byKind).reduce((s, n) => s + n, 0),
    a.failed,
  );
  assert.ok(a.byKind.other > 0);
});

test('Home harness: failing gates of the last 24 h, reused and not-applicable records are not runs', () => {
  const runs = [
    run({
      id: 'r1',
      evidence: [
        evidence('unit', false),
        evidence('unit', true),
        evidence('lint', true),
        evidence('e2e', false),
        evidence('e2e', false),
        evidence('e2e', true, { reusedEvidence: { runId: 'x' } }),
        evidence('types', false, { kind: 'not-applicable' }),
      ],
    }),
    run({ id: 'old', startedAt: at(30 * HOUR), evidence: [evidence('lint', false)] }),
    run({
      id: 'r2',
      evidence: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((g) => evidence(g, false)),
    }),
  ];
  const g = gatesOf(runs, NOW);
  assert.equal(g.total, 3 + 6, 'unit, lint, e2e and six more; not-applicable is not a gate run');
  assert.equal(g.failing.length, HOME_LIMITS.failingGates);
  assert.deepEqual(g.failing[0], { gate: 'e2e', failed: 2, passed: 0 });
  // Отказ старше суток не делает lint отказавшим.
  assert.ok(!g.failing.some((x) => x.gate === 'lint'));
  assert.deepEqual(
    gatesOf([run({ id: 'x', evidence: [evidence('unit', false), evidence('unit', true)] })], NOW)
      .failing,
    [{ gate: 'unit', failed: 1, passed: 1 }],
  );
});

test('Home harness: the budget holding work comes first, the workspace budget otherwise', () => {
  const b = (
    kind: 'task' | 'board' | 'workspace',
    state: 'within' | 'exceeded' | 'undetermined',
    extra: Record<string, unknown> = {},
  ) => ({
    scope: kind === 'workspace' ? { kind } : { kind, id: kind === 'task' ? 'T-1' : 'B-1' },
    state,
    limit: { usd: 10 },
    reportedUsd: 4,
    estimatedUsd: 1.5,
    unknownCalls: 0,
    unfinishedCalls: 0,
    ...extra,
  });
  assert.equal(budgetOf(undefined, at(0)), undefined);
  assert.equal(budgetOf({ budgets: [] }, at(0)), undefined);
  const within = budgetOf({ budgets: [b('task', 'within'), b('workspace', 'within')] }, at(0))!;
  assert.equal(within.scope, 'workspace');
  assert.equal(within.state, 'within');
  assert.equal(within.spentUsd, 5.5);
  assert.equal(within.limitUsd, 10);
  assert.equal(within.complete, true);
  assert.equal(within.exceeded, 0);
  const exhausted = budgetOf(
    {
      budgets: [
        b('workspace', 'within'),
        b('board', 'undetermined', { unknownCalls: 2 }),
        b('task', 'exceeded', { reason: 'Бюджет задачи T-1 исчерпан' }),
        b('board', 'exceeded'),
      ],
    },
    at(0),
  )!;
  assert.equal(exhausted.state, 'exceeded');
  assert.equal(exhausted.scope, 'task T-1');
  assert.equal(exhausted.reason, 'Бюджет задачи T-1 исчерпан');
  assert.equal(exhausted.exceeded, 2);
  assert.equal(exhausted.total, 4);
  const unknown = budgetOf({ budgets: [b('board', 'undetermined', { unknownCalls: 2 })] }, at(0))!;
  assert.equal(unknown.state, 'undetermined');
  assert.equal(unknown.complete, false);
  assert.equal(unknown.unknownCalls, 2);
});

test('Home progress: coverage from the product map, its reason when unavailable or failing', () => {
  const asOf = at(0);
  assert.equal(coverageOf(undefined, asOf, true), undefined);
  assert.deepEqual(coverageOf({ available: false, reason: 'Нет INTENT.md' }, asOf, false), {
    available: false,
    reason: 'Нет INTENT.md',
    asOf,
    href: '/?tab=product',
  });
  const failed = coverageOf({ error: 'git: ' + 'x'.repeat(1000) }, asOf, true)!;
  assert.equal(failed.available, false);
  assert.ok(!failed.available && failed.reason.length <= HOME_LIMITS.startupError);
  assert.equal(failed.href, '/?view=boards&tab=product');
  const view = {
    available: true,
    releaseId: 'r1',
    coverageComplete: false,
    releaseAccepted: false,
    issues: ['a', 'b'],
    unconfirmedScenarios: [{}],
    deferredScenarios: [{}, {}, {}],
  } as unknown as ProductView;
  assert.deepEqual(coverageOf(view, asOf, true), {
    available: true,
    releaseId: 'r1',
    complete: false,
    accepted: false,
    issueCount: 2,
    unconfirmed: 1,
    deferred: 3,
    asOf,
    href: '/?view=boards&tab=product',
  });
});

test('Home harness: server health — loop stalls and clock jumps of the last hour, journal, config, lead', () => {
  const f = fixture();
  try {
    const event = (type: string, msAgo: number, id: number): AuditEvent => ({
      id,
      at: at(msAgo),
      type,
      data: null,
    });
    const events = [
      event('server.loop-stalled', 5 * 60_000, 1),
      event('server.loop-stalled', 50 * 60_000, 2),
      event('server.loop-stalled', 2 * HOUR, 3),
      event('server.clock-jump', 10 * 60_000, 4),
      event('scheduler.error', 60_000, 5),
    ];
    const state = {
      ...f.store.view(),
      reconfigure: {
        operation: 'config-apply:budgets,prices',
        digest: 'd',
        requestedAt: at(1000),
      },
    } as DevContourState;
    const home = homeView({
      state,
      h: f.h,
      attention: emptyAttention,
      revision: 1,
      now: NOW,
      events,
      process: { journalError: 'EACCES journal.md', configDrift: 'budgets изменены' },
      leadMark: at(60_000),
    });
    const health = home.harness!.health;
    assert.equal(health.loopStalls1h, 2);
    assert.equal(health.clockJumps1h, 1);
    assert.equal(health.journalError, 'EACCES journal.md');
    assert.equal(health.configDrift, 'budgets изменены');
    assert.equal(health.configPending, 'Применяется config.json: budgets, prices');
    assert.deepEqual(health.lead, { present: true, lastActivityAt: at(60_000) });
    assert.equal(home.harness!.version, harnessVersion);
    assert.equal(home.harness!.concurrency, f.h.config.concurrency);
    assert.equal(home.harness!.href, '/?tab=settings');
    assert.equal(home.harness!.budgetHref, '/?tab=overview');
    assert.deepEqual(home.harness!.attempts24h, { total: 0, failed: 0, byKind: {} });
    // Без медленного яруса — ни проверок, ни бюджета (не нули).
    assert.equal(home.harness!.gates, undefined);
    assert.equal(home.harness!.budget, undefined);

    // Применение завершено, отметки ведущего нет, журнал в порядке.
    const calm = homeView({
      state: { ...state, reconfigure: { ...state.reconfigure!, appliedAt: at(10) } },
      h: f.h,
      attention: emptyAttention,
      revision: 1,
      now: NOW,
      events: [],
      leadMark: null,
    }).harness!.health;
    assert.deepEqual(calm, {
      loopStalls1h: 0,
      clockJumps1h: 0,
      lead: { present: false, lastActivityAt: null },
    });
    // Без движка — плитки исполнения нет.
    assert.equal(
      homeView({ state, h: undefined, attention: emptyAttention, revision: 1, now: NOW }).harness,
      undefined,
    );
  } finally {
    f.cleanup();
  }
});

test('Home progress: releases of the approved product, task totals and ChangeSet states', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Чат', '', 'main');
    const first = f.h.addTask(board.id, input('Первая'));
    const second = f.h.addTask(board.id, input('Вторая', [first.id]));
    f.h.addTask(board.id, input('Третья'));
    f.h.approve(board.id);
    complete(f.h, first.id);
    f.h.cancel(second.id, 'не нужна');
    const changeId = approvePreparation(new Preparation(f.store));
    const state = f.store.view();
    const sets = [
      { id: 'C-1', title: 'Принятый', acceptance: { at: at(0) }, verifications: [] },
      { id: 'C-2', title: 'Упавший', verifications: [{ status: 'failed' }] },
      {
        id: 'C-3',
        title: 'Проверяется',
        verifications: [{ status: 'failed' }, { status: 'active' }],
      },
    ] as unknown as DevContourState['changeSets'];
    const home = homeView({
      state: { ...state, changeSets: sets },
      h: f.h,
      attention: emptyAttention,
      revision: 1,
      now: NOW,
      slow: homeSlowView({
        state,
        now: NOW,
        preparation: true,
        product: { available: false, reason: 'нет карты' },
      }),
    });
    const p = home.progress!;
    assert.deepEqual(p.tasks, { total: 3, done: 1, remaining: 1, failed: 0, cancelled: 1 });
    assert.deepEqual(
      { ...p.changeSets, latest: undefined },
      { total: 3, accepted: 1, verifying: 1, failed: 1, latest: undefined },
    );
    assert.equal(p.changeSets.latest!.id, 'C-3');
    assert.equal(p.changeSets.latest!.status, 'verifying');
    assert.match(p.changeSets.latest!.href, /#changeset-C-3$/);
    const releases = Preparation.statusOf(state, changeId);
    if (!releases.enabled || !releases.current) throw new Error('preparation');
    assert.equal(p.releasesTotal, releases.current.releases.length);
    assert.ok(p.releasesTotal > 0);
    assert.equal(p.releases[0].id, releases.current.releases[0].id);
    assert.notEqual(p.releases[0].title, '');
    assert.equal(p.href, '/?view=boards&tab=progress');
    assert.equal(p.coverage!.available, false);
    // Медленный ярус пришёл и в исполнение: проверки за сутки названы.
    assert.deepEqual(home.harness!.gates!.failing, []);
    assert.equal(home.links.attention, '/?view=attention');
  } finally {
    f.cleanup();
  }
});

test('Home progress: no engine and no approved releases — no progress tile data', () => {
  const f = fixture();
  try {
    const home = homeView({
      state: f.store.view(),
      h: undefined,
      attention: emptyAttention,
      revision: 1,
      now: NOW,
    });
    assert.equal(home.progress, undefined);
    assert.equal(home.links.attention, '/?tab=attention');
  } finally {
    f.cleanup();
  }
});

test('Home slow tier: computed once across revisions within 30 s and shared with the product map', async () => {
  const f = fixture();
  const board = f.h.createBoard('Доска', '', 'main');
  const t = f.h.addTask(board.id, input('Задача'));
  f.h.approve(board.id);
  complete(f.h, t.id);
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const get = async () =>
      (await (await fetch(app.url + '/api/home')).json()) as HomeView & { etag: string };
    const first = await get();
    assert.equal(app.projections.homeSlows.computations, 1);
    const products = app.projections.products.computations;
    assert.equal(products, 1, 'the slow tier reads the product map through its cache');
    const asOf = first.harness!.gates!.asOf;
    for (let i = 0; i < 3; i++) {
      f.store.atomic(() => f.store.saveLocal('home-slow', undefined, 'k', { at: i }));
      const next = await get();
      assert.equal(next.harness!.gates!.asOf, asOf, 'slow tier reused within 30 s');
    }
    assert.equal(app.projections.homeSlows.computations, 1);
    assert.equal(app.projections.homes.computations, 4, 'the fast tier follows every revision');
    // Вкладка карты продукта получает то же вычисление.
    await fetch(app.url + '/api/product');
    assert.equal(app.projections.products.computations, products);
    assert.ok(first.harness!.attempts24h.total >= 1);
    assert.ok(first.harness!.gates!.total >= 1);
    assert.equal(first.harness!.usage!.calls >= 0, true);
    assert.equal(first.progress!.tasks.done, 1);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('Home: the per-revision path parses nothing once the slow tier is warm', async () => {
  const f = fixture();
  const board = f.h.createBoard('Доска', '', 'main');
  const t = f.h.addTask(board.id, input('Задача'));
  f.h.approve(board.id);
  complete(f.h, t.id);
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  const { Store } = await import('../src/core/store.ts');
  const proto = Store.prototype as unknown as {
    read: () => unknown;
    parseDocument: (t: string) => unknown;
  };
  const read = proto.read;
  const parse = proto.parseDocument;
  let calls = 0;
  try {
    await fetch(app.url + '/api/home');
    f.store.atomic(() => f.store.saveLocal('home-parse', undefined, 'k', { at: 1 }));
    await fetch(app.url + '/api/attention');
    proto.read = function (this: unknown) {
      calls++;
      return read.call(this);
    };
    proto.parseDocument = function (this: unknown, text: string) {
      calls++;
      return parse.call(this, text);
    };
    const home = (await (await fetch(app.url + '/api/home')).json()) as HomeView;
    assert.equal(calls, 0);
    assert.ok(home.harness && home.progress);
  } finally {
    proto.read = read;
    proto.parseDocument = parse;
    await app.close();
    f.cleanup();
  }
});

test('Home: attention service view stays the input of the home projection', () => {
  // Главная не считает центр внимания сама: тот же вид, те же числа.
  const f = fixture();
  try {
    const attention = new AttentionService(f.store, f.h).view({}, new Map());
    const home = homeView({ state: f.store.view(), h: f.h, attention, revision: 1, now: NOW });
    assert.equal(home.attention.active, attention.counts.active);
  } finally {
    f.cleanup();
  }
});

test('Home load: peak concurrency per 15 min with outcomes; overlapping runs, running clipped to now, empty history', () => {
  const empty = loadOf([], NOW);
  assert.equal(empty.peaks.length, HOME_LIMITS.loadBuckets);
  assert.equal(empty.hourly.length, 24);
  assert.ok(empty.peaks.every((p) => p.every((n) => n === 0)));
  assert.equal(Date.parse(empty.to) - Date.parse(empty.from), 24 * HOUR);
  assert.ok(Date.parse(empty.to) >= NOW && Date.parse(empty.to) - NOW < 15 * 60_000);

  const Q = 15 * 60_000;
  // Окно кончается на границе интервала после NOW (NOW — ровно 12:00).
  const bucket = (msAgo: number) => Math.floor((NOW - msAgo - Date.parse(empty.from)) / Q);
  const runs = [
    // Две попытки перекрываются в 11:05–11:10: пик 2 (принята и сбой).
    run({ id: 'a', status: 'succeeded', startedAt: at(60 * 60_000), finishedAt: at(50 * 60_000) }),
    run({ id: 'b', status: 'failed', startedAt: at(55 * 60_000), finishedAt: at(40 * 60_000) }),
    // Третья начинается после конца первой: пик не растёт до 3.
    run({ id: 'c', status: 'cancelled', startedAt: at(49 * 60_000), finishedAt: at(46 * 60_000) }),
    // Идущая попытка — до now, не дальше.
    run({ id: 'd', status: 'active', startedAt: at(20 * 60_000), leaseUntil: NOW + HOUR }),
    // Старше окна и начатая «в будущем» — вне графика.
    run({ id: 'old', status: 'succeeded', startedAt: at(30 * HOUR), finishedAt: at(29 * HOUR) }),
    run({ id: 'future', status: 'active', startedAt: new Date(NOW + 60_000).toISOString() }),
    // Оборванная без конца — до срока аренды.
    run({
      id: 'e',
      status: 'expired',
      startedAt: at(4 * HOUR),
      leaseUntil: NOW - 4 * HOUR + Q / 3,
    }),
  ];
  const load = loadOf(runs, NOW);
  const sum = (p: number[]) => p.reduce((x, y) => x + y, 0);
  assert.equal(load.peaks.length, HOME_LIMITS.loadBuckets);
  // 11:00–11:15: a (11:00–11:10) и b (11:05–11:20) перекрываются.
  assert.deepEqual(load.peaks[bucket(60 * 60_000)], [0, 1, 1, 0]);
  // 11:15–11:30: b до 11:20, c 11:11–11:14 уже кончилась.
  assert.deepEqual(load.peaks[bucket(45 * 60_000)], [0, 0, 1, 0]);
  // Идущая попытка: 11:40–12:00 и ни одного интервала после now.
  assert.deepEqual(load.peaks[bucket(20 * 60_000)], [1, 0, 0, 0]);
  assert.deepEqual(load.peaks[bucket(1)], [1, 0, 0, 0]);
  assert.ok(
    load.peaks.slice(bucket(0) + 1).every((p) => sum(p) === 0),
    'nothing after now',
  );
  // Оборванная — только интервал до срока аренды.
  assert.deepEqual(load.peaks[bucket(4 * HOUR)], [0, 0, 1, 0]);
  assert.equal(sum(load.peaks[bucket(4 * HOUR) + 1]), 0);
  assert.equal(Math.max(...load.peaks.map(sum)), 2);
  // По часам: начатые в окне и сбои среди них (failed, expired).
  assert.equal(
    load.hourly.reduce((n, [t]) => n + t, 0),
    5,
  );
  assert.equal(
    load.hourly.reduce((n, [, f]) => n + f, 0),
    2,
  );
});

test('Home load: the series size does not grow with history', () => {
  const runs = Array.from({ length: 3000 }, (_, i) =>
    run({
      id: `r${i}`,
      status: i % 3 ? 'succeeded' : 'failed',
      startedAt: at((i % 1440) * 60_000),
      finishedAt: at((i % 1440) * 60_000 - 5 * 60_000),
    }),
  );
  const started = performance.now();
  const load = loadOf(runs, NOW);
  const ms = performance.now() - started;
  assert.equal(load.peaks.length, HOME_LIMITS.loadBuckets);
  assert.ok(JSON.stringify(load).length < 4096, `${JSON.stringify(load).length} bytes`);
  assert.ok(ms < 2000, `${ms} ms`);
});
