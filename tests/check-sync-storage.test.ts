import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { effectiveChecks } from '../src/core/checks.ts';
import { canonical } from '../src/core/sync-model.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { knap, reach } from './check-fixture.ts';
import {
  deliver,
  fixture,
  git,
  readRecord,
  receiptOf,
  stateDir,
  suiteFile,
  type Peer,
} from './check-sync-fixture.ts';

test('AC22: central, component and embedded storage keep the corpus with its owner; leases, commands and paths never reach Git', async () => {
  const f = fixture();
  try {
    for (const storage of ['component', 'central', 'embedded'] as const) {
      const p = await f.create(storage, undefined, storage);
      syncGit(p.h, { member: storage });
      const { suite } = await deliver(p, 'Optimal ' + storage);
      syncGit(p.h);
      const rows = (db: string) => {
        const d = new DatabaseSync(db, { readOnly: true });
        try {
          const table = d
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_workflow'")
            .get();
          return table
            ? (d
                .prepare("SELECT data FROM local_workflow WHERE namespace='check-suites'")
                .all() as { data: string }[])
            : [];
        } finally {
          d.close();
        }
      };
      const coordinator = rows(join(p.data, 'state.sqlite'));
      if (storage === 'component') {
        const component = rows(join(p.repo, '.devcontour-local', 'state.sqlite'));
        assert.equal(component.length, 1, 'корпус — в БД компонента');
        assert.ok(component[0].data.includes('"cap\\":0'));
        assert.equal(coordinator.length, 0, 'тела корпуса не в coordinator');
      } else assert.equal(coordinator.length, 1, `${storage}: корпус в единственной БД`);
      // В Git — данные корпуса, но не операции, токены, команды и пути.
      const text = readFileSync(suiteFile(p, suite), 'utf8');
      assert.ok(text.includes('"expected": "5"'));
      for (const banned of [
        'token',
        'leaseUntil',
        'operations',
        'pending',
        '"command"',
        p.data,
        p.workspace,
        tmpdir(),
        homedir(),
      ])
        assert.equal(text.includes(banned), false, `${storage}: ${banned} не в Git`);
      const receipts = readdirSync(join(p.repo, stateDir(p), 'receipts')).map((x) =>
        readFileSync(join(p.repo, stateDir(p), 'receipts', x), 'utf8'),
      );
      for (const r of receipts) assert.equal(r.includes(p.data), false);
    }
  } finally {
    await f.cleanup();
  }
});

