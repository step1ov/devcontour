import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, fixture, input } from './helpers.ts';
import { approvePreparation } from './preparation-fixture.ts';
import type { AuditEvent, DevContourState } from '../src/core/model.ts';
import type { ProductView } from '../src/core/product-map.ts';
import { Preparation } from '../src/core/preparation.ts';
import { AttentionService, type AttentionView } from '../src/application/attention.ts';
import { attentionSections } from '../src/core/attention-model.ts';
import {
  HOME_LIMITS,
  attemptsOf,
  budgetOf,
  coverageOf,
  gatesOf,
  gateTrendOf,
  homeSlowView,
  spendOf,
  homeView,
  loadOf,
  type HomeView,
} from '../src/application/home.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { harnessVersion } from '../src/harness/index.ts';
import type { UsageRecord } from '../src/core/usage.ts';

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
  ({
    gate,
    passed,
    kind: 'test',
    phase: 'candidate',
    createdAt: at(HOUR),
    ...extra,
  }) as unknown as Run['evidence'][0];

const zeroSections = () =>
  Object.fromEntries(
    attentionSections.map((s) => [s, { operator: 0, lead: 0, unread: 0 }]),
  ) as AttentionView['counts']['bySection'];

const emptyAttention: AttentionView = {
  revision: 1,
  generatedAt: at(0),
  engineConnected: true,
  lead: { present: false, lastActivityAt: null },
  counts: {
    active: 0,
    unread: 0,
    byActor: { operator: { active: 0, unread: 0 }, lead: { active: 0, unread: 0 } },
    bySection: zeroSections(),
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
    // Начатая позже now (расхождение часов) — не попытка этих суток.
    run({ id: 'future', status: 'failed', startedAt: at(-60_000) }),
    ...[0, 1, 2].map((i) => run({ id: `g${i}`, status: 'failed', failureKind: 'gate' })),
    ...kinds.map((k) => run({ id: k, status: 'failed', failureKind: k as Run['failureKind'] })),
  ];
  const a = attemptsOf(runs, NOW);
  // Старше суток — вне окна; отменённая — не сбой; истёкшая — сбой.
  assert.equal(a.total, runs.length - 2);
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
    run({
      id: 'old',
      startedAt: at(30 * HOUR),
      finishedAt: at(29 * HOUR),
      evidence: [evidence('lint', false, { createdAt: at(29 * HOUR) })],
    }),
    // Начата больше суток назад, проверка записана минуту назад: она в окне.
    run({
      id: 'long',
      startedAt: at(25 * HOUR),
      evidence: [
        evidence('long-gate', false, { createdAt: at(60_000) }),
        evidence('long-gate', true, { createdAt: at(25 * HOUR - 1000) }),
      ],
    }),
    run({
      id: 'r2',
      evidence: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((g) => evidence(g, false)),
    }),
  ];
  const g = gatesOf(runs, NOW);
  assert.equal(
    g.total,
    3 + 6 + 1,
    'unit, lint, e2e, six more and long-gate; not-applicable is not a gate run',
  );
  assert.equal(g.failing.length, HOME_LIMITS.failingGates);
  assert.deepEqual(g.failing[0], { gate: 'e2e', failed: 2, passed: 0 });
  assert.deepEqual(
    gatesOf(
      runs.filter((r) => r.id === 'long'),
      NOW,
    ).failing,
    [{ gate: 'long-gate', failed: 1, passed: 0 }],
    'evidence time, not attempt start, decides the window',
  );
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
    // Порядок массива после sync — по ключам: самый новый (C-3) стоит первым.
    const sets = [
      {
        id: 'C-3',
        title: 'Проверяется',
        createdAt: at(HOUR),
        verifications: [{ status: 'failed' }, { status: 'active' }],
      },
      {
        id: 'C-1',
        title: 'Принятый',
        createdAt: at(3 * HOUR),
        acceptance: { at: at(0) },
        verifications: [],
      },
      {
        id: 'C-2',
        title: 'Упавший',
        createdAt: at(2 * HOUR),
        verifications: [{ status: 'failed' }],
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
    assert.deepEqual(
      p.releases.map(({ id, tasks, done, failed, criteria, readiness }) => ({
        id,
        tasks,
        done,
        failed,
        criteria,
        readiness,
      })),
      releases.current.releases
        .slice(0, HOME_LIMITS.releases)
        .map(({ id, tasks, done, failed, criteria, readiness }) => ({
          id,
          tasks,
          done,
          failed,
          criteria,
          readiness,
        })),
    );
    assert.ok(p.releases.some((r) => r.criteria > 0));
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

test('Home slow tier: computed once across revisions within 30 s, recomputed after them with a new asOf', async () => {
  const f = fixture();
  const board = f.h.createBoard('Доска', '', 'main');
  const t = f.h.addTask(board.id, input('Задача'));
  f.h.approve(board.id);
  complete(f.h, t.id);
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  const real = Date.now.bind(Date);
  let shift = 0;
  const clock = mock.method(Date, 'now', () => real() + shift);
  try {
    const get = async () =>
      (await (await fetch(app.url + '/api/home')).json()) as HomeView & { etag: string };
    const first = await get();
    assert.equal(app.projections.homeSlows.computations, 1);
    const asOf = first.harness!.gates!.asOf;
    for (let i = 0; i < 3; i++) {
      f.store.atomic(() => f.store.saveLocal('home-slow', undefined, 'k', { at: i }));
      const next = await get();
      assert.equal(next.harness!.gates!.asOf, asOf, 'slow tier reused within 30 s');
      assert.equal(next.harness!.load!.asOf, asOf);
    }
    assert.equal(app.projections.homeSlows.computations, 1);
    assert.equal(app.projections.homes.computations, 4, 'the fast tier follows every revision');
    // Через 30 с после записей — пересчёт и новый момент расчёта.
    shift = 31_000;
    const later = await get();
    assert.equal(app.projections.homeSlows.computations, 2);
    assert.ok(Date.parse(later.harness!.gates!.asOf) >= Date.parse(asOf) + 30_000);
    // Без новых записей — не пересчитывается и ещё через 30 с.
    shift = 62_000;
    await get();
    assert.equal(app.projections.homeSlows.computations, 2);
    assert.ok(first.harness!.attempts24h.total >= 1);
    assert.ok(first.harness!.gates!.total >= 1);
    assert.equal(first.harness!.usage!.calls >= 0, true);
    assert.equal(first.progress!.tasks.done, 1);
  } finally {
    clock.mock.restore();
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
  // now не на границе четверти часа: окно — ровно сутки до него.
  const now = NOW + 7 * 60_000;
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const Q = 15 * 60_000;
  const empty = loadOf([], now);
  assert.equal(empty.peaks.length, HOME_LIMITS.loadBuckets);
  assert.equal(empty.hourly.length, 24);
  assert.equal(empty.current, 0);
  assert.ok(empty.peaks.every((p) => p.every((n) => n === 0)));
  assert.equal(Date.parse(empty.to), now);
  assert.equal(Date.parse(empty.from), now - 24 * HOUR);
  // Интервал, в который попадает момент `msAgo` до now.
  const bucket = (msAgo: number) => Math.floor((24 * HOUR - msAgo) / Q);

  const runs = [
    // Перекрываются: пик 2 (принята и сбой).
    run({
      id: 'a',
      status: 'succeeded',
      startedAt: ago(60 * 60_000),
      finishedAt: ago(50 * 60_000),
    }),
    run({ id: 'b', status: 'failed', startedAt: ago(55 * 60_000), finishedAt: ago(40 * 60_000) }),
    // Начинается после конца первой: пик не растёт до 3.
    run({
      id: 'c',
      status: 'cancelled',
      startedAt: ago(49 * 60_000),
      finishedAt: ago(46 * 60_000),
    }),
    // Три принятые раньше в последнем интервале, потом одна идущая: «сейчас» — 1, не 0.
    ...[0, 1, 2].map((i) =>
      run({
        id: `early${i}`,
        status: 'succeeded',
        startedAt: ago(10 * 60_000),
        finishedAt: ago(6 * 60_000),
      }),
    ),
    run({ id: 'live', status: 'active', startedAt: ago(5 * 60_000), leaseUntil: now + HOUR }),
    // «Идущая» попытка упавшего controller: срок аренды истёк — нагрузки нет.
    run({
      id: 'dead',
      status: 'active',
      startedAt: ago(3 * HOUR),
      leaseUntil: now - 3 * HOUR + Q / 3,
    }),
    // Старше окна и начатая после now — вне графика и вне часов.
    run({ id: 'old', status: 'succeeded', startedAt: ago(30 * HOUR), finishedAt: ago(29 * HOUR) }),
    run({ id: 'future', status: 'failed', startedAt: new Date(now + 60_000).toISOString() }),
    // Оборванная без конца — до срока аренды.
    run({
      id: 'e',
      status: 'expired',
      startedAt: ago(4 * HOUR),
      leaseUntil: now - 4 * HOUR + Q / 3,
    }),
  ];
  const load = loadOf(runs, now);
  const sum = (p: number[]) => p.reduce((x, y) => x + y, 0);
  assert.equal(load.peaks.length, HOME_LIMITS.loadBuckets);
  assert.deepEqual(load.peaks[bucket(55 * 60_000)], [0, 1, 1, 0]);
  assert.equal(Math.max(...load.peaks.slice(0, bucket(20 * 60_000)).map(sum)), 2);
  // Последний интервал: пик — три принятые, но сейчас идёт одна.
  assert.deepEqual(load.peaks.at(-1), [0, 3, 0, 0]);
  assert.equal(load.current, 1);
  // Истёкшая аренда «идущей» — только до срока, дальше пусто.
  assert.deepEqual(load.peaks[bucket(3 * HOUR - 1)], [1, 0, 0, 0]);
  assert.equal(sum(load.peaks[bucket(3 * HOUR - 1) + 1]), 0);
  assert.equal(sum(load.peaks[bucket(3 * HOUR - 1) + 4]), 0);
  // Оборванная — только интервал до срока аренды.
  assert.deepEqual(load.peaks[bucket(4 * HOUR - 1)], [0, 0, 1, 0]);
  assert.equal(sum(load.peaks[bucket(4 * HOUR - 1) + 1]), 0);
  // По часам: начатые в [now − 24 ч, now) — без старой и будущей.
  assert.equal(
    load.hourly.reduce((n, [t]) => n + t, 0),
    runs.length - 2,
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

test('Home: unbounded strings from configuration and runs are clipped; a time-only budget keeps its limit', () => {
  const f = fixture();
  const board = f.h.createBoard('Доска', '', 'main');
  f.h.addTask(board.id, input('Задача'));
  f.h.approve(board.id);
  f.h.pause(false);
  const claimed = f.h.claim('test')!;
  try {
    const state = f.store.view();
    const huge = 'm'.repeat(70_000);
    const runs = state.runs.map((r) => (r.id === claimed.id ? { ...r, model: huge } : r));
    const home = homeView({
      state: { ...state, runs },
      h: f.h,
      attention: emptyAttention,
      revision: 1,
      now: Date.now(),
    });
    assert.ok(home.sections.development.runningNow[0].model!.length <= HOME_LIMITS.title);
    assert.ok(Buffer.byteLength(JSON.stringify(home)) < HOME_LIMITS.bytes);
  } finally {
    f.cleanup();
  }
  const time = budgetOf(
    {
      budgets: [
        {
          scope: { kind: 'workspace' },
          state: 'exceeded',
          limit: { timeMs: 3_600_000 },
          reportedUsd: 0,
          estimatedUsd: 0,
          unknownCalls: 0,
          unfinishedCalls: 0,
          durationMs: 4_000_000,
          reason: 'Бюджет времени workspace исчерпан',
        },
      ],
    },
    at(0),
  )!;
  assert.equal(time.limitMs, 3_600_000);
  assert.equal(time.spentMs, 4_000_000);
  assert.equal(time.limitUsd, undefined);
  assert.equal(time.reason, 'Бюджет времени workspace исчерпан');
});

test('Home windows: attempts, hourly, gates and current agree on [now - 24 h, now) and exact lease ends', () => {
  const now = NOW + 7 * 60_000;
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const runs = [
    // Ровно сутки назад — в окне; ровно now — ещё нет.
    run({
      id: 'edge',
      status: 'failed',
      startedAt: ago(24 * HOUR),
      finishedAt: ago(24 * HOUR - 60_000),
      evidence: [evidence('g', false, { createdAt: ago(24 * HOUR) })],
    }),
    run({
      id: 'now',
      status: 'active',
      startedAt: ago(0),
      leaseUntil: now + HOUR,
      evidence: [evidence('g', true, { createdAt: ago(0) })],
    }),
    // Аренда истекает ровно в now — уже не идёт; начатая ровно в now — тоже не «сейчас».
    run({ id: 'lease', status: 'active', startedAt: ago(10 * 60_000), leaseUntil: now }),
    run({ id: 'live', status: 'active', startedAt: ago(60_000), leaseUntil: now + 1 }),
  ];
  const attempts = attemptsOf(runs, now);
  const load = loadOf(runs, now);
  const hourlyTotal = load.hourly.reduce((n, [t]) => n + t, 0);
  assert.equal(attempts.total, 3, 'edge, lease, live; not the one starting at now');
  assert.equal(hourlyTotal, attempts.total, 'hourly totals agree with attempts of the day');
  assert.equal(
    load.hourly.reduce((n, [, f]) => n + f, 0),
    attempts.failed,
  );
  assert.deepEqual(gatesOf(runs, now).failing, [{ gate: 'g', failed: 1, passed: 0 }]);
  assert.equal(load.current, 2, 'live and the one starting at now; not the expired lease');
});

test('Home health: exact loop-stall counts come from the slow tier when present', () => {
  const f = fixture();
  try {
    const gapEvents = Array.from({ length: 600 }, (_, i) => ({
      id: i,
      at: at(i * 1000),
      type: i % 2 ? 'server.clock-jump' : 'server.loop-stalled',
      data: null,
    })) as AuditEvent[];
    const slow = homeSlowView({ state: f.store.view(), now: NOW, preparation: false, gapEvents });
    assert.deepEqual(slow.gaps, { loopStalls1h: 300, clockJumps1h: 300 });
    const home = homeView({
      state: f.store.view(),
      h: f.h,
      attention: emptyAttention,
      revision: 1,
      now: NOW,
      slow,
      // Окно последних событий пустое — счёт всё равно из медленного яруса.
      events: [],
    });
    assert.equal(home.harness!.health.loopStalls1h, 300);
    assert.equal(home.harness!.health.clockJumps1h, 300);
  } finally {
    f.cleanup();
  }
});

test('Home gate trend: records per hour over [now - 24 h, now), passed, failed and reused; not-applicable is not a record', () => {
  const now = NOW + 7 * 60_000;
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const runs = [
    run({
      id: 'r1',
      evidence: [
        evidence('unit', true, { createdAt: ago(30 * 60_000) }),
        evidence('unit', false, { createdAt: ago(30 * 60_000) }),
        evidence('e2e', true, { createdAt: ago(30 * 60_000), reusedEvidence: { runId: 'x' } }),
        evidence('types', false, { createdAt: ago(30 * 60_000), kind: 'not-applicable' }),
        // Ровно сутки назад — первый час окна; ровно now — ещё нет.
        evidence('edge', false, { createdAt: ago(24 * HOUR) }),
        evidence('future', true, { createdAt: ago(0) }),
      ],
    }),
    // Кончилась больше суток назад — записей в окне не несёт.
    run({
      id: 'old',
      startedAt: ago(30 * HOUR),
      finishedAt: ago(29 * HOUR),
      evidence: [evidence('lint', false, { createdAt: ago(29 * HOUR) })],
    }),
  ];
  const trend = gateTrendOf(runs, now);
  assert.equal(trend.hourly.length, 24);
  assert.equal(trend.from, ago(24 * HOUR));
  assert.equal(trend.to, ago(0));
  assert.deepEqual(trend.hourly[23], [1, 1, 1]);
  assert.deepEqual(trend.hourly[0], [0, 1, 0]);
  const sum = trend.hourly.reduce((n, [p, f, r]) => n + p + f + r, 0);
  assert.equal(sum, 4, 'unit twice, reused e2e and the edge record');
  // Отказы тренда — те же, что у сводки проверок за сутки.
  const failing = gatesOf(runs, now).failing.reduce((n, g) => n + g.failed, 0);
  assert.equal(
    trend.hourly.reduce((n, [, f]) => n + f, 0),
    failing,
  );
  // Размер постоянный при любой истории.
  const many = Array.from({ length: 2000 }, (_, i) =>
    run({
      id: `m${i}`,
      evidence: [evidence('g', i % 2 === 0, { createdAt: ago((i % 1440) * 60_000) })],
    }),
  );
  const big = gateTrendOf(many, now);
  assert.equal(big.hourly.length, 24);
  assert.ok(JSON.stringify(big).length < 1024);
});

test('Home spend: per server-local day over a week, unknown cost counted apart, the workspace limit kept', () => {
  const record = (over: Partial<UsageRecord> & { id: string; startedAt: string }): UsageRecord =>
    ({
      stage: 'implement',
      runtime: 'claude',
      model: 'm',
      runtimeVersion: null,
      outcome: 'returned',
      promptBytes: 0,
      promptDigest: '',
      usage: { complete: true },
      costUsd: 1,
      costSource: 'provider-reported',
      ...over,
    }) as UsageRecord;
  const midnight = (shift: number) => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + shift);
    return d.getTime();
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const records = [
    record({ id: 'today', startedAt: iso(midnight(0) + 1000), costUsd: 2.5 }),
    record({ id: 'today-midnight', startedAt: iso(midnight(0)), costUsd: 0.25 }),
    record({ id: 'first', startedAt: iso(midnight(-6)), costUsd: 1 }),
    record({ id: 'before', startedAt: iso(midnight(-6) - 1), costUsd: 10 }),
    // Неизвестная стоимость: не входит в сумму, считается вызовом.
    record({
      id: 'unknown',
      startedAt: iso(midnight(-2) + HOUR),
      costUsd: null,
      costSource: 'unknown',
    }),
    // Прерванный с оценкой по тарифу: оценка — нижняя граница, вызов неизвестен.
    record({
      id: 'abandoned',
      startedAt: iso(midnight(-2) + HOUR),
      outcome: 'abandoned',
      costUsd: 0.5,
      costSource: 'tariff-estimate',
    }),
    record({
      id: 'old-unknown',
      startedAt: iso(midnight(-30)),
      costUsd: null,
      costSource: 'unknown',
    }),
    // Начало позже now (часы переведены) — в последнем дне.
    record({ id: 'future', startedAt: iso(NOW + HOUR), costUsd: 0.25 }),
  ];
  const spend = spendOf(records, NOW, 100);
  const omitDate = ({ date, ...rest }: (typeof spend.days)[number]) => (void date, rest);
  // Дата дня — календарная по часам сервера.
  const local = new Date(midnight(-6));
  assert.equal(
    spend.days[0].date,
    `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`,
  );
  assert.equal(spend.days.length, HOME_LIMITS.spendDays);
  assert.equal(spend.days[0].start, iso(midnight(-6)));
  assert.equal(spend.days[6].start, iso(midnight(0)));
  assert.deepEqual(omitDate(spend.days[6]), {
    start: iso(midnight(0)),
    usd: 3,
    calls: 3,
    unknown: 0,
  });
  assert.deepEqual(omitDate(spend.days[0]), {
    start: iso(midnight(-6)),
    usd: 1,
    calls: 1,
    unknown: 0,
  });
  assert.deepEqual(omitDate(spend.days[4]), {
    start: iso(midnight(-2)),
    usd: 0.5,
    calls: 2,
    unknown: 2,
  });
  assert.equal(spend.beforeUsd, 10);
  assert.equal(spend.beforeUnknown, 1);
  assert.equal(spend.limitUsd, 100);
  // Сумма окна и до него — известная оценка всех записей (как usageTotals).
  const week = spend.days.reduce((n, d) => n + d.usd, 0);
  assert.equal(week + spend.beforeUsd, 14.5);
  assert.equal(spendOf([], NOW).limitUsd, undefined);
  assert.deepEqual(
    spendOf([], NOW).days.map((d) => d.usd),
    [0, 0, 0, 0, 0, 0, 0],
  );
  // Длинная история — тот же размер.
  const many = Array.from({ length: 5000 }, (_, i) =>
    record({ id: `u${i}`, startedAt: iso(NOW - (i % 600) * HOUR), costUsd: 0.01 }),
  );
  const big = spendOf(many, NOW, 5);
  assert.equal(big.days.length, HOME_LIMITS.spendDays);
  assert.ok(JSON.stringify(big).length < 1024);
});

test('Home slow tier: gate trend and spend carry asOf; the workspace limit comes from the budgets', () => {
  const f = fixture();
  try {
    const slow = homeSlowView({
      state: f.store.view(),
      now: NOW,
      preparation: false,
      budgets: {
        budgets: [
          {
            scope: { kind: 'task', id: 'T-1' },
            state: 'within',
            limit: { usd: 3 },
            reportedUsd: 0,
            estimatedUsd: 0,
            unknownCalls: 0,
            unfinishedCalls: 0,
          },
          {
            scope: { kind: 'workspace' },
            state: 'within',
            limit: { usd: 50 },
            reportedUsd: 0,
            estimatedUsd: 0,
            unknownCalls: 0,
            unfinishedCalls: 0,
          },
        ],
      },
      usageRecords: [],
    });
    assert.equal(slow.gateTrend.asOf, slow.asOf);
    assert.equal(slow.spend!.asOf, slow.asOf);
    assert.equal(slow.spend!.limitUsd, 50, 'the workspace limit, not a task one');
    assert.equal(
      homeSlowView({ state: f.store.view(), now: NOW, preparation: false }).spend,
      undefined,
    );
    const home = homeView({
      state: f.store.view(),
      h: f.h,
      attention: emptyAttention,
      revision: 1,
      now: NOW,
      slow,
    });
    assert.equal(home.harness!.gateTrend!.hourly.length, 24);
    assert.equal(home.harness!.spend!.days.length, HOME_LIMITS.spendDays);
  } finally {
    f.cleanup();
  }
});

test('Home progress: without preparation releases the product map releases feed the release bars', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Доска', '', 'main');
    f.h.addTask(board.id, input('Задача'));
    const view = {
      available: true,
      releaseId: 'r1',
      coverageComplete: false,
      releaseAccepted: false,
      issues: [],
      unconfirmedScenarios: [],
      deferredScenarios: [],
      releases: [
        { id: 'r1', title: 'Первый' },
        { id: 'r2', title: 'Второй' },
      ],
      features: [
        { id: 'F1', status: 'verified' },
        { id: 'F2', status: 'accepted' },
        { id: 'F3', status: 'in-progress' },
        { id: 'F4', status: 'deferred' },
        { id: 'F5', status: 'not-applicable' },
      ],
    } as unknown as ProductView;
    const coverage = coverageOf(view, at(0), false)!;
    assert.ok(coverage.available);
    assert.deepEqual(coverage.releases, [
      { id: 'r1', title: 'Первый', features: 3, done: 2, started: 3 },
      { id: 'r2', title: 'Второй' },
    ]);
    const slow = {
      ...homeSlowView({ state: f.store.view(), now: NOW, preparation: false }),
      coverage,
    };
    const home = homeView({
      state: f.store.view(),
      h: f.h,
      attention: emptyAttention,
      revision: 1,
      now: NOW,
      slow,
    });
    const progress = home.progress!;
    assert.equal(progress.releasesFrom, 'product-map');
    assert.equal(progress.releasesTotal, 2);
    assert.deepEqual(
      progress.releases.map((r) => [r.id, r.unit, r.tasks, r.done, r.readiness, r.measured]),
      [
        ['r1', 'features', 3, 2, 'in-progress', undefined],
        ['r2', 'features', 0, 0, 'unplanned', false],
      ],
    );
    // Без покрытия карты — релизов нет, источник не назван.
    const bare = homeView({
      state: f.store.view(),
      h: f.h,
      attention: emptyAttention,
      revision: 1,
      now: NOW,
    });
    assert.deepEqual(bare.progress!.releases, []);
    assert.equal(bare.progress!.releasesFrom, undefined);
  } finally {
    f.cleanup();
  }
});

test('Home spend: a midnight DST switch does not shift earlier days', () => {
  // Чили: 2026-09-06 часы переводятся в полночь, день начинается в 01:00.
  const before = process.env.TZ;
  process.env.TZ = 'America/Santiago';
  try {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const records = [
      // 5 сентября 00:30 по местному времени (UTC−4).
      {
        id: 'a',
        startedAt: '2026-09-05T04:30:00.000Z',
        outcome: 'returned',
        usage: { complete: true },
        costUsd: 1,
        costSource: 'provider-reported',
      },
    ] as unknown as UsageRecord[];
    const spend = spendOf(records, now);
    assert.deepEqual(
      spend.days.map((d) => d.date),
      [
        '2026-08-31',
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
        '2026-09-04',
        '2026-09-05',
        '2026-09-06',
      ],
    );
    assert.equal(spend.days[5].usd, 1, 'charged to 5 September, not 4');
    assert.equal(spend.days[4].usd, 0);
    // Каждый день начинается в местную полночь (кроме дня перевода — в 01:00).
    for (const d of spend.days.slice(0, 6)) assert.equal(new Date(d.start).getHours(), 0, d.date);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test('Home progress: the current map release follows the map acceptance and started features; done counts all releases', () => {
  const f = fixture();
  try {
    // Прежняя приёмка ChangeSet текущего релиза не делает его готовым.
    const state = {
      ...f.store.view(),
      changeSets: [
        {
          id: 'CS-1',
          title: 'CS-1',
          boardIds: [],
          verifications: [],
          createdAt: at(HOUR),
          releaseId: 'r1',
          acceptance: { at: at(HOUR) },
        },
        {
          id: 'CS-2',
          title: 'CS-2',
          boardIds: [],
          verifications: [],
          createdAt: at(HOUR),
          releaseId: 'r2',
          acceptance: { at: at(HOUR) },
        },
      ],
    } as unknown as DevContourState;
    const view = (
      accepted: boolean,
      features: { status: string; channels?: { covered?: boolean }[] }[],
      releases = [
        { id: 'r1', title: 'Текущий' },
        { id: 'r2', title: 'Принятый' },
        { id: 'r3', title: 'Потом' },
      ],
    ) =>
      ({
        available: true,
        releaseId: 'r1',
        coverageComplete: false,
        releaseAccepted: accepted,
        issues: [],
        unconfirmedScenarios: [],
        deferredScenarios: [],
        releases,
        features: features.map((x, i) => ({ id: `F${i}`, channels: [], checks: [], ...x })),
      }) as unknown as ProductView;
    // Медленный ярус из карты — как на сервере: покрытие и список всех релизов.
    const progress = (product: ProductView) =>
      homeView({
        state,
        h: f.h,
        attention: emptyAttention,
        revision: 1,
        now: NOW,
        slow: homeSlowView({ state, now: NOW, preparation: false, product }),
      }).progress!;
    const s = (status: string) => ({ status });
    const stale = progress(view(false, [s('awaiting-verification'), s('in-progress')]));
    assert.deepEqual(
      stale.releases.map((r) => [r.id, r.done, r.tasks, r.readiness]),
      [
        ['r1', 0, 2, 'in-progress'],
        ['r2', 0, 0, 'done'],
        ['r3', 0, 0, 'unplanned'],
      ],
    );
    assert.equal(stale.releasesDone, 1);
    assert.equal(stale.releasesTotal, 3);
    const accepted = progress(view(true, [s('accepted'), s('accepted')]));
    assert.equal(accepted.releases[0].readiness, 'done');
    assert.equal(accepted.releasesDone, 2);
    // Все фичи доказаны, но карта релиз не приняла (покрытие неполно) — в работе.
    const proven = progress(view(false, [s('verified'), s('verified')]));
    assert.equal(proven.releases[0].readiness, 'in-progress');
    assert.equal(proven.releases[0].done, 2);
    assert.equal(proven.releasesDone, 1);
    const fresh = progress(view(false, [s('unplanned')]));
    assert.equal(fresh.releases[0].readiness, 'unplanned');
    // `unplanned` с покрытым каналом — работа начата.
    const partly = progress(view(false, [{ status: 'unplanned', channels: [{ covered: true }] }]));
    assert.equal(partly.releases[0].readiness, 'in-progress');
    // Девять релизов: готовые считаются и за пределом показанных восьми.
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `r${i + 1}`, title: `R${i + 1}` }));
    const many = {
      ...state,
      changeSets: [
        ...state.changeSets,
        {
          id: 'CS-9',
          title: 'CS-9',
          boardIds: [],
          verifications: [],
          createdAt: at(HOUR),
          releaseId: 'r9',
          acceptance: { at: at(HOUR) },
        },
      ],
    } as unknown as DevContourState;
    const wide = homeView({
      state: many,
      h: f.h,
      attention: emptyAttention,
      revision: 1,
      now: NOW,
      slow: homeSlowView({
        state: many,
        now: NOW,
        preparation: false,
        product: view(true, [s('accepted')], nine),
      }),
    }).progress!;
    assert.equal(wide.releases.length, HOME_LIMITS.releases);
    assert.equal(wide.releasesTotal, 9);
    assert.equal(wide.releasesDone, 3, 'r1 by the map, r2 and r9 by acceptance');
    // Список всех релизов карты — только серверу.
    assert.ok(!JSON.stringify(wide).includes('mapReleases'));
  } finally {
    f.cleanup();
  }
});
