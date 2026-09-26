import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ESLint } from 'eslint';

// Граница слоя проверяется тем же линтером, что и весь код: этот тест
// подтверждает, что нарушение действительно становится ошибкой, а не
// предупреждением, которое можно не заметить.
const lint = async (file: string, extra: string) => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(extra + readFileSync(file, 'utf8'), { filePath: file });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
};

test('Домен не импортирует runner, а интерфейс — модули Node', async () => {
  const core = await lint('src/core/reuse.ts', "import { git } from '../runner/process.ts';\n");
  assert.equal(core.length, 1);
  assert.equal(core[0].severity, 2);
  assert.match(core[0].message, /домен/);
  const child = await lint('src/core/reuse.ts', "import { spawn } from 'node:child_process';\n");
  assert.equal(child.length, 1);
  const web = await lint('src/web/AuthorOverview.tsx', "import { readFileSync } from 'node:fs';\n");
  assert.equal(web.length, 1);
  assert.equal(web[0].severity, 2);
  const application = await lint(
    'src/application/overview.ts',
    "import { serve } from '../server/http.ts';\n",
  );
  assert.equal(application.length, 1);
  // Разрешённое направление не шумит.
  assert.equal((await lint('src/runner/backup.ts', '')).length, 0);
});
