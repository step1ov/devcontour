// Удержанный перенос базы (D42) глазами ведущего: ответ base-update,
// остановка очереди, центр внимания, session_handoff и workflow_start
// называют одно — подтверждает оператор, с путями переноса.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { demoPool, testDemo } from './demo-pool.ts';
import { fixture, input } from './helpers.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { git } from '../src/runner/process.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { BASE_HELD_DETAIL, checkBase, heldBaseDetail } from '../src/runner/base-check.ts';
import { baseUpdateOperation } from '../src/runner/base-update.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { AgentService } from '../src/application/agent.ts';
import { queueStopOf } from '../src/application/queue-stop.ts';
import { HELD_BASE_ACTION } from '../src/core/work-status.ts';

const demos = demoPool(testDemo);
after(() => demos.close());

/** Демо-workspace с Git: коммит на рабочей ветке без переноса базы. */
async function gitFixture() {
  const seed = await demos.acquire();
  const root = seed.root;
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'base-held.sqlite'));
  const h = new DevContour(store, config);
  const commit = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(config.repository, path, '..'), { recursive: true });
      await writeFile(join(config.repository, path), content);
    }
    await git(config.repository, 'add', '-f', '--', ...Object.keys(files));
    await git(config.repository, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'prepare');
    return git(config.repository, 'rev-parse', 'HEAD');
  };
  const events = (type: string) => store.allEvents().filter((e) => e.type === type);
  const detail = () => store.read().waits?.find((w) => w.kind === 'base-check')?.detail ?? '';
  const cleanup = () => {
    store.close();
    seed.release();
  };
  return { root, config, store, h, commit, events, detail, cleanup };
}

const agent = (h: DevContour, operation: string, input: unknown) =>
  new AgentService(h).execute({ operation, input });

test('base-update переноса, который gates не подтверждают, сразу удерживает его, и все виды ведущего называют оператора и пути', async () => {
  const f = await gitFixture();
  const { root, config, store, h, commit, events, detail } = f;
  try {
    assert.equal(config.approvalMode, 'agent');
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const b = h.createBoard('Held base board', '', 'main');
    h.addTask(b.id, input());
    h.approve(b.id);
    const path = '.devcontour/test-config.json';
    await commit({ [path]: '{"timeoutMs": 1}\n' });
    const held = `main:${path}`;

    // base-update: пути и оператор, а не «workflow проверит её gates».
    const result = (await baseUpdateOperation(h, root, { by: 'host' })) as {
      updated: unknown[];
      baseHeld?: { paths: string[] };
      next: string;
    };
    assert.equal(result.updated.length, 1);
    assert.deepEqual(result.baseHeld, { paths: [held] });
    assert.doesNotMatch(result.next, /Запущенный workflow доски проверит/);
    assert.match(result.next, /ждёт подтверждения оператора/);
    assert.ok(result.next.includes(held), result.next);
    assert.ok(result.next.includes(HELD_BASE_ACTION), result.next);
    assert.match(result.next, /не снимайте паузу \(queue_set\)/);

    // Удержание записано сразу — той же причиной, что у проверки базы циклом.
    assert.equal(store.read().pauseReason, 'base-check');
    assert.equal(detail(), heldBaseDetail([held]));
    assert.ok(detail().startsWith(BASE_HELD_DETAIL));
    const recorded = events('base.check.held');
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0].data, { paths: [held], by: 'base-update' });

    // Остановка очереди.
    const stop = queueStopOf(h);
    assert.equal(stop.action, HELD_BASE_ACTION);
    assert.ok(stop.stopReason?.includes(held), stop.stopReason);

    // Центр внимания: пункт ведущего называет человека.
    const items = agent(h, 'attention_list', {}).items as { sourceKey: string; actor: string }[];
    assert.ok(
      items.some((i) => i.sourceKey === 'wait:base-check:lead' && i.actor === 'lead'),
      JSON.stringify(items.map((i) => i.sourceKey)),
    );

    // workflow_start: задание поставлено, но ответ предупреждает об удержании.
    const started = agent(h, 'workflow_start', {
      kind: 'board',
      id: b.id,
      authorRuntime: 'codex',
    }) as { status: string; warning?: string; baseHeld?: unknown };
    assert.equal(started.status, 'queued');
    assert.deepEqual(started.baseHeld, { paths: [held], actor: 'operator' });
    assert.ok(started.warning?.includes(held), started.warning);
    assert.match(started.warning!, /только подтверждение оператора/);

    // session_handoff доски: host.next — оператор, пакет не называет controller.
    const pack = devcontourHandoff(h, { boardId: b.id });
    assert.equal(pack.host.next?.action, 'operator', JSON.stringify(pack.host.next));
    assert.equal(pack.host.next?.code, 'base-held');
    assert.deepEqual(pack.host.next?.params, { paths: [held] });
    assert.equal(pack.pack.next.actor, 'user', JSON.stringify(pack.pack.next));
    assert.equal(pack.pack.next.action, 'resume-queue');
    assert.equal(pack.pack.next.command, undefined);
    assert.ok(pack.pack.next.detail?.includes(held), pack.pack.next.detail);
    const queueStop = pack.pack.stops.find((s) => s.queue);
    assert.equal(queueStop?.actor, 'user');
    assert.ok(queueStop?.message.includes(held), queueStop?.message);
    assert.ok(
      !pack.pack.stops.some((s) => /Очередь ждёт операции base-check/.test(s.message)),
      JSON.stringify(pack.pack.stops),
    );

    // Проверка базы циклом причину не переписывает: второго события нет.
    assert.equal(await checkBase(h, { data: root, state: root }, () => {}), false);
    assert.equal(events('base.check.held').length, 1);
    assert.equal(detail(), heldBaseDetail([held]));
  } finally {
    f.cleanup();
  }
});

