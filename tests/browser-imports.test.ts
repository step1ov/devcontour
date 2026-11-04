import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserNodeImports } from '../scripts/check-browser-imports.mjs';

const checkout = fileURLToPath(new URL('../', import.meta.url));

// Vite dev serves the panel unbundled, so a value import that reaches node:*
// breaks the page even when the production build tree-shakes it away.
test('Панель в Vite dev не достигает модулей Node: ни транзитивно, ни через серверный слой', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-browser-imports-'));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(
    'src/web/main.ts',
    [
      "import { pure } from '../core/pure.ts';",
      "import { slug } from '../core/hashing.ts';",
      "import type { Stat } from '../core/types-only.ts';",
      "import { port } from '../server/port.ts';",
      'export const value: Stat | string = pure() + slug() + port;',
    ].join('\n'),
  );
  write('src/core/pure.ts', "export const pure = () => 'ok';\n");
  // The helper the panel uses never calls createHash, yet dev still evaluates
  // the import binding and throws.
  write(
    'src/core/hashing.ts',
    "import { createHash } from 'node:crypto';\nexport const slug = () => 's';\nexport const hash = () => createHash('sha256');\n",
  );
  // Type-only imports are erased before the browser sees them.
  write(
    'src/core/types-only.ts',
    "import { statSync } from 'node:fs';\nexport type Stat = ReturnType<typeof statSync>;\n",
  );
  write('src/server/port.ts', 'export const port = 1;\n');
  const { violations } = await browserNodeImports({
    root,
    entry: '/src/web/main.ts',
    configFile: false,
  });
  assert.deepEqual(
    violations.map((v) => v.chain),
    [
      ['src/web/main.ts', 'src/server/port.ts'],
      ['src/web/main.ts', 'src/core/hashing.ts', '__vite-browser-external:node:crypto'],
    ].sort((a, b) => a.length - b.length),
  );
});

test('Настоящая панель (src/web/main.tsx) не достигает модулей Node', async () => {
  const { modules, violations } = await browserNodeImports({
    root: checkout,
    entry: '/src/web/main.tsx',
  });
  assert.deepEqual(violations, []);
  assert.ok(modules > 20, 'граф панели обойдён целиком: ' + modules);
});
