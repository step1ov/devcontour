import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import fs, { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, fixture, input } from './helpers.ts';
import { repositorySchema } from '../src/core/model.ts';
import { reviewContract, reviewPlan } from '../src/runner/agent-control.ts';
import { ContractChanges, type ContractChange } from '../src/runner/contract-change.ts';
import { contractImpact } from '../src/runner/contract-impact.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { readyTasks } from '../src/core/graph.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { lockContextFile, pinContext, planRepin } from '../src/runner/context.ts';
import { loadedDigest } from '../src/core/service.ts';
import { busyWork } from '../src/runner/reconfigure.ts';
import { Workspace } from '../src/core/workspace.ts';
import { Previews } from '../src/core/preview.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { loadConfig } from '../src/runner/config.ts';
import { serveReconfigure } from '../src/runner/reconfigure.ts';

/** Ревьюер-фикстура: одобряет и считает вызовы по предмету ревью. */
function reviewers(calls: string[]) {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute(r: AgentRequest) {
      calls.push(/Independently review this ([a-z /]+)\./.exec(r.prompt)?.[1] ?? '?');
      return Promise.resolve({
        data: { approved: true, summary: 'Fixture', findings: [], discoveries: [] },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      });
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

async function stage() {
  const f = fixture();
  const repo = await mkdtemp(join(tmpdir(), 'devcontour-change-'));
  f.h.config.repository = repo;
  f.h.config.mode = 'local';
  const sh = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: repo })
      .toString()
      .trim();
  sh('init', '-q', '-b', 'main');
  await mkdir(join(repo, 'docs/contracts'), { recursive: true });
  await writeFile(join(repo, 'docs/contracts/catalog.md'), '# Catalog\n\nSee schema.json.\n');
  await writeFile(join(repo, 'schema.json'), '{"price":"string"}\n');
  sh('add', '.');
  sh('commit', '-qm', 'contract');
  sh('branch', 'devcontour/accepted');
  const proposal = {
    title: 'Catalog API v1',
    file: 'docs/contracts/catalog.md',
    artifacts: [{ path: 'schema.json', purpose: 'Схема ответа' }],
  };
  const calls: string[] = [];
  await reviewContract(f.h, f.root, proposal, 'codex', reviewers(calls));
  const c1 = f.store.read().contracts[0];
  const board = f.h.createBoard('Catalog');
  const api = f.h.addTask(board.id, { ...input('API'), role: 'backend', contracts: [c1.id] });
  const screen = f.h.addTask(board.id, { ...input('Screen', [api.id]), role: 'qa' });
  f.h.approve(board.id);
  const shipped = f.h.addTask(f.h.createBoard('Shipped').id, {
    ...input('Shipped API'),
    role: 'backend',
    contracts: [c1.id],
  });
  f.store.change('fixture.done', (s) => {
    s.tasks.find((t) => t.id === shipped.id)!.status = 'done';
  });
  // Новая редакция схемы закоммичена в рабочую ветку.
  await writeFile(join(repo, 'schema.json'), '{"price":"number"}\n');
  sh('commit', '-qam', 'schema');
  calls.length = 0;
  const task = (id: string) => f.store.read().tasks.find((t) => t.id === id)!;
  return {
    ...f,
    repo,
    sh,
    proposal,
    calls,
    c1,
    board,
    api,
    screen,
    shipped,
    task,
    changes: (afterStep?: (step: string) => void) =>
      new ContractChanges(f.h, f.root, reviewers(calls), afterStep),
    async remove() {
      await rm(repo, { recursive: true, force: true });
      f.cleanup();
    },
  };
}

test('A contract change runs as one command: review, rebind, plan review, base and release', async () => {
  const s = await stage();
  try {
    s.h.pause(true);
    const started = await s.changes().start(s.proposal, 'codex');
    assert.equal(started.status, 'started');
    const done = await s.changes().advance((started as { operation: ContractChange }).operation.id);
    assert.equal(done.status, 'completed', done.error);
    const c2 = s.store.read().contracts.at(-1)!;
    assert.notEqual(c2.id, s.c1.id);
    assert.equal(done.contractId, c2.id);
    // Задача перепривязана к новой редакции и утверждена заново ревью плана.
    const api = s.task(s.api.id);
    assert.deepEqual(api.contracts, [c2.id]);
    assert.equal(api.status, 'ready');
    assert.equal(api.contractDigests[c2.id], c2.digest);
    // Зависимая задача удерживалась и отпущена, не перепривязываясь.
    assert.equal(s.task(s.screen.id).status, 'ready');
    // Принятая история не переписана: нужна корректировка.
    assert.deepEqual(s.task(s.shipped.id).contracts, [s.c1.id]);
    assert.deepEqual(done.corrections, [s.shipped.id]);
    assert.ok(
      s.store.read().tasks.every((t) => !t.hold),
      'удержание снято',
    );
    // База получила новую редакцию схемы — и только её.
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
    );
    assert.deepEqual(s.calls, ['contract / architecture decision', 'task plan']);
    assert.equal(s.store.read().paused, true, 'пауза оператора не снята');
    // Повтор команды по той же редакции ничего не меняет.
    assert.equal((await s.changes().start(s.proposal, 'codex')).status, 'unchanged');
  } finally {
    await s.remove();
  }
});

test('The plan reviewer sees the base the tasks will run on: the base moves before the plan review', async () => {
  const s = await stage();
  try {
    // Рецензент плана читает базу в момент ревью: при обратном порядке он
    // видел прежнюю схему и отклонял план, которому новая ещё не досталась.
    const seen: string[] = [];
    const base = reviewers(s.calls);
    const planReader: AgentAdapter = {
      ...base.codex,
      execute(r: AgentRequest) {
        if (/Independently review this task plan\./.test(r.prompt))
          seen.push(s.sh('show', 'devcontour/accepted:schema.json'));
        return base.codex.execute(r);
      },
    };
    const changes = new ContractChanges(s.h, s.root, { codex: planReader, claude: planReader });
    const { operation } = (await changes.start(s.proposal, 'claude')) as {
      operation: ContractChange;
    };
    const done = await changes.advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.deepEqual(seen, ['{"price":"number"}']);
    const order = done.history.filter((h) => h.event === 'done').map((h) => h.step);
    assert.deepEqual(order, [
      'hold',
      'drain',
      'review',
      'rebind',
      'base',
      'context',
      'reconfigure',
      'plan',
      'release',
    ]);
  } finally {
    await s.remove();
  }
});

