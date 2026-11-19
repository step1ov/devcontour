// Пути ведущего между досками: роль черновика находки по владельцу пути и
// перенос черновика на другую доску (F73), отмена выданной задачи и доска,
// задание которой она остановила (F75), выпуск разобранных находок агентской
// операцией plan_review (F76), ожидание досок заданием ChangeSet (F78).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closePrevious, complete, config, fixture, input } from './helpers.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { DomainError } from '../src/core/model.ts';
import { LeadWorkflow, WAITING_BOARDS } from '../src/core/lead-workflow.ts';
import { Workspace } from '../src/core/workspace.ts';
import { recordsFromState, stateFromRecords } from '../src/core/sync-state.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { cancelImpact, stopperWarning, unapprovedTasks } from '../src/runner/lead-outlook.ts';
import { AgentService } from '../src/application/agent.ts';
import {
  devcontourHandoff,
  devcontourHandoffWithin,
  handoffResponse,
} from '../src/application/handoff.ts';
import { workflowStatus } from '../src/application/workflow-status.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { command } from '../src/runner/process.ts';
import { cliCommand } from './cli-command.ts';
import { controlled, inputDemos, inputFixture } from './input-fixture.ts';

after(() => inputDemos.close());

const finding = (path: string, title = 'Finding at ' + path) => ({
  kind: 'bug' as const,
  title,
  path,
  line: 3,
  observation: 'The observed behaviour differs from the contract.',
  consequence: 'Users see the wrong value.',
  reproduction: 'Run the focused test twice.',
});

/** Контур с ролями, у которых явные области записи. */
function scoped() {
  const f = fixture();
  const h = new DevContour(
    f.store,
    config({
      checkoutRoot: f.h.config.checkoutRoot,
      roles: {
        admin: { runtime: 'demo', writePaths: ['apps/admin/'] },
        mobile: { runtime: 'demo', writePaths: ['apps/mobile/'] },
        // Две роли с одинаково узкой областью: владелец не однозначен.
        engine: { runtime: 'demo', writePaths: ['packages/engine/'] },
        tuner: { runtime: 'demo', writePaths: ['packages/engine/'] },
        // Роль без области пишет весь репозиторий: владельцем она не названа.
        qa: { runtime: 'demo' },
      },
    }),
  );
  return { ...f, h };
}

