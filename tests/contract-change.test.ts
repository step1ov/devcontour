import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, input } from './helpers.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { ContractChanges, type ContractChange } from '../src/runner/contract-change.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { readyTasks } from '../src/core/graph.ts';

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
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // После перепривязки в рабочую ветку попала посторонняя работа.
    const failed = await s
      .changes((step) => {
        if (step === 'rebind') {
          execFileSync('sh', ['-c', 'echo x > unrelated.txt'], { cwd: s.repo });
          s.sh('add', 'unrelated.txt');
          s.sh('commit', '-qm', 'unrelated');
        }
      })
      .advance(operation.id);
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

test('Operator mode keeps contract changes with the operator', async () => {
  const s = await stage();
  try {
    s.h.config.approvalMode = 'operator';
    await assert.rejects(s.changes().start(s.proposal, 'codex'), /оператор/);
  } finally {
    await s.remove();
  }
});
