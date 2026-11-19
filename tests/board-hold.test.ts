// F86: ведущий закрывает упавшее задание мёртвой доски (`workflow_close`) и
// откладывает доску (`board_park`): ни то ни другое не остаётся шагом
// `session_handoff` и карточкой центра внимания.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, fixture, input } from './helpers.ts';
import { cliCommand } from './cli-command.ts';
import { command } from '../src/runner/process.ts';
import { AgentService } from '../src/application/agent.ts';
import { AttentionService } from '../src/application/attention.ts';
import {
  devcontourHandoff,
  devcontourHandoffWithin,
  handoffResponse,
} from '../src/application/handoff.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { DomainError } from '../src/core/model.ts';
import { closeDeadJob, parkOf, parkedHold, setPark } from '../src/core/board-hold.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';

type F = ReturnType<typeof fixture>;

const cards = async (f: { store: Store; h: DevContour }) =>
  (await new AttentionService(f.store, f.h).active()).items;

/** Шаги host.next по доскам: шаг пакета всего workspace и шаг пакета одной доски. */
const nextOf = (f: F, boardId?: string) =>
  devcontourHandoff(f.h, boardId ? { boardId } : {}).host.next;

/**
 * Мёртвая доска: выданная задача упала и отменена (`cancelledBy`), вторая
 * отменена ведущим, задание доски упало на отменённой задаче (D46).
 */
async function deadBoard(
  f: Pick<F, 'h' | 'root'>,
  by: 'host' | 'operator' = 'host',
  budget = false,
) {
  const b = f.h.createBoard('Dead board', '', 'main');
  const stopped = f.h.addTask(b.id, input('Fails its gate'));
  const other = f.h.addTask(b.id, input('Dropped'));
  f.h.approve(b.id);
  const flow = new LeadWorkflow(f.h);
  const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
  f.h.pause(false);
  const run = f.h.claim('test')!;
  assert.equal(run.taskId, stopped.id);
  f.h.fail(
    run.id,
    run.token,
    budget ? 'workspace budget exceeded' : 'gate failed',
    false,
    budget ? 'budget' : 'gate',
  );
  f.h.cancel(stopped.id, 'Replanned on another board', by);
  f.h.cancel(other.id, 'Replanned on another board', 'host');
  // Задание падает своим циклом (D46), а не записью теста.
  await loop(f);
  assert.equal(flow.get(job.key, job.owner).status, 'failed');
  return { board: b.id, stopped: stopped.id, job };
}

/** Несколько тактов цикла ведущего: задания делают свои шаги. */
async function loop(f: Pick<F, 'h' | 'root'>) {
  const runner = new LeadRunner(f.h, f.root);
  for (let i = 0; i < 4; i++) await runner.tick();
  await runner.stop();
}

