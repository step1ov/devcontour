import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckCorpus } from '../src/core/check-store.ts';
import { canonical } from '../src/core/sync-model.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import {
  deliver,
  fixture,
  git,
  readRecord,
  secondCase,
  snapshot,
  suiteFile,
} from './check-sync-fixture.ts';

test('AC20: an independent clone receives the accepted completion with the same task, check version, both phases and available SHA and blobs', async () => {
  const f = fixture();
  try {
    const a = await f.create('alice');
    syncGit(a.h, { member: 'alice' });
    const { task, suite } = await deliver(a, 'Optimal knapsack');
    syncGit(a.h);
    a.commit();
    const b = await f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    const restored = b.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(restored.status, 'done');
    assert.equal(restored.resultSha, task.resultSha);
    assert.deepEqual(restored.checkVersion, task.checkVersion);
    const receipt = restored.sharedCompletion!.receipt;
    assert.deepEqual(receipt.checkVersion?.corpus, task.checkVersion);
    const run = a.store
      .read()
      .runs.findLast((r) => r.taskId === task.id && r.status === 'succeeded')!;
    assert.equal(receipt.checkVersion?.effective, run.checks?.effective);
    for (const phase of ['candidate', 'integration'] as const) {
      const entry = receipt.checks.find((c) => c.gate === 'properties' && c.phase === phase)!;
      assert.equal(entry.checks, run.checks?.effective);
      assert.equal(entry.property?.level, 'manifest');
      assert.deepEqual(entry.property?.manifest?.properties, ['knapsack-optimal']);
      assert.equal(entry.property?.manifest?.corpus?.cases, 1);
    }
    // Receipt обозначен импортированным: живой попытки во втором клоне нет.
    assert.equal(b.store.read().runs.length, 0);
    assert.ok(restored.sharedCompletion!.sourceCommit);
    // Корпус и его blob доступны независимому клону.
    const imported = new CheckCorpus(b.h).get(suite);
    const version = imported.versions[0];
    assert.equal(version.digest, task.checkVersion!.digest);
    assert.ok(git(b.repo, 'cat-file', 'blob', version.blob).includes('"expected":5'));
    git(b.repo, 'cat-file', '-e', `${receipt.candidateSha}^{commit}`);
  } finally {
    await f.cleanup();
  }
});

test('AC21: independent additions merge three-way; a conflicting expectation or an invalid DAG rolls back without losing the baseline', async () => {
  const f = fixture();
  try {
    const a = await f.create('alice');
    syncGit(a.h, { member: 'alice' });
    const { task, suite } = await deliver(a, 'Optimal knapsack');
    const defect = a.store
      .read()
      .runs.find((r) => r.taskId === task.id && r.candidateSha)!.candidateSha!;
    syncGit(a.h);
    a.commit();
    const b = await f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    // Независимые добавки: каждая только в своей БД, Git ещё не видел вторую.
    const fromA = await secondCase(a, 'Alice second', 6, defect);
    const fromB = await secondCase(b, 'Bob second', 7, defect);
    syncGit(a.h);
    a.commit();
    for (const path of [b.repo, b.workspace]) git(path, 'pull', '--ff-only', '-q');
    syncGit(b.h);
    const merged = new CheckCorpus(b.h).get(suite);
    const inputs = Object.values(merged.cases).map(
      (c) => (JSON.parse(c.input) as { items: { v: number }[] }).items[0].v,
    );
    assert.deepEqual(inputs.sort(), [5, 6, 7], 'объединение сохранило случаи обоих клонов');
    const tasks = b.store.read().tasks;
    const boundA = tasks.find((t) => t.id === fromA.id)!.checkVersion!;
    const boundB = tasks.find((t) => t.id === fromB.id)!.checkVersion!;
    assert.notEqual(boundA.digest, boundB.digest);
    assert.ok(merged.versions.some((v) => v.digest === boundA.digest));
    assert.ok(merged.versions.some((v) => v.digest === boundB.digest));
    b.commit();
    git(a.repo, 'pull', '--ff-only', '-q', b.repo, 'main');
    git(a.workspace, 'pull', '--ff-only', '-q', b.workspace, 'main');
    syncGit(a.h);
    assert.equal(Object.keys(new CheckCorpus(a.h).get(suite).cases).length, 3);

    // Черновик той же доски — для проверки невалидного DAG ниже.
    const draftBoard = b.store
      .read()
      .boards.find((x) => x.revisions.at(-1)!.taskIds.includes(fromB.id))!;
    const draft = b.h.addTask(draftBoard.id, {
      title: 'Draft follow-up',
      description: 'Черновик следующей работы той же доски.',
      role: 'backend',
      acceptance: ['AC-draft'],
      contracts: [b.store.read().contracts[0].id],
    });
    syncGit(b.h);
    b.commit();
    // Противоречивое ожидание в Git: тот же вход, другой ответ.
    const before = snapshot(b);
    const baseline = JSON.stringify(b.store.syncBaseline('main'));
    const file = suiteFile(b, suite);
    const record = JSON.parse(readFileSync(file, 'utf8')) as {
      data: { cases: { expected: string }[] };
    };
    record.data.cases[0] = { ...record.data.cases[0], expected: '99' };
    writeFileSync(file, canonical(record));
    git(b.repo, 'commit', '-qam', 'forged expected');
    assert.throws(() => syncGit(b.h), /Конфликт корпуса|не совпадает/);
    assert.deepEqual(snapshot(b).state, before.state);
    assert.deepEqual(snapshot(b).suites, before.suites);
    assert.equal(JSON.stringify(b.store.syncBaseline('main')), baseline);
    git(b.repo, 'reset', '-q', '--hard', 'HEAD~1');

    // Невалидный DAG в Git откатывает и корпус.
    const taskFile = join(b.repo, '.devcontour/tasks', draft.id + '.json');
    const taskRecord = JSON.parse(readFileSync(taskFile, 'utf8')) as {
      data: { dependsOn: string[] };
    };
    taskRecord.data.dependsOn = [draft.id];
    writeFileSync(taskFile, canonical(taskRecord));
    git(b.repo, 'commit', '-qam', 'cycle');
    assert.throws(() => syncGit(b.h), /Цикл зависимостей/);
    assert.deepEqual(snapshot(b).suites, before.suites);
    assert.equal(JSON.stringify(b.store.syncBaseline('main')), baseline);
  } finally {
    await f.cleanup();
  }
});

test('F15/F20: a corpus record whose diagnostic text differs between versions or installations syncs again without a false conflict', async () => {
  const f = fixture();
  try {
    const a = await f.create('alice');
    syncGit(a.h, { member: 'alice' });
    const { suite } = await deliver(a, 'Old reason');
    syncGit(a.h);
    // Запись прежней версии: путь в причине принятия, остальное без изменений.
    const file = suiteFile(a, suite);
    const record = readRecord<{ data: { adoptions: { reason: string }[] } }>(file);
    assert.ok(record.data.adoptions.length);
    record.data.adoptions[0].reason =
      'Confirmed defect at /Users/Synthetic/old-workspace/input.json';
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    a.commit();
    const b = await f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    // Второй и третий sync без изменений — не конфликт истории. Диагностика
    // не входит в идентичность факта: остаётся значение из Git, уже
    // опубликованная история не переписывается.
    const before = readFileSync(suiteFile(b, suite), 'utf8');
    syncGit(b.h);
    syncGit(b.h);
    syncGit(a.h);
    assert.equal(readFileSync(suiteFile(b, suite), 'utf8'), before);
  } finally {
    await f.cleanup();
  }
});
