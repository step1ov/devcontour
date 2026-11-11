import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { demoPool, testDemo } from './demo-pool.ts';
import { input } from './helpers.ts';
import { LeadWorkflow, type WorkflowJob } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Workspace } from '../src/core/workspace.ts';
import { Scheduler } from '../src/runner/scheduler.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Пул demo-workspace; файл теста закрывает его в `after`. */
export const jointDemos = demoPool(testDemo);

/**
 * Принятая доска демо-workspace и задание ChangeSet над ней (не начатое,
 * если `start: false`). Совместный gate длится `gateMs` и проходит, а с
 * `fail` — завершается с кодом 1 после `gateMs`. Срок владения — 5 с.
 */
export async function jointFixture(options: {
  gateMs: number;
  fail?: boolean;
  maxAttempts?: number;
  start?: boolean;
}) {
  const seed = await jointDemos.acquire();
  const root = seed.root;
  // Политика — в файле до загрузки: процесс работает с применённой.
  const file = join(root, 'config.json');
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  raw.leaseMs = 5000;
  if (options.maxAttempts) raw.maxAttempts = options.maxAttempts;
  raw.workspaceGates = [
    {
      id: 'integration',
      repositoryId: 'main',
      kind: 'test',
      timeoutMs: 120_000,
      command: [
        process.execPath,
        '-e',
        `setTimeout(()=>{const fs=require('fs');fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync('.reports/workspace.xml','<testsuite><testcase name="joint"/></testsuite>');process.exit(${options.fail ? 1 : 0})},${options.gateMs})`,
      ],
      report: { type: 'junit', path: '.reports/workspace.xml' },
      artifacts: [],
    },
  ];
  await writeFile(file, JSON.stringify(raw, null, 2));
  const config = loadConfig(file);
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const lead = new LeadRunner(h, root);
  const scheduler = new Scheduler(h, root);
  const flow = new LeadWorkflow(h);
  const cleanup = async () => {
    await lead.stop();
    await scheduler.stop();
    store.close();
    seed.release();
  };
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const b = h.createBoard('Joint board', '', 'main');
    h.addTask(b.id, input());
    const boardJob = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    await scheduler.init();
    const deadline = Date.now() + 60_000;
    while (flow.get(boardJob.key, 'main').status !== 'completed' && Date.now() < deadline) {
      await lead.tick();
      await scheduler.drain();
    }
    assert.equal(
      flow.get(boardJob.key, 'main').status,
      'completed',
      JSON.stringify(flow.get(boardJob.key, 'main')),
    );
    const workspace = new Workspace(h);
    const change = workspace.create({
      title: 'Joint result',
      description: 'A joint verification of the accepted board.',
      boardIds: [b.id],
    });
    const job: WorkflowJob | undefined =
      options.start === false
        ? undefined
        : flow.start({ kind: 'changeset', id: change.id, authorRuntime: 'codex' });
    const verifications = (id = change.id) =>
      store.read().changeSets.find((c) => c.id === id)!.verifications;
    return {
      root,
      config,
      h,
      store,
      lead,
      flow,
      job: job!,
      board: b,
      change,
      workspace,
      verifications,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Такт цикла, не дожидаясь стадии дольше `ms`: стадия может ждать проверку.
 * Затем пауза: такт без ожидания завершается микрозадачами, и цикл теста
 * без неё не отдавал бы управление таймерам (сервер ведёт такты интервалом).
 */
export async function tickFor(lead: LeadRunner, ms: number) {
  await Promise.race([lead.tick(), sleep(ms)]);
  await sleep(100);
}