test('An operation started with the previous step order continues by it', async () => {
  const s = await stage();
  try {
    // Операция прежнего порядка остановилась перед ревью планов (индекс 4):
    // при новом порядке тот же индекс — перенос базы, и без учёта порядка
    // операция, уже прошедшая план, пропустила бы перенос.
    const legacy = s.changes((step) => {
      if (step === 'rebind') throw new Error('stop after rebind');
    });
    const { operation } = (await legacy.start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    await legacy.advance(operation.id);
    const stopped = s.changes().get(operation.id);
    assert.equal(stopped.step, 4);
    s.store.atomic(() => {
      const { order, ...rest } = s.changes().get(operation.id);
      void order;
      s.store.saveLocal('contract-change', rest.owner, rest.id, rest);
    });
    assert.equal(s.changes().view(s.changes().get(operation.id)).next, 'plan');
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    const order = done.history.filter((h) => h.event === 'done').map((h) => h.step);
    assert.deepEqual(order, ['hold', 'drain', 'review', 'rebind', 'plan', 'base', 'release']);
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
      'перенос базы не пропущен',
    );
  } finally {
    await s.remove();
  }
});

test('A contract change resumes after a crash without repeating the review, and a live owner is not overtaken', async () => {
  const s = await stage();
  try {
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Сбой процесса сразу после ревью: владение осталось, lease ещё действует.
    class Crash extends Error {}
    await s
      .changes((step) => {
        if (step === 'review') throw new Crash('process died');
      })
      .advance(operation.id)
      .catch(() => undefined);
    // Сбой в точке после шага записан как отказ; моделируем «процесс умер»:
    // запись осталась running с действующим lease.
    s.store.atomic(() =>
      s.store.saveLocal('contract-change', operation.owner, operation.id, {
        ...s.changes().get(operation.id),
        status: 'running',
        token: 'dead-process',
        leaseUntil: Date.now() + 60000,
      }),
    );
    // Пока lease жив, другой процесс не перехватывает операцию.
    const blocked = await s.changes().advance(operation.id);
    assert.equal(blocked.status, 'running');
    assert.equal(blocked.next, 'rebind');
    // Lease истёк — операция продолжается с сохранённого шага.
    s.store.atomic(() =>
      s.store.saveLocal('contract-change', operation.owner, operation.id, {
        ...s.changes().get(operation.id),
        leaseUntil: Date.now() - 1,
      }),
    );
    const resumed = await s.changes().advance(operation.id);
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(s.store.read().contracts.length, 2, 'новая редакция одна');
    assert.equal(
      s.calls.filter((c) => c.startsWith('contract')).length,
      1,
      'ревью контракта не повторялось',
    );
  } finally {
    await s.remove();
  }
});

test('A contract change waits for running attempts, refuses concurrent changes and goes stale when the branch moves', async () => {
  const s = await stage();
  try {
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Вторая операция по другой редакции того же контракта — отказ.
    await writeFile(join(s.repo, 'schema.json'), '{"price":"decimal"}\n');
    s.sh('commit', '-qam', 'another revision');
    await assert.rejects(s.changes().start(s.proposal, 'codex'), /по другой редакции/);
    s.sh('reset', '-q', '--hard', 'HEAD~1');
    // Та же редакция — та же операция.
    const again = await s.changes().start(s.proposal, 'codex');
    assert.equal(again.status, 'existing');

    // Идущая попытка: операция ждёт, а не отменяет её.
    s.store.change('fixture.running', (st) => {
      st.tasks.find((t) => t.id === s.api.id)!.activeRunId = 'R-running';
    });
    const waiting = await s.changes().advance(operation.id);
    assert.equal(waiting.status, 'waiting');
    assert.deepEqual(waiting.waitingFor, [s.api.id]);
    assert.ok(s.task(s.screen.id).hold, 'зависимые задачи удержаны');
    s.store.change('fixture.finished', (st) => {
      st.tasks.find((t) => t.id === s.api.id)!.activeRunId = undefined;
    });

    // Конкурент сдвинул рабочую ветку до ревью — операция устарела.
    await writeFile(join(s.repo, 'other.txt'), 'competitor\n');
    s.sh('add', 'other.txt');
    s.sh('commit', '-qm', 'competitor');
    const stale = await s.changes().advance(operation.id);
    assert.equal(stale.status, 'stale');
    assert.match(stale.error ?? '', /сдвинулась/);
    assert.equal(s.store.read().contracts.length, 1, 'ревью не проводилось');
    const abandoned = s.changes().abandon(operation.id);
    assert.equal(abandoned.status, 'abandoned');
    assert.ok(
      s.store.read().tasks.every((t) => !t.hold),
      'отмена снимает удержание',
    );
  } finally {
    await s.remove();
  }
});

test('A contract change does not move base work that is not part of the contract, and holds stay consistent', async () => {
  const s = await stage();
  try {
    // Посторонняя работа уже лежит в рабочей ветке к началу операции.
    execFileSync('sh', ['-c', 'echo x > unrelated.txt'], { cwd: s.repo });
    s.sh('add', 'unrelated.txt');
    s.sh('commit', '-qm', 'unrelated');
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const failed = await s.changes().advance(operation.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.next, 'base');
    assert.match(failed.error ?? '', /вне контракта: unrelated\.txt/);
    // База не тронута, задачи удержаны: выдача не начнёт работу без схемы.
    assert.notEqual(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
    );
    assert.equal(s.task(s.api.id).hold?.operation, operation.id);
    assert.equal(
      readyTasks(s.store.read()).some((t) => t.id === s.api.id),
      false,
      'выдача пропускает удержанную задачу',
    );
    // Чужое удержание — конфликт для другой операции.
    assert.throws(() => s.h.hold([s.api.id], 'CC-other', 'test'), /другая операция/);
  } finally {
    await s.remove();
  }
});

