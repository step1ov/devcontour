import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('START fast-forwards the working branch to devcontour/accepted before committing updated context', () => {
  const start = readFileSync(new URL('../START.md', import.meta.url), 'utf8');
  const paragraph = start
    .split('\n\n')
    .find((p) => p.includes('Правки инструкций и конфигурации выполняй как ведущий агент'));
  assert.ok(paragraph, 'абзац о правке инструкций и конфигурации');
  const ff = paragraph.indexOf('merge --ff-only devcontour/accepted');
  const commit = paragraph.indexOf('закоммить правки');
  const lock = paragraph.indexOf('context-lock');
  assert.ok(ff >= 0, 'перемотка к принятой ветке названа командой');
  assert.ok(ff < commit && commit < lock, 'перемотка → коммит → context-lock');
});
