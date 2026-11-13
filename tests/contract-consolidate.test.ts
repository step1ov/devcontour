import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type ContractChange } from '../src/runner/contract-change.ts';
import { supersededBy } from '../src/core/service.ts';
import { devcontourHooks } from '../src/harness/hooks.ts';
import { reviewedContractDocument } from '../src/runner/sensitive-paths.ts';
import { command } from '../src/runner/process.ts';
import { input } from './helpers.ts';
import { AMENDED, CONSOLIDATED, consolidationStage } from './consolidation-fixture.ts';

type Stage = Awaited<ReturnType<typeof consolidationStage>>;
const start = async (s: Stage, proposal: object = s.proposal) =>
  (
    (await s.changes().start(proposal, 'codex', [], 'consolidate')) as {
      operation: ContractChange;
    }
  ).operation;

test('F20: a consolidation completes without rebind or plan review; ready tasks keep their digests and run, a done task stays done', async () => {
  const s = await consolidationStage();
  try {
    s.h.pause(true);
    await s.commitDoc(CONSOLIDATED);
    const before = s.task(s.api.id);
    const op = await start(s);
    assert.equal(op.mode, 'consolidate');
    const done = await s.changes().advance(op.id);
    assert.equal(done.status, 'completed', done.error);
    assert.deepEqual(
      done.history.filter((h) => h.event === 'done').map((h) => h.step),
      ['hold', 'drain', 'review', 'base', 'context', 'reconfigure', 'release'],
    );
    assert.deepEqual(s.calls, ['contract consolidation'], 'без ревью плана');
    const c2 = s.store.read().contracts.at(-1)!;
    assert.equal(done.contractId, c2.id);
    assert.deepEqual(c2.consolidates?.from, s.c1.id);
    assert.deepEqual(done.rebound, []);
    assert.deepEqual(done.corrections, [], 'принятая задача без корректировки');
    assert.equal(s.task(s.shipped.id).status, 'done');
    assert.deepEqual(s.task(s.shipped.id).contracts, [s.c1.id]);
    // Задача прежней редакции: та же привязка, digests и утверждение.
    const api = s.task(s.api.id);
    assert.equal(api.status, 'ready');
    assert.deepEqual(api.contracts, [s.c1.id]);
    assert.deepEqual(api.contractDigests, before.contractDigests);
    assert.equal(api.approvedDigest, before.approvedDigest);
    assert.ok(
      s.store.read().tasks.every((t) => !t.hold),
      'удержание снято',
    );
    // База получила консолидированный документ.
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:docs/contracts/catalog.md'),
      s.sh('rev-parse', 'HEAD:docs/contracts/catalog.md'),
    );
    // Задача выдаётся и проходит подготовку попытки без блокировки.
    s.h.pause(false);
    const run = s.h.claim('test');
    assert.equal(run?.taskId, s.api.id);
    await devcontourHooks(s.h).prepared!({
      attempt: { id: run.id, token: run.token, workId: s.api.id },
      baseSha: s.sh('rev-parse', 'devcontour/accepted'),
    } as never);
    // Перенос, принёсший документ, доказан ревью консолидации и при открытой
    // задаче прежней редакции.
    const proof = await reviewedContractDocument(
      s.h,
      s.store.read(),
      'main',
      'docs/contracts/catalog.md',
      s.sh('rev-parse', 'devcontour/accepted'),
    );
    assert.equal(proof?.contractId, c2.id);
  } finally {
    await s.remove();
  }
});