test('Work reverted within the branch does not stop the base move; a file renamed onto an artifact does', async () => {
  const s = await stage();
  try {
    // Посторонняя правка и её отмена: итог ветки — только изменение контракта.
    execFileSync('sh', ['-c', 'echo x > scratch.txt'], { cwd: s.repo });
    s.sh('add', 'scratch.txt');
    s.sh('commit', '-qm', 'scratch');
    s.sh('rm', '-q', 'scratch.txt');
    s.sh('commit', '-qm', 'revert scratch');
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
    );
  } finally {
    await s.remove();
  }
  const r = await stage();
  try {
    // Посторонний файл переименован в новый артефакт: Git показал бы только
    // новый путь, а удаление прежнего — тоже изменение вне контракта.
    await writeFile(join(r.repo, 'notes.txt'), 'notes about types\n');
    r.sh('add', 'notes.txt');
    r.sh('commit', '-qm', 'notes');
    r.sh('branch', '-f', 'devcontour/accepted', 'HEAD');
    r.sh('mv', 'notes.txt', 'types.txt');
    r.sh('commit', '-qm', 'rename notes into a new artifact');
    const proposal = {
      ...r.proposal,
      artifacts: [...r.proposal.artifacts, { path: 'types.txt', purpose: 'Типы' }],
    };
    const { operation } = (await r.changes().start(proposal, 'codex')) as {
      operation: ContractChange;
    };
    const failed = await r.changes().advance(operation.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /вне контракта: notes\.txt/);
  } finally {
    await r.remove();
  }
});

/**
 * Пакет контекста включает документ контракта и закреплён на прежней
 * редакции; конфигурация записана в `config.json` и загружена из него, как у
 * работающего сервера. Затем документ меняется вместе со схемой.
 */
async function withContextPack(s: Awaited<ReturnType<typeof stage>>) {
  s.h.config.contextPacks = await pinContext({
    ...s.h.config,
    contextPacks: [
      {
        id: 'contracts',
        version: '1.0',
        repositoryId: 'main',
        roles: ['backend'],
        files: ['docs/contracts/catalog.md'],
        references: [],
      },
    ],
  });
  // Рабочая конфигурация local mode: исполнитель и ревьюер — разные
  // настоящие runtime (модели в тестах не вызываются: ревьюеры — фикстуры).
  for (const role of Object.values(s.h.config.roles)) {
    role.runtime = 'codex';
    if (role.reviewer) role.reviewer.runtime = 'claude';
  }
  s.h.config.reviewer = { ...s.h.config.reviewer, runtime: 'claude' };
  const path = join(s.root, 'config.json');
  await writeFile(path, JSON.stringify(s.h.config, null, 2) + '\n');
  s.h.config = loadConfig(path);
  await writeFile(join(s.repo, 'docs/contracts/catalog.md'), '# Catalog\n\nPrice is a number.\n');
  s.sh('commit', '-qam', 'contract text');
  const pinnedBefore = s.h.config.contextPacks[0].revision;
  return { path, pinnedBefore, digest: () => loadedDigest(loadConfig(path)) };
}

test('The operation repins a context pack that pins the previous contract text and applies the configuration itself', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    const before = ctx.digest();
    const pausedBefore = s.store.read().paused;
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    // config.json перезакреплён на проверенную ревизию, остальное не тронуто.
    const head = s.sh('rev-parse', 'HEAD');
    const written = JSON.parse(readFileSync(ctx.path, 'utf8')) as {
      contextPacks: { revision: string }[];
    };
    assert.equal(written.contextPacks[0].revision, head);
    assert.notEqual(head, ctx.pinnedBefore);
    assert.deepEqual(done.config, { before, after: ctx.digest() });
    // Новая конфигурация применена в процессе: рецензент плана видит новый текст.
    assert.equal(s.h.config.contextPacks[0].revision, head);
    assert.deepEqual(s.calls, ['contract / architecture decision', 'task plan']);
    assert.ok(done.history.some((h) => h.step === 'context' && h.event === 'repinned'));
    assert.ok(done.history.some((h) => h.step === 'reconfigure' && h.event === 'applied'));
    // Запрос применения снят, пауза очереди — как до операции.
    const state = s.store.read();
    assert.equal(state.reconfigure, undefined);
    assert.equal(state.paused, pausedBefore);
    assert.equal(state.waits, undefined);
    assert.ok(state.tasks.every((t) => !t.hold));
  } finally {
    await s.remove();
  }
});

test('A user pause set before or during the operation survives it; the operation lifts only its own pause', async () => {
  for (const when of ['before', 'during'] as const) {
    const s = await stage();
    try {
      await withContextPack(s);
      s.h.pause(false);
      if (when === 'before') s.h.pause(true);
      const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
        operation: ContractChange;
      };
      // Человек ставит паузу, пока операция держит свою (после context).
      const done = await s
        .changes((step) => {
          if (when === 'during' && step === 'context') {
            s.h.operationPause(operation.id);
            assert.equal(s.store.read().pauseReason, 'reconfigure');
            s.h.pause(true);
          }
        })
        .advance(operation.id);
      assert.equal(done.status, 'completed', done.error);
      const state = s.store.read();
      assert.equal(state.paused, true, when);
      assert.equal(state.pauseReason, 'operator', when);
    } finally {
      await s.remove();
    }
  }
  // Без паузы человека операция снимает свою.
  const s = await stage();
  try {
    await withContextPack(s);
    s.h.pause(false);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    let pausedInside = false;
    const done = await s
      .changes((step) => {
        if (step === 'reconfigure') pausedInside = true;
      })
      .advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.ok(pausedInside);
    assert.equal(s.store.read().paused, false);
  } finally {
    await s.remove();
  }
});

