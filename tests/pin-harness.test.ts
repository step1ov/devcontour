/**
 * Закрепление пакета harness (`scripts/pin-harness.mjs`): зависимость — точная
 * версия из registry, lock фиксирует опубликованные resolved и integrity, в
 * архив DevContour ничего не вкладывается. npm оставляет запись lock той же
 * версии с прежним resolved (локальный архив); скрипт обязан её заменить.
 * Registry — локальный HTTP-сервер теста, сеть не нужна.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/pin-harness.mjs', import.meta.url));
const COMMIT = 'a'.repeat(40);
const VERSION = '9.9.9-test.0';

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

/** Registry с одной опубликованной версией: packument и tarball. */
async function registry(published: string) {
  const server: Server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tarball = `/devcontour-harness/-/devcontour-harness-${VERSION}.tgz`;
    if (req.url === '/devcontour-harness') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: 'devcontour-harness',
          'dist-tags': { latest: VERSION },
          versions: {
            [VERSION]: {
              name: 'devcontour-harness',
              version: VERSION,
              main: 'index.js',
              dist: { tarball: base + tarball, integrity: sha512(published) },
            },
          },
        }),
      );
    } else if (req.url === tarball) res.end(readFileSync(published));
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

const env = (dir: string, registryUrl: string) => ({
  ...process.env,
  npm_config_registry: registryUrl,
  npm_config_cache: join(dir, 'npm-cache'),
  npm_config_offline: 'false',
  npm_config_prefer_offline: 'false',
});
/** Потребитель в прежней форме: вложенный архив той же версии по `file:`. */
function consumer(dir: string, vendored: string, registryUrl: string) {
  const root = join(dir, 'consumer');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'vendor', 'harness'), { recursive: true });
  copyFileSync(script, join(root, 'scripts', 'pin-harness.mjs'));
  copyFileSync(vendored, join(root, 'vendor', 'harness', `devcontour-harness-${VERSION}.tgz`));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      version: '0.0.0',
      private: true,
      dependencies: {
        'devcontour-harness': `file:vendor/harness/devcontour-harness-${VERSION}.tgz`,
      },
      bundledDependencies: ['devcontour-harness'],
    }),
  );
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root,
    env: env(dir, registryUrl),
    stdio: 'ignore',
  });
  return root;
}
// Асинхронно: процесс npm обращается к registry этого же процесса теста.
const pin = (root: string, dir: string, registryUrl: string, ...args: string[]) =>
  new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [join(root, 'scripts', 'pin-harness.mjs'), ...args, '--commit', COMMIT],
      { cwd: root, env: env(dir, registryUrl) },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (status) => resolve({ status, stderr }));
  });
const lockEntry = (root: string) =>
  (
    JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { resolved?: string; integrity?: string; inBundle?: boolean }>;
    }
  ).packages['node_modules/devcontour-harness'];

test('pin-harness: вложенный архив той же версии заменяется точной версией из registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-harness-'));
  const published = archive(dir, 'published', VERSION, 'module.exports = "registry";\n');
  const local = archive(dir, 'local', VERSION, 'module.exports = "vendored";\n');
  const { server, url } = await registry(published);
  try {
    const root = consumer(dir, local, url);
    assert.equal(lockEntry(root).resolved, `file:vendor/harness/devcontour-harness-${VERSION}.tgz`);

    const r = await pin(root, dir, url, VERSION, '--archive', published);
    assert.equal(r.status, 0, r.stderr);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      bundledDependencies?: string[];
    };
    assert.equal(pkg.dependencies['devcontour-harness'], VERSION);
    assert.equal(pkg.bundledDependencies, undefined);
    const entry = lockEntry(root);
    assert.equal(entry.resolved, `${url}devcontour-harness/-/devcontour-harness-${VERSION}.tgz`);
    assert.equal(entry.integrity, sha512(published));
    assert.equal(entry.inBundle, undefined);
    assert.equal(
      readFileSync(join(root, 'node_modules', 'devcontour-harness', 'index.js'), 'utf8'),
      'module.exports = "registry";\n',
    );
    const record = readFileSync(join(root, 'vendor', 'harness', 'README.md'), 'utf8');
    for (const part of [VERSION, sha512(published), COMMIT]) assert.ok(record.includes(part), part);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin-harness: архив не равен опубликованным байтам — отказ до изменений; диапазон версии — отказ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-harness-'));
  const published = archive(dir, 'published', VERSION, 'module.exports = "registry";\n');
  const other = archive(dir, 'other', VERSION, 'module.exports = "other";\n');
  const { server, url } = await registry(published);
  try {
    const root = consumer(dir, other, url);
    const files = () =>
      ['package.json', 'package-lock.json'].map((f) => readFileSync(join(root, f), 'utf8'));
    const before = files();

    const refused = await pin(root, dir, url, VERSION, '--archive', other);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /опубликованные байты .* отличаются от архива/);
    assert.deepEqual(files(), before);
    assert.equal(existsSync(join(root, 'vendor', 'harness', 'README.md')), false);

    const range = await pin(root, dir, url, '^' + VERSION);
    assert.equal(range.status, 1);
    assert.match(range.stderr, /точную версию/);
    assert.deepEqual(files(), before);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
