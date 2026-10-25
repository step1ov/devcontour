// AC13 / DC-F001: один агрегированный ответ считает сроки lease по одному
// моменту. Раньше revision/scheduling снимка и причины каждой задачи читали
// часы по отдельности: на границе срока две одинаковые задачи в одном ответе
// получали противоположную доступность. Часы здесь пересекают границу между
// чтениями; ответ обязан быть согласован, состояние — не меняться.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import { AgentContext } from '../src/application/context.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import type { DevContourState } from '../src/core/model.ts';

type Progress = { eligible: boolean; reasons: string[] };

/** Три одинаковые задачи и активная поставка, lease которой истекает в `lease`. */
function arrange() {
  const f = fixture();
  const board = f.h.createBoard('Lease boundary');
  for (const title of ['Equal task A', 'Equal task B', 'Equal task C'])
    f.h.addTask(board.id, input(title));
  f.h.approve(board.id);
  f.h.pause(false);
  const lease = Date.now() + 60_000;
  f.store.change('fixture.delivery', (s) => {
    s.changeSets.push({
      id: 'CS-clock',
      title: 'Synthetic delivery',
      description: '',
      boardIds: [board.id],
      createdAt: new Date().toISOString(),
      verifications: [],
      deliveries: [
        {
          id: 'D-clock',
          verificationId: 'V-clock',
          manifestDigest: 'a'.repeat(64),
          policyDigest: 'b'.repeat(64),
          token: 'private-clock-token',
          leaseUntil: lease,
          status: 'active',
          startedAt: new Date().toISOString(),
          components: {},
        },
      ],
    } as unknown as DevContourState['changeSets'][number]);
  });
  return { f, lease };
}

/** Часы, которые при каждом чтении переходят через границу lease и обратно. */
function crossingClock(lease: number) {
  const real = Date.now;
  let calls = 0;
  Date.now = () => (calls++ % 2 === 0 ? lease - 1 : lease);
  return {
    get calls() {
      return calls;
    },
    restore: () => {
      Date.now = real;
    },
  };
}
function fixedClock(at: number) {
  const real = Date.now;
  Date.now = () => at;
  return () => {
    Date.now = real;
  };
}

const consistent = (progress: Progress[]) => {
  assert.equal(progress.length, 3);
  const view = progress.map((p) => ({ eligible: p.eligible, reasons: p.reasons }));
  for (const p of view.slice(1)) assert.deepEqual(p, view[0], 'одинаковые задачи — один ответ');
};

test('project_overview: снимок, revision и причины всех задач — по одному моменту на границе lease', () => {
  const { f, lease } = arrange();
  try {
    const api = new AgentContext(f.h);
    const state = JSON.stringify(f.store.read());
    const events = f.store.events().length;
    const at = (now: number) => {
      const restore = fixedClock(now);
      try {
        return api.execute('project_overview', { repositoryId: 'main' }) as {
          revision: string;
          items: { kind: string; progress?: Progress }[];
        };
      } finally {
        restore();
      }
    };
    const before = at(lease - 1);
    const after = at(lease);
    // Граница настоящая: до срока операция workspace держит задачи, в срок — нет.
    assert.notEqual(before.revision, after.revision);
    assert.ok(before.items.every((i) => i.kind !== 'task' || !i.progress!.eligible));
    assert.ok(after.items.every((i) => i.kind !== 'task' || i.progress!.eligible));
    for (let round = 0; round < 3; round++) {
      const clock = crossingClock(lease);
      let result: typeof before;
      try {
        result = api.execute('project_overview', { repositoryId: 'main' }) as typeof before;
      } finally {
        clock.restore();
      }
      const tasks = result.items.filter((i) => i.kind === 'task').map((i) => i.progress!);
      consistent(tasks);
      // revision (scheduling) — тот же момент, что у причин задач.
      const expected = tasks[0].eligible ? after : before;
      assert.equal(result.revision, expected.revision, 'revision согласован с причинами');
      assert.deepEqual(
        tasks[0].reasons,
        expected.items.find((i) => i.kind === 'task')!.progress!.reasons,
      );
      assert.ok(!JSON.stringify(result).includes('private-clock-token'));
    }
    assert.equal(JSON.stringify(f.store.read()), state, 'чтение ничего не меняет');
    assert.equal(f.store.events().length, events);
    assert.equal(f.store.read().runs.length, 0);
  } finally {
    f.cleanup();
  }
});

test('/api/state: причины всех задач — по одному моменту на границе lease', async () => {
  const { f, lease } = arrange();
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const state = JSON.stringify(f.store.read());
    const events = f.store.events().length;
    for (let round = 0; round < 3; round++) {
      const clock = crossingClock(lease);
      let body: { tasks: { progress: Progress }[] };
      try {
        body = (await (await fetch(app.url + '/api/state')).json()) as typeof body;
      } finally {
        clock.restore();
      }
      assert.ok(clock.calls > 0);
      consistent(body.tasks.map((t) => t.progress));
    }
    assert.equal(JSON.stringify(f.store.read()), state);
    assert.equal(f.store.events().length, events);
  } finally {
    await app.close();
    f.cleanup();
  }
});
