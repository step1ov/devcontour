import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const core = await lint('src/core/graph.ts', "import { git } from '../runner/process.ts';\n");
  assert.equal(core.length, 1);
  assert.equal(core[0].severity, 2);
  assert.match(core[0].message, /домен/);
  const child = await lint('src/core/graph.ts', "import { spawn } from 'node:child_process';\n");
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

test('harness — только из корня пакета или /contracts, не соседний checkout', async () => {
  const file = 'src/harness/index.ts';
  const deep = await lint(
    file,
    "import { Engine } from 'devcontour-harness/lib/engine/engine.js';\n",
  );
  assert.equal(deep.length, 1);
  assert.equal(deep[0].severity, 2);
  assert.match(deep[0].message, /корня пакета/);
  const sibling = await lint(
    file,
    "import { Engine } from '../../../devcontour-harness/src/index.ts';\n",
  );
  assert.equal(sibling.length, 1);
  assert.match(sibling[0].message, /соседний checkout/);
  // Тот же запрет действует и в слоях со своими правилами импорта.
  const core = await lint(
    'src/core/graph.ts',
    "import { Engine } from 'devcontour-harness/lib/index.js';\n",
  );
  assert.equal(core.length, 1);
  assert.equal(
    (await lint(file, "import { HARNESS_VERSION } from 'devcontour-harness';\n")).length,
    0,
  );
  assert.equal(
    (await lint(file, "import { workGraphSchema } from 'devcontour-harness/contracts';\n")).length,
    0,
  );
});

test('S3.1: harness — закреплённый versioned archive из vendor/harness, установленный в node_modules', async () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies: Record<string, string>;
    bundledDependencies?: string[];
  };
  const spec = pkg.dependencies['devcontour-harness'];
  const match = /^file:vendor\/harness\/devcontour-harness-([0-9A-Za-z.-]+)\.tgz$/.exec(spec ?? '');
  assert.ok(match, 'зависимость — относительный versioned archive: ' + spec);
  const version = match[1];
  assert.deepEqual(pkg.bundledDependencies, ['devcontour-harness']);
  const archive = spec.slice('file:'.length);
  const bytes = readFileSync(archive);
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };
  const locked = lock.packages['node_modules/devcontour-harness'];
  assert.equal(locked?.version, version);
  assert.equal(locked?.resolved, spec);
  assert.equal(
    locked?.integrity,
    'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    'lock фиксирует integrity поставленного архива',
  );
  // Ни соседнего checkout, ни абсолютных путей, ни ссылки.
  const manifests =
    readFileSync('package.json', 'utf8') + readFileSync('package-lock.json', 'utf8');
  assert.doesNotMatch(manifests, /file:\.\.\/|"\/(?:Users|home|private|tmp)\//);
  const installed = fileURLToPath(import.meta.resolve('devcontour-harness/package.json'));
  assert.equal(installed, join(process.cwd(), 'node_modules/devcontour-harness/package.json'));
  assert.equal(lstatSync(dirname(installed)).isSymbolicLink(), false, 'не npm link');
  assert.equal(
    (JSON.parse(readFileSync(installed, 'utf8')) as { version: string }).version,
    version,
  );
  const { harnessVersion } = await import('../src/harness/index.ts');
  assert.equal(harnessVersion, version);
  // Общие зависимости — одни и те же точные версии.
  const harness = JSON.parse(readFileSync(installed, 'utf8')) as {
    dependencies: Record<string, string>;
  };
  for (const [name, range] of Object.entries(harness.dependencies))
    if (pkg.dependencies[name] !== undefined) assert.equal(pkg.dependencies[name], range, name);
});

test('S3.1: в исходниках нет глубоких импортов harness и путей к его checkout', () => {
  const offending: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
        const text = readFileSync(path, 'utf8');
        if (
          /devcontour-harness\/(?!contracts['"]|package\.json['"])|\.\.\/devcontour-harness/.test(
            text,
          )
        )
          offending.push(path);
      }
    }
  };
  walk('src');
  assert.deepEqual(offending, []);
});

test('Код панели не загружает исполнение harness: из браузерного кода доступен только devcontour-harness/contracts', () => {
  // Корень пакета при загрузке читает файлы (версию пакета) — в браузере это
  // падение всей панели. Договоры пакета чистые.
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^(?!import type)[^\n]*from '((?:\.{1,2}|@)\/[^']+)'/gm)) {
      const ref = m[1];
      const path = ref.startsWith('@/') ? join('src/web', ref.slice(2)) : join(dirname(file), ref);
      if (/\.(ts|tsx)$/.test(path)) visit(path);
    }
  };
  for (const entry of readdirSync('src/web', { recursive: true }) as string[])
    if (/\.(ts|tsx)$/.test(entry)) visit(join('src/web', entry));
  const root = [...seen].filter((f) =>
    /^(?!import type)[^\n]*from 'devcontour-harness'/m.test(readFileSync(f, 'utf8')),
  );
  assert.deepEqual(root, []);
  assert.ok(seen.has('src/core/model.ts'), 'обход дошёл до модели предметной области');
});
