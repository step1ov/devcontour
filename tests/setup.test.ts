import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupProject } from '../src/runner/setup.ts';
import { loadConfig } from '../src/runner/config.ts';
import { command, git } from '../src/runner/process.ts';

async function product() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-setup-')));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs/spec.md'), '# Каталог\nПоиск товаров в настоящей базе.');
  return root;
}

test('Setup starts from only a Markdown spec, copies hidden roles and pins an agent-mode config', async () => {
  const root = await product();
  try {
    const result = await setupProject({ repository: root, profile: 'react-vite-admin' });
    assert.equal(result.status, 'needs-agent-bootstrap');
    assert.equal(result.approvalMode, 'agent');
    assert.equal(result.data, join(root, '.harness/local'));
    assert.match(
      await readFile(join(root, '.agents/roles/backend.md'), 'utf8'),
      /backend|API|бэкенд/i,
    );
    await access(join(root, 'docs/harness-start.md'));
    await access(join(root, 'docs/harness-project-memory.md'));
    await access(join(root, 'docs/harness-experiments.md'));
    assert.match(
      await readFile(join(root, 'docs/harness-start.md'), 'utf8'),
      /\(harness-project-memory.md\)/,
    );
    await access(join(root, 'docs/harness-workspaces.md'));
    await access(join(root, 'docs/harness-engineering.md'));
    await access(join(root, '.agents/context/mobile-maestro.md'));
    await access(join(root, 'CLAUDE.md'));
    assert.match(
      await readFile(join(root, 'docs/harness-start.md'), 'utf8'),
      /\(harness-engineering.md\)/,
    );
    assert.match(
      await readFile(join(root, 'docs/harness-start.md'), 'utf8'),
      /\(harness-workspaces.md\)/,
    );
    await access(join(result.data, 'profiles/react-vite-admin.json'));
    const config = loadConfig(join(result.data, 'config.json'));
    assert.equal(config.repository, root);
    assert.equal(config.approvalMode, 'agent');
    assert.ok(config.gates.some((g) => g.report?.type === 'junit'));
    assert.ok(config.contextPacks.some((p) => p.id === 'backend' && p.roles.includes('backend')));
    assert.ok(config.contextPacks.every((p) => !p.revision && !p.digest));
    await assert.rejects(access(join(root, '.git')));
    await assert.rejects(access(join(result.data, 'state.sqlite')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Setup preserves existing files and explicit operator mode across repeated preparation', async () => {
  const root = await product();
  try {
    await writeFile(join(root, 'AGENTS.md'), 'Existing team rules');
    await writeFile(join(root, '.gitignore'), 'existing-ignore\n');
    const first = await setupProject({
      repository: root,
      profile: 'go-api',
      approvalMode: 'operator',
    });
    const configFile = join(first.data, 'config.json');
    const config = loadConfig(configFile);
    config.concurrency = 1;
    await writeFile(configFile, JSON.stringify(config));
    const before = await readFile(configFile, 'utf8');
    const repeated = await setupProject({ repository: root, profile: 'go-api' });
    assert.equal(repeated.approvalMode, 'operator');
    assert.equal(repeated.created.length, 0);
    assert.equal(await readFile(configFile, 'utf8'), before);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Existing team rules');
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), 'existing-ignore\n');
    await assert.rejects(
      setupProject({ repository: root, profile: 'go-api', approvalMode: 'agent' }),
      /режим/,
    );
    await assert.rejects(setupProject({ repository: root, profile: 'next-product' }), /профилю/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Setup rejects escaping symlinks and invalid specs before copying any rules', async () => {
  const root = await product();
  const outside = await product();
  try {
    await symlink(outside, join(root, 'contracts'));
    await assert.rejects(setupProject({ repository: root, profile: 'go-api' }), /symlink/);
    await assert.rejects(access(join(root, 'AGENTS.md')));
    await assert.rejects(access(join(outside, 'README.md')));
    await rm(join(root, 'contracts'));
    await assert.rejects(
      setupProject({ repository: root, profile: 'go-api', brief: join(outside, 'docs/spec.md') }),
      /внутри docs/,
    );
    await writeFile(join(root, 'docs/spec.md'), '  \n');
    await assert.rejects(setupProject({ repository: root, profile: 'go-api' }), /пустое/);
    await assert.rejects(access(join(root, '.harness')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Setup refuses an accidental child of another real Git repository', async () => {
  const root = await product();
  try {
    await git(root, 'init', '-b', 'main');
    const child = join(root, 'child');
    await mkdir(join(child, 'docs'), { recursive: true });
    await writeFile(join(child, 'docs/spec.md'), '# Nested product');
    await assert.rejects(setupProject({ repository: child, profile: 'go-api' }), /другого Git/);
    await assert.rejects(access(join(child, 'AGENTS.md')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI setup supports explicit legacy data without bootstrapping a demo', async () => {
  const root = await product();
  try {
    const result = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'setup',
        '--repository',
        root,
        '--profile',
        'mobile-maestro',
        '--data',
        join(root, '.harness/local'),
        '--approval-mode',
        'operator',
      ],
      resolve('.'),
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.data, join(root, '.harness/local'));
    assert.equal(output.approvalMode, 'operator');
    assert.equal(loadConfig(join(output.data, 'config.json')).concurrency, 1);
    await assert.rejects(access(join(root, '.harness/demo')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
