import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDemo } from './demo-pool.ts';
import { input } from './helpers.ts';
import { LeadWorkflow, type WorkflowJob } from '../src/core/lead-workflow.ts';
import { DomainError } from '../src/core/model.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Workspace } from '../src/core/workspace.ts';
import { Scheduler } from '../src/runner/scheduler.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Принятая доска демо-workspace и ChangeSet над ней. Совместный gate
 * длится `gateMs` — дольше такта цикла и, в первом тесте, дольше срока
 * владения заданием ведущего (`leaseMs` 5 с).
 */
async function jointFixture(gateMs: number) {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-joint-life-'));
  await testDemo(root);
  // Политика — в файле до загрузки: процесс работает с применённой.
  const file = join(root, 'config.json');
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  raw.leaseMs = 5000;
  raw.workspaceGates = [
    {
      id: 'integration',
      repositoryId: 'main',
      kind: 'test',
      timeoutMs: 120_000,
      command: [
        process.execPath,
        '-e',
        `setTimeout(()=>{const fs=require('fs');fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync('.reports/workspace.xml','<testsuite><testcase name="joint"/></testsuite>')},${gateMs})`,
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
    await rm(root, { recursive: true, force: true });
  };
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const b = h.createBoard('Joint lifetime board', '', 'main');
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
    const change = new Workspace(h).create({
      title: 'Joint result',
      description: 'A joint verification that outlives the loop tick.',
      boardIds: [b.id],
    });
    const job = flow.start({ kind: 'changeset', id: change.id, authorRuntime: 'codex' });
    const verifications = () => store.read().changeSets[0].verifications;
    return { h, store, lead, flow, job, verifications, cleanup };
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
async function tickFor(lead: LeadRunner, ms: number) {
  await Promise.race([lead.tick(), sleep(ms)]);
  await sleep(100);
}

test('Совместная проверка ChangeSet переживает такт и потерю владения заданием ведущего', async () => {
  // Проверка дольше срока владения заданием. Продление владения однажды
  // не удаётся (процесс стоял дольше срока, как при синхронной работе на
  // большом наборе): прежде это прерывало саму проверку до первого gate, и
  // каждая прерванная проверка тратила предел совместных проверок набора.
  const f = await jointFixture(6000);
  try {
    let lost = false;
    const heartbeat = f.lead.workflow.heartbeat.bind(f.lead.workflow);
    f.lead.workflow.heartbeat = (job: WorkflowJob) => {
      if (
        !lost &&
        job.kind === 'changeset' &&
        f.verifications().some((v) => v.status === 'active')
      ) {
        lost = true;
        throw new DomainError('Владение заданием утрачено');
      }
      heartbeat(job);
    };
    const deadline = Date.now() + 90_000;
    while (['queued', 'running'].includes(f.flow.get(f.job.key).status) && Date.now() < deadline) {
      await tickFor(f.lead, 2500);
    }
    const job = f.flow.get(f.job.key);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.deepEqual(
      f.verifications().map((v) => [v.status, v.error ?? null]),
      [['passed', null]],
    );
    const v = f.verifications()[0];
    // Проверка шла дольше такта и срока владения заданием.
    assert.ok(Date.parse(v.finishedAt!) - Date.parse(v.startedAt) > 5000);
    assert.ok(f.store.read().changeSets[0].acceptance);
  } finally {
    await f.cleanup();
  }
});

test('Остановка цикла ведущего (остановка сервера) прерывает идущую совместную проверку', async () => {
  const f = await jointFixture(120_000);
  try {
    const deadline = Date.now() + 60_000;
    while (!f.verifications().some((v) => v.status === 'active') && Date.now() < deadline)
      await tickFor(f.lead, 500);
    assert.ok(
      f.verifications().some((v) => v.status === 'active'),
      JSON.stringify(f.flow.get(f.job.key)),
    );
    // Gate уже идёт: проверка не закончилась бы ещё две минуты.
    await sleep(1500);
    const stopped = Date.now();
    await f.lead.stop();
    assert.ok(Date.now() - stopped < 30_000, 'stop waits for the gate instead of aborting it');
    const [v] = f.verifications();
    assert.equal(v.status, 'failed');
    // Задание не провалено: остановка — прерывание, стадия продолжится после запуска.
    assert.equal(f.flow.get(f.job.key).status, 'queued');
  } finally {
    await f.cleanup();
  }
});
