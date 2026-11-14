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
import { devcontourHandoff, withHeldBaseStop } from '../src/application/handoff.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { liftsPause, loopAhead, pauseStep } from '../src/runner/lead-outlook.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { STALE_BASE } from '../src/runner/base-update.ts';
import { holdSensitiveBaseMove } from '../src/runner/base-check.ts';
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
          assert.match(pack.next.detail!, /«Подтвердить и запустить»/, label);
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

test('Пауза человека до старта задания и удержанный перенос: цикл паузу не снимает, queue_set ведущего отказывает, виды называют оператора', async () => {
  const f = fixture();
  const lead = new LeadRunner(f.h, f.root);
  try {
    const b = f.h.createBoard('Board', '', 'main');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    // Пауза — раньше старта задания: её цикл стадии 1 снял бы (operatorDecided ложно).
    f.h.pause(true);
    await new Promise((r) => setTimeout(r, 5));
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const at = new Date().toISOString();
    const setWait = (detail: string) =>
      f.store.change('fixture.wait', (s) => {
        s.baseMoves = {
          at,
          bases: [{ repositoryId: 'main', from: 'a'.repeat(40), to: 'b'.repeat(40) }],
        };
        s.waits = [{ kind: 'base-check', detail, at }] as never;
      });
    const state = () => f.store.read();
    const stage1 = () => ({ ...flow.get(job.key, job.owner), stage: 1 }) as never;
    const tasks = () => state().tasks.filter((x) => x.id === t.id);
    // Контроль: без удержания цикл снял бы эту паузу.
    setWait('База прогонов перенесена (main): проверьте её гейтами и продолжите очередь');
    assert.equal(state().pauseReason, 'operator');
    assert.equal(
      pauseStep(state(), stage1(), tasks()).lift,
      true,
      'без удержания цикл снимает паузу',
    );
    // Удержание: ни стадия 1, ни стадия 2 паузу не снимают.
    setWait(heldBaseDetail(['main:tests/config.json']));
    assert.equal(pauseStep(state(), stage1(), tasks()).lift, false);
    assert.equal(
      pauseStep(state(), { ...flow.get(job.key, job.owner), stage: 2 }, tasks()).lift,
      false,
    );
    const ahead = loopAhead(f.h, state(), flow.get(job.key, job.owner));
    assert.notEqual(ahead.outlook.step, 'lift-pause', JSON.stringify(ahead));
    assert.equal(liftsPause(f.h, state(), flow.get(job.key, job.owner) as never), false);
    // Виды: оператор.
    const handoff = devcontourHandoff(f.h, { boardId: b.id });
    assert.equal(handoff.host.next?.code, 'base-held', JSON.stringify(handoff.host.next));
    const started = agent(f.h, 'workflow_start', {
      kind: 'board',
      id: b.id,
      authorRuntime: 'codex',
    }) as { baseHeld?: unknown };
    assert.ok(started.baseHeld);
    // Цикл задания: такты не снимают паузу и не снимают удержание.
    for (let i = 0; i < 3; i++) await lead.tick();
    assert.equal(
      state().paused,
      true,
      'очередь на паузе: ' + JSON.stringify(flow.get(job.key, job.owner)),
    );
    assert.ok(
      state().waits?.some((w) => w.kind === 'base-check' && w.detail.startsWith(BASE_HELD_DETAIL)),
    );
    // queue_set ведущего паузу не снимает.
    assert.throws(() => agent(f.h, 'queue_set', { paused: false }), /Подтвердить и запустить/);
    assert.equal(state().paused, true);
    // Подтверждение человека (снятие паузы оператором) снимает и удержание.
    f.h.pause(false);
    assert.equal(state().paused, false);
    assert.ok(!state().waits?.some((w) => w.kind === 'base-check'));
  } finally {
    await lead.stop();
    f.cleanup();
  }
});

/** Одобрение независимого ревью контракта (как `review-contract` в режиме агента). */
const reviewed = (root: string, id: string) => ({
  actor: 'agent' as const,
  authorRuntime: 'codex' as const,
  reviewerRuntime: 'claude' as const,
  artifact: join(root, 'decisions', id),
  digest: 'review-' + id,
});

