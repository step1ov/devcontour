import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCheck } from 'devcontour-harness';
import { installProbe } from '../src/runner/install-probe.ts';
import { isolationSupport } from '../src/runner/isolation.ts';

const os = { isolation: { mode: 'os' as const, domains: [] } };
const support = isolationSupport();
// Ограничение записано явно: без песочницы ОС проверять здесь нечего.
const noSandbox = support.ok ? false : 'OS sandbox unavailable: ' + support.detail;
const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), 'dc-install-probe-')));

/** Независимый ответ: пишет ли песочница проверок в каталог IDE внутри node_modules. */
async function sandboxWritesIdeInDependencies() {
  const dir = workspace();
  const target = join(dir, 'node_modules', 'pkg', '.idea', 'x.xml');
  const r = await runCheck(
    { config: os },
    {
      argv: [
        process.execPath,
        '-e',
        `const fs=require('fs');fs.mkdirSync(${JSON.stringify(dirname(target))},{recursive:true});fs.writeFileSync(${JSON.stringify(target)},'x')`,
      ],
      cwd: dir,
      env: { PATH: process.env.PATH },
      signal: AbortSignal.timeout(60000),
      write: [dir],
      readable: [],
      controller: [],
      settingsDir: workspace(),
    },
  );
  return r.code === 0 && existsSync(target);
}

test(
  'doctor install probe agrees with the real sandbox about IDE directories inside node_modules',
  {
    skip: noSandbox,
  },
  async () => {
    const root = workspace();
    const result = await installProbe(os, root);
    const expected = await sandboxWritesIdeInDependencies();
    assert.equal(result.status, expected ? 'passed' : 'blocked', result.detail);
    if (!expected) {
      assert.match(result.detail, /\.idea/);
      assert.match(result.detail, /EPERM|TAR_ENTRY_ERROR|Operation not permitted/i);
    }
    assert.equal(existsSync(join(root, 'doctor')), false, 'the probe removes doctor/ it created');
  },
);

/** Подменённый runCheck: исход задаётся тестом, установка не запускается. */
function fake(outcome: { code: number; stderr?: string; install?: boolean }) {
  const calls: Parameters<typeof runCheck>[1][] = [];
  const run = (async (_h, options) => {
    calls.push(options);
    if (outcome.install) {
      const file = join(
        options.cwd,
        'node_modules/devcontour-probe-dep/.idea/codeStyles/codeStyleConfig.xml',
      );
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '<probe/>');
    }
    return {
      code: outcome.code,
      stdout: '',
      stderr: outcome.stderr ?? '',
      timedOut: false,
      attempts: 1,
      started: true,
    };
  }) as typeof runCheck;
  return { run, calls };
}

test('install probe passes only when the dependency file landed; npm warnings with exit 0 are blocked', async () => {
  const ok = fake({ code: 0, install: true });
  const passed = await installProbe(os, workspace(), ok.run);
  assert.equal(passed.status, 'passed', passed.detail);
  const call = ok.calls[0];
  assert.match(call.argv.join(' '), /npm install --offline --ignore-scripts/);
  assert.equal(existsSync(call.cwd), false, 'probe directory is removed after the run');
  assert.equal(call.write.length, 2, 'install writes into the tree and a cache outside it');

  const warned = fake({
    code: 0,
    stderr:
      "npm warn tar TAR_ENTRY_ERROR EPERM: operation not permitted, open '/w/app/node_modules/devcontour-probe-dep/.idea/codeStyles/codeStyleConfig.xml'",
  });
  const blocked = await installProbe(os, workspace(), warned.run);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.detail, /код 0, но файла/);
  assert.match(blocked.detail, /TAR_ENTRY_ERROR EPERM/);

  const failed = await installProbe(
    os,
    workspace(),
    fake({ code: 1, stderr: "EPERM: operation not permitted, mkdir '/w/app/node_modules/x/.idea'" })
      .run,
  );
  assert.equal(failed.status, 'blocked');
  assert.match(failed.detail, /код 1/);
});

test('install probe is not run without OS isolation', async () => {
  const { run, calls } = fake({ code: 0, install: true });
  const r = await installProbe({ isolation: { mode: 'none', domains: [] } }, workspace(), run);
  assert.equal(r.status, 'not-checked');
  assert.equal(calls.length, 0);
});

test('fixture package really carries an .idea directory', async () => {
  // Пакет-фикстура, который ставит проба, содержит каталог IDE: иначе проба
  // проходила бы и там, где запрет песочницы ломает установку.
  let seen = '';
  const run = (async (_h, options) => {
    const { execFileSync } = await import('node:child_process');
    seen = execFileSync('tar', ['tzf', join(options.cwd, 'dep.tgz')], { encoding: 'utf8' });
    return { code: 1, stdout: '', stderr: '', timedOut: false, attempts: 1, started: true };
  }) as typeof runCheck;
  await installProbe(os, workspace(), run);
  assert.match(seen, /package\/\.idea\/codeStyles\/codeStyleConfig\.xml/);
  assert.doesNotMatch(seen, /\._/, 'no AppleDouble entries');
});

test('install probe keeps a doctor/ directory that existed before it', async () => {
  const root = workspace();
  await mkdir(join(root, 'doctor'));
  await writeFile(join(root, 'doctor', 'keep.txt'), 'x');
  await installProbe(os, root, fake({ code: 0, install: true }).run);
  assert.deepEqual(readdirSync(join(root, 'doctor')), ['keep.txt']);
});
