// Дифф результата быстрого изменения: интегрированная задача — от рабочей
// ветки, на которую она слита, а не от устаревшей базы попытки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quickResultDiff } from '../src/runner/quick.ts';

test('quickResultDiff: работа другой доски, слитая раньше, не попадает в дифф интегрированной задачи', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-quick-diff-')));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    ).trim();
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    // Кандидат задачи — от базы попытки.
    git('checkout', '-q', '-b', 'candidate');
    writeFileSync(join(root, 'own.txt'), 'own\n');
    git('add', '.');
    git('commit', '-qm', 'own');
    const candidate = git('rev-parse', 'HEAD');
    // Тем временем рабочая ветка приняла работу другой доски.
    git('checkout', '-q', 'main');
    writeFileSync(join(root, 'other.txt'), 'other\n');
    git('add', '.');
    git('commit', '-qm', 'other board');
    git('merge', '-q', '--no-ff', '--no-edit', candidate);
    const integration = git('rev-parse', 'HEAD');

    const merged = await quickResultDiff(root, {
      baseSha: base,
      candidateSha: candidate,
      integrationSha: integration,
    });
    assert.deepEqual(
      merged?.files.map((f) => f.path),
      ['own.txt'],
    );
    assert.equal(merged?.added, 1);
    // Без интеграции — кандидат от базы попытки.
    const pending = await quickResultDiff(root, {
      baseSha: base,
      candidateSha: candidate,
      integrationSha: null,
    });
    assert.deepEqual(
      pending?.files.map((f) => f.path),
      ['own.txt'],
    );
    assert.equal(await quickResultDiff(root, { baseSha: base, candidateSha: null }), null);
  } finally {
    assert.ok(root.includes('dc-quick-diff-'));
    rmSync(root, { recursive: true, force: true });
  }
});
