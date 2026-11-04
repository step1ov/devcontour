import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, fixture, input } from './helpers.ts';
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
  runLiveness,
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
    assert.equal(stalled.text, 'зависла 12 мин: проверьте среду');
    assert.match(stalled.next, /^Проверьте среду исполнения/);

    // `/api/state` несёт тот же вид, что workflow_status.
    const scheduler = new Scheduler(f.h, f.root);
    const app = await serve(f.h, scheduler, { port: 0 });
    try {
      const state = (await (await fetch(app.url + '/api/state')).json()) as {
        liveness: QuietAttempt[];
      };
      assert.equal(state.liveness.length, 1);
      assert.equal(state.liveness[0].state, 'stalled');
      assert.equal(state.liveness[0].attention, true);
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
    assert.match(live.text, /controller останавливает попытку/);
    f.h.fail(run.id, run.token, 'Попытка зависла: движения нет', false, 'stalled');
    const line = summary().runs.find((r) => r.id === run.id)!;
    assert.equal(line.failureKind, 'stalled');
    assert.equal(line.liveness, undefined);
    assert.deepEqual(status().liveness, []);
    assert.equal(f.h.store.read().tasks.find((x) => x.id === t.id)!.failureKind, 'stalled');
    assert.match(stalledFailureText, /повтор или правка среды, не кода/);
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
    'зависла 10 мин: проверьте среду',
  );
  assert.match(livenessNext({ state: 'stalled', action: 'stop' }), /повторит/);
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
  // Эксплуатационный предел: утверждённый план остаётся в силе.
  assert.equal(approvalPolicyDigest(tuned), approvalPolicyDigest(plain));
  // Правила harness: quiet меньше stalled.
  assert.throws(() =>
    config({
      stallSweep: { intervalMs: 10_000, quietMs: 60_000, stalledMs: 60_000, action: 'report' },
    }),
  );
});