test('workflow_close: задание мёртвой доски закрыто — нет ни шага host.next, ни карточки; повтор задачи возвращает шаг', async () => {
  const f = fixture();
  try {
    const { board, stopped, job } = await deadBoard(f);
    // Другая доска с решением о плане: остановка мёртвой доски (decide)
    // стояла раньше него в шаге workspace.
    const other = f.h.createBoard('Real work', '', 'main');
    f.h.addTask(other.id, input('Next real task'));
    assert.equal(nextOf(f)?.boardId, board);
    const before = nextOf(f, board);
    assert.equal(before?.code, 'job-cancelled-task', JSON.stringify(before));
    assert.equal((before.params as { closable?: true }).closable, true);
    assert.match(before.detail, /workflow_close \{"boardId": /);
    assert.ok(
      (await cards(f)).some((c) => c.sourceKey === `board:${board}`),
      'до закрытия — карточка решения по доске',
    );
    const agent = new AgentService(f.h, f.root);
    const closed = agent.execute({
      operation: 'workflow_close',
      input: { boardId: board, reason: 'Work was replanned on board B-next and accepted' },
    }) as { job: { key: string }; closure: { by: string; reason: string } };
    assert.equal(closed.job.key, job.key);
    assert.equal(closed.closure.by, 'lead');
    assert.equal(nextOf(f, board), undefined);
    assert.equal(nextOf(f)?.boardId, other.id);
    assert.equal(nextOf(f)?.code, 'plan-unapproved');
    assert.ok(!(await cards(f)).some((c) => c.sourceKey === `board:${board}`));
    // Задание осталось упавшим: закрытие ничего не меняет в очереди и задачах.
    assert.equal(new LeadWorkflow(f.h).get(job.key, job.owner).status, 'failed');
    assert.equal(f.h.store.read().tasks.find((t) => t.id === stopped)?.status, 'cancelled');
    // Доска ожила (повтор задачи): закрытие больше не прячет её шаги.
    f.h.retry(stopped, undefined, 'host', { lead: true });
    const after = nextOf(f, board);
    assert.ok(after, 'после повтора задачи у доски снова есть шаг');
  } finally {
    f.cleanup();
  }
});

test('workflow_close: отказы — живая доска, отмена человеком или бюджетом (ведущему), неупавшее задание', async () => {
  const f = fixture();
  try {
    // В ревизии есть неотменённая задача: приёмка без задачи — решение пользователя.
    const live = f.h.createBoard('Live board', '', 'main');
    const stopped = f.h.addTask(live.id, input('Fails'));
    f.h.addTask(live.id, input('Kept'));
    f.h.approve(live.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: live.id, authorRuntime: 'codex' });
    f.h.pause(false);
    const run = f.h.claim('test')!;
    f.h.fail(run.id, run.token, 'gate failed', false, 'gate');
    f.h.cancel(stopped.id, 'Not worth it', 'host');
    flow.fail(flow.claim(job.key, job.owner)!, `${stopped.id}: stopped`);
    f.h.pause(true);
    assert.throws(
      () => closeDeadJob(f.h, live.id, 'Replanned elsewhere already', 'lead'),
      (e: unknown) => e instanceof DomainError && /не мертва/.test(e.message),
    );
    assert.throws(
      () => closeDeadJob(f.h, live.id, 'Replanned elsewhere already', 'operator'),
      /не мертва/,
    );
  } finally {
    f.cleanup();
  }
  for (const [by, budget] of [
    ['operator', false],
    ['host', true],
  ] as const) {
    const g = fixture();
    try {
      const { board } = await deadBoard(g, by, budget);
      const step = nextOf(g, board);
      assert.equal(step?.code, 'job-cancelled-task');
      assert.equal((step.params as { closable?: true }).closable, undefined, `${by} ${budget}`);
      assert.doesNotMatch(step.detail, /workflow_close/);
      assert.throws(
        () => closeDeadJob(g.h, board, 'Replanned elsewhere already', 'lead'),
        /решение пользователя/,
      );
      // Человек закрывает сам (CLI --by operator).
      closeDeadJob(g.h, board, 'Replanned elsewhere already', 'operator');
      assert.equal(nextOf(g, board), undefined);
    } finally {
      g.cleanup();
    }
  }
  const g = fixture();
  try {
    // Действующее задание мёртвой доски ещё не упало: закрывать нечего.
    const b = g.h.createBoard('Cancelled before failing', '', 'main');
    const t = g.h.addTask(b.id, input('Only task'));
    g.h.approve(b.id);
    new LeadWorkflow(g.h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    g.h.cancel(t.id, 'Not needed any more', 'host');
    assert.throws(() => closeDeadJob(g.h, b.id, 'Not needed any more', 'lead'), /не упавшее/);
    assert.throws(() => closeDeadJob(g.h, b.id, 'short', 'lead'), /Причина/);
  } finally {
    g.cleanup();
  }
});

test('board_park: отложенная доска — без plan-unapproved и карточки, host.parked, старт и ревью отказывают; снятие возвращает шаг', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Debt after release', '', 'main');
    f.h.addTask(b.id, input('Deferred debt task'));
    // Доска только с черновиками: пакета доски нет, шаг — в пакете workspace.
    assert.equal(nextOf(f)?.code, 'plan-unapproved');
    assert.equal(nextOf(f)?.boardId, b.id);
    const title = 'План доски «Debt after release» не согласован';
    assert.ok((await cards(f)).some((c) => c.title === title));
    const agent = new AgentService(f.h, f.root);
    const parked = agent.execute({
      operation: 'board_park',
      input: { boardId: b.id, parked: true, reason: 'Owner: after the 0.2.0 release' },
    }) as { parked: boolean; park: { by: string } };
    assert.equal(parked.parked, true);
    assert.equal(parked.park.by, 'lead');
    assert.equal(nextOf(f), undefined);
    assert.ok(!(await cards(f)).some((c) => c.title === title));
    const host = devcontourHandoff(f.h, {}).host;
    assert.deepEqual(
      host.parked?.map((p) => [p.boardId, p.reason]),
      [[b.id, 'Owner: after the 0.2.0 release']],
    );
    assert.throws(
      () =>
        agent.execute({
          operation: 'workflow_start',
          input: { kind: 'board', id: b.id, authorRuntime: 'codex' },
        }),
      (e: unknown) =>
        e instanceof DomainError && e.status === 409 && e.details?.code === 'BOARD_PARKED',
    );
    // Ревью плана отказывает до вызова модели (адаптеров у теста нет).
    await assert.rejects(
      agent.run({
        operation: 'plan_review',
        input: { boardId: b.id, authorRuntime: 'codex' },
      }),
      /отложена/,
    );
    assert.equal(new LeadWorkflow(f.h).list().length, 0);
    agent.execute({ operation: 'board_park', input: { boardId: b.id, parked: false } });
    assert.equal(parkOf(f.h, b.id), undefined);
    assert.equal(nextOf(f)?.code, 'plan-unapproved');
    assert.equal(devcontourHandoff(f.h, {}).host.parked, undefined);
    // Схема: reason обязателен с parked true и запрещён с false.
    assert.throws(
      () => agent.execute({ operation: 'board_park', input: { boardId: b.id, parked: true } }),
      /reason/,
    );
    assert.throws(
      () =>
        agent.execute({
          operation: 'board_park',
          input: { boardId: b.id, parked: false, reason: 'Owner: after the release' },
        }),
      /reason/,
    );
  } finally {
    f.cleanup();
  }
});

