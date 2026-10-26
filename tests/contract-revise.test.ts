import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture as base, input, statePrevious } from './helpers.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { AgentService } from '../src/application/agent.ts';
import { ContractChanges, type ContractChange } from '../src/runner/contract-change.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { digest, specDigest } from '../src/core/service.ts';
import { readyTasks } from '../src/core/graph.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { submitCase } from '../src/runner/checks.ts';
import { git as gitCommand } from '../src/runner/process.ts';
import {
  check,
  checkProject,
  declaration,
  fixture as checkFixture,
  propertyGate,
  knap,
  rejection,
  removeRoot,
} from './check-fixture.ts';

type Decide = (
  r: AgentRequest,
  subject: string,
) => { approved: boolean; summary?: string } | undefined;
/** Ревьюер-фикстура: решение задаёт тест, вызовы и предложения записываются. */
function reviewers(calls: string[], proposals: unknown[], decide: Decide = () => undefined) {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    async execute(r: AgentRequest) {
      const subject = /Independently review this ([a-z /]+)\./.exec(r.prompt)?.[1] ?? '?';
      calls.push(subject);
      proposals.push(JSON.parse(await readFile(join(r.artifactDir, 'proposal.json'), 'utf8')));
      const verdict = decide(r, subject) ?? { approved: true };
      return {
        data: {
          approved: verdict.approved,
          summary: verdict.summary ?? 'Fixture',
          findings: verdict.approved
            ? []
            : [{ severity: 'blocking', message: 'Схема противоречит требованию' }],
          discoveries: [],
          previous: statePrevious(r.prompt, verdict.approved),
        },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      };
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

async function stage() {
  const f = base();
  const repo = await mkdtemp(join(tmpdir(), 'devcontour-revise-'));
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
  const proposals: unknown[] = [];
  await reviewContract(f.h, f.root, proposal, 'codex', reviewers(calls, proposals));
  const c1 = f.store.read().contracts[0];
  const board = f.h.createBoard('Catalog');
  const api = f.h.addTask(board.id, { ...input('API'), role: 'backend', contracts: [c1.id] });
  const screen = f.h.addTask(board.id, { ...input('Screen', [api.id]), role: 'qa' });
  f.h.approve(board.id);
  const schema = async (text: string) => {
    await writeFile(join(repo, 'schema.json'), text);
    sh('commit', '-qam', 'schema ' + text.trim());
  };
  await schema('{"price":"number"}\n');
  calls.length = 0;
  proposals.length = 0;
  const task = (id: string) => f.store.read().tasks.find((t) => t.id === id)!;
  return {
    ...f,
    repo,
    sh,
    proposal,
    calls,
    proposals,
    c1,
    board,
    api,
    screen,
    task,
    schema,
    changes: (decide?: Decide, afterStep?: (step: string) => void) =>
      new ContractChanges(f.h, f.root, reviewers(calls, proposals, decide), afterStep),
    async remove() {
      await rm(repo, { recursive: true, force: true });
      f.cleanup();
    },
  };
}
const rejectFirstContract = (): Decide => {
  let rejected = false;
  return (_r, subject) => {
    if (subject.startsWith('contract') && !rejected) {
      rejected = true;
      return { approved: false, summary: 'Схема противоречит требованию' };
    }
    return undefined;
  };
};

test('AC29: a rejected contract fixed before side effects is revised in the same operation history without an abandon', async () => {
  const s = await stage();
  try {
    const decide = rejectFirstContract();
    const { operation } = (await s.changes(decide).start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const rejected = await s.changes(decide).advance(operation.id);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.next, 'review');
    assert.match(rejected.error ?? '', /Независимое ревью отклонено/);
    assert.equal(s.store.read().contracts.length, 1, 'редакция не зарегистрирована');
    assert.equal(s.task(s.api.id).hold?.operation, operation.id);
    // Исправленная редакция в рабочей ветке; обычное продолжение её не подхватывает.
    await s.schema('{"price":"number","currency":"string"}\n');
    const stale = await s.changes(decide).advance(operation.id);
    assert.equal(stale.status, 'stale');
    // Пересмотр с устаревшей версией записи отклонён.
    await assert.rejects(
      s.changes(decide).revise(operation.id, (stale.version ?? 0) - 1),
      /изменилась/,
    );
    const revised = await s.changes(decide).revise(operation.id, stale.version!);
    assert.equal(revised.status, 'revised');
    assert.equal(revised.operation.id, operation.id, 'та же операция');
    assert.equal(revised.operation.next, 'drain');
    const history = revised.operation.revisions!;
    assert.equal(history.length, 1);
    assert.equal(history[0].head, operation.expected.head);
    assert.deepEqual(
      history[0].reviews.map((r) => r.approved),
      [false],
      'отклонённое ревью прежней редакции сохранено',
    );
    assert.equal(s.task(s.api.id).hold?.operation, operation.id, 'удержание без окна');
    const done = await s.changes(decide).advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.deepEqual(s.calls, [
      'contract / architecture decision',
      'contract / architecture decision',
      'task plan',
    ]);
    // Зарегистрирована новая редакция, а не та, что была отклонена.
    const c2 = s.store.read().contracts.at(-1)!;
    assert.match(JSON.stringify(c2.artifacts), new RegExp(s.sh('rev-parse', 'HEAD:schema.json')));
    assert.deepEqual(s.task(s.api.id).contracts, [c2.id]);
    assert.equal(s.task(s.api.id).status, 'ready');
  } finally {
    await s.remove();
  }
});

test('AC30: a revise after rebind or base never fakes a rollback, a late reviewer cannot approve the new redaction, and the continuation is explicit', async () => {
  const s = await stage();
  try {
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const stopped = await s
      .changes(undefined, (step) => {
        if (step === 'rebind') throw new Error('crash after rebind');
      })
      .advance(operation.id);
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.next, 'base', 'продолжение после сбоя определено следующим шагом');
    const c2 = stopped.contractId!;
    assert.deepEqual(s.task(s.api.id).contracts, [c2]);
    await s.schema('{"price":"number","currency":"string"}\n');
    const revised = await s.changes().revise(operation.id, stopped.version!);
    assert.equal(revised.status, 'superseded');
    const next = revised.operation;
    assert.notEqual(next.id, operation.id);
    assert.equal(next.previous, operation.id);
    const old = s.changes().get(operation.id);
    assert.equal(old.status, 'superseded');
    assert.equal(old.next, next.id);
    // Эффекты прежней операции остаются: редакция и перепривязка — история.
    assert.equal(old.contractId, c2);
    assert.ok(s.store.read().contracts.some((c) => c.id === c2));
    assert.equal(s.task(s.api.id).hold?.operation, next.id, 'удержание передано без окна');
    assert.equal(
      readyTasks(s.store.read()).some((t) => t.id === s.api.id),
      false,
    );
    const done = await s.changes().advance(next.id);
    assert.equal(done.status, 'completed', done.error);
    const c3 = s.store.read().contracts.at(-1)!;
    assert.notEqual(c3.id, c2);
    assert.deepEqual(s.task(s.api.id).contracts, [c3.id]);

    // Поздний ответ ревьюера прежней редакции ничего не регистрирует.
    await s.schema('{"price":"integer"}\n');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inReview = new Promise<void>((resolve) => (entered = resolve));
    const slow: Decide = (_r, subject) => {
      void subject;
      return undefined;
    };
    const late = new ContractChanges(s.h, s.root, {
      codex: { name: 'codex', execute: () => Promise.reject(new Error('unused')) },
      claude: {
        name: 'claude',
        async execute() {
          entered();
          await held;
          return {
            data: { approved: true, summary: 'Late', findings: [], discoveries: [] },
            log: '',
            command: [],
          };
        },
      },
    });
    void slow;
    const started = (await late.start(s.proposal, 'codex')) as { operation: ContractChange };
    const pending = late.advance(started.operation.id);
    await inReview;
    // Живой владелец: пересмотр отказан.
    await assert.rejects(
      s.changes().revise(started.operation.id, s.changes().get(started.operation.id).version!),
      /выполняется/,
    );
    // Lease истёк — пересмотр возможен, владение старого ответа сброшено.
    s.h.store.atomic(() => {
      const op = s.changes().get(started.operation.id);
      op.leaseUntil = 0;
      s.h.store.saveLocal('contract-change', op.owner, op.id, op);
    });
    await s.schema('{"price":"integer","unit":"string"}\n');
    const current = s.changes().get(started.operation.id);
    const contracts = s.store.read().contracts.length;
    const again = await s.changes().revise(started.operation.id, current.version!);
    assert.equal(again.status, 'revised');
    release();
    await pending;
    assert.equal(s.store.read().contracts.length, contracts, 'поздний ответ не создал редакцию');
    const finished = await s.changes().advance(started.operation.id);
    assert.equal(finished.status, 'completed', finished.error);
    const last = s.store.read().contracts.at(-1)!;
    assert.match(JSON.stringify(last.artifacts), new RegExp(s.sh('rev-parse', 'HEAD:schema.json')));
  } finally {
    await s.remove();
  }
});

test('AC31: the plan reviewer sees a rebound draft and a new neighbour, approves only the selected prepared tasks, and a context change makes the review stale', async () => {
  const s = await stage();
  try {
    // Новые черновики той же доски: подготовленный и неподготовленный.
    s.h.reopen(s.api.id, 'Задача ждёт новой редакции контракта перед повторным утверждением.');
    const prepared = s.h.addTask(s.board.id, { ...input('Prepared docs', [s.api.id]), role: 'qa' });
    const neighbour = s.h.addTask(s.board.id, { ...input('Neighbour draft'), role: 'qa' });
    const { operation } = (await s.changes().start(s.proposal, 'codex', [prepared.id])) as {
      operation: ContractChange;
    };
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    const plan = s.proposals.find((p) => (p as { approving?: string[] }).approving) as {
      tasks: { id: string }[];
      approving: string[];
    };
    assert.ok(plan, 'план ревьюировался');
    const shown = plan.tasks.map((t) => t.id);
    for (const id of [s.api.id, prepared.id, neighbour.id, s.screen.id])
      assert.ok(shown.includes(id), `ревьюер видит ${id}`);
    assert.deepEqual([...plan.approving].sort(), [s.api.id, prepared.id].sort());
    assert.equal(s.task(prepared.id).status, 'ready');
    assert.equal(
      s.task(neighbour.id).status,
      'draft',
      'неподготовленный черновик не утверждён побочно',
    );

    // Изменение показанного контекста во время ревью плана делает его устаревшим.
    await s.schema('{"price":"number","tax":"number"}\n');
    s.h.reopen(s.api.id, 'Следующая редакция контракта меняет схему ответа.');
    const edit = () => {
      const t = s.task(neighbour.id);
      s.h.editTask(
        neighbour.id,
        { ...input('Neighbour draft, edited'), role: 'qa' },
        specDigest(t),
      );
    };
    const decide: Decide = (_r, subject) => {
      if (subject === 'task plan') edit();
      return undefined;
    };
    const second = (await s.changes(decide).start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const stale = await s.changes(decide).advance(second.operation.id);
    assert.equal(stale.status, 'failed');
    assert.match(stale.error ?? '', /План изменился во время ревью/);
    assert.equal(s.task(s.api.id).status, 'draft', 'устаревшее утверждение не применено');
    assert.equal(s.task(s.api.id).hold?.operation, second.operation.id);
  } finally {
    await s.remove();
  }
});

test('AC32: a base check wait and a human pause stay distinct, the pause is not lifted, and the data-only corpus path needs no restart, base update or context lock', async () => {
  const s = await stage();
  try {
    // Пауза человека, затем перенос базы: обе причины видны отдельно.
    s.h.pause(true);
    s.h.baseUpdated([{ repositoryId: 'main', from: 'a'.repeat(40), to: 'b'.repeat(40) }]);
    let state = s.store.read();
    assert.equal(state.pauseReason, 'operator', 'пауза человека не подменена');
    assert.equal(state.waits?.[0].kind, 'base-check');
    // Цикл не снимает ни паузу человека, ни ожидание проверки базы.
    const runner = new LeadRunner(s.h, s.root);
    runner.workflow.start({ kind: 'board', id: s.board.id, authorRuntime: 'codex' });
    s.h.config.mode = 'demo';
    await runner.tick();
    await runner.tick();
    state = s.store.read();
    assert.equal(state.paused, true);
    assert.equal(state.pauseReason, 'operator');
    // Без паузы человека перенос базы — техническое ожидание, не operator.
    s.h.pause(false);
    assert.equal(s.store.read().waits, undefined, 'продолжение снимает ожидание базы');
    s.h.pause(true, 'shutdown');
    s.h.baseUpdated([{ repositoryId: 'main', from: 'a'.repeat(40), to: 'b'.repeat(40) }]);
    assert.equal(s.store.read().pauseReason, 'base-check');
    await runner.tick();
    assert.equal(s.store.read().pauseReason, 'base-check', 'цикл не снимает ожидание базы');
    await runner.stop();
  } finally {
    await s.remove();
  }

  // Быстрый маршрут S3: только данные — без restart, base-update и context-lock.
  const p = await checkProject({ 'check.mjs': check(120, { zeroWeights: false }) });
  const f = await checkFixture(p, {
    reviewer: (_r, calls) =>
      calls.review === 1
        ? rejection({
            property: 'knapsack-optimal',
            input: '{"items":[{"w":0,"v":5}],"cap":0}',
            expected: '5',
            actual: '0',
          })
        : undefined,
  });
  try {
    f.write('src/knap.mjs', knap.zeroWeight);
    const board = f.h.createBoard('Data only');
    const t = f.h.addTask(board.id, {
      title: 'Knapsack',
      description: 'Оптимум рюкзака по договору проверки.',
      role: 'backend',
      contracts: [f.contract!.id],
      acceptance: ['AC-optimal'],
      writePaths: ['src/'],
      properties: ['knapsack-optimal'],
    });
    f.h.approve(board.id);
    f.h.pause(false);
    await f.scheduler.drain();
    const accepted = await gitCommand(p.repo, 'rev-parse', 'refs/heads/devcontour/accepted');
    const head = await gitCommand(p.repo, 'rev-parse', 'HEAD');
    const policy = f.h.policyDigest();
    const confirmed = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: '{"items":[{"w":0,"v":5}],"cap":0}',
      key: 'data-only-case',
    });
    assert.equal(confirmed.decision.outcome, 'confirmed');
    assert.equal(
      await gitCommand(p.repo, 'rev-parse', 'refs/heads/devcontour/accepted'),
      accepted,
      'база не двигалась',
    );
    assert.equal(await gitCommand(p.repo, 'rev-parse', 'HEAD'), head, 'рабочая ветка не двигалась');
    assert.equal(f.h.policyDigest(), policy, 'конфигурация не менялась');
    assert.equal(f.store.read().waits, undefined, 'ожиданий context-lock нет');
    // Тот же экземпляр планировщика без перезапуска выдаёт попытку уже по новой версии.
    f.h.retry(t.id);
    await f.scheduler.drain();
    const run = f.store.read().runs.findLast((r) => r.taskId === t.id)!;
    assert.equal(run.checks?.corpus?.number, 1);
    assert.equal(run.failureKind, 'gate', 'новый случай исполнен гейтом');
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('A rejected operation is revised from a new proposal file: same operation and holds, pre-checks before the model, the proposal digest recorded', async () => {
  const s = await stage();
  try {
    s.h.config.gates = [...s.h.config.gates, propertyGate()];
    // Эталон и проверка без локальных импортов; отдельный файл — с
    // незакреплённым helper.
    await writeFile(join(s.repo, 'oracle.mjs'), 'export const best = () => 0;\n');
    await writeFile(join(s.repo, 'check.mjs'), 'export const run = () => true;\n');
    await writeFile(join(s.repo, 'helper.mjs'), 'export const h = 1;\n');
    await writeFile(join(s.repo, 'bad.mjs'), "import { h } from './helper.mjs';\nexport { h };\n");
    s.sh('add', '.');
    s.sh('commit', '-qm', 'oracle');
    const decide = rejectFirstContract();
    const { operation } = (await s.changes(decide).start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const rejected = await s.changes(decide).advance(operation.id);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.next, 'review');
    const calls = s.calls.length;
    const version = rejected.version!;
    const artifacts = [
      ...s.proposal.artifacts,
      { path: 'oracle.mjs', purpose: 'Эталон' },
      { path: 'check.mjs', purpose: 'Свойства' },
    ];
    const fixed = { ...s.proposal, artifacts, checks: declaration() };
    // Устаревшая версия записи — отказ.
    await assert.rejects(
      s.changes(decide).revise(operation.id, version - 1, undefined, fixed),
      /изменилась/,
    );
    // Незащищённая зависимость артефакта — отказ до модели и до записи.
    await assert.rejects(
      s.changes(decide).revise(operation.id, version, undefined, {
        ...fixed,
        artifacts: [...artifacts, { path: 'bad.mjs', purpose: 'Проверка' }],
      }),
      /helper\.mjs/,
    );
    // Структурно неполный договор проверки — тоже до модели.
    await assert.rejects(
      s.changes(decide).revise(operation.id, version, undefined, {
        ...fixed,
        artifacts: s.proposal.artifacts,
      }),
      /Договор проверки неполон/,
    );
    // Другой контракт тем же пересмотром не подменяется.
    await assert.rejects(
      s.changes(decide).revise(operation.id, version, undefined, {
        ...fixed,
        file: 'schema.json',
      }),
      /тот же контракт/,
    );
    assert.equal(s.calls.length, calls, 'ревьюер не вызван');
    assert.equal(s.changes().get(operation.id).version, version, 'операция не изменилась');
    // Файлы отказного случая убраны: перенос базы видит только контракт.
    s.sh('rm', '-q', 'bad.mjs', 'helper.mjs');
    s.sh('commit', '-qm', 'drop helper');
    const revised = await s.changes(decide).revise(operation.id, version, undefined, fixed);
    assert.equal(revised.status, 'revised');
    assert.equal(revised.operation.id, operation.id, 'та же операция');
    assert.equal(s.task(s.api.id).hold?.operation, operation.id, 'удержание сохранено');
    assert.equal(revised.operation.revisions![0].proposal, digest(s.proposal));
    assert.match(
      revised.operation.history.at(-1)!.detail ?? '',
      new RegExp(`предложение ${digest(fixed).slice(0, 12)}`),
    );
    const done = await s.changes(decide).advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    // Ревью шло по новому предложению: с договором проверки и эталоном.
    const reviewed = s.proposals[calls] as { checks?: unknown; artifacts?: { path: string }[] };
    assert.deepEqual(reviewed.checks, declaration());
    assert.ok(reviewed.artifacts?.some((a) => a.path === 'oracle.mjs'));
    assert.deepEqual(s.store.read().contracts.at(-1)!.checks, declaration());
  } finally {
    await s.remove();
  }
});

test('A revise keeps the contract identity: a repositoryId or title change is refused, and no parallel contract is registered', async () => {
  const s = await stage();
  try {
    const decide = rejectFirstContract();
    const { operation } = (await s.changes(decide).start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const rejected = await s.changes(decide).advance(operation.id);
    assert.equal(rejected.status, 'failed');
    const calls = s.calls.length;
    // Тот же файл, но repositoryId записан иначе: отчёт влияния видит его как
    // новый контракт рядом с прежним — пересмотр так его не регистрирует.
    await assert.rejects(
      s.changes(decide).revise(operation.id, rejected.version!, undefined, {
        ...s.proposal,
        repositoryId: 'main',
      }),
      /уже зарегистрирован|тот же контракт/,
    );
    await assert.rejects(
      s.changes(decide).revise(operation.id, rejected.version!, undefined, {
        ...s.proposal,
        title: 'Catalog API v2',
      }),
      /тот же контракт/,
    );
    // Агентский API передаёт исправленное предложение так же, как --file.
    await assert.rejects(
      new AgentService(s.h, s.root).run({
        operation: 'contract_change_revise',
        input: {
          id: operation.id,
          expectedVersion: rejected.version!,
          proposal: { ...s.proposal, title: 'Catalog API v2' },
        },
      }),
      /тот же контракт/,
    );
    assert.equal(s.calls.length, calls, 'ревьюер не вызван');
    assert.equal(s.store.read().contracts.length, 1, 'параллельный контракт не появился');
    assert.equal(s.task(s.api.id).hold?.operation, operation.id, 'удержание на месте');
    assert.equal(s.changes().get(operation.id).version, rejected.version);
  } finally {
    await s.remove();
  }
});

test('Review history belongs to the operation: a same-titled review elsewhere is not listed, and a failure without a new review gets no link', async () => {
  const s = await stage();
  try {
    const decide = rejectFirstContract();
    const { operation } = (await s.changes(decide).start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const rejected = await s.changes(decide).advance(operation.id);
    assert.equal(rejected.status, 'failed');
    const own = rejected.history.at(-1)!.review;
    assert.ok(own, 'отказ ревью ссылается на свою попытку');
    // Сбой модели без ответа ревью: запись истории без ссылки на прежнюю попытку.
    const broken: AgentAdapter = {
      name: 'claude',
      execute: () => Promise.reject(new Error('transport closed')),
    };
    const failed = await new ContractChanges(s.h, s.root, {
      codex: { ...broken, name: 'codex' },
      claude: broken,
    }).advance(operation.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.history.at(-1)!.step, 'review');
    assert.equal(failed.history.at(-1)!.review, undefined, 'нет устаревшей ссылки');
    // Ревью другого контракта с тем же названием — не история этой операции.
    await reviewContract(
      s.h,
      s.root,
      { title: s.proposal.title, content: '# Другой документ\n' },
      'codex',
      s.changes().runtimes,
    ).catch(() => undefined);
    const other = s.store.read().contractAttempts!.at(-1)!;
    assert.notEqual(other.id, own.id);
    await s.schema('{"price":"number","currency":"string"}\n');
    const revised = await s.changes(decide).revise(operation.id, failed.version!);
    assert.deepEqual(
      revised.operation.revisions![0].reviews.map((r) => r.id),
      [own.id],
    );
  } finally {
    await s.remove();
  }
});
