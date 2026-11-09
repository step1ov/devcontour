import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Preparation } from '../src/core/preparation.ts';
import { Store } from '../src/core/store.ts';
import { preparationStore, startWorkspace } from '../src/runner/start.ts';
import { approveStage, architecture, product } from './preparation-fixture.ts';
import { withTestHome } from './helpers.ts';

const cli = resolve('src/cli.ts');
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Quick Test',
  GIT_AUTHOR_EMAIL: 'quick@example.test',
  GIT_COMMITTER_NAME: 'Quick Test',
  GIT_COMMITTER_EMAIL: 'quick@example.test',
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env }).trim();

function repository(root: string) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'existing-app', private: true, scripts: { test: 'node --test' } }) +
      '\n',
  );
  writeFileSync(join(root, 'package-lock.json'), '{"name":"existing-app","lockfileVersion":3}\n');
  writeFileSync(join(root, 'src/index.js'), 'export const add = (a, b) => a + b;\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'existing project');
}

const journalMode = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  } finally {
    db.close();
  }
};

// Сервер с подключённым движком держит базу открытой в режиме WAL. Команды
// подготовки из CLI не должны переключать режим журнала: выход из WAL требует
// исключительного доступа и при живом сервере кончался «database is locked».
test('agent preparation_* и setup --change --plan работают, пока сервер держит базу', () =>
  withTestHome(async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-prep-lock-')));
    repository(root);
    const data = join(root, '.devcontour-local');
    const app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });
    // Соединение движка работающего сервера.
    const runtime = new Store(join(data, 'state.sqlite'));
    try {
      const response = await fetch(app.url + '/api/preparation/quick', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-devcontour-request': '1' },
        body: JSON.stringify({
          requestKey: 'lock-request-1',
          title: 'Сумма',
          repository: root,
          brief: 'add() складывает отрицательные числа',
          criterion: 'add(-2, -3) возвращает -5',
        }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const store = preparationStore(data);
      let changeId: string;
      try {
        changeId = store.read().preparation!.changes[0].id;
        const p = new Preparation(store);
        p.execute('preparation_product', {
          changeId,
          expectedDigest: null,
          reason: 'Постановка',
          content: product,
        });
        approveStage(p, changeId, 'product');
        p.execute('preparation_architecture', {
          changeId,
          expectedDigest: null,
          reason: 'Стек',
          content: architecture,
        });
        approveStage(p, changeId, 'architecture');
        p.execute('preparation_references', {
          changeId,
          expectedDigest: null,
          reason: 'Без интерфейса',
          content: { applicable: false, reason: 'Без интерфейса', summary: '', questions: [] },
        });
        approveStage(p, changeId, 'references');
      } finally {
        store.close();
      }
      assert.equal(journalMode(join(data, 'state.sqlite')), 'wal');
      const request = join(root, '.devcontour-local', 'request.json');
      writeFileSync(
        request,
        JSON.stringify({
          operation: 'preparation_setup',
          input: {
            changeId,
            expectedDigest: null,
            profile: 'npm-project',
            gates: [{ id: 'install', kind: 'check', command: ['npm', 'ci'], timeoutMs: 600000 }],
            reason: 'Проверки проекта',
          },
        }),
      );
      const started = Date.now();
      const agent = spawnSync(
        process.execPath,
        ['--import', 'tsx', cli, 'agent', '--file', request, '--workspace', root],
        { encoding: 'utf8', env: process.env },
      );
      assert.equal(agent.status, 0, agent.stderr);
      assert.ok(Date.now() - started < 15000, 'команда не ждёт блокировку базы');
      const plan = spawnSync(
        process.execPath,
        ['--import', 'tsx', cli, 'setup', '--change', changeId, '--workspace', root, '--plan'],
        { encoding: 'utf8', env: process.env },
      );
      assert.equal(plan.status, 0, plan.stderr);
      assert.equal((JSON.parse(plan.stdout) as { status: string }).status, 'plan');
      // Запись CLI видна соединению сервера.
      assert.equal(runtime.read().preparation!.changes[0].setup?.length, 1);
      assert.equal(journalMode(join(data, 'state.sqlite')), 'wal');
    } finally {
      runtime.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }));