test('Reconfigure waits for a running attempt and issues nothing new until the configuration is applied', async () => {
  const s = await stage();
  try {
    await withContextPack(s);
    // Попытка другой задачи идёт под прежней конфигурацией.
    const other = s.h.addTask(s.h.createBoard('Other').id, { ...input('Other'), role: 'qa' });
    s.h.approve(s.store.read().boards.at(-1)!.id);
    s.h.pause(false);
    // Задачи контракта на время выдачи удержаны: попытку получает другая.
    s.h.hold([s.api.id, s.screen.id], 'fixture', 'выдать другую задачу');
    const run = s.h.claim('worker')!;
    s.h.release('fixture');
    assert.equal(run.taskId, other.id);
    // Исполнитель жив: его lease не истекает, пока идут шаги операции, даже
    // если машина медленная (истёкшая попытка drain не держит).
    s.store.change('fixture.live-run', (st) => {
      st.runs.find((r) => r.id === run.id)!.leaseUntil = Date.now() + 3_600_000;
    });
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const waiting = await s.changes().advance(operation.id);
    assert.equal(waiting.status, 'waiting', waiting.error);
    assert.equal(waiting.next, 'reconfigure');
    assert.deepEqual(waiting.waitingFor, [run.id]);
    // Пока запрос не применён, выдача и совместные проверки остановлены, даже
    // если человек снял паузу.
    s.h.pause(false);
    assert.equal(s.h.claim('worker-2'), undefined);
    assert.ok(s.store.read().reconfigure && !s.store.read().reconfigure!.appliedAt);
    // Попытка завершилась — операция применяет конфигурацию и продолжает.
    s.store.change('fixture.finish', (st) => {
      st.runs.find((r) => r.id === run.id)!.status = 'failed';
      const t = st.tasks.find((x) => x.id === run.taskId)!;
      t.activeRunId = undefined;
      t.status = 'ready';
    });
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(s.store.read().reconfigure, undefined);
  } finally {
    await s.remove();
  }
});

test('Only one operation applies a configuration at a time', () => {
  const f = fixture();
  try {
    f.h.requestReconfigure('CC-a', 'a'.repeat(64));
    // Повтор того же запроса — не конфликт.
    f.h.requestReconfigure('CC-a', 'a'.repeat(64));
    assert.throws(
      () => f.h.requestReconfigure('CC-b', 'b'.repeat(64)),
      /Конфигурацию уже применяет операция CC-a/,
    );
    f.h.settleReconfigure('CC-a', 'a'.repeat(64), 'server');
    f.h.requestReconfigure('CC-b', 'b'.repeat(64));
    assert.equal(f.store.read().reconfigure?.operation, 'CC-b');
  } finally {
    f.cleanup();
  }
});

test('A configuration changed outside the operation is refused with both digests, not applied', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // После перезакрепления кто-то правит config.json вне операции.
    const stopped = await s
      .changes((step) => {
        if (step === 'context') {
          const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as Record<string, unknown>;
          writeFileSync(
            ctx.path,
            JSON.stringify({ ...raw, runTimeoutMs: Number(raw.runTimeoutMs) + 1 }, null, 2) + '\n',
          );
        }
      })
      .advance(operation.id);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.error ?? '', /ожидался digest [0-9a-f]{16}, загружен [0-9a-f]{16}/);
    assert.equal(
      s.h.config.runTimeoutMs,
      loadConfig(ctx.path).runTimeoutMs - 1,
      'чужая правка не применена',
    );
  } finally {
    await s.remove();
  }
});

test('A crash after repinning or after applying resumes without a repeated review or a second write', async () => {
  for (const crashAt of ['context', 'reconfigure'] as const) {
    const s = await stage();
    try {
      const ctx = await withContextPack(s);
      const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
        operation: ContractChange;
      };
      const crashed = await s
        .changes((step) => {
          if (step === crashAt) throw new Error('crash after ' + step);
        })
        .advance(operation.id);
      assert.equal(crashed.status, 'failed');
      const written = ctx.digest();
      const mtime = statSync(ctx.path).mtimeMs;
      // Новый процесс читает уже записанный config.json.
      s.h.config = loadConfig(ctx.path);
      const done = await s.changes().advance(operation.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(ctx.digest(), written, crashAt);
      assert.equal(statSync(ctx.path).mtimeMs, mtime, 'файл не переписан: ' + crashAt);
      assert.deepEqual(s.calls, ['contract / architecture decision', 'task plan'], crashAt);
      assert.equal(done.history.filter((h) => h.event === 'repinned').length, 1, crashAt);
    } finally {
      await s.remove();
    }
  }
});

test('A running server applies the requested configuration and confirms it; an edit without a request is not applied', async () => {
  const s = await stage();
  let server: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    server = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    // Правка config.json без запроса операции работающий сервер не подхватывает.
    const raw = readFileSync(ctx.path, 'utf8');
    writeFileSync(ctx.path, raw.replace('"concurrency": 2', '"concurrency": 3'));
    serveReconfigure(server, ctx.path, 'server');
    assert.equal(server.config.concurrency, s.h.config.concurrency);
    writeFileSync(ctx.path, raw);
    // Сервер — живой лидер; операция ждёт его подтверждения.
    assert.ok(server.leader('server'));
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Сервер тикает, как настоящий: продлевает лидерство и обрабатывает
    // запрос, когда операция его запишет.
    let finished = false;
    const advancing = s
      .changes()
      .advance(operation.id)
      .finally(() => (finished = true));
    while (!finished) {
      server.leader('server');
      serveReconfigure(server, ctx.path, 'server');
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = await advancing;
    assert.equal(
      done.history.find((h) => h.step === 'reconfigure' && h.event === 'applied') !== undefined,
      true,
    );
    assert.equal(done.status, 'completed', done.error);
    assert.equal(server.config.contextPacks[0].revision, s.sh('rev-parse', 'HEAD'));
  } finally {
    server?.store.close();
    await s.remove();
  }
});

test('An attempt started under the previous configuration cannot be accepted under the new one', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    s.h.pause(false);
    const run = s.h.claim('worker')!;
    const before = s.h.policyDigest('main');
    // Новое закрепление применено (минуя drain — моделирует опоздавшего исполнителя).
    writeFileSync(
      ctx.path,
      await planRepin(s.h.config, readFileSync(ctx.path, 'utf8'), ['contracts'], 'HEAD'),
    );
    s.h.reconfigure(loadConfig(ctx.path));
    assert.notEqual(s.h.policyDigest('main'), before);
    assert.throws(
      () => s.h.phase(run.id, run.token, 'integrating', { candidateSha: 'c' }),
      /Политика проверок изменилась/,
    );
  } finally {
    await s.remove();
  }
});