test('board_park: срок until и утверждённые позже задачи снимают действие отметки; отказы для утверждённых задач и действующего задания', () => {
  const f = fixture();
  const realNow = Date.now;
  try {
    const b = f.h.createBoard('Parked for a while', '', 'main');
    f.h.addTask(b.id, input('Deferred'));
    const until = new Date(realNow() + 60 * 60_000).toISOString();
    setPark(f.h, b.id, { parked: true, reason: 'Owner: after the release', until }, 'lead');
    assert.equal(nextOf(f), undefined);
    Date.now = () => realNow() + 2 * 60 * 60_000;
    try {
      assert.equal(nextOf(f)?.code, 'plan-unapproved', 'срок истёк — шаг вернулся');
    } finally {
      Date.now = realNow;
    }
    assert.throws(
      () =>
        setPark(
          f.h,
          b.id,
          { parked: true, reason: 'Owner: after the release', until: '2000-01-01T00:00:00Z' },
          'lead',
        ),
      /срок уже прошёл/,
    );
    // Задачи доски утвердили после отметки: очередь выдаст их — шаги видны.
    f.h.approve(b.id);
    assert.equal(nextOf(f, b.id)?.code, 'board-start');
    // Отложить доску с утверждёнными задачами нельзя.
    assert.throws(
      () => setPark(f.h, b.id, { parked: true, reason: 'Owner: after the release' }, 'lead'),
      /уже утверждены/,
    );
    // Старт задания разрешён: отметка не действует.
    const job = new LeadWorkflow(f.h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    assert.equal(job.status, 'queued');
    // Только черновики, но задание доски действует: отложить нельзя.
    const c = f.h.createBoard('With a live job', '', 'main');
    const approved = f.h.addTask(c.id, input('Approved'));
    f.h.approve(c.id);
    new LeadWorkflow(f.h).start({ kind: 'board', id: c.id, authorRuntime: 'codex' });
    f.h.cancel(approved.id, 'Not needed before issue', 'host');
    f.h.addTask(c.id, input('Later draft'));
    assert.throws(
      () => setPark(f.h, c.id, { parked: true, reason: 'Owner: after the release' }, 'lead'),
      /действующее задание/,
    );
  } finally {
    Date.now = realNow;
    f.cleanup();
  }
});

test('CLI board-park и workflow-close: человек откладывает доску и закрывает задание мёртвой доски с отменой человеком', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-board-hold-')));
  const data = join(root, 'data');
  try {
    await mkdir(data);
    const c = config();
    await writeFile(join(data, 'config.json'), JSON.stringify(c));
    const store = new Store(join(data, 'state.sqlite'));
    const h = new DevContour(store, c);
    let dead: string, parked: string;
    try {
      ({ board: dead } = await deadBoard({ h, root: data }, 'operator'));
      parked = h.createBoard('Debt later', '', 'main').id;
      h.addTask(parked, input('Deferred'));
    } finally {
      store.close();
    }
    const cli = (...args: string[]) =>
      command([...cliCommand(), ...args, '--data', data], process.cwd());
    const refused = await cli(
      'workflow-close',
      '--board',
      dead,
      '--reason',
      'Replanned elsewhere',
      '--by',
      'host',
    );
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /решение пользователя/);
    const closed = await cli('workflow-close', '--board', dead, '--reason', 'Replanned elsewhere');
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal((JSON.parse(closed.stdout) as { closure: { by: string } }).closure.by, 'operator');
    const park = await cli(
      'board-park',
      '--board',
      parked,
      '--reason',
      'Owner: after the release',
      '--by',
      'host',
    );
    assert.equal(park.code, 0, park.stderr);
    assert.equal((JSON.parse(park.stdout) as { park: { by: string } }).park.by, 'lead');
    const bad = await cli('board-park', '--board', parked, '--unpark', '--reason', 'x');
    assert.notEqual(bad.code, 0);
    const reread = new Store(join(data, 'state.sqlite'));
    try {
      const g = new DevContour(reread, c);
      assert.equal(devcontourHandoff(g, {}).host.next, undefined);
      assert.equal(devcontourHandoff(g, {}).host.parked?.[0]?.boardId, parked);
    } finally {
      reread.close();
    }
    const unpark = await cli('board-park', '--board', parked, '--unpark');
    assert.equal(unpark.code, 0, unpark.stderr);
    assert.equal((JSON.parse(unpark.stdout) as { parked: boolean }).parked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow_close: закрытие относится к одному эпизоду — повтор задачи и новая отмена, повтор задания не наследуют его', async () => {
  // Повтор задачи, затем отмена человеком: прежнее закрытие не прячет шаг.
  const f = fixture();
  try {
    const { board, stopped } = await deadBoard(f);
    closeDeadJob(f.h, board, 'Work was replanned on another board', 'lead');
    assert.equal(nextOf(f, board), undefined);
    f.h.retry(stopped, undefined, 'host', { lead: true });
    assert.ok(nextOf(f, board));
    f.h.cancel(stopped, 'The user drops it after all', 'operator');
    const step = nextOf(f, board);
    assert.equal(step?.code, 'job-cancelled-task', JSON.stringify(step));
    assert.equal((step.params as { closable?: true }).closable, undefined);
    assert.ok((await cards(f)).some((c) => c.sourceKey === `board:${board}`));
    assert.throws(
      () => closeDeadJob(f.h, board, 'Work was replanned on another board', 'lead'),
      /решение пользователя/,
    );
  } finally {
    f.cleanup();
  }
  // Повтор задачи и новая отмена тем же ведущим: тот же вид, но другой эпизод.
  const g = fixture();
  try {
    const { board, stopped } = await deadBoard(g);
    closeDeadJob(g.h, board, 'Work was replanned on another board', 'lead');
    g.h.retry(stopped, undefined, 'host', { lead: true });
    g.h.cancel(stopped, 'Replanned on another board', 'host');
    assert.equal(nextOf(g, board)?.code, 'job-cancelled-task');
  } finally {
    g.cleanup();
  }
  // Повтор задания: тот же ключ, задание снова падает своим циклом.
  const k = fixture();
  try {
    const { board, job } = await deadBoard(k);
    closeDeadJob(k.h, board, 'Work was replanned on another board', 'lead');
    const flow = new LeadWorkflow(k.h);
    const before = flow.get(job.key, job.owner);
    flow.retry(job.key, job.owner);
    await loop(k);
    const after = flow.get(job.key, job.owner);
    assert.equal(after.status, 'failed');
    assert.notDeepEqual(
      [after.attempts, after.finishedAt],
      [before.attempts, before.finishedAt],
      'повтор задания — новый эпизод остановки',
    );
    assert.ok(nextOf(k, board), 'закрытие прежнего эпизода не прячет новый отказ');
  } finally {
    k.cleanup();
  }
});

test('workflow_close: отмена без актёра (из Git sync, без локальных прогонов) — не closable и не закрывается ведущим', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Synced cancellation', '', 'main');
    const local = f.h.addTask(b.id, input('Local issued task'));
    const imported = f.h.addTask(b.id, input('Imported cancelled task'));
    f.h.approve(b.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, local.id);
    f.h.fail(run.id, run.token, 'gate failed', false, 'gate');
    f.h.cancel(local.id, 'Replanned on another board', 'host');
    f.h.cancel(imported.id, 'Cancelled by a teammate', 'operator');
    // Запись из Git: актёр отмены — локальное поле, в синхронизированной задаче его нет.
    f.store.change('test.synced', (s) => {
      const t = s.tasks.find((x) => x.id === imported.id)!;
      delete t.cancelledBy;
      t.failureKind = 'budget';
    });
    await loop(f);
    assert.equal(flow.get(job.key, job.owner).status, 'failed');
    const step = nextOf(f, b.id);
    assert.equal(step?.code, 'job-cancelled-task', JSON.stringify(step));
    assert.equal((step.params as { closable?: true }).closable, undefined);
    assert.throws(
      () => closeDeadJob(f.h, b.id, 'Work was replanned on another board', 'lead'),
      (e: unknown) => e instanceof DomainError && e.message.includes(imported.id),
    );
  } finally {
    f.cleanup();
  }
});

