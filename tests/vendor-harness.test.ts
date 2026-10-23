/**
 * Поставка архива harness (`scripts/vendor-harness.mjs`): установленные байты —
 * байты поставленного архива. npm не переустанавливает пакет той же версии из
 * `file:`-архива с другими байтами; скрипт обязан обновить lock и установленную
 * копию либо отказать, но не оставить прежние байты под новой записью.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/vendor-harness.mjs', import.meta.url));
const COMMIT = 'a'.repeat(40);

/** Архив пакета `devcontour-harness` с заданным содержимым `index.js`. */
function archive(dir: string, name: string, version: string, body: string) {
  const src = join(dir, 'src-' + name, 'package');
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, 'package.json'),
    JSON.stringify({ name: 'devcontour-harness', version, main: 'index.js' }),
  );
  writeFileSync(join(src, 'index.js'), body);
  const out = join(dir, name);
  mkdirSync(out, { recursive: true });
  const file = join(out, `devcontour-harness-${version}.tgz`);
  // Без служебных файлов AppleDouble (`._*`) tar на macOS — как у `npm pack`.
  execFileSync('tar', ['-czf', file, '-C', join(dir, 'src-' + name), 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return file;
}
const sha512 = (file: string) =>
  'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64');

function project(dir: string) {
  const root = join(dir, 'consumer');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(script, join(root, 'scripts', 'vendor-harness.mjs'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '0.0.0', private: true, dependencies: {} }),
  );
  return root;
}
const vendor = (root: string, file: string, ...extra: string[]) =>
  spawnSync(
    process.execPath,
    [join(root, 'scripts', 'vendor-harness.mjs'), file, '--commit', COMMIT, ...extra],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_offline: 'true' },
    },
  );
const state = (root: string) => ({
  integrity: (
    JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { integrity?: string }>;
    }
  ).packages['node_modules/devcontour-harness']?.integrity,
  body: readFileSync(join(root, 'node_modules', 'devcontour-harness', 'index.js'), 'utf8'),
});

test('vendor-harness: тот же номер другими байтами — отказ без --replace; с --replace lock и установленные байты новые', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-harness-'));
  try {
    const first = archive(dir, 'first', '9.9.9-test.0', 'module.exports = 1;\n');
    const second = archive(dir, 'second', '9.9.9-test.0', 'module.exports = 2;\n');
    const root = project(dir);

    const r1 = vendor(root, first);
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(state(root), { integrity: sha512(first), body: 'module.exports = 1;\n' });

    const refused = vendor(root, second);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /уже поставлена другими байтами/);
    assert.deepEqual(state(root), { integrity: sha512(first), body: 'module.exports = 1;\n' });

    const replaced = vendor(root, second, '--replace');
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.deepEqual(state(root), { integrity: sha512(second), body: 'module.exports = 2;\n' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vendor-harness: новый номер заменяет прежний архив; lock и установленная копия — байты нового', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-harness-'));
  try {
    const older = archive(dir, 'older', '9.9.9-test.1', 'module.exports = "older";\n');
    const newer = archive(dir, 'newer', '9.9.9-test.2', 'module.exports = "newer";\n');
    const root = project(dir);
    assert.equal(vendor(root, older).status, 0);
    const r = vendor(root, newer);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(state(root), {
      integrity: sha512(newer),
      body: 'module.exports = "newer";\n',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