test('C-F01: a repin retry accepts only the planned result; an edit in the crash window is refused', async () => {
  for (const edit of [false, true]) {
    const s = await stage();
    const realRename = fs.renameSync;
    try {
      const ctx = await withContextPack(s);
      const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
        operation: ContractChange;
      };
      // Процесс падает сразу после записи файла, до сохранения шага.
      let crashed = false;
      fs.renameSync = function (from, to) {
        realRename(from, to);
        if (String(to) === ctx.path && !crashed) {
          crashed = true;
          throw new Error('crash after rename');
        }
      };
      syncBuiltinESMExports();
      const failed = await s.changes().advance(operation.id);
      fs.renameSync = realRename;
      syncBuiltinESMExports();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.next, 'context');
      const planned = s.changes().get(operation.id).config!;
      assert.equal(ctx.digest(), planned.after, 'файл записан до падения');
      if (edit) {
        // В окне сбоя кто-то правит файл: повтор не принимает это за результат.
        const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as Record<string, unknown>;
        writeFileSync(
          ctx.path,
          JSON.stringify({ ...raw, runTimeoutMs: Number(raw.runTimeoutMs) + 1 }, null, 2) + '\n',
        );
        const refused = await s.changes().advance(operation.id);
        assert.equal(refused.status, 'failed');
        assert.match(refused.error ?? '', /изменён вне операции: ожидался digest/);
        continue;
      }
      s.h.config = loadConfig(ctx.path);
      const done = await s.changes().advance(operation.id);
      assert.equal(done.status, 'completed', done.error);
      assert.ok(done.history.some((h) => h.event === 'already-repinned'));
    } finally {
      fs.renameSync = realRename;
      syncBuiltinESMExports();
      await s.remove();
    }
  }
});

test('C-F02/C-F15: an owner that loses the operation mid-write writes nothing; a context-lock started before a request does not write after it', async () => {
  const s = await stage();
  const realWriteFile = fsp.writeFile;
  try {
    const ctx = await withContextPack(s);
    const before = readFileSync(ctx.path, 'utf8');
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Операцию перехватывают, пока её шаг готовит новый файл: запись уже
    // подготовлена, а владения больше нет.
    fsp.writeFile = async function (...args: Parameters<typeof fsp.writeFile>) {
      await realWriteFile(...args);
      if (typeof args[0] === 'string' && args[0].startsWith(ctx.path + '.'))
        s.store.atomic(() => {
          const op = s.changes().get(operation.id);
          s.store.saveLocal('contract-change', op.owner, op.id, { ...op, token: 'other' });
        });
    } as typeof fsp.writeFile;
    syncBuiltinESMExports();
    const lost = await s.changes().advance(operation.id);
    fsp.writeFile = realWriteFile;
    syncBuiltinESMExports();
    assert.equal(lost.next, 'context');
    assert.equal(readFileSync(ctx.path, 'utf8'), before, 'потерявший владение не пишет');
    // context-lock прочёл файл до запроса операции; запрос появился, пока он
    // считал закрепление. Право на запись проверяется у самой записи.
    await assert.rejects(
      lockContextFile(s.h.config, ctx.path, 'HEAD', (write) => {
        s.h.requestReconfigure('CC-late', 'l'.repeat(64));
        s.store.atomic(() => {
          const pending = s.store.read().reconfigure;
          if (pending && !pending.appliedAt) throw new Error('применяет конфигурацию');
          write();
        });
      }),
      /применяет конфигурацию/,
    );
    assert.equal(readFileSync(ctx.path, 'utf8'), before, 'context-lock не записал');
  } finally {
    fsp.writeFile = realWriteFile;
    syncBuiltinESMExports();
    await s.remove();
  }
});

test('C-F11/C-F12/C-F16/C-F17: a stale process accepts nothing even after the leader lease expires, a non-leader start changes nothing, and only pins change without a restart', async () => {
  const s = await stage();
  let stale: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    stale = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    // Действующий controller записал свою конфигурацию.
    assert.ok(s.h.leader('server'));
    s.h.recordConfig('server');
    // Операция применяет новое закрепление.
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    let finished = false;
    const advancing = s
      .changes()
      .advance(operation.id)
      .finally(() => (finished = true));
    while (!finished) {
      s.h.leader('server');
      serveReconfigure(s.h, ctx.path, 'server');
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal((await advancing).status, 'completed');
    const applied = s.store.read().appliedConfig;
    // Запуск отставшего процесса с другой конфигурацией, не ставшего лидером,
    // ничего не меняет.
    stale.recordConfig('other-start');
    assert.deepEqual(s.store.read().appliedConfig, applied);
    // Лидер остановился, lease истёк: отставший процесс всё равно не
    // утверждает план и не принимает ChangeSet, а став лидером — не
    // перезаписывает применённую конфигурацию своей.
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    const draft = stale.addTask(s.board.id, {
      ...input('Late draft'),
      role: 'qa',
    });
    assert.throws(() => stale!.approve(s.board.id, [draft.id]), /устаревшей конфигурацией/);
    assert.throws(() => new Workspace(stale!).accept('CHG-none'), /устаревшей конфигурацией/);
    assert.equal(stale.claim('stale-worker'), undefined);
    assert.ok(stale.leader('other-start'));
    stale.recordConfig('other-start');
    assert.deepEqual(s.store.read().appliedConfig, applied);
    // Без перезапуска меняется только закрепление: роли пакета — нет.
    const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as {
      contextPacks: { roles: string[] }[];
    };
    raw.contextPacks[0].roles = ['qa'];
    writeFileSync(ctx.path, JSON.stringify(raw, null, 2) + '\n');
    assert.throws(() => s.h.reconfigure(loadConfig(ctx.path)), /revision и digest/);
  } finally {
    stale?.store.close();
    await s.remove();
  }
});

