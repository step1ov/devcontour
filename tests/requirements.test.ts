import { test } from 'node:test';
import { testDemo } from './demo-pool.ts';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/runner/config.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import {
  parseRequirements,
  requirementSnapshot,
  requirementReport,
  requirementReportPage,
  correctRequirements,
  type RequirementReportRow,
} from '../src/runner/requirements.ts';
import { config, input, removeTestCheckoutRoot, testCheckoutRoot } from './helpers.ts';
import { AgentService } from '../src/application/agent.ts';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';

test('Requirement parser ignores examples, rejects duplicate IDs and bounds sections', () => {
  assert.equal(
    parseRequirements(
      '```md\n## REQ-fake: example\n```\n## REQ-real: Real\nExpected behaviour\n## Notes\nNot requirement',
    )[0].id,
    'REQ-real',
  );
  assert.throws(() => parseRequirements('## REQ-a: One\n## REQ-a: Two'), /Повтор/);
  assert.throws(() => parseRequirements('## REQ-a: One\n' + 'x'.repeat(12000)), /Разбейте/);
});

test('Requirements survive real Git execution; changed spec loses current coverage and creates immutable correction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-requirements-'));
  await testDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config),
    scheduler = new Scheduler(h, root);
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    await mkdir(join(config.repository, 'docs'), { recursive: true });
    await writeFile(
      join(config.repository, 'docs/spec.md'),
      '## REQ-catalog: Catalogue\nList the catalogue.\n',
    );
    await git(config.repository, 'add', 'docs/spec.md');
    await git(config.repository, 'commit', '-m', 'Specify catalogue');
    await git(config.repository, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
    const snapshot = requirementSnapshot(config.repository, 'docs/spec.md');
    const requirement = {
      ...snapshot.requirements[0],
      source: snapshot.source,
      gate: config.gates[0].id,
      scenario: 'Catalogue listing',
    };
    const board = h.createBoard('Traceable catalogue');
    const task = h.addTask(board.id, { ...input(), requirements: [requirement] });
    assert.throws(
      () =>
        h.addTask(board.id, { ...input(), requirements: [{ ...requirement, gate: 'missing' }] }),
      /test gate/,
    );
    assert.throws(
      () =>
        h.addTask(board.id, {
          ...input(),
          requirements: [{ ...requirement, text: 'Forged requirement' }],
        }),
      /digest/,
    );
    // Отменённая задача с тем же требованием — не корень корректировки.
    const dropped = h.addTask(board.id, { ...input('Dropped'), requirements: [requirement] });
    h.approve(board.id);
    h.cancel(dropped.id, 'Решено в другой задаче');
    await scheduler.init();
    // Требование только что закоммичено в рабочую ветку: база прогонов должна
    // его содержать, иначе исполнитель ищет источник в дереве без него.
    await updateBase(config, root);
    h.pause(false);
    await scheduler.drain();
    const done = store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(done.status, 'done', done.failure);
    assert.ok(
      store
        .read()
        .runs[0].timings?.some((t) => t.stage === 'implementation' && t.outcome === 'passed'),
    );
    assert.ok(
      store
        .read()
        .runs[0].timings?.some((t) => t.stage.startsWith('integration-test:') && t.finishedAt),
    );
    assert.equal(requirementReport(h, 'main').tasks[0].requirements[0].verified, true);
    assert.equal(
      store.read().runs[0].evidence.filter((e) => e.gate === 'requirement-source').length,
      2,
    );
    await acceptBoard(h, board.id, 'codex');
    const original = store.read().boards[0].revisions[0].snapshot!.digest;
    await writeFile(
      join(config.repository, 'docs/spec.md'),
      '## REQ-catalog: Catalogue\nList and filter the catalogue.\n',
    );
    await git(config.repository, 'add', 'docs/spec.md');
    await git(config.repository, 'commit', '-m', 'Change requirement');
    assert.equal(requirementReport(h, 'main').tasks[0].requirements[0].verified, false);
    correctRequirements(h, board.id, 'Add filtering to catalogue requirement');
    const state = store.read(),
      replacement = state.tasks.find((t) => t.supersedes === task.id)!;
    assert.equal(state.boards[0].revisions[0].snapshot!.digest, original);
    assert.equal(replacement.status, 'draft');
    assert.equal(
      state.tasks.find((t) => t.supersedes === dropped.id),
      undefined,
      'отменённая задача не корректируется',
    );
    assert.notEqual(replacement.requirements![0].digest, requirement.digest);
    assert.notEqual(specDigest(replacement), done.approvedDigest);
    // Задача цитирует новую редакцию спецификации, а база прогонов её ещё не
    // содержит: выдать работу на таком дереве значит искать источник там, где
    // его нет. Раньше это давало непонятный провал задачи — теперь отказ назван.
    h.approve(board.id);
    await assert.rejects(scheduler.drain(), /base-update/);
    assert.equal(store.read().tasks.find((t) => t.id === replacement.id)!.status, 'ready');

    // С перенесённой базой источник на месте, и доказательство снова собирается.
    await updateBase(config, root);
    await scheduler.drain();
    const redone = store.read().tasks.find((t) => t.id === replacement.id)!;
    assert.equal(redone.status, 'done', redone.failure);
    assert.equal(
      requirementReport(h, 'main').tasks.find((t) => t.taskId === replacement.id)!.requirements[0]
        .verified,
      true,
    );
  } finally {
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Компонент с большим отчётом требований: реальный Git-репозиторий с ТЗ и
 * много задач со ссылками на его требования.
 */
async function largeReport(tasks: number) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-req-page-')));
  const repo = join(dir, 'repo');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'Test');
  const ids = Array.from({ length: 6 }, (_, i) => `REQ-item-${i}`);
  await writeFile(
    join(repo, 'docs/spec.md'),
    ids.map((id) => `## ${id}: Item ${id}\n${'Observable behaviour. '.repeat(5)}\n`).join('\n'),
  );
  await git(repo, 'add', 'docs/spec.md');
  await git(repo, 'commit', '-q', '-m', 'Specify items');
  const checkouts = testCheckoutRoot();
  const store = new Store(join(dir, 'state.sqlite'));
  const h = new DevContour(store, config({ repository: repo, checkoutRoot: checkouts }));
  const snapshot = requirementSnapshot(repo, 'docs/spec.md');
  const requirements = snapshot.requirements.map((r) => ({
    ...r,
    source: snapshot.source,
    gate: 'test',
    scenario: `Scenario of ${r.id}`,
  }));
  const created: string[] = [];
  for (let b = 0; created.length < tasks; b++) {
    const board = h.createBoard(`Requirements board ${b}`);
    for (let i = 0; i < 40 && created.length < tasks; i++)
      created.push(h.addTask(board.id, { ...input(`Task ${b}-${i}`), requirements }).id);
  }
  return {
    h,
    root: dir,
    created,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      removeTestCheckoutRoot(checkouts);
    },
  };
}