/** Fixture-ревьюер плана: одобряет и записывает предложения. */
function reviewer(proposals: Record<string, unknown>[]) {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute(r: AgentRequest) {
      proposals.push(
        JSON.parse(readFileSync(join(r.artifactDir, 'proposal.json'), 'utf8')) as Record<
          string,
          unknown
        >,
      );
      return Promise.resolve({
        data: {
          approved: true,
          summary: 'Explicit test fixture',
          findings: [],
          previous: closePrevious(r.prompt),
        },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      });
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

test('F73: черновик находки получает роль владельца пути; неоднозначный или ничей путь — роль источника с пометкой и флаг в host.next', () => {
  const f = scoped();
  try {
    const b = f.h.createBoard('Admin work', '', 'main');
    const source = f.h.addTask(b.id, { ...input('Admin task'), role: 'admin' });
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('writer')!;
    assert.equal(run.taskId, source.id);
    const ids = f.h.discoveries(run.id, run.token, 'a'.repeat(40), [
      finding('apps/mobile/src/session.test.tsx'),
      finding('apps/admin/src/table.ts'),
      finding('packages/engine/src/budget.ts'),
      finding('tools/report.ts'),
    ]);
    const drafts = ids.map((id) => f.store.read().tasks.find((t) => t.id === id)!);
    const [mobile, own, ambiguous, nobody] = drafts;
    // Путь другой роли — её черновик, с пометкой, откуда находка.
    assert.equal(mobile.role, 'mobile');
    assert.match(mobile.description, /Роль mobile выбрана по области записи пути/);
    assert.match(mobile.description, /задача-источник — роли admin/);
    assert.equal(mobile.finding?.sourceTaskId, source.id);
    // Путь в области роли источника — её роль, без пометки.
    assert.equal(own.role, 'admin');
    assert.doesNotMatch(own.description, /Роль .* выбрана|выберите роль/);
    // Две одинаково узкие роли — роль источника и просьба выбрать.
    assert.equal(ambiguous.role, 'admin');
    assert.match(ambiguous.description, /покрывают его несколько ролей \(engine, tuner\)/);
    // Ни одна роль с явной областью путь не покрывает (qa без области не в счёт).
    assert.equal(nobody.role, 'admin');
    assert.match(nobody.description, /ни одна роль с явной областью его не покрывает/);

    const next = devcontourHandoff(f.h).host.next;
    assert.equal(next?.decision, 'plan');
    assert.deepEqual(
      next?.plan?.misrouted?.map((m) => [m.id, m.role, m.owners]),
      [
        [ambiguous.id, 'admin', ['engine', 'tuner']],
        [nobody.id, 'admin', []],
      ],
    );
    assert.equal(next?.plan?.misroutedCount, 2);
    assert.match(next.detail, /role whose write scope does not cover the finding path/);
    assert.match(
      next.detail,
      new RegExp(`${ambiguous.id} \\(admin, packages/engine/src/budget.ts → engine\\|tuner\\)`),
    );
    // Разбор правкой роли снимает флаг.
    f.h.editTask(
      ambiguous.id,
      {
        repositoryId: ambiguous.repositoryId,
        role: 'engine',
        title: ambiguous.title,
        description: ambiguous.description,
        acceptance: ambiguous.acceptance,
      },
      specDigest(ambiguous),
    );
    assert.deepEqual(
      devcontourHandoff(f.h).host.next?.plan?.misrouted?.map((m) => m.id),
      [nobody.id],
    );
  } finally {
    f.cleanup();
  }
});

test('F80: правка одной роли и перенос не разбирают находку — она вне области ревью; иная правка — разбор', () => {
  const f = scoped();
  try {
    const b = f.h.createBoard('Admin work', '', 'main');
    f.h.addTask(b.id, { ...input('Admin task'), role: 'admin' });
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('writer')!;
    const [held, other] = f.h.discoveries(run.id, run.token, 'a'.repeat(40), [
      finding('packages/engine/src/budget.ts'),
      finding('packages/engine/src/limits.ts'),
    ]);
    const task = (id: string) => f.store.read().tasks.find((t) => t.id === id)!;
    const plan = () => {
      const next = devcontourHandoff(f.h).host.next;
      assert.equal(next?.decision, 'plan');
      return next;
    };
    assert.deepEqual(
      plan().plan?.misrouted?.map((m) => m.id),
      [held, other],
    );
    // Роль-владелец пути — только роль: находка ждёт решения владельца.
    const t = task(held);
    const roleOnly = {
      repositoryId: t.repositoryId,
      role: 'engine',
      title: t.title,
      description: t.description,
      acceptance: t.acceptance,
    };
    f.h.editTask(held, roleOnly, specDigest(t));
    let after = task(held);
    assert.equal(after.role, 'engine');
    assert.equal(after.triagedAt, undefined, 'правка одной роли — не разбор');
    const next = plan();
    assert.ok(next.plan?.unverified.includes(held), 'по-прежнему непроверенная');
    assert.ok(!next.plan?.review.includes(held), 'и не предложена к ревью');
    assert.deepEqual(
      next.plan?.misrouted?.map((m) => m.id),
      [other],
      'флаг не той роли снят',
    );
    assert.match(next.detail, /an edit that changes only the role keeps the finding unverified/);
    // Перенос на другую доску разбор тоже не отмечает.
    const target = f.h.createBoard('Engine', '', 'main');
    f.h.moveTask(held, target.id, 'Belongs to the engine board');
    assert.equal(task(held).triagedAt, undefined, 'перенос — не разбор');
    const s = f.store.read();
    assert.deepEqual(
      unapprovedTasks(f.h, s, [task(held)]).unverified,
      [held],
      'на новой доске — непроверенная (вне области ревью)',
    );
    // Роль вместе с приёмкой — разбор (Поломка: «только роль» по одному
    // полю role, без сравнения остальной постановки).
    const o = task(other);
    f.h.editTask(
      other,
      {
        repositoryId: o.repositoryId,
        role: 'engine',
        title: o.title,
        description: o.description,
        acceptance: ['Regression test for limits.ts fails before the fix and passes after it.'],
      },
      specDigest(o),
    );
    assert.ok(task(other).triagedAt, 'роль и приёмка — разбор');
    // Правка без перемен по-прежнему явный разбор.
    after = task(held);
    f.h.editTask(held, { ...roleOnly }, specDigest(after));
    assert.ok(task(held).triagedAt, 'правка без перемен — разбор, как прежде');
  } finally {
    f.cleanup();
  }
});

test('F73/F76: plan_review выпускает только названные разобранные находки; ревьюер видит находку с ролью не той области', async () => {
  const f = scoped();
  try {
    f.h.config.mode = 'local';
    const b = f.h.createBoard('Admin work', '', 'main');
    f.h.addTask(b.id, { ...input('Admin task'), role: 'admin' });
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('writer')!;
    const [ambiguous, nobody] = f.h.discoveries(run.id, run.token, 'a'.repeat(40), [
      finding('packages/engine/src/budget.ts'),
      finding('tools/report.ts'),
    ]);
    const findings = f.store.read().boards.find((x) => x.title === 'Находки агентов')!;
    const triage = (id: string) => {
      const t = f.store.read().tasks.find((x) => x.id === id)!;
      f.h.editTask(
        id,
        {
          repositoryId: t.repositoryId,
          role: t.role,
          title: t.title,
          description: t.description,
          acceptance: ['The focused test passes twice in a row.'],
        },
        specDigest(t),
      );
    };
    triage(nobody);
    // host.next называет агентскую операцию с разобранными id.
    const next = devcontourHandoff(f.h).host.next;
    assert.deepEqual(next?.plan?.review, [nobody]);
    assert.ok(
      next?.detail.includes(
        `plan_review {"boardId": "${findings.id}", "tasks": ["${nobody}"], "authorRuntime": "codex|claude"}`,
      ),
      next?.detail,
    );
    const proposals: Record<string, unknown>[] = [];
    const agent = new AgentService(f.h, f.root, { runtimes: reviewer(proposals) });
    // Синхронный execute операцию с вызовом модели не исполняет.
    assert.throws(
      () =>
        agent.execute({
          operation: 'plan_review',
          input: { boardId: findings.id, authorRuntime: 'codex', tasks: [nobody] },
        }),
      /через run/,
    );
    const result = await agent.run({
      operation: 'plan_review',
      input: { boardId: findings.id, authorRuntime: 'codex', tasks: [nobody] },
    });
    assert.equal(result.status, 'approved');
    const state = f.store.read();
    assert.equal(state.tasks.find((t) => t.id === nobody)!.status, 'ready');
    assert.equal(state.tasks.find((t) => t.id === ambiguous)!.status, 'draft');
    // В предложении — только выбранная находка и сведение о роли.
    const [proposal] = proposals;
    assert.deepEqual(
      (proposal.tasks as { id: string }[])
        .map((t) => t.id)
        .filter((id) => id !== state.tasks[0].id),
      [nobody],
    );
    const ownership = proposal.findingOwnership as {
      note: string;
      tasks: { taskId: string; role: string; path: string; owners: string[] }[];
    };
    assert.deepEqual(ownership.tasks, [
      { taskId: nobody, role: 'admin', path: 'tools/report.ts', owners: [] },
    ]);
    assert.match(ownership.note, /write scope does not cover the finding path/);
    // Чужой id в области — отказ до вызова модели.
    await assert.rejects(
      agent.run({
        operation: 'plan_review',
        input: { boardId: findings.id, authorRuntime: 'codex', tasks: [state.tasks[0].id] },
      }),
      /Не черновики этой доски/,
    );
    assert.equal(proposals.length, 1);
  } finally {
    f.cleanup();
  }
});

test('F73: task_move переносит невыданный черновик той же задачей; выданная, утверждённая и зависимая — отказ', () => {
  const f = scoped();
  try {
    const b = f.h.createBoard('Admin work', '', 'main');
    const source = f.h.addTask(b.id, { ...input('Admin task'), role: 'admin' });
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('writer')!;
    const [found, other] = f.h.discoveries(run.id, run.token, 'a'.repeat(40), [
      finding('apps/mobile/src/a.ts'),
      finding('apps/mobile/src/b.ts'),
    ]);
    const findings = f.store.read().boards.find((x) => x.title === 'Находки агентов')!;
    const target = f.h.createBoard('Mobile stability', '', 'main');
    const agent = new AgentService(f.h, f.root);
    const moved = agent.execute({
      operation: 'task_move',
      input: { taskId: found, boardId: target.id, reason: 'Triaged: belongs to the mobile board' },
    });
    assert.deepEqual(moved, {
      taskId: found,
      from: findings.id,
      to: target.id,
      reason: 'Triaged: belongs to the mobile board',
    });
    let s = f.store.read();
    assert.deepEqual(s.boards.find((x) => x.id === target.id)!.revisions.at(-1)!.taskIds, [found]);
    assert.ok(
      !s.boards
        .find((x) => x.id === findings.id)!
        .revisions.at(-1)!
        .taskIds.includes(found),
    );
    // Та же задача: id, происхождение и статус черновика.
    const t = s.tasks.find((x) => x.id === found)!;
    assert.equal(t.status, 'draft');
    assert.equal(t.finding?.sourceTaskId, source.id);
    // Повтор на ту же доску, утверждённая задача, выданная — отказ.
    const refuse = (taskId: string, boardId: string, pattern: RegExp) =>
      assert.throws(
        () => f.h.moveTask(taskId, boardId, 'A reason long enough'),
        (e: unknown) => {
          assert.ok(e instanceof DomainError, String(e));
          assert.match(e.message, pattern);
          return true;
        },
      );
    refuse(found, target.id, /уже на доске/);
    refuse(source.id, target.id, /Переносится только черновик/);
    assert.throws(() => f.h.moveTask(found, target.id, 'short'), /от 10 до 2000/);
    // Невыданный черновик, от которого зависит живая задача своей ревизии.
    const dependent = f.h.addTask(findings.id, {
      ...input('Depends on the finding'),
      role: 'mobile',
      dependsOn: [other],
    });
    refuse(other, target.id, new RegExp(`зависят задачи доски ${findings.id}: ${dependent.id}`));
    f.h.cancel(dependent.id, 'Not needed', 'host');
    f.h.moveTask(other, target.id, 'Dependent cancelled, move it');
    // Черновик, который уже выдавали (отменён и возвращён), не переносится.
    f.h.approve(target.id);
    f.h.fail(run.id, run.token, 'gate failed', false, 'gate');
    const second = f.h.claim('writer')!;
    assert.ok([found, other].includes(second.taskId));
    f.h.fail(second.id, second.token, 'gate failed', false, 'gate');
    f.h.reopen(second.taskId, 'Respecify after the failed attempt');
    const back = f.h.createBoard('Elsewhere', '', 'main');
    refuse(second.taskId, back.id, /уже выдавали/);
    s = f.store.read();
    assert.equal(s.tasks.find((x) => x.id === second.taskId)!.status, 'draft');
  } finally {
    f.cleanup();
  }
});

test('F75: отмена выданной задачи называет остановку задания; задание новой ревизии останавливается до ревью плана; путь — новая доска', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Flaky check', '', 'main');
    const bad = f.h.addTask(b.id, input('Wrong acceptance'));
    const spare = f.h.addTask(b.id, input('Spare'));
    f.h.approve(b.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    f.h.pause(false);
    const run = f.h.claim('writer')!;
    assert.equal(run.taskId, bad.id);
    // Невыданная задача ведущего задание не останавливает: предупреждения нет.
    assert.equal(cancelImpact(f.h, spare.id, 'host'), undefined);
    // Выданная — останавливает: живое задание названо, пути — тоже.
    const impact = cancelImpact(f.h, bad.id, 'host')!;
    assert.equal(impact.boardId, b.id);
    assert.equal(impact.issued, true);
    assert.deepEqual(
      impact.jobs.map((j) => j.key),
      [job.key],
    );
    assert.match(impact.warning, /навсегда останавливает задание ведущего доски .* \(D46\)/);
    assert.match(impact.warning, /замена на новой доске \(plan_import без boardId/);
    // Отмена человеком невыданной задачи тоже останавливает задание.
    assert.ok(cancelImpact(f.h, spare.id, 'operator'));
    f.h.fail(run.id, run.token, 'gate failed', false, 'gate');
    f.h.cancel(bad.id, 'Acceptance asked to load the host', 'host');
    f.h.cancel(spare.id, 'Not needed', 'host');
    const runner = new LeadRunner(f.h, f.root);
    for (let i = 0; i < 4; i++) await runner.tick();
    assert.equal(flow.get(job.key, 'main').status, 'failed');
    // Замена в ту же ревизию: ответ task_create предупреждает.
    const agent = new AgentService(f.h, f.root);
    const created = agent.execute({
      operation: 'task_create',
      input: { boardId: b.id, task: input('Replacement') },
    }) as { taskId: string; jobStop?: { taskId: string; warning: string } };
    assert.equal(created.jobStop?.taskId, bad.id);
    assert.match(created.jobStop.warning, /любое задание ведущего этой ревизии остановится на ней/);
    // host.next по черновику называет остановку и новую доску.
    let next = devcontourHandoff(f.h, { boardId: b.id }).host.next;
    assert.equal(next?.code, 'plan-unapproved', JSON.stringify(next));
    assert.equal((next?.params as { stopper?: string }).stopper, bad.id);
    assert.match(next.detail, /plan the replacement on a new board \(plan_import without boardId/);
    // Новое задание ревизии останавливается на стадии 0: ревью плана нет,
    // замена остаётся черновиком и не выдаётся.
    const second = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    assert.notEqual(second.key, job.key);
    for (let i = 0; i < 4; i++) await runner.tick();
    await runner.stop();
    const failed = flow.get(second.key, 'main');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stage, 0);
    assert.match(failed.error ?? '', new RegExp(`^${bad.id}: `));
    assert.equal(f.store.read().tasks.find((t) => t.id === created.taskId)!.status, 'draft');
    next = devcontourHandoff(f.h, { boardId: b.id }).host.next;
    assert.equal(next?.code, 'job-cancelled-task', JSON.stringify(next));
    assert.equal(next?.job?.key, second.key);
    assert.match(next.detail, /\(3\) a replacement goes on a new board/);
  } finally {
    f.cleanup();
  }
});

test('F75: CLI cancel --by host выданной задачи с живым заданием требует --stop-job и возвращает jobStop', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'dc-lead-routes-')));
  const data = join(root, 'data');
  try {
    await mkdir(data);
    const c = config();
    await writeFile(join(data, 'config.json'), JSON.stringify(c));
    const h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    let taskId: string, key: string;
    try {
      const b = h.createBoard('CLI cancel', '', 'main');
      taskId = h.addTask(b.id, input('Issued')).id;
      h.approve(b.id);
      key = new LeadWorkflow(h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' }).key;
      h.pause(false);
      const run = h.claim('writer')!;
      h.fail(run.id, run.token, 'gate failed', false, 'gate');
    } finally {
      h.store.close();
    }
    const cli = (...args: string[]) =>
      command(
        [
          ...cliCommand(),
          'cancel',
          '--task',
          taskId,
          '--reason',
          'Wrong spec',
          ...args,
          '--data',
          data,
        ],
        process.cwd(),
      );
    const refused = await cli('--by', 'host');
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /D46/);
    assert.match(refused.stderr, /--stop-job/);
    // Отказ ничего не изменил: задача по-прежнему упавшая, не отменённая.
    const read = () => {
      const store = new Store(join(data, 'state.sqlite'));
      try {
        return store.read().tasks.find((t) => t.id === taskId)!;
      } finally {
        store.close();
      }
    };
    assert.equal(read().status, 'failed');
    const done = await cli('--by', 'host', '--stop-job');
    assert.equal(done.code, 0, done.stderr);
    const out = JSON.parse(done.stdout) as {
      taskId: string;
      jobStop: { jobs: { key: string }[]; warning: string };
    };
    assert.equal(out.taskId, taskId);
    assert.deepEqual(
      out.jobStop.jobs.map((j) => j.key),
      [key],
    );
    // Отмена записана: статус и актёр в базе.
    const cancelled = read();
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelledBy, 'host');
  } finally {
    assert.ok(root.includes('dc-lead-routes-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('F78: задание ChangeSet на стадии 0 называет доски и их причины в workflow_status, истории и session_handoff', async () => {
  const f = fixture();
  try {
    const done = f.h.createBoard('Done board', '', 'main');
    const finished = f.h.addTask(done.id, input('Finished'));
    f.h.approve(done.id);
    complete(f.h, finished.id);
    f.h.accept(done.id, 'b'.repeat(40));
    const open = f.h.createBoard('Open board', '', 'main');
    f.h.addTask(open.id, input('Open task'));
    f.h.approve(open.id);
    const idle = f.h.createBoard('No job board', '', 'main');
    f.h.addTask(idle.id, input('Idle task'));
    f.h.approve(idle.id);
    const flow = new LeadWorkflow(f.h);
    const boardJob = flow.start({ kind: 'board', id: open.id, authorRuntime: 'codex' });
    const change = new Workspace(f.h).create({
      title: 'Release r1',
      description: 'Joint verification of the release boards.',
      boardIds: [done.id, open.id, idle.id],
    });
    const job = flow.start({ kind: 'changeset', id: change.id, authorRuntime: 'codex' });
    const waiting = flow.waitingOf(job);
    assert.deepEqual(waiting, {
      kind: 'boards',
      boards: [
        {
          boardId: open.id,
          job: { key: boardJob.key, status: 'queued', stage: 0 },
          blocker: { kind: 'job' },
        },
        { boardId: idle.id, blocker: { kind: 'no-job' } },
      ],
    });
    // workflow_status показывает то же ожидание.
    const status = workflowStatus(f.h, { kind: 'changeset', id: change.id }) as unknown as {
      jobs: { key: string; waiting?: unknown }[];
    };
    assert.deepEqual(status.jobs.find((j) => j.key === job.key)?.waiting, waiting);
    // Такт стадии 0 отмечает ожидание в истории один раз.
    const runner = new LeadRunner(f.h, f.root);
    const claimed = flow.claim(job.key)!;
    assert.equal(await runner.execute(claimed, new AbortController().signal), true);
    flow.finish(claimed, true);
    const again = flow.claim(job.key)!;
    assert.equal(await runner.execute(again, new AbortController().signal), true);
    flow.finish(again, true);
    assert.deepEqual(
      flow
        .get(job.key)
        .history.filter((h) => h.event.startsWith('waiting:'))
        .map((h) => h.event),
      [WAITING_BOARDS],
    );
    // session_handoff: живое задание ChangeSet с досками и их причинами.
    for (const value of [devcontourHandoff(f.h), devcontourHandoff(f.h, { boardId: idle.id })]) {
      const [entry] = value.host.changesets ?? [];
      assert.equal(entry?.changeSetId, change.id);
      assert.equal(entry.job.key, job.key);
      assert.deepEqual(entry.waiting, waiting);
      assert.match(
        handoffResponse(value, 'md').markdown ?? '',
        new RegExp(`ChangeSet ${change.id} ждёт приёмки досок .*${idle.id} — у неё нет задания`),
      );
    }
    // Пакет доски вне набора набор не называет.
    const outside = f.h.createBoard('Outside board', '', 'main');
    f.h.addTask(outside.id, input('Outside task'));
    f.h.approve(outside.id);
    assert.equal(devcontourHandoff(f.h, { boardId: outside.id }).host.changesets, undefined);
    // Упавшее задание доски: причина — ошибка, маска — до усечения.
    const idleJob = flow.start({ kind: 'board', id: idle.id, authorRuntime: 'codex' });
    const secret = 'SECRET-VALUE-0123456789';
    flow.fail(flow.claim(idleJob.key, 'main')!, 'x'.repeat(290) + secret);
    const masked = flow.boardsWaitingOf(job, f.store.read(), (t) => t.replaceAll(secret, '***'));
    const failedBoard = masked!.boards.find((x) => x.boardId === idle.id)!;
    assert.equal(failedBoard.blocker.kind, 'job-failed');
    const error = (failedBoard.blocker as { error?: string }).error ?? '';
    assert.ok(error.endsWith('***'), error.slice(-30));
    assert.ok(!error.includes('SECRET'));
    // Доски приняты — стадия 0 больше не ждёт.
    for (const board of [open, idle]) {
      for (const t of f.store.read().tasks.filter((x) =>
        f.store
          .read()
          .boards.find((y) => y.id === board.id)!
          .revisions.at(-1)!
          .taskIds.includes(x.id),
      ))
        complete(f.h, t.id);
      f.h.accept(board.id, 'b'.repeat(40));
    }
    assert.equal(flow.waitingOf(job), undefined);
    const last = flow.claim(job.key)!;
    assert.equal(await runner.execute(last, new AbortController().signal), false);
    flow.finish(last, false);
    assert.equal(devcontourHandoff(f.h).host.changesets, undefined);
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('F75: стадия 0 не останавливается на невыданной задаче, отменённой ведущим; отмена выданной во время ревью плана не даёт утвердить', async () => {
  const f = fixture();
  try {
    // Невыданная задача, снятая ведущим, — объём плана: ревью и утверждение идут.
    const scope = f.h.createBoard('Scope cut', '', 'main');
    f.h.addTask(scope.id, input('Kept draft'));
    const dropped = f.h.addTask(scope.id, input('Dropped draft'));
    f.h.cancel(dropped.id, 'Out of scope', 'host');
    const flow = new LeadWorkflow(f.h);
    const kept = flow.start({ kind: 'board', id: scope.id, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    const first = flow.claim(kept.key, 'main')!;
    await runner.execute(first, new AbortController().signal);
    flow.finish(first, false);
    assert.equal(
      f.store.read().tasks.find((t) => t.title === 'Kept draft')!.status,
      'ready',
      'стадия 0 утвердила план',
    );
    await runner.stop();
  } finally {
    f.cleanup();
  }
  // Отмена во время ревью (её видит проверка после ревью) и отмена между
  // проверкой после ревью и транзакцией утверждения (её видит только
  // проверка внутри транзакции).
  for (const when of ['review', 'commit'] as const) {
    const g = fixture();
    try {
      g.h.config.mode = 'local';
      const b = g.h.createBoard('Race', '', 'main');
      const issued = g.h.addTask(b.id, input('Issued'));
      g.h.approve(b.id);
      g.h.pause(false);
      const run = g.h.claim('writer')!;
      g.h.fail(run.id, run.token, 'gate failed', false, 'gate');
      const replacement = g.h.addTask(b.id, input('Replacement'));
      const flow = new LeadWorkflow(g.h);
      const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
      const cancel = () => g.h.cancel(issued.id, 'Cancelled during plan review', 'host');
      const proposals: Record<string, unknown>[] = [];
      const approve = reviewer(proposals);
      let armed = false;
      const racing = (name: 'codex' | 'claude'): AgentAdapter => ({
        ...approve[name],
        async execute(r: AgentRequest) {
          if (when === 'review') cancel();
          const result = await approve[name].execute(r);
          armed = when === 'commit';
          return result;
        },
      });
      const runner = new LeadRunner(g.h, g.root, {
        codex: racing('codex'),
        claude: racing('claude'),
      });
      // Первая проверка задания после ревью — проверка перед транзакцией
      // утверждения; следующая транзакция — само утверждение. Отмена — прямо
      // перед ней, вне её (другой писатель), уже после проверки.
      const workflow = (runner as unknown as { workflow: LeadWorkflow }).workflow;
      const check = workflow.guard.bind(workflow);
      let checked = false;
      workflow.guard = (j: Parameters<typeof check>[0]) => {
        if (armed) checked = true;
        return check(j);
      };
      const atomic = g.h.store.atomic.bind(g.h.store);
      let late = 0;
      g.h.store.atomic = <T>(fn: () => T): T => {
        if (checked) {
          armed = checked = false;
          late++;
          cancel();
        }
        return atomic(fn);
      };
      const claimed = flow.claim(job.key, 'main')!;
      await assert.rejects(
        runner.execute(claimed, new AbortController().signal),
        new RegExp(`^Error: ${issued.id}: `),
      );
      assert.equal(proposals.length, 1, 'ревью было');
      if (when === 'commit') assert.equal(late, 1, 'отмена между проверкой и транзакцией');
      const s = g.store.read();
      assert.equal(s.tasks.find((t) => t.id === issued.id)!.status, 'cancelled');
      assert.equal(
        s.tasks.find((t) => t.id === replacement.id)!.status,
        'draft',
        'утверждение после отмены не записано',
      );
      await runner.stop();
    } finally {
      g.cleanup();
    }
  }
});

test('F73: Git sync не объединяет задачу на двух досках (два клона перенесли её по-разному)', () => {
  const f = fixture();
  try {
    const a = f.h.createBoard('Board A', '', 'main');
    const t = f.h.addTask(a.id, input('Movable'));
    const b = f.h.createBoard('Board B', '', 'main');
    const c = f.h.createBoard('Board C', '', 'main');
    f.h.moveTask(t.id, b.id, 'Moved by the first clone');
    const state = f.store.read();
    // Перенос сам по себе состояние sync не ломает.
    const clean = stateFromRecords(f.h, state, recordsFromState(f.h, state), new Map());
    assert.deepEqual(clean.boards.find((x) => x.id === b.id)!.revisions.at(-1)!.taskIds, [t.id]);
    // Объединение двух переносов: задача в B и в C.
    const merged = structuredClone(state);
    merged.boards
      .find((x) => x.id === c.id)!
      .revisions.at(-1)!
      .taskIds.push(t.id);
    assert.throws(
      () => stateFromRecords(f.h, state, recordsFromState(f.h, merged), new Map()),
      new RegExp(`Задача ${t.id} на двух досках`),
    );
  } finally {
    f.cleanup();
  }
});

test('F78: пакет в пределе ответа ужимает ожидание ChangeSet без потери id вопросов; Markdown строится', async () => {
  const runtimes = controlled();
  const f = await inputFixture(runtimes);
  try {
    const { boardId } = f.askingTask('Asking A');
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await lead.tick(); // согласование (demo)
    await lead.tick(); // выдача
    await f.scheduler.drain();
    await lead.tick();
    await lead.tick();
    await lead.stop();
    const asked = flow.waitingOf(flow.get(job.key, job.owner));
    assert.equal(asked?.kind, 'input', JSON.stringify(asked));
    const requestIds = (asked as { requestIds: string[] }).requestIds;
    const change = new Workspace(f.h).create({
      title: 'Release r1',
      description: 'Joint verification of the release boards.',
      boardIds: [boardId],
    });
    flow.start({ kind: 'changeset', id: change.id, authorRuntime: 'codex' });
    // Без предела — полный вид; в тесном пределе ожидание ужато, но причина
    // `input` держит свои id, а Markdown пакета их называет.
    for (const limit of [undefined, { bytes: 3000, format: 'md' as const }]) {
      const { value } = devcontourHandoffWithin(f.h, {}, limit);
      const [entry] = value.host.changesets ?? [];
      assert.equal(entry?.changeSetId, change.id);
      assert.deepEqual(entry.waiting.boards[0].blocker, { kind: 'input', requestIds });
      assert.match(handoffResponse(value, 'md').markdown ?? '', new RegExp(requestIds[0]));
    }
  } finally {
    await f.cleanup();
  }
});

test('F75: черновик, отменённый человеком, — тоже стоппер ревизии; текст не называет его выданным', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Owner trimmed', '', 'main');
    f.h.addTask(b.id, input('Keep'));
    const drop = f.h.addTask(b.id, input('Drop'));
    f.h.cancel(drop.id, 'Not needed by the owner', 'operator');
    const warning = stopperWarning(f.store.read(), b.id).jobStop?.warning ?? '';
    assert.match(warning, new RegExp(`${drop.id} ревизии доски .* отменена человеком \\(D46\\)`));
    assert.doesNotMatch(warning, /после выдачи \(D46\)/);
    const next = devcontourHandoff(f.h).host.next;
    assert.equal(next?.code, 'plan-unapproved', JSON.stringify(next));
    assert.equal((next?.params as { stopper?: string }).stopper, drop.id);
    assert.match(next.detail, /was cancelled by a person or after issue \(D46\)/);
  } finally {
    f.cleanup();
  }
});
