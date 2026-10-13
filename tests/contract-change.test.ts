import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, input } from './helpers.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { ContractChanges, type ContractChange } from '../src/runner/contract-change.ts';
import { contractImpact } from '../src/runner/contract-impact.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { readyTasks } from '../src/core/graph.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { configDigest, pinContext, repinContext } from '../src/runner/context.ts';
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
  return { path, pinnedBefore, digest: () => configDigest(readFileSync(path, 'utf8')) };
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
    // Перезакрепление сверяет ожидаемое состояние файла.
    await assert.rejects(
      repinContext(s.h.config, ctx.path, ['contracts'], 'HEAD', 'f'.repeat(64)),
      /config\.json изменён вне операции: ожидался digest f{16}, в файле [0-9a-f]{16}/,
    );
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // После перезакрепления кто-то правит config.json вне операции.
    const stopped = await s
      .changes((step) => {
        if (step === 'context') {
          const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as Record<string, unknown>;
          writeFileSync(ctx.path, JSON.stringify({ ...raw, concurrency: 7 }, null, 2) + '\n');
        }
      })
      .advance(operation.id);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.error ?? '', /ожидался digest [0-9a-f]{16}, в файле [0-9a-f]{16}/);
    assert.notEqual(s.h.config.concurrency, 7, 'чужая правка не применена');
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
    await repinContext(s.h.config, ctx.path, ['contracts'], 'HEAD', ctx.digest());
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