test('requirements_report агента: сводка и страницы в пределе ответа вместо отказа 64 KiB', async () => {
  const f = await largeReport(120);
  try {
    const full = requirementReport(f.h, 'main');
    assert.equal(full.tasks.length, 120);
    assert.ok(
      Buffer.byteLength(JSON.stringify(full)) > 65536,
      'полный отчёт больше предела ответа',
    );
    const agent = new AgentService(f.h, f.root);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = (await agent.run({
        operation: 'requirements_report',
        input: { repositoryId: 'main', ...(cursor ? { cursor } : {}) },
      })) as {
        summary: {
          tasks: number;
          requirements: number;
          stale: number;
          proof: Record<string, number>;
        };
        tasks: { taskId: string; requirements: unknown[] }[];
        nextCursor?: string;
        full: string;
        complete: boolean;
      };
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 65536);
      // Отчёт больше предела: ни одна страница не весь отчёт.
      assert.equal(page.complete, false);
      assert.deepEqual(page.summary, {
        tasks: 120,
        requirements: 720,
        stale: 0,
        proof: { none: 720 },
      });
      assert.match(page.full, /devcontour requirements-report --repository-id main/);
      assert.ok(page.tasks.length > 0);
      for (const t of page.tasks) assert.equal(t.requirements.length, 6);
      seen.push(...page.tasks.map((t) => t.taskId));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    assert.ok(pages > 1, 'больше одной страницы');
    assert.deepEqual(seen, f.created, 'страницы покрывают все задачи по порядку без повторов');
    // Явный предел страницы и синхронный путь агента — те же строки.
    const small = agent.execute({
      operation: 'requirements_report',
      input: { repositoryId: 'main', limit: 3 },
    }) as { tasks: { taskId: string }[]; nextCursor?: string };
    assert.deepEqual(
      small.tasks.map((t) => t.taskId),
      f.created.slice(0, 3),
    );
    assert.equal(small.nextCursor, f.created[2]);
    await assert.rejects(
      agent.run({
        operation: 'requirements_report',
        input: { repositoryId: 'main', cursor: 'T-missing' },
      }),
      /Курсор отчёта требований не найден/,
    );
  } finally {
    f.cleanup();
  }
});

