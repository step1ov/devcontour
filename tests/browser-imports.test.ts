import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserNodeImports } from '../scripts/check-browser-imports.mjs';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const prefix = 'devcontour-browser-imports-fixture-';

// A fixture project removed after the test: only the directory this call
// created, and the node_modules link is unlinked rather than followed.
function fixture(t: TestContext, files: Record<string, string>) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, prefix));
  t.after(() => {
    if (dirname(root) !== parent || !basename(root).startsWith(prefix)) return;
    const link = join(root, 'node_modules');
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {
      // no link in this fixture
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const chains = (violations: { chain: string[] }[]) =>
  violations.map((v) => v.chain.join(' -> ')).sort();

// Vite dev serves the panel unbundled, so a value import that reaches node:*
// breaks the page even when the production build tree-shakes it away.
test('Панель в Vite dev не достигает модулей Node: ни транзитивно, ни через серверный слой', async (t) => {
  const root = fixture(t, {
    'src/web/main.ts': [
      "import { pure } from '../core/pure.ts';",
      "import { slug } from '../core/hashing.ts';",
      "import type { Stat } from '../core/types-only.ts';",
      "import { port } from '../server/port.ts';",
      'export const value: Stat | string = pure() + slug() + port;',
    ].join('\n'),
    'src/core/pure.ts': "export const pure = () => 'ok';\n",
    // The helper the panel uses never calls createHash, yet dev still
    // evaluates the import binding and throws.
    'src/core/hashing.ts':
      "import { createHash } from 'node:crypto';\nexport const slug = () => 's';\nexport const hash = () => createHash('sha256');\n",
    // Type-only imports are erased before the browser sees them.
    'src/core/types-only.ts':
      "import { statSync } from 'node:fs';\nexport type Stat = ReturnType<typeof statSync>;\n",
    'src/server/port.ts': 'export const port = 1;\n',
  });
  const { violations } = await browserNodeImports({
    root,
    entry: '/src/web/main.ts',
    configFile: false,
    cacheDir: join(root, '.vite-cache'),
  });
  assert.deepEqual(chains(violations), [
    'src/web/main.ts -> src/core/hashing.ts -> __vite-browser-external:node:crypto',
    'src/web/main.ts -> src/server/port.ts',
  ]);
});

test('С настоящим vite.config.ts (React, алиас @): harness вне /contracts и /projections, воркеры и src/cli* ловятся', async (t) => {
  const root = fixture(t, {
    'src/web/main.tsx': [
      "import { createRoot } from 'react-dom/client';",
      "import { tag } from '@/lib/tag.ts';",
      "import { status } from '../core/harness-root.ts';",
      "import { safe } from '../core/harness-safe.ts';",
      "import { help } from '../cli-help.ts';",
      "import { client } from '../client.ts';",
      "import Counter from './counter.ts?worker';",
      "const hashing = new Worker(new URL('./hashing.worker.ts', import.meta.url), { type: 'module' });",
      'const App = () => <p>{tag + status + safe + help + client}</p>;',
      "createRoot(document.getElementById('root')!).render(<App />);",
      'export { Counter, hashing };',
    ].join('\n'),
    // Reached only through the alias from vite.config.ts.
    'src/web/lib/tag.ts':
      "import { hash } from '../../core/hashing.ts';\nexport const tag = hash;\n",
    'src/core/hashing.ts':
      "import { randomUUID } from 'node:crypto';\nexport const hash = () => randomUUID();\n",
    'src/core/harness-root.ts':
      "import { HARNESS_VERSION } from 'devcontour-harness';\nexport const status = HARNESS_VERSION;\n",
    'src/core/harness-safe.ts': [
      "import { workGraphSchema } from 'devcontour-harness/contracts';",
      "import * as projections from 'devcontour-harness/projections';",
      'export const safe = String(Boolean(workGraphSchema && projections));',
    ].join('\n'),
    'src/cli-help.ts': "export const help = 'help';\n",
    // Shares the prefix with src/cli, but is no CLI module.
    'src/client.ts': "export const client = 'client';\n",
    'src/web/counter.ts': "import { port } from '../server/port.ts';\npostMessage(port);\n",
    'src/server/port.ts': 'export const port = 1;\n',
    'src/web/hashing.worker.ts':
      "import { readFileSync } from 'node:fs';\npostMessage(typeof readFileSync);\n",
  });
  copyFileSync(join(checkout, 'vite.config.ts'), join(root, 'vite.config.ts'));
  symlinkSync(join(checkout, 'node_modules'), join(root, 'node_modules'), 'dir');
  const { violations } = await browserNodeImports({
    root,
    entry: '/src/web/main.tsx',
    configFile: join(root, 'vite.config.ts'),
    cacheDir: join(root, '.vite-cache'),
  });
  const found = chains(violations);
  const has = (pattern: RegExp) =>
    assert.ok(
      found.some((c) => pattern.test(c)),
      pattern + ' not in\n' + found.join('\n'),
    );
  has(
    /^src\/web\/main\.tsx -> src\/web\/lib\/tag\.ts -> src\/core\/hashing\.ts -> __vite-browser-external:node:crypto$/,
  );
  has(
    /^src\/web\/main\.tsx -> src\/core\/harness-root\.ts -> .*node_modules\/devcontour-harness\/lib\/index\.js$/,
  );
  has(/^src\/web\/main\.tsx -> src\/cli-help\.ts$/);
  has(/^src\/web\/main\.tsx -> .*counter\.ts.* -> src\/server\/port\.ts$/);
  has(
    /^src\/web\/main\.tsx -> src\/web\/hashing\.worker\.ts\?worker_file\S* -> __vite-browser-external:node:fs$/,
  );
  assert.equal(found.length, 5, found.join('\n'));
  assert.ok(!found.some((c) => /client\.ts|harness-safe|contracts|projections/.test(c)));
});

test('Настоящая панель (src/web/main.tsx) не достигает модулей Node', async () => {
  const { modules, violations } = await browserNodeImports({
    root: checkout,
    entry: '/src/web/main.tsx',
  });
  assert.deepEqual(violations, []);
  assert.ok(modules > 20, 'граф панели обойдён целиком: ' + modules);
});
