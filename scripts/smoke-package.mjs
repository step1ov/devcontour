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
  await access(join(product, 'docs/harness-project-memory.md'));
  await access(join(product, 'docs/harness-experiments.md'));
  await access(join(product, 'docs/harness-intent.md'));
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
  const agent = async (operation, input) => {
    const reply = await fetch(url + '/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Harness-Request': '1' },
      body: JSON.stringify({ operation, input }),
    });
    const value = await reply.json();
    assert.equal(reply.status, 200, JSON.stringify(value));
    return value;
  };
  const board = await agent('board_create', {
    title: 'Installed durable workflow',
    repositoryId: 'main',
  });
  const task = await agent('task_create', {
    boardId: board.boardId,
    task: {
      title: 'Verify installed workflow',
      description: 'Produce and verify a real isolated Git deliverable.',
      role: 'qa',
      acceptance: ['The deliverable passes the configured test.'],
    },
  });
  const job = await agent('workflow_start', {
    kind: 'board',
    id: board.boardId,
    authorRuntime: 'codex',
  });
  assert.equal(
    (await agent('workflow_start', { kind: 'board', id: board.boardId, authorRuntime: 'codex' }))
      .key,
    job.key,
  );
  let completed = false;
  for (let count = 0; count < 450; count++) {
    const report = await agent('workflow_status', { repositoryId: 'main' });
    assert.ok(report.jobs.every((j) => !('token' in j)));
    const current = report.jobs.find((j) => j.key === job.key);
    if (current.status === 'failed' || current.status === 'stale')
      assert.fail(JSON.stringify(current));
    if (current.status === 'completed') {
      completed = true;
      break;
    }
    await delay(100);
  }
  assert.ok(completed, 'Installed server must advance a durable workflow without an active chat');
  const metrics = await agent('workflow_metrics', { repositoryId: 'main' });
  assert.ok((await agent('usage_report', { repositoryId: 'main' })).records.length);
  assert.ok((await agent('decision_report', { repositoryId: 'main' })).records.length);
  assert.equal(
    (await agent('strategy_replay', { repositoryId: 'main', policy: 'fifo-ready-v1' })).unsupported,
    0,
  );
  const knowledge = await agent('memory_retain', {
    repositoryId: 'main',
    kind: 'fact',
    subject: 'smoke',
    text: 'Package memory smoke',
    sources: ['README.md'],
  });
  const recall = await agent('memory_recall', { repositoryId: 'main', query: 'smoke' });
  assert.ok(recall.records.some((r) => r.record.id === knowledge.id));
  const intentRepo = join(root, 'demo', 'repository');
  await writeFile(
    join(intentRepo, 'intent-spec.md'),
    '## REQ-smoke: Package intent\nVerify complete release coverage.\n',
  );
  await exec('git', ['add', 'intent-spec.md'], { cwd: intentRepo });
  await exec('git', ['commit', '-m', 'Package intent fixture'], { cwd: intentRepo });
  const intent = await agent('intent_render', {
    repositoryId: 'main',
    definition: {
      kind: 'component',
      title: 'Installed product intent',
      purpose: 'Verify installed intent API behaviour.',
      audience: ['Product operators'],
      sources: ['intent-spec.md'],
      releases: [{ id: 'mvp', title: 'First release' }],
      stories: [
        {
          id: 'smoke',
          title: 'Operator sees completion',
          releaseId: 'mvp',
          criteria: [
            {
              id: 'ac-smoke',
              text: 'Missing work remains visible.',
              requirements: [{ source: 'intent-spec.md', id: 'REQ-smoke' }],
            },
          ],
        },
      ],
    },
  });
  await writeFile(join(intentRepo, 'INTENT.md'), intent.markdown);
  await exec('git', ['add', 'INTENT.md'], { cwd: intentRepo });
  await exec('git', ['commit', '-m', 'Pin package intent'], { cwd: intentRepo });
  assert.equal(
    (await agent('intent_snapshot', { repositoryId: 'main', storyId: 'smoke' })).stories[0]
      .requirement.id,
    'REQ-intent-smoke',
  );
  const coverage = await agent('intent_report', { repositoryId: 'main', releaseId: 'mvp' });
  assert.equal(coverage.coverageComplete, false);
  assert.deepEqual(coverage.stories[0].taskIds, []);
  await assert.rejects(
    cli(
      'intent-report',
      '--repository-id',
      'main',
      '--release',
      'mvp',
      '--require-complete',
      '--data',
      join(root, 'demo'),
    ),
    (error) => {
      assert.equal(JSON.parse(error.stdout).coverageComplete, false);
      return error.code === 1;
    },
  );
  assert.ok(
    metrics.attempts.some(
      (r) => r.taskId === task.taskId && r.status === 'succeeded' && r.stages.length,
    ),
  );
  const signal = {
    source: 'ci-fixture',
    eventId: 'failed-1',
    incidentId: 'regression-1',
    repositoryId: 'main',
    observedAt: new Date().toISOString(),
    state: 'open',
    title: 'Inspect CI regression',
    summary: 'A normalized external CI observation needs reproduction.',
    evidenceUrl: 'https://ci.example.invalid/job/1',
  };
  const first = await agent('signal_ingest', signal),
    duplicate = await agent('signal_ingest', signal);
  assert.equal(first.taskIds[0], duplicate.taskIds[0]);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await agent('task_briefing', { taskId: first.taskIds[0] })).task.status, 'draft');
  assert.equal(JSON.parse((await cli('evals')).stdout).passed, true);
  const engineering = JSON.parse((await cli('engineering-evals')).stdout);
  assert.equal(engineering.passed, true);
  const evaluationPath = join(root, 'engineering.json');
  await writeFile(evaluationPath, JSON.stringify(engineering));
  assert.equal(
    JSON.parse(
      (await cli('eval-compare', '--baseline', evaluationPath, '--candidate', evaluationPath))
        .stdout,
    ).passRateDelta,
    0,
  );

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
          'MCP negotiation and draft mutation',
          'portable skill schema parity',
          'packaged static assets',
          'real Git fixture pipeline',
          'HTTP agent API',
          'durable workflow through real Git acceptance',
          'workflow metrics and private lease tokens',
          'deduplicated external signal stays draft',
          'installed protocol evals',
          'installed intent render, snapshot and missing-work report',
          'CLI coverage gate rejects an undecomposed release',
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
