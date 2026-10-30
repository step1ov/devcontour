import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const packageScripts = (
  JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const toolPath = join(checkout, 'node_modules', '.bin');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-build-output-'));
  for (const path of ['scripts', 'src/web/lib', 'lib', 'outside'])
    mkdirSync(join(root, path), { recursive: true });
  cpSync(join(checkout, 'scripts/clean-lib.mjs'), join(root, 'scripts/clean-lib.mjs'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: { typecheck: packageScripts.typecheck, 'build:lib': packageScripts['build:lib'] },
    }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        strict: true,
        noEmit: true,
        types: [],
      },
      include: ['src/cli.ts'],
    }),
  );
  writeFileSync(
    join(root, 'tsconfig.build.json'),
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { noEmit: false, rootDir: 'src', outDir: 'lib' },
    }),
  );
  writeFileSync(join(root, 'src/cli.ts'), 'export const value: number = 42;\n');
  writeFileSync(join(root, 'lib/obsolete.js'), 'stale generated module\n');
  writeFileSync(join(root, 'user.txt'), 'user data\n');
  writeFileSync(join(root, 'src/web/lib/user.ts'), 'user source\n');
  writeFileSync(join(root, 'outside/user.txt'), 'external user data\n');
  const run = () =>
    execFileSync('npm', ['run', 'build:lib'], {
      cwd: root,
      env: { ...process.env, PATH: toolPath + delimiter + process.env.PATH },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
  return { root, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function outputFiles(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(root.length + 1), readFileSync(path, 'utf8')];
      }),
  );
}

test('Library build removes obsolete output and equals a fresh compiler emit while preserving source and user files', () => {
  const f = fixture();
  try {
    symlinkSync(join(f.root, 'outside'), join(f.root, 'lib/external-link'), 'dir');
    const source = readFileSync(join(f.root, 'src/cli.ts'), 'utf8');
    f.run();
    assert.deepEqual(Object.keys(outputFiles(join(f.root, 'lib'))), ['cli.js']);
    execFileSync(
      process.execPath,
      [
        join(checkout, 'node_modules/typescript/bin/tsc'),
        '-p',
        'tsconfig.build.json',
        '--outDir',
        'fresh-lib',
      ],
      { cwd: f.root, stdio: 'pipe', timeout: 30000 },
    );
    assert.deepEqual(outputFiles(join(f.root, 'lib')), outputFiles(join(f.root, 'fresh-lib')));
    assert.equal(readFileSync(join(f.root, 'src/cli.ts'), 'utf8'), source);
    assert.equal(readFileSync(join(f.root, 'src/web/lib/user.ts'), 'utf8'), 'user source\n');
    assert.equal(readFileSync(join(f.root, 'user.txt'), 'utf8'), 'user data\n');
    assert.equal(readFileSync(join(f.root, 'outside/user.txt'), 'utf8'), 'external user data\n');
  } finally {
    f.cleanup();
  }
});

test('A failed typecheck leaves the previous library build intact', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'src/cli.ts'), 'export const value: number = "invalid";\n');
    assert.throws(f.run, /Command failed/);
    assert.equal(readFileSync(join(f.root, 'lib/obsolete.js'), 'utf8'), 'stale generated module\n');
  } finally {
    f.cleanup();
  }
});

test('Library cleanup targets its own root even from another cwd and unlinks a root output symlink without following it', () => {
  const f = fixture();
  try {
    rmSync(join(f.root, 'lib'), { recursive: true });
    symlinkSync(join(f.root, 'outside'), join(f.root, 'lib'), 'dir');
    execFileSync(process.execPath, [join(f.root, 'scripts/clean-lib.mjs')], {
      cwd: dirname(f.root),
      stdio: 'pipe',
    });
    assert.equal(readFileSync(join(f.root, 'outside/user.txt'), 'utf8'), 'external user data\n');
    assert.equal(readFileSync(join(f.root, 'src/web/lib/user.ts'), 'utf8'), 'user source\n');
  } finally {
    f.cleanup();
  }
});