test('C-F18: a server that loaded the previous configuration does not write it back on its first leader tick and catches up', async () => {
  const s = await stage();
  let server: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    // Сервер загрузил конфигурацию A и ещё не сделал первый тик.
    server = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    await new Promise((r) => setTimeout(r, 5));
    // Операция в это время применяет B (живого лидера нет — подтверждает сама).
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    assert.equal((await s.changes().advance(operation.id)).status, 'completed');
    const applied = s.store.read().appliedConfig!;
    assert.equal(applied.digest, loadedDigest(s.h.config));
    // Первый тик сервера: лидерство получено, но A не записывается обратно.
    assert.ok(server.leader('server'));
    server.recordConfig('server');
    assert.deepEqual(s.store.read().appliedConfig, applied);
    assert.equal(server.claim('server'), undefined, 'отставший сервер не выдаёт');
    // Сервер догоняет B из файла тем же правилом и снова работает.
    serveReconfigure(server, ctx.path, 'server');
    assert.equal(server.config.contextPacks[0].revision, s.sh('rev-parse', 'HEAD'));
    assert.doesNotThrow(() => server!.assertCurrentConfig(s.store.read()));
  } finally {
    server?.store.close();
    await s.remove();
  }
});

test('C-F19/C-F20/C-F21: staleness follows generations, not clocks; a snapshot read before an apply stays stale; a real restart with new fields becomes current', async () => {
  const s = await stage();
  const realNow = Date.now;
  let early: DevContour | undefined;
  let late: DevContour | undefined;
  let restarted: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    assert.ok(s.h.leader('server'));
    s.h.recordConfig('server');
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    // Часы процессов ушли на час вперёд, пока они загружали конфигурацию, а
    // потом откатились: момент загрузки «позже» применения. Правило по времени
    // на этом ошибается, поколения — нет.
    const frozen = realNow() + 3_600_000;
    Date.now = () => frozen;
    early = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    // CLI прочитал конфигурацию A до применения, а объект создаст после.
    const snapshotA = loadConfig(ctx.path);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    Date.now = realNow;
    assert.equal((await s.changes().advance(operation.id)).status, 'completed');
    Date.now = () => frozen;
    late = new DevContour(new Store(join(s.root, 'state.sqlite')), snapshotA);
    for (const stale of [early, late])
      assert.throws(
        () => stale.assertCurrentConfig(stale.store.read()),
        /устаревшей конфигурацией/,
      );
    const applied = s.store.read().appliedConfig;
    assert.ok(early.leader('early'));
    early.recordConfig('early');
    assert.deepEqual(s.store.read().appliedConfig, applied, 'отставший не вернул A');
    Date.now = realNow;
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    // Настоящий перезапуск с новым полем: файл прочитан после правки.
    const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      ctx.path,
      JSON.stringify({ ...raw, runTimeoutMs: Number(raw.runTimeoutMs) + 1 }, null, 2) + '\n',
    );
    restarted = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    assert.doesNotThrow(() => restarted!.assertCurrentConfig(restarted!.store.read()));
    assert.ok(restarted.leader('restarted'));
    restarted.recordConfig('restarted');
    assert.equal(s.store.read().appliedConfig?.digest, loadedDigest(restarted.config));
    assert.equal(s.store.read().appliedConfig?.generation, (applied?.generation ?? 0) + 1);
  } finally {
    Date.now = realNow;
    early?.store.close();
    late?.store.close();
    restarted?.store.close();
    await s.remove();
  }
});

test('C-F16: a config edit made before the context step is not taken over by the operation', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    const roles = s.h.config.contextPacks[0].roles;
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const stopped = await s
      .changes((step) => {
        if (step === 'base') {
          const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as {
            contextPacks: { roles: string[] }[];
          };
          raw.contextPacks[0].roles = ['qa'];
          writeFileSync(ctx.path, JSON.stringify(raw, null, 2) + '\n');
        }
      })
      .advance(operation.id);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.error ?? '', /отличается от действующей конфигурации процесса/);
    assert.deepEqual(s.h.config.contextPacks[0].roles, roles, 'роли не подхвачены');
  } finally {
    await s.remove();
  }
});

test('C-F03/C-F04: a fixed config file is applied on retry, and an expired verification does not hold the drain', async () => {
  const s = await stage();
  let server: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    server = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    // Истёкшая совместная проверка осталась active.
    s.store.change('fixture.expired-verification', (st) => {
      st.changeSets.push({
        id: 'CHG-expired',
        title: 'expired',
        description: '',
        boardIds: [],
        createdAt: new Date().toISOString(),
        verifications: [
          {
            id: 'V-expired',
            token: 't',
            leaseUntil: Date.now() - 1000,
            startedAt: new Date().toISOString(),
            status: 'active',
            policyDigest: 'p',
            specDigest: 's',
            tasks: [],
            boards: [],
            evidence: [],
          },
        ],
      });
    });
    assert.deepEqual(busyWork(s.h), []);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    ContractChanges.reconfigureWaitMs = 1000;
    // Сервер жив, но запрос не обработал: операция ждёт его подтверждения.
    // Лидерство не истекает, пока идут шаги операции на медленной машине.
    server.leader('server');
    s.store.change('fixture.live-leader', (st) => {
      st.leader = { owner: 'server', leaseUntil: Date.now() + 3_600_000 };
    });
    const waiting = await s.changes().advance(operation.id);
    assert.equal(waiting.status, 'waiting', waiting.error);
    assert.deepEqual(waiting.waitingFor, ['reconfigure']);
    // Сервер отказал (например, файл был испорчен) — отказ записан в запросе.
    const request = s.store.read().reconfigure!;
    server.settleReconfigure(request.operation, request.digest, 'server', 'файл испорчен');
    // Повтор операции снимает прежний отказ, и исправный сервер применяет.
    let finished = false;
    const retry = s
      .changes()
      .advance(operation.id)
      .finally(() => (finished = true));
    while (!finished) {
      server.leader('server');
      serveReconfigure(server, ctx.path, 'server');
      await new Promise((r) => setTimeout(r, 50));
    }
    const done = await retry;
    assert.equal(done.status, 'completed', done.error);
    assert.equal(s.store.read().reconfigure, undefined);
  } finally {
    ContractChanges.reconfigureWaitMs = 30000;
    server?.store.close();
    await s.remove();
  }
});

