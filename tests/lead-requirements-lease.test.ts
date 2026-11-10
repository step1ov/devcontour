import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { git } from '../src/runner/process.ts';
import { requirementSnapshot } from '../src/runner/requirements.ts';
import { jointFixture } from './joint-fixture.ts';

test('Чтение требований стадии ведущего не держит процесс дольше срока владения заданием', async () => {
  // Медленный Git (большой репозиторий, холодный кэш): каждое чтение ТЗ
  // идёт 0,8 с, а источников три — чтение требований стадии дольше срока
  // владения заданием (5 с). Синхронный Git держал процесс всё это время:
  // продление владения не успевало, и стадия ChangeSet прерывалась потерей
  // владения, не начав совместную проверку.
  const f = await jointFixture({ gateMs: 100, start: false });
  const path = process.env.PATH ?? '';
  try {
    const repo = f.config.repository;
    await mkdir(join(repo, 'docs'), { recursive: true });
    const sources = ['docs/a.md', 'docs/b.md', 'docs/c.md'];
    for (const [i, source] of sources.entries())
      await writeFile(join(repo, source), `## REQ-slow-${i}: Slow\nThe result works.\n`);
    await git(repo, 'add', 'docs');
    await git(repo, 'commit', '-qm', 'Specs');
    const links = sources.map((source) => {
      const snapshot = requirementSnapshot(repo, source);
      return {
        ...snapshot.requirements[0],
        source: snapshot.source,
        gate: f.config.gates[0].id,
        scenario: 'Slow result',
      };
    });
    f.store.change('fixture.requirements', (s) => {
      for (const t of s.tasks) t.requirements = links;
    });
    const job = f.flow.start({ kind: 'changeset', id: f.change.id, authorRuntime: 'codex' });
    await f.lead.tick(); // стадия 0: доски приняты
    assert.equal(f.flow.get(job.key).stage, 1);
    const real = path
      .split(delimiter)
      .map((dir) => join(dir, 'git'))
      .find((file) => existsSync(file));
    assert.ok(real, 'git on PATH');
    const shim = join(f.root, 'slow-git');
    await mkdir(shim);
    await writeFile(join(shim, 'git'), `#!/bin/sh\nsleep 0.8\nexec "${real}" "$@"\n`);
    await chmod(join(shim, 'git'), 0o755);
    process.env.PATH = shim + delimiter + path;
    const started = Date.now();
    await f.lead.tick(); // стадия 1: требования, затем начало проверки
    process.env.PATH = path;
    assert.ok(Date.now() - started > f.config.leaseMs, 'reading took longer than the lease');
    const current = f.flow.get(job.key);
    // Стадия ответила «жду» начатой проверки: владение не утрачено,
    // попытка не израсходована прерыванием.
    assert.equal(current.status, 'queued', JSON.stringify(current));
    assert.equal(current.stage, 1);
    assert.equal(current.attempts, 0, JSON.stringify(current));
    assert.equal(current.error, undefined);
    await f.lead.settled();
    assert.deepEqual(
      f.verifications().map((v) => v.status),
      ['passed'],
    );
  } finally {
    process.env.PATH = path;
    await f.cleanup();
  }
});
