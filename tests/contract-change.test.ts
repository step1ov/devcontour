import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, input } from './helpers.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { ContractChanges, type ContractChange } from '../src/runner/contract-change.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { readyTasks } from '../src/core/graph.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';

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
      if (step === 'plan') armed = true;
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