test('base-update продуктовых коммитов не удерживает перенос: проверку ведёт workflow, оператор не назван', async () => {
  const f = await gitFixture();
  const { root, store, h, commit, events, detail } = f;
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const b = h.createBoard('Product board', '', 'main');
    h.addTask(b.id, input());
    h.approve(b.id);
    await commit({ 'src/product-held-check.txt': 'product\n' });
    const result = (await baseUpdateOperation(h, root, { by: 'host' })) as {
      updated: unknown[];
      baseHeld?: unknown;
      next: string;
    };
    assert.equal(result.updated.length, 1);
    assert.equal(result.baseHeld, undefined);
    assert.match(result.next, /Запущенный workflow доски проверит её gates/);
    assert.equal(events('base.check.held').length, 0);
    assert.ok(!detail().startsWith(BASE_HELD_DETAIL), detail());
    const started = agent(h, 'workflow_start', {
      kind: 'board',
      id: b.id,
      authorRuntime: 'codex',
    }) as { baseHeld?: unknown; warning?: string };
    assert.equal(started.baseHeld, undefined);
    assert.doesNotMatch(started.warning ?? '', /оператор/);
    const pack = devcontourHandoff(h, { boardId: b.id });
    assert.notEqual(pack.host.next?.code, 'base-held');
  } finally {
    f.cleanup();
  }
});

const HELD =
  'Перенос базы меняет приёмку или настройку контура (main:tests/config.json): gates этой базы его не подтверждают.';

/** Доска с открытой задачей и заданием; очередь стоит на `base-check` с причиной `detail`. */
function heldState(detail: string, pauseReason: 'base-check' | 'operator' = 'base-check') {
  const f = fixture();
  const b = f.h.createBoard('Board', '', 'main');
  f.h.addTask(b.id, input());
  f.h.approve(b.id);
  new LeadWorkflow(f.h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
  f.store.change('fixture.held', (s) => {
    s.paused = true;
    s.pauseReason = pauseReason;
    s.pausedAt = new Date().toISOString();
    s.baseMoves = [{ repositoryId: 'main', from: 'a'.repeat(40) }] as never;
    s.waits = [{ kind: 'base-check', detail, at: new Date().toISOString() }] as never;
  });
  return { ...f, boardId: b.id };
}

test('session_handoff: удержанный перенос в пакете — человек и пути при любой причине паузы; обычное ожидание проверки базы — прежнее ожидание controller', () => {
  for (const reason of ['base-check', 'operator'] as const) {
    const f = heldState(HELD, reason);
    try {
      for (const request of [{}, { boardId: f.boardId }]) {
        const { pack, host } = devcontourHandoff(f.h, request);
        const label = `${reason} ${JSON.stringify(request)}`;
        assert.equal(host.next?.action, 'operator', label + JSON.stringify(host.next));
        assert.equal(host.next?.code, 'base-held', label);
        assert.deepEqual(host.next?.params, { paths: ['main:tests/config.json'] }, label);
        assert.equal(host.next?.boardId, f.boardId, label);
        if (reason === 'base-check') {
          // Пакет harness видит паузу base-check как ожидание controller.
          assert.equal(pack.next.actor, 'user', label);
          assert.equal(pack.next.action, 'resume-queue', label);
          assert.match(pack.next.detail!, /main:tests\/config\.json/, label);
          assert.ok(pack.next.detail!.includes(HELD_BASE_ACTION), label);
          const stop = pack.stops.find((s) => s.queue)!;
          assert.equal(stop.actor, 'user', label);
          assert.equal(stop.action, 'resume-queue', label);
          assert.match(stop.message, /main:tests\/config\.json/, label);
        }
      }
    } finally {
      f.cleanup();
    }
  }
  // Ожидание проверки базы без удержания: снимут gates, пакет не меняется.
  const f = heldState('База прогонов перенесена (main): проверьте её гейтами и продолжите очередь');
  try {
    const { pack, host } = devcontourHandoff(f.h, { boardId: f.boardId });
    assert.notEqual(host.next?.code, 'base-held');
    assert.equal(pack.next.actor, 'controller');
    assert.equal(pack.next.action, 'wait');
    const stop = pack.stops.find((s) => s.queue)!;
    assert.equal(stop.actor, 'controller');
    assert.match(stop.message, /Очередь ждёт операции base-check/);
  } finally {
    f.cleanup();
  }
});

test('workflow_start предупреждает об удержанном переносе только для действующего задания доски', () => {
  const f = heldState(HELD);
  try {
    const started = agent(f.h, 'workflow_start', {
      kind: 'board',
      id: f.boardId,
      authorRuntime: 'codex',
    }) as { status: string; warning?: string; baseHeld?: unknown };
    assert.equal(started.status, 'queued');
    assert.deepEqual(started.baseHeld, { paths: ['main:tests/config.json'], actor: 'operator' });
    assert.match(started.warning!, /main:tests\/config\.json/);
    assert.ok(started.warning!.includes(HELD_BASE_ACTION), started.warning);
  } finally {
    f.cleanup();
  }
  const plain = heldState(
    'База прогонов перенесена (main): проверьте её гейтами и продолжите очередь',
  );
  try {
    const started = agent(plain.h, 'workflow_start', {
      kind: 'board',
      id: plain.boardId,
      authorRuntime: 'codex',
    }) as { baseHeld?: unknown; warning?: string };
    assert.equal(started.baseHeld, undefined);
    assert.doesNotMatch(started.warning ?? '', /оператор/);
  } finally {
    plain.cleanup();
  }
});