test('requirements_report агента не держит цикл событий: таймер срабатывает до ответа', async () => {
  const f = await largeReport(60);
  try {
    const agent = new AgentService(f.h, f.root);
    const order: string[] = [];
    const report = agent
      .run({ operation: 'requirements_report', input: { repositoryId: 'main', limit: 1 } })
      .then(() => order.push('report'));
    setTimeout(() => order.push('timer'), 0);
    await report;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(order, ['timer', 'report']);
  } finally {
    f.cleanup();
  }
});

test('requirements_report агента: уложившийся отчёт без cursor и limit — весь список, как прежде, с complete', async () => {
  const f = await largeReport(12);
  try {
    const agent = new AgentService(f.h, f.root);
    const whole = (await agent.run({
      operation: 'requirements_report',
      input: { repositoryId: 'main' },
    })) as { complete: boolean; tasks: { taskId: string }[]; nextCursor?: string };
    assert.equal(whole.complete, true);
    assert.deepEqual(
      whole.tasks.map((t) => t.taskId),
      f.created,
    );
    assert.equal(whole.nextCursor, undefined);
    const page = (await agent.run({
      operation: 'requirements_report',
      input: { repositoryId: 'main', limit: 5 },
    })) as { complete: boolean; nextCursor?: string };
    assert.equal(page.complete, false);
    assert.equal(page.nextCursor, f.created[4]);
  } finally {
    f.cleanup();
  }
});

test('requirements_report агента: требования задачи, не вместившиеся в страницу одни, сокращаются с omittedRequirements', () => {
  // Сценарий до 1500 знаков: 30 требований с кириллическим сценарием
  // больше страницы строк задач.
  const requirement = (i: number) => ({
    id: `REQ-long-${i}`,
    source: 'docs/spec.md',
    digest: 'a'.repeat(64),
    gate: 'test',
    scenario: 'Сценарий '.repeat(160),
    currentDigest: 'a'.repeat(64),
    fresh: true,
    verified: false,
    proof: 'none',
    proofReason: 'Задача ещё не принята',
  });
  const row = (id: string, n: number) =>
    ({
      taskId: id,
      contracts: {},
      specDigest: undefined,
      resultSha: undefined,
      requirements: Array.from({ length: n }, (_, i) => requirement(i)),
    }) as unknown as RequirementReportRow;
  const report = {
    repositoryId: 'main',
    source: 'committed HEAD',
    tasks: [row('T-big', 30), row('T-next', 1)],
  };
  const first = requirementReportPage(report, {});
  assert.equal(first.tasks.length, 1);
  const big = first.tasks[0];
  assert.equal(big.taskId, 'T-big');
  assert.ok(big.requirements.length > 0 && big.requirements.length < 30);
  assert.equal(big.omittedRequirements, 30 - big.requirements.length);
  assert.equal(first.complete, false);
  assert.equal(first.nextCursor, 'T-big');
  assert.equal(first.summary.requirements, 31);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 65536);
  const second = requirementReportPage(report, { cursor: first.nextCursor });
  assert.deepEqual(
    second.tasks.map((t) => t.taskId),
    ['T-next'],
  );
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.complete, false, 'не первая страница — не весь отчёт');
  // Без cursor и limit уложившийся отчёт приходит целиком, и больше 50 задач.
  const many = {
    ...report,
    tasks: Array.from({ length: 60 }, (_, i) => row(`T-${i}`, 0)),
  };
  const all = requirementReportPage(many, {});
  assert.equal(all.tasks.length, 60);
  assert.equal(all.complete, true);
  assert.equal(all.nextCursor, undefined);
  assert.equal(requirementReportPage(many, { limit: 50 }).complete, false);
});