test('AC23: an old receipt keeps its level, an incomplete new one is refused, and the new format round-trips without losing fields', async () => {
  const f = fixture();
  try {
    const a = await f.create('alice');
    syncGit(a.h, { member: 'alice' });
    const { task } = await deliver(a, 'Optimal knapsack');
    syncGit(a.h);
    a.commit();
    // Round-trip: экспорт второго клона совпадает с исходным.
    const b = await f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    for (const dir of ['receipts', 'checks', 'tasks', 'contracts']) {
      const names = readdirSync(join(a.repo, '.devcontour', dir));
      for (const name of names)
        assert.equal(
          readFileSync(join(b.repo, '.devcontour', dir, name), 'utf8'),
          readFileSync(join(a.repo, '.devcontour', dir, name), 'utf8'),
          `${dir}/${name} без потерь`,
        );
    }
    // Новый receipt без версии проверок у задачи с договором проверки.
    const receiptId = receiptOf(a.repo, task.id);
    const strip = (p: Peer, change: (r: { data: Record<string, unknown> }) => void) => {
      const file = join(p.repo, '.devcontour/receipts', receiptId + '.json');
      const record = readRecord<{ data: Record<string, unknown> }>(file);
      change(record);
      writeFileSync(file, canonical(record));
      git(p.repo, 'commit', '-qam', 'tampered receipt');
    };
    const c = await f.create('carol', a);
    strip(c, (r) => delete r.data.checkVersion);
    // Записи receipt подписаны версией проверок, которой у него больше нет.
    assert.throws(() => syncGit(c.h, { member: 'carol' }), /получена под другой версией проверок/);
    assert.equal(c.store.read().tasks.length, 0, 'ничего не импортировано');
    // Ссылка на версию корпуса, которой нет в Git.
    const d = await f.create('dave', a);
    // Согласованная подделка: версия, evidence, манифест и привязка задачи
    // указывают на корпус, которого в Git нет, — остаётся только проверка
    // наличия версии.
    const missing = 'e'.repeat(64);
    const doneTask = a.store.read().tasks.find((x) => x.id === task.id)!;
    strip(d, (r) => {
      const v = r.data.checkVersion as { effective: string; corpus: { digest: string } };
      v.corpus.digest = missing;
      v.effective = effectiveChecks(
        {
          approvedDigest: r.data.specDigest as string,
          contractDigests: doneTask.contractDigests,
          checkVersion: v.corpus as never,
        },
        r.data.policyDigest as string,
      );
      for (const c of r.data.checks as {
        checks?: string;
        property?: { manifest?: { corpus?: { digest: string } } };
      }[]) {
        if (c.checks) c.checks = v.effective;
        if (c.property?.manifest?.corpus) c.property.manifest.corpus.digest = missing;
      }
    });
    const taskFile2 = join(d.repo, '.devcontour/tasks', task.id + '.json');
    const taskRecord2 = readRecord<{ progress: { checkVersion: { digest: string } } }>(taskFile2);
    taskRecord2.progress.checkVersion.digest = missing;
    writeFileSync(taskFile2, canonical(taskRecord2));
    git(d.repo, 'commit', '-qam', 'binding to a missing corpus version');
    assert.throws(() => syncGit(d.h, { member: 'dave' }), /которой нет у получателя/);
    assert.equal(d.store.read().tasks.length, 0, 'ничего не импортировано');
    // Старый receipt задачи без договора проверки читается на прежнем уровне.
    const contract = a.store.read().contracts[0];
    const board = a.h.createBoard('Legacy', '', 'main');
    const legacy = a.h.addTask(board.id, {
      title: 'Legacy knapsack',
      description: 'Задача прежнего договора без области свойств.',
      role: 'backend',
      contracts: [contract.id],
      acceptance: ['AC-optimal'],
      writePaths: ['src/'],
    });
    a.h.approve(board.id, undefined, {
      actor: 'agent',
      authorRuntime: 'codex',
      reviewerRuntime: 'claude',
    });
    // Записи sync закоммичены в рабочую ветку: база прогонов переносится.
    git(a.repo, 'update-ref', 'refs/heads/devcontour/accepted', 'HEAD');
    a.h.pause(false);
    // Задача без области свойств проверяется всеми свойствами файла проверок.
    a.files['src/knap.mjs'] = knap.correct + '\n// legacy\n';
    a.files['src/reach.mjs'] = reach.correct;
    await a.scheduler.drain();
    a.h.pause(true);
    assert.equal(a.store.read().tasks.find((t) => t.id === legacy.id)!.status, 'done');
    git(a.repo, 'merge', '--ff-only', 'devcontour/accepted');
    syncGit(a.h);
    a.commit();
    const old = await f.create('erin', a);
    const legacyReceipt = receiptOf(old.repo, legacy.id);
    // Receipt прежнего формата: без версии проверок и манифеста свойств.
    const file = join(old.repo, '.devcontour/receipts', legacyReceipt + '.json');
    const record = readRecord<{
      data: { checkVersion?: unknown; checks: { checks?: unknown; property?: unknown }[] };
    }>(file);
    delete record.data.checkVersion;
    for (const c of record.data.checks) {
      delete c.checks;
      delete c.property;
    }
    writeFileSync(file, canonical(record));
    git(old.repo, 'commit', '-qam', 'receipt of the previous format');
    syncGit(old.h, { member: 'erin' });
    const restored = old.store.read().tasks.find((t) => t.id === legacy.id)!;
    assert.equal(restored.status, 'done');
    assert.equal(restored.sharedCompletion?.receipt.checkVersion, undefined);
  } finally {
    await f.cleanup();
  }
});
