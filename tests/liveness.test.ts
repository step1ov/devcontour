import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, fixture, input } from './helpers.ts';
import { executionDigest } from 'devcontour-harness';
import { DevContour } from '../src/core/service.ts';
import { approvalPolicyDigest, policyFromConfig } from '../src/harness/policy.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { AgentService } from '../src/application/agent.ts';
import { panelSummary, type PanelSummary } from '../src/application/panel.ts';
import type { QuietAttempt } from '../src/application/queue-stop.ts';
import { executionOf } from '../src/harness/execution.ts';
import {
  idleSpan,
  livenessNext,
  livenessText,
  operationLiveness,
  runLiveness,
  stalledFailureNext,
  stalledFailureText,
} from '../src/core/work-status.ts';

/**
 * Живость идущей попытки (обход зависаний controller harness) видна без
 * запроса: в строке попытки сводки панели, в `/api/state` и в MCP
 * `workflow_status`. Переходы пишет движок (`Engine.liveness`) — тот же путь,
 * что у обхода runner; запись в базу руками не делается.
 */
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
  const f = fixture();
  const b = f.h.createBoard('Доска');
  const t = f.h.addTask(b.id, input('Миграция базы'));
  f.h.approve(b.id);
  f.h.pause(false);
  const run = f.h.claim('test')!;
  assert.equal(run.taskId, t.id);
  const { engine } = executionOf(f.h);
  const move = (
    state: 'active' | 'quiet' | 'stalled',
    previous: 'active' | 'quiet' | 'stalled',
    idleMs: number,
    action?: 'stop' | 'report',
  ) => {
    const now = Date.now();
    const lastMovementAt = iso(now - idleMs);
    const activity = { kind: 'gate' as const, label: 'unit' };
    engine.liveness(
      run.id,
      run.token,
      {
        state,
        at: iso(now),
        lastMovementAt,
        ...(state === 'active' ? {} : { activity }),
        ...(action ? { action } : {}),
      },
      {
        state,
        previous,
        lastMovementAt,
        idleMs,
        ...(state === 'active' ? {} : { activity }),
        ...(action ? { action } : {}),
      },
    );
  };
  const summary = () => panelSummary(f.h, f.root, {}) as PanelSummary;
  const status = () =>
    new AgentService(f.h).execute({ operation: 'workflow_status', input: {} }) as {
      liveness: QuietAttempt[];
    };
  return { f, t, run, move, summary, status };
}

test('Тихая попытка: подпись без тревоги, простой и последняя команда', () => {
  const { f, t, run, move, summary, status } = setup();
  try {
    move('quiet', 'active', 4 * MIN);
    const line = summary().runs.find((r) => r.id === run.id)!;
    assert.equal(line.liveness?.state, 'quiet');
    assert.equal(line.liveness?.attention, false);
    assert.ok((line.liveness?.idleMs ?? 0) >= 4 * MIN);
    assert.deepEqual(line.liveness?.activity, { kind: 'gate', label: 'unit' });

    const [quiet, ...rest] = status().liveness;
    assert.equal(rest.length, 0);
    assert.equal(quiet.taskId, t.id);
    assert.equal(quiet.title, 'Миграция базы');
    assert.equal(quiet.runId, run.id);
    assert.equal(quiet.state, 'quiet');
    assert.equal(quiet.text, 'без движения 4 мин');
    assert.match(quiet.next, /^Ничего не требуется/);
    // Компонент без попыток — пустой список, а не чужая попытка.
    const other = new AgentService(f.h).execute({
      operation: 'workflow_status',
      input: { repositoryId: 'other' },
    }) as { liveness: QuietAttempt[] };
    assert.deepEqual(other.liveness, []);
  } finally {
    f.cleanup();
  }
});

