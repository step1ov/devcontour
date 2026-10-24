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

test('devcontour-harness/projections разрешён ровно домену и только этим точным subpath', async () => {
  const projections = "import { chainRoots } from 'devcontour-harness/projections';\n";
  // Домен вызывает чистые проекции, которые исполняются и в браузере.
  assert.equal((await lint('src/core/graph.ts', projections)).length, 0);
  // Остальные слои — прежний запрет: корень или /contracts.
  for (const file of [
    'src/runner/backup.ts',
    'src/application/overview.ts',
    'src/web/AuthorOverview.tsx',
    'src/server/http.ts',
    'src/harness/index.ts',
  ]) {
    const found = await lint(file, projections);
    assert.equal(found.length, 1, file);
    assert.equal(found[0].severity, 2, file);
  }
  // Исключение точечное: ни вложенный путь, ни другой subpath домену недоступны.
  for (const spec of [
    'devcontour-harness/projections/chain',
    'devcontour-harness/lib/projections/index.js',
    'devcontour-harness/toolchains',
    'devcontour-harness/testing',
  ])
    assert.equal(
      (await lint('src/core/graph.ts', `import { x } from '${spec}';\n`)).length,
      1,
      spec,
    );
  // В тестах — дополнительно к /testing.
  assert.equal((await lint('tests/boundaries.test.ts', projections)).length, 0);
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
          /devcontour-harness\/(?!contracts['"]|projections['"]|package\.json['"])|\.\.\/devcontour-harness/.test(
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

test('Код панели не загружает исполнение harness: из браузерного кода доступны только /contracts и /projections', () => {
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('S3.6: учёт вызовов, бюджеты, ревью плана и контракта, очередь ведущего и решение о восстановлении — только harness', () => {
  // Удалённые вторые реализации не возвращаются.
  for (const removed of ['core/budget.ts', 'core/live-calls.ts', 'runner/live-calls.ts'])
    assert.throws(() => lstatSync(join(root, 'src', removed)), removed);
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [join(dir, e.name)]
          : [],
    );
  const code = (path: string) => readFileSync(join(root, path), 'utf8');
  for (const path of [
    ...sources('src/core'),
    ...sources('src/harness'),
    'src/runner/agent-control.ts',
    'src/runner/lead-workflow.ts',
  ]) {
    const text = code(path);
    assert.doesNotMatch(
      text,
      /=== '(codex|claude)' \? '(claude|codex)' : '(codex|claude)'/,
      `${path}: безусловный «противоположный runtime» вместо правила вендора политики`,
    );
    assert.doesNotMatch(
      text,
      /measuredExecute|assertBudget|callBudgets/,
      `${path}: свой учёт вызовов`,
    );
  }
  // Техническое ревью, очередь и восстановление вызывают harness.
  assert.match(code('src/runner/agent-control.ts'), /technicalReview\(/);
  assert.match(code('src/core/lead-workflow.ts'), /new WorkflowQueue\(/);
  assert.match(code('src/core/repair.ts'), /from 'devcontour-harness'/);
  assert.match(code('src/harness/measured.ts'), /measuredInvoke\(/);
});

test('S3.6: применение конфигурации, удержания, перенос базы и совместная проверка — механизмы harness', () => {
  const code = (path: string) => readFileSync(join(root, path), 'utf8');
  // Своих записей состояния операции, удержаний и применённой конфигурации нет:
  // их пишет только движок через адаптер хранилища.
  for (const path of ['src/core/service.ts', 'src/core/workspace.ts', 'src/runner/reconfigure.ts'])
    assert.doesNotMatch(
      code(path),
      /\.appliedConfig = |\.reconfigure = |\.hold = /,
      `${path}: своя запись применения конфигурации или удержания`,
    );
  // Совместная проверка и перенос базы — исполнение harness, без своих копий.
  for (const path of [
    'src/core/workspace.ts',
    'src/runner/workspace.ts',
    'src/runner/base-update.ts',
    'src/runner/contract-change.ts',
  ])
    assert.doesNotMatch(
      code(path),
      /'update-ref'|'worktree', 'add'|junitSummary|componentImpact|merge-base/,
      `${path}: своя реализация переноса базы или совместной проверки`,
    );
  assert.match(code('src/runner/workspace.ts'), /new JointRunner\(/);
  assert.match(code('src/runner/base-update.ts'), /moveBase\(/);
  assert.match(code('src/runner/contract-change.ts'), /fencedRefMove\(/);
});

test('S3.6: корпус, подтверждение случая, разбор по свойству и исполнение gate — только harness', () => {
  for (const removed of [
    'runner/gates.ts',
    'runner/property.ts',
    'core/property.ts',
    'core/property-recovery.ts',
  ])
    assert.throws(() => lstatSync(join(root, 'src', removed)), removed);
  const code = (path: string) => readFileSync(join(root, path), 'utf8');
  // Своих правил подтверждения, записи версии корпуса и эпизода разбора нет.
  for (const path of [
    'src/core/check-store.ts',
    'src/runner/checks.ts',
    'src/runner/recovery.ts',
    'src/core/service.ts',
  ])
    assert.doesNotMatch(
      code(path),
      /hash-object|function decide\(|function afterFailure|function propertyStreak|recovery\.status = |\.versions\.push\(/,
      `${path}: своя реализация корпуса, подтверждения или эпизода разбора`,
    );
  assert.match(code('src/core/check-store.ts'), /new CorpusStore\(/);
  assert.match(code('src/runner/checks.ts'), /submitCase as confirmCase/);
  assert.match(code('src/runner/recovery.ts'), /analyzeRecovery as analyze/);
  // Основание эпизода — формула DevContour через порт хоста.
  assert.match(code('src/harness/host.ts'), /episodeBasis: \(work, view\)/);
});

test('S3.6: доказательство сценария, договор проверки, эксперимент, самопроверка, добавление случаев и маскирование — правила harness', () => {
  const code = (path: string) => readFileSync(join(root, path), 'utf8');
  // Правила — вызовы harness; в DevContour остаются продуктовые входы.
  assert.match(
    code('src/core/proof.ts'),
    /export \{ requirementProof, unprovenReason \} from 'devcontour-harness'/,
  );
  assert.match(code('src/core/checks.ts'), /harnessDeclarationProblems\(/);
  assert.match(code('src/core/checks.ts'), /orderPropertyProblems\(/);
  assert.match(code('src/core/checks.ts'), /checkDeclaration = checkDeclarationSchema/);
  assert.match(code('src/runner/checks.ts'), /harnessRunSpike\(/);
  assert.match(code('src/runner/checks.ts'), /harnessWriteSelfCheck\(/);
  assert.match(code('src/runner/recovery.ts'), /harnessApplyCases\(/);
  assert.match(code('src/runner/redaction.ts'), /from 'devcontour-harness'/);
  // Вторых реализаций нет: ни сверки манифеста testcase, ни структурных
  // правил договора, ни своего запуска эксперимента или плана самопроверки.
  for (const [path, pattern] of [
    ['src/core/proof.ts', /withManifest|\.tests!\.filter|встречается .* раза/],
    ['src/core/checks.ts', /strongPromises\.has|не генеративный|minCases|function declared\(/],
    [
      'src/runner/checks.ts',
      /'worktree', 'add'|DEVCONTOUR_SPIKE_SIZE|selfcheck\.mjs|spawnSync|runCheck\(/,
    ],
    ['src/runner/recovery.ts', /-case-\$\{i\}/],
    ['src/runner/redaction.ts', /\[REDACTED\]|encodeURIComponent|replaceAll/],
  ] as const)
    assert.doesNotMatch(code(path), pattern, `${path}: вторая реализация правила harness`);
});

test('S3.6: приёмка по receipt Git-синхронизации — получатель harness; в DevContour только формат receipt', () => {
  const code = (path: string) => readFileSync(join(root, path), 'utf8');
  const sync = code('src/core/sync-state.ts');
  assert.match(sync, /receiptProblems\(/);
  // Своих решающих записей, раскрытия области, версии проверок и доказательств нет.
  assert.doesNotMatch(
    sync,
    /const decisive|unprovenReason|effectiveChecks|obligationOf|expandGates|propertyProofProblem|Нет PASS в receipt/,
    'src/core/sync-state.ts: вторая реализация приёмки по receipt',
  );
  assert.match(code('src/harness/receipt.ts'), /resultProblems\(/);
});