test('C-F05/C-F07: a verification and a process from the previous configuration accept nothing after it changed', async () => {
  const s = await stage();
  let stale: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    const verificationPolicy = new Workspace(s.h).policyDigest();
    s.h.leader('server');
    s.h.recordConfig('server');
    // Сервер остановился: операция подтверждает применение сама.
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    // Второй процесс с прежней конфигурацией.
    stale = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    s.h.pause(false);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.notEqual(new Workspace(s.h).policyDigest(), verificationPolicy, 'проверка устарела');
    // Применённая конфигурация записана; прежний процесс попыток не выдаёт.
    assert.equal(s.store.read().appliedConfig?.digest, loadedDigest(s.h.config));
    // Лидера нет — прежний процесс всё равно попыток не выдаёт.
    assert.equal(stale.claim('stale-worker'), undefined);
    const run = s.h.claim('worker');
    assert.ok(run, 'актуальный процесс выдаёт');
    assert.throws(
      () => stale!.phase(run.id, run.token, 'integrating', { candidateSha: 'c' }),
      /устаревшей конфигурацией/,
    );
  } finally {
    stale?.store.close();
    await s.remove();
  }
});

test('C-F06/C-F09: nothing new starts while the configuration is applied, and a shutdown over the operation pause stays', async () => {
  const s = await stage();
  try {
    s.h.requestReconfigure('CC-x', 'x'.repeat(64));
    assert.throws(() => new Previews(s.h).start('CHG-none'), /применяет конфигурацию/);
    s.store.atomic(() =>
      s.store.saveLocal('lead', undefined, 'job-1', {
        key: 'job-1',
        kind: 'board',
        id: 'B',
        status: 'queued',
        attempts: 0,
        maxAttempts: 3,
        history: [],
      }),
    );
    assert.equal(new LeadWorkflow(s.h).claim('job-1'), undefined);
    s.h.clearReconfigure('CC-x');
    // Shutdown поверх паузы операции забирает её: операция её не снимает.
    s.h.pause(false);
    s.h.operationPause('CC-y');
    s.h.pause(true, 'shutdown');
    s.h.operationResume('CC-y');
    assert.equal(s.store.read().paused, true);
    assert.equal(s.store.read().pauseReason, 'shutdown');
  } finally {
    await s.remove();
  }
});

test('C-F10: a plan review read under the previous context is not approved after the context changed', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    const draft = s.h.addTask(s.board.id, {
      ...input('Draft'),
      role: 'backend',
      contracts: [s.c1.id],
    });
    const next = loadConfig(
      ctx.path,
      await planRepin(s.h.config, readFileSync(ctx.path, 'utf8'), ['contracts'], 'HEAD'),
    );
    // Пока ревьюер читает план, контекст перезакрепляют.
    const changing = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      execute() {
        s.h.reconfigure(next);
        return Promise.resolve({
          data: { approved: true, summary: 'Fixture', findings: [], discoveries: [] },
          log: 'Fixture only; no provider called',
          command: ['fixture'],
        });
      },
    });
    await assert.rejects(
      reviewPlan(
        s.h,
        s.root,
        s.board.id,
        'codex',
        { codex: changing('codex'), claude: changing('claude') },
        () => {},
        [draft.id],
      ),
      /План изменился во время ревью/,
    );
    assert.equal(s.task(draft.id).status, 'draft');
  } finally {
    await s.remove();
  }
});

test('C-F08: the expected digest covers component config files, not only config.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-component-digest-'));
  try {
    const repo = join(root, 'product');
    await mkdir(repo);
    const component = join(repo, 'devcontour.component.json');
    await writeFile(component, JSON.stringify({ protectedPaths: ['a.txt'] }));
    const base = config();
    const path = join(root, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        repository: repo,
        repositories: [
          repositorySchema.parse({
            id: 'product',
            name: 'Product',
            path: repo,
            configFile: 'devcontour.component.json',
            gates: base.gates,
          }),
        ],
      }),
    );
    const text = readFileSync(path, 'utf8');
    const first = loadedDigest(loadConfig(path));
    // Главный файл не менялся, component config — да: digest другой.
    await writeFile(component, JSON.stringify({ protectedPaths: ['b.txt'] }));
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.notEqual(loadedDigest(loadConfig(path)), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A redaction committed after review makes the operation stale and moves nothing', async () => {
  const s = await stage();
  try {
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Ревью одобрило схему number; после него в тот же файл закоммитили boolean.
    const stopped = await s
      .changes((step) => {
        if (step === 'review') throw new Error('stop after review');
      })
      .advance(operation.id);
    assert.equal(stopped.next, 'rebind');
    const base = s.sh('rev-parse', 'devcontour/accepted');
    await writeFile(join(s.repo, 'schema.json'), '{"price":"boolean"}\n');
    s.sh('commit', '-qam', 'boolean after review');
    const resumed = await s.changes().advance(operation.id);
    assert.equal(resumed.status, 'stale', resumed.error);
    assert.equal(s.sh('rev-parse', 'devcontour/accepted'), base, 'база не сдвинута');
    assert.equal(s.task(s.api.id).hold?.operation, operation.id, 'удержание сохранено');
    assert.deepEqual(s.task(s.api.id).contracts, [s.c1.id], 'перепривязки не было');
  } finally {
    await s.remove();
  }
});

test('A review answer that arrives after the operation was taken over registers nothing', async () => {
  const s = await stage();
  try {
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Первый владелец зависает в ревью контракта дольше своего lease.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const slow = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      async execute() {
        entered();
        await held;
        return {
          data: { approved: true, summary: 'Late', findings: [], discoveries: [] },
          log: 'fixture',
          command: ['fixture'],
        };
      },
    });
    const first = new ContractChanges(s.h, s.root, {
      codex: slow('codex'),
      claude: slow('claude'),
    });
    const late = first.advance(operation.id);
    await started;
    s.store.atomic(() =>
      s.store.saveLocal('contract-change', operation.owner, operation.id, {
        ...first.get(operation.id),
        leaseUntil: Date.now() - 1,
      }),
    );
    // Второй владелец штатно перехватывает и завершает операцию.
    const second = await s.changes().advance(operation.id);
    assert.equal(second.status, 'completed', second.error);
    const c2 = s.store.read().contracts.at(-1)!;
    // Запоздавший ответ первого владельца приходит после этого.
    release();
    await late;
    assert.equal(s.store.read().contracts.length, 2, 'запоздавшее ревью не создало редакцию');
    assert.deepEqual(s.task(s.api.id).contracts, [c2.id]);
    assert.equal(s.changes().get(operation.id).status, 'completed');
  } finally {
    await s.remove();
  }
});

