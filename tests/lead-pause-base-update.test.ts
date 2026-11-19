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
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { AgentService } from '../src/application/agent.ts';
import { AttentionService } from '../src/application/attention.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { baseUpdateOperation } from '../src/runner/base-update.ts';
import { BASE_HELD_DETAIL } from '../src/runner/base-check.ts';
import { repositorySchema, type DevContourState } from '../src/core/model.ts';
import { git } from '../src/runner/process.ts';
import { leadLiftsPause, leadResumeOf, queueStopView } from '../src/core/work-status.ts';

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
    assert.deepEqual(next?.params, { by: 'lead', reason });
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
    assert.deepEqual(next?.params, {});
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
