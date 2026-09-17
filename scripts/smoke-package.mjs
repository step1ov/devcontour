import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-package-')));
const installation = join(root, 'installation'),
  outside = join(root, 'outside');
let child;
let closed;
let output = '';
try {
  await mkdir(installation);
  await mkdir(outside);
  const { stdout } = await exec(
    'npm',
    [
      'pack',
      '--json',
      '--ignore-scripts',
      '--cache',
      join(root, 'cache'),
      '--pack-destination',
      root,
    ],
    { cwd: source, timeout: 60000 },
  );
  const [archive] = JSON.parse(stdout);
  assert.ok(archive.files.some((f) => f.path === 'lib/cli.js'));
  assert.ok(archive.files.some((f) => f.path === 'dist/index.html'));
  assert.ok(archive.files.some((f) => f.path === 'templates/project/.agents/roles/backend.md'));
  assert.ok(!archive.files.some((f) => /^(src|tests|node_modules|\.harness)\//.test(f.path)));
  await writeFile(join(installation, 'package.json'), '{"private":true}');
  await exec(
    'npm',
    [
      'install',
      '--cache',
      join(root, 'cache'),
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(root, archive.filename),
    ],
    { cwd: installation, timeout: 120000 },
  );
  const installed = join(installation, 'node_modules/devcontour');
  const bin = join(installation, 'node_modules/.bin/devcontour');
  await assert.rejects(access(join(installed, 'src')));
  await assert.rejects(access(join(installation, 'node_modules/tsx')));
  const cli = (...args) => exec(bin, args, { cwd: outside, timeout: 30000 });
  assert.match((await cli('help')).stdout, /DevContour/);
  await assert.rejects(cli('serve'), /workspace/);
  await assert.rejects(cli('serve', '--workspace', installed), /вне каталога/);

  const product = join(root, 'product'),
    workspace = join(root, 'workspace');
  await mkdir(join(product, 'docs'), { recursive: true });
  await writeFile(
    join(product, 'docs/spec.md'),
    '# API\nCreate a product with tested requirements.',
  );
  const setup = JSON.parse(
    (await cli('setup', '--repository', product, '--workspace', workspace, '--profile', 'go-api'))
      .stdout,
  );
  assert.equal(setup.status, 'needs-agent-bootstrap');
  await access(join(product, '.agents/roles/backend.md'));
  await access(join(product, 'docs/harness-start.md'));
  const request = join(root, 'request.json');
  await writeFile(request, JSON.stringify({ operation: 'project_context', input: {} }));
  const context = JSON.parse(
    (await cli('agent', '--workspace', workspace, '--file', request)).stdout,
  );
  assert.equal(resolve(context.workspace), resolve(workspace));
  assert.equal(context.approvalMode, 'agent');
  const catalog = JSON.parse((await cli('capabilities')).stdout);
  const skill = (await cli('skill-path')).stdout.trim();
  assert.deepEqual(
    JSON.parse(await readFile(join(skill, 'references/agent-api.json'), 'utf8')),
    catalog,
  );
  await access(join(skill, 'SKILL.md'));
  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: bin,
        args: ['mcp', '--workspace', workspace],
        cwd: outside,
        stderr: 'pipe',
      }),
    );
    assert.equal((await client.listTools()).tools.length, catalog.tools.length);
    const reply = await client.callTool({ name: 'project_context', arguments: {} });
    assert.equal(reply.structuredContent.workspace, context.workspace);
    const board = await client.callTool({
      name: 'board_create',
      arguments: { title: 'Packaged MCP board', repositoryId: 'main' },
    });
    assert.ok(board.structuredContent.boardId);
  } finally {
    await client.close();
  }

  child = spawn(bin, ['demo', '--data', join(root, 'demo'), '--port', '0'], {
    cwd: outside,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Package fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Package fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise((done) => child.once('close', done));
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  let url;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && child.exitCode === null) {
    url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) break;
    await delay(100);
  }
  assert.ok(url, 'Installed server did not start: ' + output);
  const index = await fetch(url).then((r) => {
    assert.equal(r.status, 200);
    return r.text();
  });
  const asset = index.match(/src="(\/assets\/[^\"]+)"/)[1];
  assert.equal((await fetch(url + asset)).status, 200);
  const state = await fetch(url + '/api/state').then((r) => r.json());
  assert.ok(
    state.tasks.some((t) => t.status === 'done' && t.resultSha),
    'Packaged Git pipeline must complete fixture work',
  );
  const response = await fetch(url + '/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Harness-Request': '1' },
    body: JSON.stringify({ operation: 'project_context', input: {} }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).protocolVersion, 1);
  console.log(
    JSON.stringify(
      {
        package: archive.filename,
        size: archive.size,
        checks: [
          'isolated production install',
          'no source or tsx',
          'explicit workspace',
          'installed profiles and templates',
          'CLI context',
          'packaged static assets',
          'real Git fixture pipeline',
          'HTTP agent API',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await closed;
    clearTimeout(timer);
  }
  await rm(root, { recursive: true, force: true });
}
