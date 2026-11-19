// F89: перенос базы (`base-update`) поверх паузы ведущего оставляет паузу
// ведущего его паузой — с причиной; подсказки (ответ base-update, вид
// остановки, session_handoff, центр внимания) говорят то же, что реальная
// проверка снятия паузы (`leadResumeOf`, один источник).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, fixture, input } from './helpers.ts';
import { DevContour, baseMovesOf } from '../src/core/service.ts';
import { checkBase } from '../src/runner/base-check.ts';
import { Store } from '../src/core/store.ts';
import { AgentService } from '../src/application/agent.ts';
import { AttentionService } from '../src/application/attention.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { baseUpdateOperation } from '../src/runner/base-update.ts';
import { BASE_CHECK, BASE_HELD_DETAIL, type BaseCheck } from '../src/runner/base-check.ts';
import { repositorySchema, type DevContourState } from '../src/core/model.ts';
import { git } from '../src/runner/process.ts';
import { leadLiftsPause, leadResumeOf, queueStopView } from '../src/core/work-status.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { homeView } from '../src/application/home.ts';
import { queueStopOf } from '../src/application/queue-stop.ts';
import { Workspace } from '../src/core/workspace.ts';

/** Репозиторий, рабочая ветка которого на коммит впереди базы прогонов. */
async function behindBase(root: string) {
  const path = join(root, 'repo');
  await mkdir(path);
  await git(path, 'init', '-q', '-b', 'work');
  await writeFile(join(path, 'base.txt'), 'base');
  await git(path, 'add', '.');
  await git(path, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base', '--no-gpg-sign');
  await git(path, 'branch', 'devcontour/accepted');
  await writeFile(join(path, 'prep.txt'), 'prepared');
  await git(path, 'add', '.');
  await git(path, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'prep', '--no-gpg-sign');
  const data = join(root, 'data');
  await mkdir(data);
  const h = new DevContour(
    new Store(join(data, 'state.sqlite')),
    config({
      repositories: [
        repositorySchema.parse({ id: 'main', name: 'main', path, gates: config().gates }),
      ],
      checkoutRoot: join(root, 'checkouts'),
    }),
  );
  return { h, data };
}

async function withRepo(run: (r: Awaited<ReturnType<typeof behindBase>>) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-f89-')));
  try {
    const r = await behindBase(root);
    try {
      await run(r);
    } finally {
      r.h.store.close();
    }
  } finally {
    assert.ok(root.startsWith(await realpath(tmpdir())) && root.includes('dc-f89-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('F89: base-update поверх паузы ведущего — пауза остаётся ведущего с причиной, подсказки совпадают с проверкой снятия', async () => {
  await withRepo(async ({ h, data }) => {
    // Открытая утверждённая работа без задания: шаг пакета — снятие паузы.
    const b = h.createBoard('Board');
    h.addTask(b.id, input('Task'));
    h.approve(b.id);
    h.pause(false);
    const agent = new AgentService(h, data);
    const reason = 'Guides refresh and the change record commit';
    await agent.run({ operation: 'queue_set', input: { paused: true, reason } });
    const moved = (await baseUpdateOperation(h, data, { by: 'host' })) as {
      updated: unknown[];
      next: string;
    };
    assert.equal(moved.updated.length, 1);
    const state = h.store.read();
    assert.equal(state.pauseReason, 'operator');
    assert.ok(state.waits?.some((w) => w.kind === 'base-check'));
    assert.equal(state.pauseActor?.by, 'lead');
    assert.equal(state.pauseActor?.reason, reason);
    const view = queueStopView(state, []);
    assert.equal(view.by, 'lead', 'пауза ведущего не стала паузой человека');
    // Реальная проверка: снимается только пауза, ожидание остаётся.
    assert.equal(leadResumeOf(state), 'keeps-base-check');
    assert.equal(leadLiftsPause(state), true);
    // Ответ base-update: снять свою паузу, базу проверит workflow, — а не
    // «только пользователь» и не «queue_set откажет».
    assert.match(
      moved.next,
      /^База обновлена; очередь ждёт проверки базы \(base-check\) под паузой\. Свою паузу ведущий снимает queue_set \{"paused": false\}: снимется только пауза/,
    );
    assert.doesNotMatch(moved.next, /Паузу человека/);
    // Пакет ведущего: шаг — своя пауза с причиной.
    const next = devcontourHandoff(h, {}).host.next;
    assert.equal(next?.code, 'pause-operator', JSON.stringify(next));
    // Задания доски нет: базу проверит только зарегистрированная доска (F93).
    assert.deepEqual(next?.params, { by: 'lead', reason, base: 'no-board' });
    assert.match(next?.detail ?? '', /register the board with workflow_start/);
    assert.match(next?.detail ?? '', /paused by the lead/);
    assert.doesNotMatch(next?.detail ?? '', /user's decision/);
    // Центр внимания: карточка паузы — ведущего, а не оператора.
    const card = (await new AttentionService(h.store, h).active()).items.find(
      (i) => i.sourceKey === 'queue',
    );
    assert.equal(card?.actor, 'lead', JSON.stringify(card));
    // Запуск очереди ведущим перенос не подтверждает: карточка этого не обещает.
    assert.doesNotMatch(card?.reason ?? '', /подтвердит и перенос/);
    // Снятие паузы ведущим принято: очередь остаётся на ожидании проверки базы.
    await agent.run({ operation: 'queue_set', input: { paused: false } });
    const after = h.store.read();
    assert.equal(after.paused, true);
    assert.equal(after.pauseReason, 'base-check');
    assert.ok(after.waits?.some((w) => w.kind === 'base-check'));
  });
});

/** Центр внимания и главная одного снимка. */
async function views(h: DevContour) {
  const attention = await new AttentionService(h.store, h).active();
  const home = homeView({
    state: h.store.read(),
    h,
    attention,
    revision: h.store.revision(),
    now: Date.now(),
    events: h.store.events(),
  });
  return { attention, queue: home.sections.development.queue };
}

test('F93: lead pause over an unheld base check with a board job — no operator action in attention or home; home names the lead and its reason', async () => {
  await withRepo(async ({ h, data }) => {
    const b = h.createBoard('Board');
    h.addTask(b.id, input('Task'));
    h.approve(b.id);
    h.pause(false);
    // Доску ведёт задание: неудержанное ожидание проверит его цикл.
    new LeadWorkflow(h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const agent = new AgentService(h, data);
    const reason = 'Guides refresh and the change record commit';
    await agent.run({ operation: 'queue_set', input: { paused: true, reason } });
    await baseUpdateOperation(h, data, { by: 'host' });
    const state = h.store.read();
    assert.equal(leadResumeOf(state), 'keeps-base-check');
    const { attention, queue } = await views(h);
    // Ни карточки переноса базы, ни действия оператора: паузу снимает
    // ведущий, базу проверяет цикл задания (как host.next и карточка ведущего).
    assert.equal(
      attention.items.find((i) => i.sourceKey === 'wait:base-check'),
      undefined,
      JSON.stringify(attention.items.map((i) => [i.sourceKey, i.actor, i.title])),
    );
    for (const item of attention.items.filter((i) => i.actor === 'operator'))
      assert.ok(
        !item.actions.some((a) => a.id === 'resume'),
        `${item.sourceKey}: ${item.title} offers the operator a resume`,
      );
    assert.equal(attention.items.find((i) => i.sourceKey === 'queue')?.actor, 'lead');
    // Главная говорит то же: пауза ведущего с его причиной, действия оператора нет.
    assert.equal(queue.reason, `Выдачу остановил ведущий агент: ${reason}`);
    assert.doesNotMatch(queue.hint ?? '', /Проверьте базу gates|«Нужно действие»/);
    assert.match(queue.hint ?? '', /ведущий агент снимает сам; затем он проверит базу/);
    // Ведущий снял паузу: ожидание проверяет цикл, у оператора действия нет.
    await agent.run({ operation: 'queue_set', input: { paused: false } });
    const lifted = await views(h);
    assert.equal(
      lifted.attention.items.find((i) => i.sourceKey === 'wait:base-check'),
      undefined,
    );
    assert.equal(lifted.queue.hint, 'Ведущий агент проверит базу и продолжит выдачу сам.');
    // Причина — не команда «проверьте её гейтами», а то, что делает цикл.
    assert.doesNotMatch(lifted.queue.reason ?? '', /проверьте её гейтами/);
    assert.match(lifted.queue.reason ?? '', /цикл ведущего проверяет её gates/);
    const stop = queueStopOf(h);
    assert.match(
      stop.stopReason ?? '',
      /цикл ведущего проверяет её gates и продолжит очередь сам$/,
    );
    const card = lifted.attention.items.find((i) => i.sourceKey === 'queue');
    if (card) assert.doesNotMatch(card.reason, /проверьте её гейтами/);
  });
});

/** Пауза ведущего над неудержанным переносом; `job` — какое задание ведёт работу. */
async function leadPauseOverMove(
  h: DevContour,
  data: string,
  job: 'board' | 'changeset',
  /** Правка состояния после переноса (прежние записи). */
  edit?: (s: DevContourState) => void,
) {
  const b = h.createBoard('Board');
  h.addTask(b.id, input('Task'));
  h.approve(b.id);
  h.pause(false);
  if (job === 'board')
    new LeadWorkflow(h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
  else {
    const release = new Workspace(h).create({
      title: 'Release r1',
      description: 'Joint verification of the board.',
      boardIds: [b.id],
    });
    new LeadWorkflow(h).start({ kind: 'changeset', id: release.id, authorRuntime: 'claude' });
  }
  const agent = new AgentService(h, data);
  await agent.run({ operation: 'queue_set', input: { paused: true, reason: 'Guides' } });
  await baseUpdateOperation(h, data, { by: 'host' });
  if (edit) h.store.change('fixture.edit', edit);
  return agent;
}

/** Действие оператора есть в центре внимания и на главной — до и после снятия паузы ведущим. */
async function operatorActs(
  h: DevContour,
  agent: AgentService,
  name: string,
  /** Выход, который называет карточка паузы ведущего. */
  expected: RegExp,
) {
  for (const phase of ['under the lead pause', 'after the lead lifts it']) {
    if (phase !== 'under the lead pause')
      await agent.run({ operation: 'queue_set', input: { paused: false } });
    const { attention, queue } = await views(h);
    const card = attention.items.find((i) => i.sourceKey === 'wait:base-check');
    assert.equal(card?.actor, 'operator', `${name}, ${phase}`);
    assert.ok(
      card?.actions.some((a) => a.id === 'resume'),
      `${name}, ${phase}`,
    );
    assert.match(queue.hint ?? '', /Проверьте базу gates и запустите очередь/, `${name}, ${phase}`);
    // Карточка паузы не обещает проверки, которой цикл не сделает, а
    // называет реальный выход.
    for (const item of attention.items)
      assert.doesNotMatch(
        item.reason,
        /Цикл ведущего проверит базу/,
        `${name}, ${phase}: ${item.sourceKey}`,
      );
    if (phase === 'under the lead pause') {
      const pause = attention.items.find((i) => i.sourceKey === 'queue');
      assert.equal(pause?.actor, 'lead', name);
      assert.match(pause?.reason ?? '', expected, name);
    }
  }
}

test('F93: without a current base-move range the loop cannot check the base — attention and home both leave the action to the operator', async () => {
  for (const [name, edit] of [
    ['missing range', (s: DevContourState) => void delete s.baseMoves],
    [
      'stale range',
      (s: DevContourState) => {
        s.baseMoves = { ...s.baseMoves!, at: '2000-01-01T00:00:00.000Z' };
      },
    ],
  ] as const)
    await withRepo(async ({ h, data }) => {
      const agent = await leadPauseOverMove(h, data, 'board', edit);
      assert.equal(baseMovesOf(h.store.read()), undefined, name);
      await operatorActs(
        h,
        agent,
        name,
        /Цикл ведущего эту базу не проверит: у ожидания нет диапазона переноса/,
      );
      // Пауза ведущего снята, очередь на ожидании: сам цикл эту базу не проверит.
      assert.equal(h.store.read().pauseReason, 'base-check', name);
      assert.equal(await checkBase(h, { data, state: data }, () => {}), false, name);
      assert.equal(h.store.read().pauseReason, 'base-check', name);
    });
});

test('F93: a ChangeSet job does not check the base — with no board job the operator acts', async () => {
  await withRepo(async ({ h, data }) => {
    const agent = await leadPauseOverMove(h, data, 'changeset');
    await operatorActs(h, agent, 'changeset only', /зарегистрируйте доску через workflow_start/);
  });
});

test('F93: a human pause over the same base check keeps the operator action', async () => {
  await withRepo(async ({ h, data }) => {
    const b = h.createBoard('Board');
    h.addTask(b.id, input('Task'));
    h.approve(b.id);
    h.pause(false);
    new LeadWorkflow(h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    h.pause(true);
    await baseUpdateOperation(h, data, { by: 'host' });
    const { attention, queue } = await views(h);
    const card = attention.items.find((i) => i.sourceKey === 'queue');
    assert.equal(card?.actor, 'operator');
    assert.ok(card?.actions.some((a) => a.id === 'resume'));
    assert.match(queue.hint ?? '', /Проверьте базу gates и запустите очередь/);
  });
});

test('F89: base-update поверх паузы человека — пауза остаётся человека, подсказка называет решение пользователя', async () => {
  await withRepo(async ({ h, data }) => {
    const b = h.createBoard('Board');
    h.addTask(b.id, input('Task'));
    h.approve(b.id);
    h.pause(false);
    h.pause(true);
    const moved = (await baseUpdateOperation(h, data, { by: 'host' })) as { next: string };
    const state = h.store.read();
    assert.equal(state.pauseReason, 'operator');
    assert.equal(state.pauseActor, undefined);
    assert.equal(queueStopView(state, []).by, undefined);
    assert.equal(leadLiftsPause(state), false);
    assert.match(moved.next, /под паузой\. Паузу человека снимает пользователь/);
    const next = devcontourHandoff(h, {}).host.next;
    assert.equal(next?.code, 'pause-operator');
    assert.deepEqual(next?.params, { base: 'no-board' });
  });
});

test('F89: leadResumeOf предсказывает исход снятия паузы ведущим для каждого вида паузы', () => {
  const f = fixture();
  try {
    const at = new Date().toISOString();
    const plain = 'База прогонов перенесена (main): проверьте её гейтами и продолжите очередь';
    const held = `${BASE_HELD_DETAIL} (main:contracts/api.md): gates этой базы его не подтверждают`;
    const cases: { name: string; expect: string; edit: (s: DevContourState) => void }[] = [
      {
        name: 'lead pause',
        expect: 'lifts',
        edit: (s) => void (s.pauseActor = { by: 'lead', at: s.pausedAt! }),
      },
      { name: 'human pause', expect: 'lifts', edit: () => {} },
      {
        name: 'lead pause over a wait',
        expect: 'keeps-base-check',
        edit: (s) => {
          s.pauseActor = { by: 'lead', at: s.pausedAt! };
          s.waits = [{ kind: 'base-check', detail: plain, at }];
        },
      },
      {
        name: 'human pause over a wait',
        expect: 'keeps-base-check',
        edit: (s) => void (s.waits = [{ kind: 'base-check', detail: plain, at }]),
      },
      {
        name: 'wait only',
        expect: 'base-check',
        edit: (s) => {
          s.pauseReason = 'base-check';
          s.waits = [{ kind: 'base-check', detail: plain, at }];
        },
      },
      {
        name: 'held move under a lead pause',
        expect: 'held',
        edit: (s) => {
          s.pauseActor = { by: 'lead', at: s.pausedAt! };
          s.waits = [{ kind: 'base-check', detail: held, at }];
        },
      },
    ];
    for (const { name, expect, edit } of cases) {
      f.h.pause(false);
      f.h.pause(true);
      f.h.store.change('fixture', (s) => {
        edit(s);
        return {};
      });
      const before = f.h.store.read();
      const predicted = leadResumeOf(before);
      let outcome: string;
      try {
        f.h.pause(false, 'operator', 'lead');
        const s = f.h.store.read();
        outcome = !s.paused ? 'lifts' : s.pauseReason === 'base-check' ? 'keeps-base-check' : '?';
      } catch (error) {
        outcome = /меняет приёмку или настройку контура/.test(String(error))
          ? 'held'
          : 'base-check';
      }
      // Ожидаемый исход задан явно: и правило, и проверка сверяются с ним.
      assert.equal(predicted, expect, name);
      assert.equal(outcome, expect, name);
      // Подсказка «ведущий снимает свою паузу» — только когда проверка её пропустит.
      if (leadLiftsPause(before)) assert.notEqual(predicted, 'held', name);
      f.h.store.change('fixture', (s) => {
        s.waits = undefined;
        s.paused = true;
        s.pauseReason = 'operator';
        return {};
      });
    }
  } finally {
    f.cleanup();
  }
});

test('F93: session_handoff host.next names the real way out of a base check — the loop only with a current range and a board job', async () => {
  const stale = (s: DevContourState) => {
    s.baseMoves = { ...s.baseMoves!, at: '2000-01-01T00:00:00.000Z' };
  };
  for (const [name, job, edit] of [
    ['normal', 'board', undefined],
    ['missing range', 'board', (s: DevContourState) => void delete s.baseMoves],
    ['stale range', 'board', stale],
    ['changeset only', 'changeset', undefined],
  ] as const)
    await withRepo(async ({ h, data }) => {
      const agent = await leadPauseOverMove(h, data, job, edit);
      const unchecked = name === 'missing range' || name === 'stale range';
      // Под паузой ведущего: шаг — снять свою паузу; текст не обещает
      // проверки, которой цикл не сделает.
      const before = devcontourHandoff(h, {}).host.next!;
      assert.equal(before.code, 'pause-operator', name);
      const gap = unchecked ? 'unchecked' : name === 'changeset only' ? 'no-board' : undefined;
      assert.deepEqual(
        before.params,
        { by: 'lead', reason: 'Guides', ...(gap ? { base: gap } : {}) },
        name,
      );
      if (gap) assert.doesNotMatch(before.detail, /the board workflow checks the base/, name);
      else assert.match(before.detail, /the board workflow checks the base/, name);
      if (gap === 'no-board') assert.match(before.detail, /register the board with workflow_start/);
      await agent.run({ operation: 'queue_set', input: { paused: false } });
      assert.equal(h.store.read().pauseReason, 'base-check', name);
      const after = devcontourHandoff(h, {}).host.next!;
      if (name === 'normal') {
        assert.equal(after.action, 'wait', name);
        assert.equal(after.code, 'pause-lift', name);
      } else if (unchecked) {
        // checkBase откажет: решение пользователя, а не ожидание цикла.
        assert.equal(after.action, 'operator', name);
        assert.equal(after.code, 'base-unchecked', name);
        assert.match(after.detail, /confirm-and-start/, name);
        assert.equal(await checkBase(h, { data, state: data }, () => {}), false, name);
      } else {
        // Задание ChangeSet базу не проверит: зарегистрировать доску.
        assert.equal(after.action, 'workflow_start', name);
        assert.equal(after.code, 'board-start', name);
      }
    });
});

test('F93: host.next for a base wait the loop cannot check — with another board waiting for a plan decision, with a failed check and with a held move', async () => {
  for (const name of ['other board plan', 'failed check', 'held move'] as const)
    await withRepo(async ({ h, data }) => {
      const agent = await leadPauseOverMove(h, data, 'board', (s) => {
        if (name === 'held move') {
          // Удержанный перенос с диапазоном: подтверждает только человек.
          for (const w of s.waits ?? [])
            w.detail = `${BASE_HELD_DETAIL} (main:verify.mjs): gates этой базы его не подтверждают`;
          return;
        }
        delete s.baseMoves;
        if (name === 'failed check')
          for (const w of s.waits ?? []) w.detail = 'Проверка базы не пройдена: main/unit';
      });
      // Черновик другой доски: решение о плане ждёт, а живое задание первой
      // доски не должно выглядеть ожиданием проверки базы.
      if (name !== 'failed check') h.addTask(h.createBoard('Draft board').id, input('Draft'));
      if (name === 'held move')
        // Пауза ведущего над удержанием не снимается: ставим ожидание напрямую.
        h.store.change('fixture.base-check', (s) => {
          s.pauseReason = 'base-check';
          delete s.pauseActor;
        });
      else await agent.run({ operation: 'queue_set', input: { paused: false } });
      assert.equal(h.store.read().pauseReason, 'base-check', name);
      const next = devcontourHandoff(h, {}).host.next!;
      if (name === 'held move') {
        assert.equal(next.action, 'operator', `${name}: ${JSON.stringify(next)}`);
        assert.equal(next.code, 'base-held', name);
        assert.deepEqual(next.params, { paths: ['main:verify.mjs'] });
        return;
      }
      assert.equal(next.action, 'operator', `${name}: ${JSON.stringify(next)}`);
      assert.equal(next.code, 'base-unchecked', name);
      if (name === 'failed check') {
        assert.deepEqual(next.params, { failed: true });
        assert.match(next.detail, /fix the base and run devcontour base-update --by host/);
      } else assert.deepEqual(next.params, {});
      assert.equal(await checkBase(h, { data, state: data }, () => {}), false, name);
    });
});

/**
 * Запись проверки базы `main` на SHA этого переноса: провал gate `test`;
 * `tries` — прогонов (2 — повтор исчерпан), `policy` — договор записи.
 */
function seedBaseCheck(h: DevContour, tries: number, policy = h.policyDigest('main')) {
  const sha = baseMovesOf(h.store.read())![0].to;
  h.store.atomic(() =>
    h.store.saveLocal(BASE_CHECK, 'main', sha, {
      repositoryId: 'main',
      sha,
      policyDigest: policy,
      runId: 'BK-seeded',
      passed: false,
      gates: ['test'],
      failures: [{ gate: 'test', message: 'seeded failure' }],
      evidence: [],
      at: new Date().toISOString(),
      tries,
    } satisfies BaseCheck),
  );
  return sha;
}

test('host.next names the way out of a failed base check whose retries are used up — the same decision as checkBase, not pause-lift or job-live', async () => {
  for (const name of ['spent, named', 'spent, fresh wait', 'retry left', 'other policy'] as const)
    await withRepo(async ({ h, data }) => {
      const agent = await leadPauseOverMove(h, data, 'board');
      const sha = seedBaseCheck(
        h,
        name === 'retry left' ? 1 : 2,
        name === 'other policy' ? 'p-earlier-contract' : undefined,
      );
      // Ожидание, которое уже назвало провал (как пишет checkBase), — кроме
      // переноса, вернувшего базу на SHA с исчерпанной проверкой.
      if (name !== 'spent, fresh wait')
        h.store.change('fixture.failed', (s) => {
          for (const w of s.waits ?? []) w.detail = 'Проверка базы не пройдена: main/test';
        });
      const spent = name.startsWith('spent');
      const boardId = h.store.read().boards[0].id;
      const steps = () => [
        devcontourHandoff(h, {}).host.next!,
        devcontourHandoff(h, { boardId }).host.next!,
      ];
      // Под своей паузой ведущего: снятие паузы ожидание не снимет.
      for (const next of steps())
        if (spent) {
          assert.equal(next.action, 'base-update', `${name}: ${JSON.stringify(next)}`);
          assert.equal(next.code, 'base-exhausted', name);
          assert.deepEqual(next.params, { failures: ['main/test'] }, name);
          assert.match(next.detail, /devcontour base-update --by host/, name);
          assert.match(next.detail, /ask the user to lift the wait without gates/, name);
          assert.doesNotMatch(next.detail, /the board workflow checks the base/, name);
        } else assert.equal(next.code, 'pause-operator', `${name}: ${JSON.stringify(next)}`);
      await agent.run({ operation: 'queue_set', input: { paused: false } });
      assert.equal(h.store.read().pauseReason, 'base-check', name);
      for (const next of steps())
        if (spent) {
          assert.equal(next.code, 'base-exhausted', `${name}: ${JSON.stringify(next)}`);
          assert.equal(next.action, 'base-update', name);
        } else {
          // Повтор ещё есть или запись другого договора: цикл проверит базу.
          assert.equal(next.action, 'wait', `${name}: ${JSON.stringify(next)}`);
          assert.equal(next.code, 'pause-lift', name);
        }
      // Вид остановки очереди не обещает проверку циклом, когда повторы исчерпаны.
      if (spent) {
        const stop = queueStopOf(h);
        assert.doesNotMatch(stop.action ?? '', /Цикл ведущего проверит базу/, name);
        assert.match(stop.action ?? '', /base-update/, name);
      }
      // Центр внимания: цикл базу не проверит — снимает человек.
      const { attention } = await views(h);
      const card = attention.items.find((i) => i.sourceKey === 'wait:base-check');
      if (name === 'spent, fresh wait') {
        // Ожидание ещё не названо провалом: снимает оператор (цикл не проверит).
        assert.equal(card?.actor, 'operator', name);
        assert.ok(
          card?.actions.some((a) => a.id === 'resume'),
          name,
        );
      } else {
        // Названный провал — карточка ведущего: исправить базу.
        assert.equal(card?.actor, 'lead', name);
        assert.equal(card?.title, 'Проверка перенесённой базы не пройдена', name);
      }
      if (!spent) {
        // Повтор есть (или запись другого договора): проверка действительно
        // исполняет gates, а после исчерпания повторов шаг — тот же выход.
        assert.equal(await checkBase(h, { data, state: data }, () => {}), false, name);
        assert.ok(
          h.store.events().some((e) => e.type === 'base.check.started'),
          `${name}: the check ran`,
        );
        const after = h.store.localRecord<BaseCheck>(BASE_CHECK, 'main', sha)!;
        assert.notEqual(after.runId, 'BK-seeded', name);
        assert.equal(after.tries, 2, name);
        assert.equal(devcontourHandoff(h, {}).host.next!.code, 'base-exhausted', name);
        return;
      }
      // Реальная проверка: gates не запускаются, запись прежняя, ожидание стоит.
      assert.equal(await checkBase(h, { data, state: data }, () => {}), false, name);
      const record = h.store.localRecord<BaseCheck>(BASE_CHECK, 'main', sha)!;
      assert.equal(record.runId, 'BK-seeded', name);
      assert.equal(record.tries, 2, name);
      assert.equal(h.store.events().filter((e) => e.type === 'base.check.started').length, 0, name);
      assert.match(
        h.store.read().waits!.find((w) => w.kind === 'base-check')!.detail,
        /^Проверка базы не пройдена: main\/test/,
        name,
      );
    });
});