test('Operator mode keeps contract changes with the operator', async () => {
  const s = await stage();
  try {
    s.h.config.approvalMode = 'operator';
    await assert.rejects(s.changes().start(s.proposal, 'codex'), /оператор/);
  } finally {
    await s.remove();
  }
});

test('A base move cannot happen after the operation was abandoned inside the base step', async () => {
  const s = await stage();
  const other = new Store(join(s.root, 'state.sqlite'));
  const second = new ContractChanges(
    new DevContour(other, { ...s.h.config, mode: 'demo' }),
    s.root,
  );
  const realSpawn = cp.spawn;
  try {
    const before = s.sh('rev-parse', 'devcontour/accepted');
    let armed = false;
    const held: { operation?: ContractChange } = {};
    let abandoned: string | undefined;
    // Окно — внутри переноса базы, после проверки входа и до сдвига ref:
    // lease истекает, и другой процесс штатно отменяет операцию.
    cp.spawn = function (this: unknown, command: string, args: string[], options: unknown) {
      if (
        armed &&
        command === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === 'refs/heads/devcontour/accepted'
      ) {
        armed = false;
        other.atomic(() =>
          other.saveLocal('contract-change', held.operation!.owner, held.operation!.id, {
            ...second.get(held.operation!.id),
            leaseUntil: Date.now() - 1,
          }),
        );
        abandoned = second.abandon(held.operation!.id).status;
      }
      return realSpawn.call(this, command, args, options as never);
    } as typeof cp.spawn;
    syncBuiltinESMExports();
    const changes = s.changes((step) => {
      if (step === 'rebind') armed = true;
    });
    const { operation } = (await changes.start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    held.operation = operation;
    await changes.advance(operation.id);
    assert.equal(abandoned, 'abandoned');
    assert.equal(s.sh('rev-parse', 'devcontour/accepted'), before, 'база не сдвинута после отмены');
    assert.equal(s.changes().get(operation.id).status, 'abandoned');
  } finally {
    cp.spawn = realSpawn;
    syncBuiltinESMExports();
    other.close();
    await s.remove();
  }
});

test('The base ref move inside the transaction runs no repository hooks', async () => {
  const s = await stage();
  try {
    // Hook reference-transaction, который ждёт ту же базу, — взаимное
    // ожидание, пока транзакция держит её на время git update-ref.
    const marker = join(s.root, 'hook-ran');
    const hook = join(s.repo, '.git', 'hooks', 'reference-transaction');
    // Срабатывает только на сдвиге ветки интеграции: Git передаёт
    // обновляемые ref на stdin.
    await writeFile(
      hook,
      `#!/bin/sh\nif grep -q 'refs/heads/devcontour/accepted'; then touch ${JSON.stringify(marker)}; sleep 5; fi\n`,
    );
    await chmod(hook, 0o755);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    let worst = 0;
    let last = Date.now();
    const probe = setInterval(() => {
      worst = Math.max(worst, Date.now() - last);
      last = Date.now();
    }, 20);
    const done = await s.changes().advance(operation.id);
    clearInterval(probe);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(existsSync(marker), false, 'hook внутри транзакции не запускался');
    assert.ok(worst < 4000, `event loop стоял ${worst} мс`);
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
    );
  } finally {
    await s.remove();
  }
});

test('A hung git update-ref inside the transaction is stopped by its time limit', async () => {
  const s = await stage();
  const shim = await mkdtemp(join(tmpdir(), 'devcontour-git-shim-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  const path = process.env.PATH;
  const limit = ContractChanges.refMoveTimeoutMs;
  // Тест ставит свой короткий предел; рабочий предел должен быть конечным
  // и короче lease, иначе зависший Git держал бы базу контура без срока.
  assert.ok(
    Number.isFinite(limit) && limit > 0 && limit <= 60000,
    `рабочий предел сдвига ref: ${limit} мс`,
  );
  try {
    // Git, который зависает только на сдвиге ref; остальное — настоящий Git.
    await writeFile(
      join(shim, 'git'),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = update-ref ] && exec sleep 60; done\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    await chmod(join(shim, 'git'), 0o755);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const before = s.sh('rev-parse', 'devcontour/accepted');
    ContractChanges.refMoveTimeoutMs = 1500;
    // Обёртка действует только на шаге переноса базы: замер не зависит от
    // скорости предыдущих шагов под нагрузкой.
    let baseStarted = 0;
    const failed = await s
      .changes((step) => {
        if (step === 'rebind') {
          process.env.PATH = `${shim}:${path}`;
          baseStarted = Date.now();
        }
      })
      .advance(operation.id);
    const baseTook = Date.now() - baseStarted;
    process.env.PATH = path;
    // Без предела шаг ждал бы зависший Git целиком (60 с).
    assert.ok(baseTook < 30000, `шаг переноса базы занял ${baseTook} мс`);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.next, 'base');
    assert.equal(s.sh('rev-parse', 'devcontour/accepted'), before, 'база не сдвинута');
    // Операция продолжается после устранения причины.
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
  } finally {
    process.env.PATH = path;
    ContractChanges.refMoveTimeoutMs = limit;
    await rm(shim, { recursive: true, force: true });
    await s.remove();
  }
});

test('A contract file registered under another component is named, not treated as a new contract', async () => {
  const s = await stage();
  try {
    // Контракт зарегистрирован как общий; предложение называет компонент.
    const other = { ...s.proposal, repositoryId: 'main' };
    const impact = (await contractImpact(s.h, other)) as {
      status: string;
      warning?: string;
      registeredUnder?: string[];
    };
    assert.equal(impact.status, 'new');
    assert.deepEqual(impact.registeredUnder, ['(общий)']);
    assert.match(impact.warning ?? '', /уже зарегистрирован как контракт/);
    await assert.rejects(s.changes().start(other, 'codex'), /уже зарегистрирован/);
    assert.equal(s.store.read().contracts.length, 1, 'параллельный контракт не заведён');
  } finally {
    await s.remove();
  }
});
