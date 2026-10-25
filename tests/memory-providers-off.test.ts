// AC20: у DevContour собственная память и подготовка; внешние провайдеры
// памяти (Relay, Hindsight) не подключены и не нужны. Setup, память, контекст и
// checkpoint работают без них: ни сетевых соединений, ни вызовов их CLI, ни
// чтения их credentials; записи остаются в прежнем host-хранилище.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/runner/process.ts';
import { setupProject } from '../src/runner/setup.ts';
import { ProjectMemory } from '../src/application/memory.ts';
import { AgentContext } from '../src/application/context.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { config } from './helpers.ts';

async function walk(dir: string, out: string[] = [], root = dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.name === '.git') continue;
    out.push(p.slice(root.length + 1) + (e.isDirectory() ? '/' : ''));
    if (e.isDirectory()) await walk(p, out, root);
  }
  return out;
}

test('AC20: setup, память, контекст и checkpoint без Relay/Hindsight — ни сети, ни их CLI, записи в host-хранилище', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-memory-off-'));
  const trap = join(root, 'bin');
  const marker = join(root, 'provider-called');
  const env = { ...process.env };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- восстанавливается в finally
  const connect = net.Socket.prototype.connect;
  const fetchBefore = globalThis.fetch;
  const attempts: string[] = [];
  try {
    // Ловушки: CLI провайдеров в PATH, их credentials в окружении, сеть.
    await mkdir(trap);
    for (const name of ['relay', 'hindsight', 'relay-v2']) {
      await writeFile(join(trap, name), `#!/bin/sh\necho ${name} >> "${marker}"\n`);
      await chmod(join(trap, name), 0o755);
    }
    process.env.PATH = trap + ':' + (process.env.PATH ?? '');
    process.env.RELAY_API_KEY = 'trap-relay-secret';
    process.env.HINDSIGHT_API_KEY = 'trap-hindsight-secret';
    process.env.RELAY_URL = 'http://127.0.0.1:9/relay';
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      attempts.push(JSON.stringify(args[0] ?? null).slice(0, 200));
      return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
    };
    globalThis.fetch = (input: unknown) => {
      attempts.push('fetch ' + String(input));
      return Promise.reject(new Error('network is not allowed in this test'));
    };

    const repo = join(root, 'shop');
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs/spec.md'), '# Каталог\nПоиск товаров.\n');
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Fixture');
    await git(repo, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(repo, 'rules.md'), 'Pagination uses a cursor.\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'Initial');
    const setup = await setupProject({ repository: repo, profile: 'go-api' });
    assert.equal(setup.status, 'needs-agent-bootstrap');

    const store = new Store(join(root, 'state.sqlite'));
    try {
      const h = new DevContour(store, config({ repository: repo }));
      const memory = new ProjectMemory(h);
      const fact = memory.retain({
        repositoryId: 'main',
        kind: 'decision',
        subject: 'chat.pagination',
        text: 'Pagination uses a cursor.',
        sources: ['rules.md'],
      });
      const recalled = memory.recall({ repositoryId: 'main', query: 'cursor' }) as {
        items?: { id: string }[];
      };
      assert.ok(JSON.stringify(recalled).includes(fact.id));
      const context = new AgentContext(h);
      context.execute('project_context', {});
      const overview = context.execute('project_overview', { repositoryId: 'main' }) as {
        revision: string;
      };
      context.execute('checkpoint_save', {
        repositoryId: 'main',
        expectedRevision: overview.revision,
        summary: 'Cursor decision',
        nextStep: 'Use cursor pagination',
      });
    } finally {
      store.close();
    }

    assert.equal(existsSync(marker), false, 'CLI провайдеров не вызывались');
    assert.deepEqual(attempts, [], 'сетевых соединений не было');
    // Записи памяти и checkpoints — в прежнем host-хранилище компонента.
    const files = await walk(repo);
    assert.ok(
      files.some((f) => f.startsWith('.devcontour/') && f.endsWith('.json')),
      files.join('\n'),
    );
    assert.equal(
      files.some((f) => /^\.harness\/|relay|hindsight|notes\//i.test(f)),
      false,
      'нет второго хранилища знаний',
    );
    const secrets = files
      .filter((f) => !f.endsWith('/'))
      .map((f) => readFileSync(join(repo, f), 'utf8'))
      .join('\n');
    assert.equal(
      secrets.includes('trap-relay-secret') || secrets.includes('trap-hindsight-secret'),
      false,
    );
  } finally {
    net.Socket.prototype.connect = connect;
    globalThis.fetch = fetchBefore;
    process.env = env;
    await rm(root, { recursive: true, force: true });
  }
});

test('AC20: исходники DevContour не подключают интеграции памяти harness', () => {
  const offending: string[] = [];
  const scan = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) scan(p);
      else if (/\.(ts|tsx)$/.test(name.name)) {
        const text = readFileSync(p, 'utf8');
        if (/devcontour-harness\/integrations|relay|hindsight/i.test(text)) offending.push(p);
      }
    }
  };
  scan('src');
  assert.deepEqual(offending, []);
});