test('Документ контракта в одобренной ревью редакции: base-update его не удерживает, рядом с файлом настройки удерживает только файл, остановка «база отстала» оператора не называет', async () => {
  const doc = 'docs/contracts/api.md';
  const text = '# API v1\n\nGET /items returns the list of items.\n';
  const setup = async () => {
    const f = await gitFixture();
    f.store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const b = f.h.createBoard('Reviewed board', '', 'main');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.contract('API v1', text, reviewed(f.root, 'review-1'), undefined, doc);
    return f;
  };
  // (a) только одобренный документ: удержания нет, проверку ведёт цикл.
  {
    const f = await setup();
    try {
      await f.commit({ [doc]: text });
      const result = (await baseUpdateOperation(f.h, f.root, { by: 'host' })) as {
        baseHeld?: unknown;
        next: string;
      };
      assert.equal(result.baseHeld, undefined);
      assert.match(result.next, /Запущенный workflow доски проверит её gates/);
      assert.equal(f.events('base.check.held').length, 0);
      assert.ok(!f.detail().startsWith(BASE_HELD_DETAIL), f.detail());
    } finally {
      f.cleanup();
    }
  }
  // (b) документ и файл настройки: удержан только файл настройки.
  {
    const f = await setup();
    try {
      await f.commit({ [doc]: text, '.devcontour/x.json': '{}\n' });
      const result = (await baseUpdateOperation(f.h, f.root, { by: 'host' })) as {
        baseHeld?: { paths: string[] };
      };
      assert.deepEqual(result.baseHeld, { paths: ['main:.devcontour/x.json'] });
      assert.equal(f.detail(), heldBaseDetail(['main:.devcontour/x.json']));
      // Ожидание этого переноса сменилось за время разбора (его заменил
      // более поздний перенос): первое чтение — до разбора, дальше ожидание
      // другое. Удержание не пишется, пути не возвращаются.
      const read = f.h.store.read.bind(f.h.store);
      let calls = 0;
      f.h.store.read = () => {
        const st = read();
        if (calls++ > 0)
          st.waits = st.waits?.map((w) => ({
            ...w,
            at: '2000-01-01T00:00:00.000Z',
            detail: 'База прогонов перенесена (main): проверьте её гейтами и продолжите очередь',
          }));
        return st;
      };
      try {
        assert.deepEqual(await holdSensitiveBaseMove(f.h, f.root), []);
      } finally {
        f.h.store.read = read;
      }
      assert.equal(f.events('base.check.held').length, 1, 'второго события нет');
    } finally {
      f.cleanup();
    }
  }
  // (c) остановка такта: перемотки нет (документ чувствителен), но после
  // переноса его снимут gates — оператор не назван.
  {
    const f = await setup();
    const scheduler = new Scheduler(f.h, f.root);
    try {
      // База — предок рабочей ветки: перемотка возможна, её держит только документ.
      await git(
        f.config.repository,
        'update-ref',
        'refs/heads/' + f.config.targetBranch,
        await git(f.config.repository, 'rev-parse', 'HEAD'),
      );
      await f.commit({ [doc]: text });
      await scheduler.init();
      f.h.pause(false);
      await assert.rejects(scheduler.tick(), (e: Error) => {
        assert.ok(e.message.includes(STALE_BASE), e.message);
        assert.match(e.message, /Перемотка не выполнена автоматически/);
        assert.match(e.message, /main:docs\/contracts\/api\.md/);
        assert.doesNotMatch(e.message, /подтверждение оператора/);
        return true;
      });
    } finally {
      await scheduler.stop();
      f.cleanup();
    }
  }
});

test('withHeldBaseStop: поручения называют человека, отброшенная пределом остановка очереди возвращается, текст в пределе строки пакета', () => {
  const long = Array.from(
    { length: 20 },
    (_, i) => `main:config/very/long/path/number-${i}/settings.json`,
  );
  const f = heldState(heldBaseDetail(long));
  try {
    const { pack } = devcontourHandoff(f.h, { boardId: f.boardId });
    assert.ok(pack.works.length > 0);
    for (const w of pack.works) {
      assert.ok(
        !(w.next.actor === 'controller' && w.next.action === 'wait'),
        JSON.stringify(w.next),
      );
      assert.equal(w.next.command, undefined);
    }
    assert.ok(pack.works.some((w) => w.next.actor === 'user' && w.next.action === 'resume-queue'));
    const stop = pack.stops.find((x) => x.queue)!;
    assert.ok([...stop.message].length <= 300, String([...stop.message].length));
    // Остановку отбросил предел размера: она возвращается, счётчик уменьшен.
    const dropped = {
      ...pack,
      stops: pack.stops.filter((x) => !x.queue),
      truncated: { ...pack.truncated, stops: 1 },
    };
    const back = withHeldBaseStop(dropped, f.store.read());
    assert.equal(back.stops.filter((x) => x.queue).length, 1);
    assert.equal(back.stops.find((x) => x.queue)!.actor, 'user');
    assert.equal(back.truncated.stops, 0);
  } finally {
    f.cleanup();
  }
});