test('Зависшая попытка при report ждёт человека; движение снимает вид', async () => {
  const { f, run, move, summary, status } = setup();
  try {
    move('quiet', 'active', 4 * MIN);
    move('stalled', 'quiet', 12 * MIN, 'report');
    const line = summary().runs.find((r) => r.id === run.id)!;
    assert.equal(line.liveness?.state, 'stalled');
    assert.equal(line.liveness?.action, 'report');
    assert.equal(line.liveness?.attention, true);
    const [stalled] = status().liveness;
    assert.equal(stalled.text, 'зависла 12 мин — проверьте среду');
    assert.match(stalled.next, /^Проверьте среду исполнения/);
    // Ведущему — с именами политики и события, по которым он найдёт снимок.
    assert.match(stalled.next, /stallSweep\.action: report/);
    assert.match(stalled.next, /attempt\.liveness/);

    // Настоящие /api/summary и /api/state: форма, которую ждёт панель
    // (`RunLiveness` строки попытки), и тот же вид, что workflow_status.
    const scheduler = new Scheduler(f.h, f.root);
    const app = await serve(f.h, scheduler, { port: 0 });
    try {
      const summary = (await (await fetch(app.url + '/api/summary')).json()) as PanelSummary;
      const panel = summary.runs.find((r) => r.id === run.id)!.liveness!;
      assert.deepEqual(Object.keys(panel).sort(), [
        'action',
        'activity',
        'attention',
        'idleMs',
        'lastMovementAt',
        'since',
        'state',
      ]);
      assert.equal(panel.state, 'stalled');
      assert.equal(panel.action, 'report');
      assert.equal(panel.attention, true);
      assert.deepEqual(panel.activity, { kind: 'gate', label: 'unit' });
      assert.ok(panel.idleMs >= 12 * MIN && panel.idleMs < 13 * MIN);
      assert.ok(!Number.isNaN(Date.parse(panel.since)));
      assert.ok(!Number.isNaN(Date.parse(panel.lastMovementAt)));
      assert.deepEqual(summary.operations, []);
      // Неизменившиеся данные — ответ без тела: простой досчитывает панель.
      const again = (await (
        await fetch(app.url + '/api/summary?revision=' + summary.revision)
      ).json()) as { unchanged?: boolean };
      assert.equal(again.unchanged, true);
      const state = (await (await fetch(app.url + '/api/state')).json()) as {
        liveness: QuietAttempt[];
        operations: unknown[];
      };
      assert.equal(state.liveness.length, 1);
      assert.equal(state.liveness[0].state, 'stalled');
      assert.equal(state.liveness[0].attention, true);
      assert.deepEqual(state.operations, []);
    } finally {
      await app.close();
      await scheduler.stop();
    }

    // Движение вернулось — вида больше нет: active не шумит.
    move('active', 'stalled', 0);
    assert.equal(summary().runs.find((r) => r.id === run.id)!.liveness, undefined);
    assert.deepEqual(status().liveness, []);
  } finally {
    f.cleanup();
  }
});

test('Отказ stalled: завершённая попытка без вида живости, класс отказа в строке', () => {
  const { f, t, run, move, summary, status } = setup();
  try {
    move('stalled', 'quiet', 11 * MIN, 'stop');
    const live = status().liveness[0];
    assert.equal(live.attention, false, 'при stop действует controller');
    assert.equal(live.text, 'зависла 11 мин — будет остановлена и повторена автоматически');
    assert.match(live.next, /repairPolicy\.stalled/);
    f.h.fail(run.id, run.token, 'Попытка зависла: движения нет', false, 'stalled');
    const line = summary().runs.find((r) => r.id === run.id)!;
    assert.equal(line.failureKind, 'stalled');
    assert.equal(line.liveness, undefined);
    assert.deepEqual(status().liveness, []);
    assert.equal(f.h.store.read().tasks.find((x) => x.id === t.id)!.failureKind, 'stalled');
    assert.match(stalledFailureText, /повтор или правка среды, не кода/);
    assert.match(stalledFailureNext(false), /^Повтор назначается автоматически один раз/);
    assert.match(stalledFailureNext(true), /^Попытка зависла повторно: повтор уже был/);
  } finally {
    f.cleanup();
  }
});

test('Слова живости: простой, состояние и действие', () => {
  assert.equal(idleSpan(40_000), '40 с');
  assert.equal(idleSpan(12 * MIN + 59_000), '12 мин');
  assert.equal(idleSpan(65 * MIN), '1 ч 5 мин');
  assert.equal(livenessText({ state: 'quiet', idleMs: 3 * MIN }), 'без движения 3 мин');
  assert.equal(
    livenessText({ state: 'stalled', idleMs: 10 * MIN, action: 'report' }),
    'зависла 10 мин — проверьте среду',
  );
  assert.equal(
    livenessText({ state: 'stalled', idleMs: 10 * MIN, action: 'stop' }, 'check'),
    'зависла 10 мин — будет остановлена автоматически',
  );
  // Панель — без внутренних имён; ведущему — с ними.
  for (const l of [
    { state: 'quiet' as const },
    { state: 'stalled' as const, action: 'report' as const },
    { state: 'stalled' as const, action: 'stop' as const },
  ])
    for (const subject of ['attempt', 'check'] as const) {
      const panel = livenessNext(l, 'panel', subject);
      assert.doesNotMatch(panel, /controller|stallSweep|liveness|repairPolicy/, panel);
      assert.match(livenessNext(l, 'agent', subject), /stallSweep|controller/);
    }
  assert.equal(
    livenessNext({ state: 'stalled', action: 'stop' }),
    'Ничего не требуется: попытка будет остановлена автоматически и повторена один раз.',
  );
  assert.match(livenessNext({ state: 'stalled', action: 'report' }), /в журнале задачи\.$/);
  const at = iso(Date.now());
  const liveness = { state: 'quiet' as const, at, lastMovementAt: at };
  assert.equal(runLiveness({ status: 'succeeded', liveness }, Date.now()), undefined);
  assert.equal(
    runLiveness({ status: 'active', liveness: { ...liveness, state: 'active' } }, Date.now()),
    undefined,
  );
  assert.equal(runLiveness({ status: 'active', liveness }, Date.parse(at) + MIN)?.idleMs, MIN);
});