test('F20: refusals before holds and before the model: changed artifacts, no current redaction, a dropped id, a removed sibling anchor', async () => {
  const s = await consolidationStage();
  try {
    const refused = async (proposal: object, pattern: RegExp) => {
      await assert.rejects(s.changes().start(proposal, 'codex', [], 'consolidate'), pattern);
      assert.equal(s.changes().list().length, 0, 'операция не заведена');
      assert.ok(
        s.store.read().tasks.every((t) => !t.hold),
        'ничего не удержано',
      );
    };
    await s.commitDoc(CONSOLIDATED);
    await writeFile(join(s.repo, 'schema.json'), '{"price":"string"}\n');
    s.sh('commit', '-qam', 'schema');
    await refused(s.proposal, /меняет artifacts/);
    await writeFile(join(s.repo, 'schema.json'), '{"price":"number"}\n');
    s.sh('commit', '-qam', 'schema back');
    await s.commitDoc('# New\n\nREQ-9.\n', 'docs/contracts/new.md');
    await refused({ title: 'New', file: 'docs/contracts/new.md' }, /нет зарегистрированной/);
    await s.commitDoc(CONSOLIDATED.replace('REQ-1. ', ''));
    await refused(s.proposal, /нет REQ-1/);
    await s.commitDoc(CONSOLIDATED.replace('## Prices', '## Pricing'));
    await refused(s.proposal, /#prices/);
    await assert.rejects(
      s.changes().start(s.proposal, 'codex', [s.screen.id], 'consolidate'),
      /--include к ней не относится/,
    );
    assert.deepEqual(s.calls, []);
  } finally {
    await s.remove();
  }
});

test('F20: a rejected consolidation review fails the operation and registers nothing; operator mode refuses', async () => {
  const s = await consolidationStage();
  try {
    await s.commitDoc(CONSOLIDATED);
    const op = await start(s);
    const failed = await s
      .changes(() => ({ approved: false, summary: 'REQ-2 was widened' }))
      .advance(op.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.next, 'review');
    assert.match(failed.error ?? '', /Независимое ревью отклонено: REQ-2 was widened/);
    assert.equal(s.store.read().contracts.length, 2, 'ничего не зарегистрировано');
    assert.equal(s.task(s.api.id).hold?.operation, op.id);
    s.changes().abandon(op.id);
    assert.equal(s.task(s.api.id).hold, undefined);
    s.h.config.approvalMode = 'operator';
    await assert.rejects(
      s.changes().start(s.proposal, 'codex', [], 'consolidate'),
      /В режиме operator изменение контракта проводит оператор/,
    );
  } finally {
    await s.remove();
  }
});

test('F20: drain waits for an active attempt before the consolidation review', async () => {
  const s = await consolidationStage();
  try {
    await s.commitDoc(CONSOLIDATED);
    s.h.pause(false);
    const run = s.h.claim('test');
    assert.equal(run?.taskId, s.api.id);
    const op = await start(s);
    const waiting = await s.changes().advance(op.id);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.next, 'drain');
    assert.deepEqual(waiting.waitingFor, [s.api.id]);
    assert.deepEqual(s.calls, [], 'ревью не начато');
    assert.equal(s.store.read().contracts.length, 2);
  } finally {
    await s.remove();
  }
});

test('F20: an amendment after a consolidation supersedes both earlier ids and rebinds their tasks', async () => {
  const s = await consolidationStage();
  try {
    s.h.pause(true);
    await s.commitDoc(CONSOLIDATED);
    const op = await start(s);
    assert.equal((await s.changes().advance(op.id)).status, 'completed');
    const c2 = s.store.read().contracts.at(-1)!;
    // Новая задача — уже на консолидированной редакции.
    const docs = s.h.addTask(s.board.id, {
      ...input('Docs'),
      role: 'backend',
      contracts: [c2.id],
    });
    s.h.approve(s.board.id, [docs.id]);
    assert.equal(s.task(docs.id).status, 'ready');
    // Смысловая поправка: схема меняется.
    await writeFile(join(s.repo, 'schema.json'), '{"price":"number","currency":"string"}\n');
    s.sh('commit', '-qam', 'schema amendment');
    const amend = (await s.changes().start(s.proposal, 'codex')) as { operation: ContractChange };
    const done = await s.changes().advance(amend.operation.id);
    assert.equal(done.status, 'completed', done.error);
    const c3 = s.store.read().contracts.at(-1)!;
    assert.equal(c3.consolidates, undefined);
    const contracts = s.store.read().contracts;
    assert.equal(supersededBy(contracts, s.c1.id)?.id, c3.id);
    assert.equal(supersededBy(contracts, c2.id)?.id, c3.id);
    assert.deepEqual(s.task(s.api.id).contracts, [c3.id]);
    assert.deepEqual(s.task(docs.id).contracts, [c3.id]);
    assert.deepEqual([...done.rebound].sort(), [s.api.id, docs.id].sort());
    // Принятая задача прежней редакции требует корректировки, как обычно.
    assert.deepEqual(done.corrections, [s.shipped.id]);
  } finally {
    await s.remove();
  }
});

test('F20: the CLI flag --consolidate starts the consolidation mode', async () => {
  const s = await consolidationStage();
  try {
    // Без флага операция дошла бы до удержания и отказала бы на нём: задачу
    // держит другая операция. С флагом — отказ предпроверки до операции.
    s.h.hold([s.api.id], 'CC-other', 'другая операция');
    const runtime = { runtime: 'codex' };
    await writeFile(
      join(s.root, 'config.json'),
      JSON.stringify({
        ...s.h.config,
        roles: Object.fromEntries(Object.keys(s.h.config.roles).map((r) => [r, runtime])),
        reviewer: { runtime: 'claude' },
      }),
    );
    await s.commitDoc(AMENDED.replace(/REQ-3/g, 'REQ-30').slice(0, AMENDED.length - 40));
    const file = join(s.root, 'proposal.json');
    await writeFile(file, JSON.stringify(s.proposal));
    const run = await command(
      [
        process.execPath,
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/cli.ts'),
        'contract-change',
        '--consolidate',
        '--file',
        file,
        '--author-runtime',
        'codex',
        '--data',
        s.root,
      ],
      process.cwd(),
      {
        timeoutMs: 120000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      },
    );
    assert.equal(run.code, 1);
    assert.match(run.stderr, /нет REQ-3/);
    assert.equal(s.changes().list().length, 0);
  } finally {
    await s.remove();
  }
});
