import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const platform = { darwin: 'macos', linux: 'linux' }[process.platform];
if (!platform) throw new Error('Probe supports macOS/Linux; no sandbox fallback is permitted');
const root = await mkdtemp(join(tmpdir(), 'devcontour-review-sandbox-'));
const run = (argv, cwd = root) =>
  spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
const git = (...args) => {
  const result = run(['git', ...args]);
  if (result.status !== 0) throw new Error(result.stderr || 'git failed');
  return result.stdout.trim();
};
try {
  git('init', '-b', 'main');
  await writeFile(join(root, 'source.txt'), 'immutable\n');
  git('add', 'source.txt');
  git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'fixture');
  const worktree = join(root, 'review');
  git('worktree', 'add', '--detach', worktree, 'HEAD');
  const check = `
    const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
    assert.equal(fs.readFileSync('source.txt','utf8'), 'immutable\\n');
    assert.equal(cp.spawnSync('git',['log','-1','--oneline']).status,0);
    console.log('READ_AND_TEST_PASS');
    assert.throws(()=>fs.writeFileSync('source.txt','changed'), e=>['EPERM','EACCES','EROFS'].includes(e.code));
    assert.notEqual(cp.spawnSync('git',['update-ref','refs/heads/probe','HEAD']).status,0);
    console.log('WRITE_AND_REF_DENIED');
  `;
  const result = run(
    [
      'codex',
      'sandbox',
      platform,
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'approval_policy="never"',
      '--',
      process.execPath,
      '-e',
      check,
    ],
    worktree,
  );
  const passed =
    result.status === 0 &&
    result.stdout.includes('READ_AND_TEST_PASS') &&
    result.stdout.includes('WRITE_AND_REF_DENIED');
  console.log(
    JSON.stringify(
      {
        status: passed ? 'PASS' : 'FAIL_OR_ENVIRONMENT_BLOCKED',
        exitCode: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
        liveModels: false,
      },
      null,
      2,
    ),
  );
  process.exitCode = passed ? 0 : 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