test('board_park: утверждение и старт задания после отметки снимают её навсегда — новый отказ задания не прячется', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Parked then started', '', 'main');
    const t = f.h.addTask(b.id, input('Deferred then needed'));
    setPark(f.h, b.id, { parked: true, reason: 'Owner: after the release' }, 'lead');
    assert.equal(nextOf(f), undefined);
    // Утверждение тем же путём, что ревью плана (`approve`), старт задания.
    f.h.approve(b.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, t.id);
    f.h.fail(run.id, run.token, 'gate failed', false, 'gate');
    f.h.cancel(t.id, 'The user stops it', 'operator');
    await loop(f);
    assert.equal(flow.get(job.key, job.owner).status, 'failed');
    // Задач к выдаче снова нет, но отметка не вернулась.
    assert.equal(parkedHold(f.h, f.h.store.read(), b.id), undefined);
    assert.equal(nextOf(f, b.id)?.code, 'job-cancelled-task');
    assert.equal(devcontourHandoff(f.h, {}).host.parked, undefined);
  } finally {
    f.cleanup();
  }
  // Только утверждение, затем задача снова в черновике: отметка тоже снята.
  const g = fixture();
  try {
    const b = g.h.createBoard('Parked then approved', '', 'main');
    const t = g.h.addTask(b.id, input('Approved then reopened'));
    setPark(g.h, b.id, { parked: true, reason: 'Owner: after the release' }, 'lead');
    g.h.approve(b.id);
    g.h.reopen(t.id, 'Back to a draft for now');
    assert.equal(g.h.store.read().tasks.find((x) => x.id === t.id)?.status, 'draft');
    assert.equal(nextOf(g)?.code, 'plan-unapproved');
  } finally {
    g.cleanup();
  }
});