test('stallSweep конфигурации доходит до политики и не требует переутверждения плана', () => {
  const plain = config();
  assert.equal(policyFromConfig(plain).stallSweep, undefined, 'нет поля — умолчания harness');
  const tuned = config({
    stallSweep: { intervalMs: 10_000, quietMs: 60_000, stalledMs: 300_000, action: 'stop' },
  });
  assert.deepEqual(policyFromConfig(tuned).stallSweep, {
    intervalMs: 10_000,
    quietMs: 60_000,
    stalledMs: 300_000,
    action: 'stop',
  });
  // Частичное поле: политика получает заданное, умолчания подставляет harness.
  assert.deepEqual(policyFromConfig(config({ stallSweep: { action: 'stop' } })).stallSweep, {
    intervalMs: 30_000,
    quietMs: 180_000,
    stalledMs: 600_000,
    action: 'stop',
  });
  // Эксплуатационный предел: утверждённый план, digest исполнения (основания
  // попыток и reuse) и digest политики компонента не меняются.
  assert.equal(approvalPolicyDigest(tuned), approvalPolicyDigest(plain));
  assert.equal(executionDigest(policyFromConfig(tuned)), executionDigest(policyFromConfig(plain)));
  const f = fixture();
  try {
    const tunedHost = new DevContour(f.store, { ...f.h.config, stallSweep: tuned.stallSweep });
    assert.equal(tunedHost.policyDigest(), f.h.policyDigest());
    assert.equal(tunedHost.planPolicyDigest(), f.h.planPolicyDigest());
  } finally {
    f.cleanup();
  }
});

test('Отказ stallSweep называет действующее значение незаданного поля', () => {
  const message = (stallSweep: object) => {
    try {
      config({ stallSweep });
    } catch (error) {
      return (error as { issues: { message: string }[] }).issues.map((i) => i.message);
    }
    assert.fail('ожидался отказ');
  };
  // Задан только quietMs: мешает intervalMs по умолчанию.
  assert.deepEqual(message({ quietMs: 20_000 }), [
    'stallSweep: intervalMs по умолчанию (30000) не может быть больше, чем quietMs (20000): иначе «без движения» не заметить вовремя; задайте intervalMs не больше quietMs',
  ]);
  assert.deepEqual(message({ quietMs: 700_000 }), [
    'stallSweep: quietMs (700000) должен быть меньше, чем stalledMs по умолчанию (600000)',
  ]);
  assert.deepEqual(message({ intervalMs: 5000, quietMs: 60_000, stalledMs: 60_000 }), [
    'stallSweep: quietMs (60000) должен быть меньше, чем stalledMs (60000)',
  ]);
  assert.throws(
    () => config({ stallSweep: { intervalMs: 500 } }),
    /stallSweep|intervalMs/,
  );
});

test('Проверка gates вне попытки: последний переход незавершённой, пока роль controller жива', () => {
  const now = Date.now();
  const at = (ms: number) => iso(now - ms);
  const event = (id: number, type: string, data: object) => ({ id, at: at(0), type, data });
  const report = (state: string, runId: string, idleMs: number) => ({
    repositoryId: 'main',
    sha: 'a'.repeat(40),
    runId,
    state,
    previous: 'quiet',
    lastMovementAt: at(idleMs),
    idleMs,
    activity: { kind: 'gate', label: 'unit' },
    ...(state === 'stalled' ? { action: 'report' } : {}),
  });
  const state = {
    changeSets: [],
    boards: [],
    leader: { owner: 'server', leaseUntil: now + 30_000 },
  };
  const events = [
    // Новые сначала, как у Store.latestEvents.
    event(5, 'base.check.liveness', report('stalled', 'BK-1', 12 * MIN)),
    event(4, 'base.check.liveness', report('quiet', 'BK-1', 4 * MIN)),
    event(3, 'base.check.passed', { runId: 'BK-0' }),
    event(2, 'base.check.liveness', report('stalled', 'BK-0', 20 * MIN)),
  ];
  const [only, ...rest] = operationLiveness(state, events, now);
  assert.equal(rest.length, 0, 'законченная проверка вида не даёт');
  assert.equal(only.kind, 'base-check');
  assert.equal(only.id, 'BK-1');
  assert.equal(only.state, 'stalled');
  assert.equal(only.attention, true);
  assert.equal(only.subjectId, 'main');
  assert.ok(only.idleMs >= 12 * MIN);
  // Без живой роли controller незавершённая проверка — оборванная.
  assert.deepEqual(operationLiveness({ ...state, leader: undefined }, events, now), []);
});
