import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { pinArtifacts } from '../src/runner/contract-artifacts.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';

test('A run uses the pinned artifact revision from its base, and a candidate cannot edit it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-artifacts-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  let edit = false;
  // Исполнитель demo, который по флагу ещё и правит нормативный артефакт.
  const runtimes = {
    ...adapters,
    demo: {
      name: 'demo' as const,
      async execute(r: AgentRequest) {
        if (!r.review && edit) await writeFile(join(r.cwd, 'schema.json'), '{"price":"any"}\n');
        return adapters.demo.execute(r);
      },
    },
  };
  const scheduler = new Scheduler(h, root, runtimes);
  const commit = async (message: string) => {
    await git(config.repository, 'add', '.');
    await git(
      config.repository,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e',
      'commit',
      '-qm',
      message,
    );
  };
  const task = (title: string, contract: string) => {
    const board = h.createBoard(title);
    const t = h.addTask(board.id, {
      title,
      description: 'Реализовать по контракту со схемой.',
      role: 'backend',
      contracts: [contract],
      acceptance: ['Ответ соответствует схеме.'],
    });
    h.approve(board.id);
    return t;
  };
  try {
    await scheduler.init();
    for (const t of store.read().tasks) if (t.status !== 'done') h.cancel(t.id);
    // Схема закреплена контрактом и перенесена в базу; затем её изменили и
    // тоже перенесли — без нового ревью. База не отстаёт, но договор другой.
    await writeFile(join(config.repository, 'schema.json'), '{"price":"number"}\n');
    await commit('schema');
    const pinned = await pinArtifacts({ id: 'main', path: config.repository }, [
      { path: 'schema.json', purpose: 'Схема ответа' },
    ]);
    const contract = h.contract(
      'Catalog',
      'Ответ по schema.json.',
      undefined,
      undefined,
      undefined,
      pinned.artifacts,
    );
    await writeFile(join(config.repository, 'schema.json'), '{"price":"string"}\n');
    await commit('schema changed without review');
    await updateBase(config, root);
    const stale = task('Stale base', contract.id);
    h.pause(false);
    await scheduler.drain();
    const blocked = store.read().runs.filter((r) => r.taskId === stale.id);
    assert.ok(blocked.length > 0);
    assert.ok(
      blocked.every((r) => /не содержит закреплённых.*schema\.json/.test(r.error ?? '')),
      JSON.stringify(blocked.map((r) => r.error)),
    );
    h.cancel(stale.id);

    // Правку откатили к закреплённой редакции — исполнитель, правящий
    // артефакт, нарушает границу задачи, а не меняет договор.
    await writeFile(join(config.repository, 'schema.json'), '{"price":"number"}\n');
    await commit('schema restored');
    await updateBase(config, root);
    edit = true;
    const guarded = task('Edits schema', contract.id);
    h.pause(false);
    await scheduler.drain();
    const runs = store.read().runs.filter((r) => r.taskId === guarded.id);
    assert.ok(
      runs.some((r) => /защищённые файлы: schema\.json/.test(r.error ?? '')),
      JSON.stringify(runs.map((r) => r.error)),
    );
    assert.notEqual(store.read().tasks.find((t) => t.id === guarded.id)?.status, 'done');
    h.cancel(guarded.id);

    // Без правки артефакта задача проходит на закреплённой редакции.
    edit = false;
    const honest = task('Honest', contract.id);
    h.pause(false);
    await scheduler.drain();
    assert.equal(store.read().tasks.find((t) => t.id === honest.id)?.status, 'done');
  } finally {
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