test('board_park: until — только строгая дата и время ISO 8601 со смещением', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Strict until', '', 'main');
    f.h.addTask(b.id, input('Deferred'));
    for (const until of [
      '2099-02-30T00:00:00Z',
      '03/04/2099',
      '2099-03-04',
      '2099-03-04T10:00:00',
      '2099-13-01T00:00:00Z',
      '2099-03-04T24:00:00Z',
    ])
      assert.throws(
        () =>
          setPark(f.h, b.id, { parked: true, reason: 'Owner: after the release', until }, 'lead'),
        /ISO 8601/,
        until,
      );
    const ok = setPark(
      f.h,
      b.id,
      { parked: true, reason: 'Owner: after the release', until: '2099-03-01T00:00:00+03:00' },
      'lead',
    );
    assert.equal(ok.parked && ok.park.until, '2099-02-28T21:00:00.000Z');
  } finally {
    f.cleanup();
  }
});

test('board_park: в approvalMode operator отложенная доска не даёт карточки ведущего «черновики не готовы»', async () => {
  const f = fixture();
  try {
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Parked backend drafts', '', 'main');
    f.h.addTask(b.id, { ...input('Unbound backend'), role: 'backend' });
    const title = 'Черновики доски «Parked backend drafts» не готовы к утверждению';
    assert.ok((await cards(f)).some((c) => c.title === title && c.actor === 'lead'));
    setPark(f.h, b.id, { parked: true, reason: 'Owner: after the release' }, 'lead');
    assert.ok(!(await cards(f)).some((c) => c.title === title));
  } finally {
    f.cleanup();
  }
});

