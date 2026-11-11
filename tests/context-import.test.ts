import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackedFiles } from '../src/runner/context-import.ts';
import { withQuotedGitPaths } from './helpers.ts';

// Импорт отбирает файлы апстрима по суффиксу `.md` и разрешённым префиксам.
// Без `-z` git экранирует не-ASCII путь (core.quotePath), и файл с путём
// кириллицей молча выпадал из импорта.

async function repository(files: Record<string, string>) {
  const repo = await mkdtemp(join(tmpdir(), 'devcontour-context-import-'));
  const sh = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
      cwd: repo,
    }).toString();
  sh('init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  sh('add', '.');
  sh('commit', '-qm', 'files');
  return { repo, remove: () => rm(repo, { recursive: true, force: true }) };
}

test('Импорт контекста видит Markdown-файлы апстрима с путями кириллицей', async () => {
  await withQuotedGitPaths(async () => {
    const r = await repository({
      'docs/руководство.md': '# Руководство\n',
      'docs/plain.md': '# Plain\n',
    });
    try {
      assert.deepEqual((await trackedFiles(r.repo)).sort(), [
        'docs/plain.md',
        'docs/руководство.md',
      ]);
    } finally {
      await r.remove();
    }
  });
});