test('session_handoff: host.parked в пределе ответа — причины уходят последней уступкой', () => {
  const f = fixture();
  try {
    const reason = 'Ж'.repeat(290) + ' after';
    for (let i = 0; i < 10; i++) {
      const b = f.h.createBoard(`Parked ${i}`, '', 'main');
      f.h.addTask(b.id, input(`Deferred ${i}`));
      setPark(f.h, b.id, { parked: true, reason }, 'lead');
    }
    const full = devcontourHandoffWithin(f.h, {}, { bytes: 10_000_000, format: 'md' });
    assert.equal(full.value.host.parked?.length, 10);
    assert.ok(full.value.host.parked.every((p) => p.reason === reason));
    const size = (v: typeof full.value) =>
      Buffer.byteLength(JSON.stringify(handoffResponse(v, 'md')));
    const total = size(full.value);
    // Предел меньше полного ответа на половину причин: остаются id, причины уходят.
    const limit = total - 10 * Buffer.byteLength(reason);
    const fitted = devcontourHandoffWithin(f.h, {}, { bytes: limit, format: 'md' });
    assert.ok(size(fitted.value) <= limit, `${size(fitted.value)} > ${limit}`);
    assert.equal(fitted.value.host.parked?.length, 10);
    assert.ok(fitted.value.host.parked.every((p) => p.reason === undefined && p.boardId));
    // Причина длиннее 300 знаков не записывается.
    const b = f.h.createBoard('Too long reason', '', 'main');
    f.h.addTask(b.id, input('Deferred'));
    assert.throws(
      () => setPark(f.h, b.id, { parked: true, reason: 'x'.repeat(301) }, 'lead'),
      /от 10 до 300/,
    );
  } finally {
    f.cleanup();
  }
});
