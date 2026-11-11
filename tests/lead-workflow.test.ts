import { BASE_HELD_DETAIL } from '../src/runner/base-check.ts';
import { executionOf } from '../src/harness/execution.ts';
import { after, test } from 'node:test';
import { demoPool, testDemo } from './demo-pool.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { complete, config, fixture, input, MERGED } from './helpers.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { loopOutlook } from '../src/runner/lead-outlook.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, SERVER_STOPPING, specDigest } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Workspace, changeSnapshot } from '../src/core/workspace.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { taskProgress } from '../src/application/context.ts';
import { panelSummary, panelTask, type PanelSummary } from '../src/application/panel.ts';
import { git } from '../src/runner/process.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { checkBase } from '../src/runner/base-check.ts';
import { baseUpdateOperation } from '../src/runner/base-update.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { AgentService } from '../src/application/agent.ts';
import { repository } from '../src/core/repositories.ts';

// Копии одного учебного workspace вместо новой сборки демо в каждом тесте.
const demos = demoPool(testDemo);
after(() => demos.close());

test('Workflow enqueue is idempotent, expired owners are fenced and changed inputs become stale', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Durable workflow', '', 'main'),
      t = f.h.addTask(b.id, input());
    const flow = new LeadWorkflow(f.h),
      request = { kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 2 };
    const job = flow.start(request);
    assert.equal(flow.start(request).key, job.key);
    const first = flow.claim(job.key, 'main')!;
    assert.equal(flow.claim(job.key, 'main'), undefined);
    f.store.atomic(() => f.store.saveLocal('lead', 'main', job.key, { ...first, leaseUntil: 0 }));
    const replacement = flow.claim(job.key, 'main')!;
    assert.notEqual(first.token, replacement.token);
    assert.throws(() => flow.finish(first), /Владение заданием утрачено/);
    flow.finish(replacement);
    assert.equal(flow.get(job.key, 'main').stage, 1);
    f.h.editTask(
      t.id,
      { ...input(), description: 'A changed requirement invalidates pending work.' },
      specDigest(t),
    );
    assert.equal(flow.claim(job.key, 'main'), undefined);
    assert.equal(flow.get(job.key, 'main').status, 'stale');
    assert.notEqual(flow.start(request).key, job.key);
  } finally {
    f.cleanup();
  }
});

test('Смена политики на паузе: прогресс держит задачу (approval_stale) и называет устаревшее задание; новое задание и повторное утверждение снимают их', () => {
  // Ревьюер изменился (как после workspace-init). Утверждение плана
  // закрепило прежнюю политику: задача не выдаётся, `eligible` ложно.
  // Задание доски начато по прежнему входу: это сведение, а не причина, —
  // очередь заданий закроет его `stale` при следующем взятии стадии, а на
  // паузе стадии не берутся. Проекции считают всё чтением, ничего не пишут.
  const f = fixture();
  try {
    const b = f.h.createBoard('Release board', '', 'main');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const request = { kind: 'board', id: b.id, authorRuntime: 'codex' } as const;
    const job = new LeadWorkflow(f.h).start(request);
    f.h.pause(true, 'shutdown');
    const progressOf = (h: DevContour) => {
      const s = h.store.read();
      return taskProgress(
        h,
        s,
        s.tasks.find((x) => x.id === t.id)!,
        Date.now(),
      );
    };
    assert.deepEqual([...new LeadWorkflow(f.h).staleBoards().keys()], []);
    assert.ok(!progressOf(f.h).reasons.includes('approval_stale'));
    assert.equal(progressOf(f.h).workflowStale, undefined);

    const changed = new DevContour(
      f.store,
      config({ reviewer: { runtime: 'demo', model: 'another-reviewer' } }),
    );
    const flow = new LeadWorkflow(changed);
    assert.deepEqual([...flow.staleBoards().keys()], [b.id]);
    const progress = progressOf(changed);
    assert.ok(progress.reasons.includes('approval_stale'), progress.reasons.join(','));
    assert.ok(progress.reasons.includes('queue_paused'));
    assert.equal(progress.eligible, false);
    assert.equal(progress.approvalStale?.boardId, b.id);
    assert.match(progress.approvalStale.hint, new RegExp(`review-plan --board ${b.id}`));
    assert.equal(progress.workflowStale?.boardId, b.id);
    assert.match(progress.workflowStale.hint, /workflow_start/);
    const line = flow.view().find((w) => w.key === job.key)!;
    assert.equal(line.status, 'queued', 'задание не переписано чтением');
    assert.match(line.inputStale?.hint ?? '', new RegExp(`доски ${b.id}`));

    // Панель: сводка и карточка задачи несут ту же причину и подсказку.
    const summary = panelSummary(changed, f.root, {}) as PanelSummary;
    assert.ok(summary.workflows.some((w) => w.key === job.key && w.inputStale));
    const row = summary.tasks.find((x) => x.id === t.id)!;
    assert.ok(row.progress.reasons.includes('approval_stale'));
    assert.equal(row.progress.workflowStale?.boardId, b.id);
    const card = panelTask(changed, t.id, {});
    assert.equal(card.task.progress.approvalStale?.boardId, b.id);
    assert.equal(new LeadWorkflow(changed).get(job.key, 'main').status, 'queued');

    // Новое задание доски на паузе: прежнее больше не делает доску устаревшей.
    const next = new LeadWorkflow(changed).start(request);
    assert.notEqual(next.key, job.key);
    assert.deepEqual([...new LeadWorkflow(changed).staleBoards().keys()], []);
    assert.equal(progressOf(changed).workflowStale, undefined);
    assert.ok(progressOf(changed).reasons.includes('approval_stale'), 'политика ещё не утверждена');
    // Повторное утверждение плана при новой политике снимает причину.
    const approved = changed.approve(b.id);
    assert.deepEqual(approved.repinned, [t.id]);
    assert.ok(!progressOf(changed).reasons.includes('approval_stale'));

    // Вход, который нельзя построить, — не устаревшее согласование: доска без
    // задач не получает подсказку «утвердите заново».
    f.store.change('fixture.empty', (s) => {
      s.boards.find((x) => x.id === b.id)!.revisions.at(-1)!.taskIds = [];
    });
    const other = new DevContour(f.store, config({ maxAttempts: 9 }));
    assert.deepEqual([...new LeadWorkflow(other).staleBoards().keys()], []);
  } finally {
    f.cleanup();
  }
});

test('Atomic local event and domain changes roll back together', () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.store.atomic(() => {
          f.h.createBoard('Should roll back');
          f.store.saveLocal('signals', 'main', 'key', { received: true });
          throw new Error('Crash before commit');
        }),
      /Crash/,
    );
    assert.equal(f.store.read().boards.length, 0);
    assert.equal(f.store.allEvents().length, 0);
    assert.deepEqual(f.store.localRecords('signals', 'main'), {});
  } finally {
    f.cleanup();
  }
});

test('Removed workflow inputs become stale without starving unrelated jobs', async () => {
  const f = fixture();
  try {
    const flow = new LeadWorkflow(f.h);
    const jobs = ['Queued removal', 'Running removal', 'Unrelated board'].map((title) => {
      const board = f.h.createBoard(title, '', 'main');
      f.h.addTask(board.id, input());
      return flow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    });
    const running = flow.claim(jobs[1].key, 'main')!;
    f.store.change('fixture.remove', (s) => {
      s.boards = s.boards.filter((b) => b.id === jobs[2].id);
      const retained = new Set(s.boards[0].revisions.at(-1)!.taskIds);
      s.tasks = s.tasks.filter((t) => retained.has(t.id));
    });
    flow.fail(running, 'Subject removed during review');
    assert.equal(flow.get(running.key, 'main').status, 'stale');
    const runner = new LeadRunner(f.h, f.root);
    await runner.tick();
    await runner.stop();
    assert.equal(flow.get(jobs[0].key, 'main').status, 'stale');
    assert.equal(flow.get(jobs[2].key, 'main').stage, 1);
  } finally {
    f.cleanup();
  }
});

test('A real Git board resumes after process replacement without duplicating review or acceptance', async () => {
  const seed = await demos.acquire();
  const root = seed.root;
  const config = loadConfig(join(root, 'config.json'));
  let store = new Store(join(root, 'state.sqlite'));
  let h = new DevContour(store, config),
    lead = new LeadRunner(h, root);
  let scheduler: Scheduler | undefined;
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const b = h.createBoard('Recoverable board', '', 'main');
    h.addTask(b.id, input());
    const flow = new LeadWorkflow(h),
      job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const claimed = flow.claim(job.key, 'main')!;
    // Simulate process death after the domain commit but before recording the stage receipt.
    await lead.execute(claimed, new AbortController().signal);
    store.atomic(() => store.saveLocal('lead', 'main', job.key, { ...claimed, leaseUntil: 0 }));
    store.close();
    store = new Store(join(root, 'state.sqlite'));
    h = new DevContour(store, config);
    lead = new LeadRunner(h, root);
    await lead.tick();
    await lead.tick();
    assert.equal(
      store
        .allEvents()
        .filter((e) => e.type === 'board.approved' && (e.data as any).boardId === b.id).length,
      1,
    );
    scheduler = new Scheduler(h, root);
    await scheduler.init();
    await scheduler.drain();
    assert.ok(store.read().tasks.every((t) => t.status === 'done'));
    await lead.tick();
    await lead.tick();
    assert.equal(new LeadWorkflow(h).get(job.key, 'main').status, 'completed');
    assert.equal(
      store
        .allEvents()
        .filter((e) => e.type === 'board.accepted' && (e.data as any).boardId === b.id).length,
      1,
    );
    assert.equal(store.read().boards.length, 1);
    const taskId = store.read().tasks[0].id;
    config.workspaceGates = [
      {
        id: 'integration',
        repositoryId: 'main',
        kind: 'test',
        timeoutMs: 10000,
        command: [
          process.execPath,
          '--input-type=module',
          '-e',
          `import fs from 'node:fs';import assert from 'node:assert/strict';const d=JSON.parse(fs.readFileSync('deliverables/${taskId}.json'));assert.equal(d.id,'${taskId}');fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync('.reports/workspace.xml','<testsuite><testcase name="integrated-deliverable"/></testsuite>');`,
        ],
        report: { type: 'junit', path: '.reports/workspace.xml' },
        artifacts: [],
      },
    ];
    const change = new Workspace(h).create({
      title: 'Integrated result',
      description: 'Verify accepted board on its real Git snapshot.',
      boardIds: [b.id],
    });
    const sharedJob = new LeadWorkflow(h).start({
      kind: 'changeset',
      id: change.id,
      authorRuntime: 'codex',
    });
    // Стадия 1 начинает совместную проверку и ждёт её итога следующими
    // тактами: проверка живёт дольше такта (своим lease), а не под ним.
    for (let i = 0; i < 20 && new LeadWorkflow(h).get(sharedJob.key).status !== 'completed'; i++) {
      await lead.tick();
      await lead.settled();
    }
    assert.equal(new LeadWorkflow(h).get(sharedJob.key).status, 'completed');
    assert.ok(store.read().changeSets[0].acceptance);
  } finally {
    await lead.stop();
    await scheduler?.stop();
    store.close();
    seed.release();
  }
});

/** Демо-workspace в режиме агента с gate базы: проходит, пока base.txt входит в `accepted`. */
async function baseCheckFixture() {
  const seed = await demos.acquire();
  const root = seed.root;
  const config = loadConfig(join(root, 'config.json'));
  const gate = (accepted: string[]) => [
    process.execPath,
    '-e',
    `const fs=require('fs');const ok=${JSON.stringify(accepted)}.includes(fs.readFileSync('base.txt','utf8').trim());fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="base">'+(ok?'':'<failure message="broken"/>')+'</testcase></testsuite>');process.exit(ok?0:1)`,
  ];
  config.gates = [
    {
      id: 'base-gate',
      kind: 'test',
      timeoutMs: 10000,
      command: gate(['ok', 'ok 2', 'ok 3', 'ok 4', 'moved']),
      report: { type: 'junit', path: '.reports/base.xml' },
    },
  ];
  // Своя база состояния: политика с этим gate применяется при первом запуске.
  const store = new Store(join(root, 'base-check.sqlite'));
  const h = new DevContour(store, config);
  const lead = new LeadRunner(h, root);
  const target = 'refs/heads/' + config.targetBranch;
  /** Коммит на рабочей ветке; `move` — и перенос базы на него, как base-update. */
  const commit = async (text: string, files: Record<string, string> = {}, move = true) => {
    const all = { 'base.txt': text, ...files };
    for (const [path, content] of Object.entries(all))
      await writeFile(join(config.repository, path), content);
    await git(config.repository, 'add', '--', ...Object.keys(all));
    await git(config.repository, 'commit', '-qm', 'Base ' + text);
    const sha = await git(config.repository, 'rev-parse', 'HEAD');
    if (!move) return sha;
    const from = await git(config.repository, 'rev-parse', target);
    await git(config.repository, 'update-ref', target, sha);
    h.baseUpdated([{ repositoryId: 'main', from, to: sha }]);
    return sha;
  };
  const events = (type: string) => store.allEvents().filter((e) => e.type === type);
  const detail = () => store.read().waits?.find((w) => w.kind === 'base-check')?.detail ?? '';
  const cleanup = async () => {
    await lead.stop();
    store.close();
    seed.release();
  };
  return { root, config, store, h, lead, target, gate, commit, events, detail, cleanup };
}

test('В режиме агента workflow доски сам проверяет перенесённую базу gates: провал повторяется один раз и держит ожидание, прохождение продолжает очередь, чувствительный перенос ждёт решения', async () => {
  const f = await baseCheckFixture();
  const { store, h, lead, commit, events, detail } = f;
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const b = h.createBoard('Base check board', '', 'main');
    h.addTask(b.id, input());
    new LeadWorkflow(h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    await lead.tick();
    await lead.tick();
    assert.equal(
      store.read().paused,
      false,
      'workflow запустил очередь: ' + JSON.stringify(new LeadWorkflow(h).list('main')),
    );
    // Перенос в режиме агента сам ставит очередь на ожидание проверки базы.
    assert.deepEqual(h.holdForBaseUpdate(), { held: true });
    assert.equal(store.read().pauseReason, 'base-check');
    const broken = await commit('broken');
    await lead.tick();
    let state = store.read();
    assert.equal(state.paused, true, 'провал gate базы держит очередь');
    assert.equal(state.pauseReason, 'base-check');
    assert.match(detail(), /main\/base-gate/);
    assert.match(detail(), /queue --start/);
    // Провал повторён автоматически один раз, и оба прогона записаны.
    assert.deepEqual(
      events('base.check.failed').map((e) => (e.data as { sha: string }).sha),
      [broken, broken],
    );
    assert.deepEqual(
      events('base.check.started').map((e) => (e.data as { retry?: number }).retry ?? 0),
      [0, 1],
    );
    // Дальше та же база под тем же договором повторно не проверяется.
    await lead.tick();
    assert.equal(events('base.check.started').length, 2);
    const fixed = await commit('ok');
    await lead.tick();
    state = store.read();
    assert.equal(state.paused, false, 'прошедшая проверка базы продолжает очередь');
    assert.equal(state.waits, undefined);
    assert.deepEqual(
      events('base.check.passed').map((e) => (e.data as { sha: string }).sha),
      [fixed],
    );
    assert.equal(events('base.checked').length, 1);

    // Перенос, задевший чувствительный путь, gates этой базы не снимают — и
    // следующий безобидный перенос поверх него тоже: непроверенный диапазон
    // начинается с первой непроверенной базы.
    h.holdForBaseUpdate();
    // Защищённый файл приёмки демо-проекта (protectedPaths).
    await commit('ok 2', { 'verify.mjs': 'process.exit(0);\n' });
    await commit('ok 3');
    await lead.tick();
    state = store.read();
    assert.equal(state.paused, true, 'чувствительный перенос не снят автоматически');
    assert.equal(state.pauseReason, 'base-check');
    assert.match(detail(), /main:verify\.mjs/);
    // Карточка решения оператора называет кнопку панели, а не устаревший queue --start.
    assert.match(detail(), /«Подтвердить и запустить» в «Внимании»/);
    assert.doesNotMatch(detail(), /queue --start/);
    assert.equal(
      events('base.check.started').length,
      3,
      'gates чувствительного переноса не исполнялись',
    );
    assert.equal(events('base.check.held').length, 1);
    // Удержание помечено как решение человека — панель не выдаёт его за техническое.
    assert.ok(
      store
        .read()
        .waits?.find((w) => w.kind === 'base-check')
        ?.detail.startsWith(BASE_HELD_DETAIL),
    );
    await lead.tick();
    assert.equal(events('base.check.held').length, 1, 'та же причина — без нового события');
    // Решение человека или ведущего после проверки переноса — queue --start.
    h.pause(false);
    assert.equal(store.read().paused, false);

    // В режиме оператора ожидание остаётся решением человека.
    h.config.approvalMode = 'operator';
    assert.throws(() => h.holdForBaseUpdate(), /queue --pause/);
    h.pause(true, 'shutdown');
    await commit('ok 4');
    await lead.tick();
    assert.equal(store.read().pauseReason, 'base-check');
    assert.equal(events('base.check.started').length, 3);
  } finally {
    await f.cleanup();
  }
});

test('Проверка базы: сдвиг базы до решения не снимает ожидание; смена договора проверяет базу заново; пауза провайдера переносом не снимается', async () => {
  const f = await baseCheckFixture();
  const { root, config, store, h, target, gate, commit, events } = f;
  const roots = { data: root, state: root };
  const waiting = () => store.read().paused && store.read().pauseReason === 'base-check';
  try {
    h.pause(false);
    // Сдвиг базы в последний момент — внутри транзакции решения: сверка SHA
    // идёт в ней же, и ожидание не снимается по устаревшему прогону.
    h.holdForBaseUpdate();
    // Ожидание без записанного диапазона (перенос ещё идёт) не снимается.
    assert.equal(await checkBase(h, roots, () => {}), false);
    assert.ok(waiting());
    assert.equal(events('base.check.started').length, 0);
    await commit('ok');
    const moved = await commit('moved', {}, false);
    let shift = false;
    const late = () => {
      if (!shift && events('base.check.passed').length === 1) {
        shift = true;
        execFileSync('git', ['-C', config.repository, 'update-ref', target, moved]);
      }
    };
    assert.equal(await checkBase(h, roots, late, undefined), false);
    assert.ok(shift, 'база сдвинута после прохождения gates');
    assert.ok(waiting(), 'ожидание осталось');
    assert.equal(events('base.checked').length, 0);
    // Следующая проверка — уже сдвинутой базы.
    assert.equal(await checkBase(h, roots, () => {}), true);
    assert.deepEqual(
      events('base.check.passed')
        .map((e) => (e.data as { sha: string }).sha)
        .at(-1),
      moved,
    );
    assert.ok(!waiting());

    // Ожидание снято и поставлено заново под новый, ещё идущий перенос, пока
    // шла проверка: прежний прогон его не снимает.
    h.holdForBaseUpdate();
    await commit('ok 3');
    let rehold = false;
    const restart = () => {
      if (!rehold && events('base.check.passed').length === 3) {
        rehold = true;
        h.pause(false);
        h.holdForBaseUpdate();
      }
    };
    assert.equal(await checkBase(h, roots, restart), false);
    assert.ok(rehold);
    assert.ok(waiting(), 'новое ожидание переноса осталось');
    h.pause(false);

    // Провал под прежним договором после повтора стоит; новый договор
    // (исправленный gate) проверяет ту же базу заново.
    h.holdForBaseUpdate();
    await commit('flaky');
    assert.equal(await checkBase(h, roots, () => {}), false);
    assert.equal(await checkBase(h, roots, () => {}), false);
    assert.equal(events('base.check.failed').length, 2);
    config.gates[0].command = gate(['flaky']);
    assert.equal(await checkBase(h, roots, () => {}), true, 'новый договор — новый прогон');
    assert.equal(events('base.check.failed').length, 2);
    assert.ok(!waiting());

    // Пауза из-за отказа провайдера остаётся своей причиной со сбоями.
    store.change('fixture.runtime', (s) => {
      s.paused = true;
      s.pauseReason = 'runtime';
      s.pauseFailures = ['provider-auth'];
    });
    await commit('ok 2');
    let state = store.read();
    assert.equal(state.pauseReason, 'runtime');
    assert.deepEqual(state.pauseFailures, ['provider-auth']);
    assert.ok(
      state.waits?.some((w) => w.kind === 'base-check'),
      'перенос ждёт проверки',
    );
    assert.equal(await checkBase(h, roots, () => {}), true, 'не ожидание base-check');
    state = store.read();
    assert.equal(state.pauseReason, 'runtime', 'проверка базы паузу провайдера не снимает');

    // Снятое ожидание удаляет свой диапазон.
    h.pause(false);
    assert.equal(store.read().baseMoves, undefined, 'queue --start удалил диапазон');
    h.holdForBaseUpdate();
    const first = await commit('ok 3');
    assert.ok(store.read().baseMoves);
    // Откат на версию, не знающую диапазона: она снимает ожидание мимо него и
    // ставит своё. После обновления чужой диапазон не используется.
    store.change('fixture.older', (s) => {
      s.paused = false;
      s.pauseReason = undefined;
      s.waits = undefined;
    });
    await new Promise((r) => setTimeout(r, 5));
    const target2 = await commit('broken', {}, false);
    execFileSync('git', ['-C', config.repository, 'update-ref', target, target2]);
    store.change('fixture.older', (s) => {
      s.paused = true;
      s.pauseReason = 'base-check';
      s.waits = [
        { kind: 'base-check', detail: 'База прогонов перенесена', at: new Date().toISOString() },
      ];
    });
    const started = events('base.check.started').length;
    assert.equal(await checkBase(h, roots, () => {}), false, 'ожидание без своего диапазона');
    assert.equal(events('base.check.started').length, started, 'gates по чужому диапазону не шли');
    assert.ok(waiting());
    // Следующий перенос новой версии начинает диапазон заново.
    const from = await git(config.repository, 'rev-parse', target);
    const next = await commit('ok 4');
    assert.deepEqual(store.read().baseMoves?.bases, [{ repositoryId: 'main', from, to: next }]);
    assert.notEqual(from, first);
  } finally {
    await f.cleanup();
  }
});

test('base-update в режиме агента: работающая очередь встаёт на base-check; нечего переносить или отказ переноса — ожидание снято', async () => {
  const f = await baseCheckFixture();
  const { root, config, store, h, target, commit } = f;
  try {
    h.pause(false);
    // Переносить нечего: поставленное переносом ожидание снято.
    const none = await baseUpdateOperation(h, root);
    assert.deepEqual(none.updated, []);
    assert.equal(store.read().paused, false);
    // Перенос на работающей очереди без ручной паузы — ожидание base-check.
    const sha = await commit('ok', {}, false);
    const moved = await baseUpdateOperation(h, root);
    assert.equal(moved.updated.length, 1);
    const to = moved.updated[0].to;
    assert.equal(await git(config.repository, 'rev-parse', target), to);
    await git(config.repository, 'merge-base', '--is-ancestor', sha, to);
    let state = store.read();
    assert.equal(state.paused, true);
    assert.equal(state.pauseReason, 'base-check');
    assert.deepEqual(state.baseMoves?.bases, [
      { repositoryId: 'main', from: moved.updated[0].from, to },
    ]);
    // Событие harness: base-update — сдвиг базы человеком (`operator`).
    assert.deepEqual(
      executionOf(h)
        .store.events(0, 500)
        .filter((e) => e.type === 'base.moved')
        .map((e) => (e as { payload?: { by?: string } }).payload?.by),
      ['operator'],
    );
    h.pause(false);
    // Отказ переноса (рабочая ветка разошлась с базой и конфликтует) снимает
    // поставленное им ожидание; очередь остаётся работающей.
    const base = await git(config.repository, 'rev-parse', target);
    await commit('side', {}, false);
    await writeFile(join(config.repository, 'base.txt'), 'other');
    await git(config.repository, 'add', 'base.txt');
    const tree = await git(config.repository, 'write-tree');
    await git(config.repository, 'reset', '-q', '--hard', 'HEAD');
    const other = await git(config.repository, 'commit-tree', tree, '-p', base, '-m', 'Other');
    await git(config.repository, 'update-ref', target, other);
    await assert.rejects(baseUpdateOperation(h, root));
    state = store.read();
    assert.equal(state.paused, false, 'отказ переноса не оставил ожидания');
    // Пауза человека остаётся его паузой, а без неё в режиме оператора перенос отклонён.
    h.config.approvalMode = 'operator';
    await assert.rejects(baseUpdateOperation(h, root), /queue --pause/);
  } finally {
    await f.cleanup();
  }
});

test('base-update, пока сервер останавливается: ожидание переноса становится паузой остановки, отказ назван; отказ переноса — исходной ошибкой', async () => {
  const f = await baseCheckFixture();
  const { root, config, store, h, target, commit } = f;
  const stoppingServer = () => {
    h.leader('server');
    h.markStopping('server', true);
  };
  const stopped = () => {
    executionOf(h).engine.release('server');
    h.markStopping('server', false);
  };
  try {
    h.pause(false);
    stoppingServer();
    // Переносить нечего, но снять поставленное ожидание нельзя: отказ назван,
    // а ожидание без диапазона переноса не остаётся навсегда.
    await assert.rejects(
      baseUpdateOperation(h, root),
      (e: Error) =>
        e.message.startsWith('Переносить базу не пришлось, но очередь не продолжена') &&
        e.message.includes(SERVER_STOPPING),
    );
    let state = store.read();
    assert.equal(state.paused, true);
    assert.equal(state.pauseReason, 'shutdown', 'ожидание стало паузой остановки');
    stopped();
    h.pause(false);
    assert.equal(store.read().paused, false);

    // Отказ переноса во время остановки — исходной ошибкой, не SERVER_STOPPING.
    const base = await git(config.repository, 'rev-parse', target);
    await commit('side', {}, false);
    await writeFile(join(config.repository, 'base.txt'), 'other');
    await git(config.repository, 'add', 'base.txt');
    const tree = await git(config.repository, 'write-tree');
    await git(config.repository, 'reset', '-q', '--hard', 'HEAD');
    const other = await git(config.repository, 'commit-tree', tree, '-p', base, '-m', 'Other');
    await git(config.repository, 'update-ref', target, other);
    stoppingServer();
    await assert.rejects(
      baseUpdateOperation(h, root),
      (e: Error) => !e.message.includes(SERVER_STOPPING),
    );
    state = store.read();
    assert.equal(state.paused, true);
    assert.equal(state.pauseReason, 'shutdown');
    stopped();
  } finally {
    await f.cleanup();
  }
});

test('Запуск планировщика снимает отметку остановки упавшего сервера, но не действующую отметку ведущего', async () => {
  const f = await baseCheckFixture();
  const { root, store, h } = f;
  const marker = () => store.localRecord<{ owner: string } | null>('server', undefined, 'stopping');
  try {
    // Действующая: её владелец держит живую роль и останавливается.
    h.leader('live');
    h.markStopping('live', true);
    await new Scheduler(h, root).init();
    assert.equal(marker()?.owner, 'live');
    // Сервер упал посреди остановки: срок роли истёк.
    store.update('test.lease-expired', (d) => {
      d.leader = { ...d.leader!, leaseUntil: Date.now() - 1 };
    });
    await new Scheduler(h, root).init();
    assert.equal(marker(), null);
  } finally {
    await f.cleanup();
  }
});

test('Operator policy never starts automatic review or resumes a queue', async () => {
  const f = fixture();
  try {
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Operator workflow', '', 'main');
    f.h.addTask(b.id, input());
    const flow = new LeadWorkflow(f.h);
    flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    await runner.tick();
    await runner.stop();
    assert.equal(flow.list('main')[0].attempts, 0);
    assert.equal(f.store.read().tasks[0].status, 'draft');
    assert.equal(f.store.read().paused, true);
  } finally {
    f.cleanup();
  }
});

test('Waiting cycles resume shutdown pauses but preserve explicit user pauses', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Paused workflow', '', 'main');
    f.h.addTask(b.id, input());
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    await runner.tick();
    await runner.tick();
    f.h.pause(true);
    f.h.pause(true, 'shutdown');
    await runner.tick();
    assert.equal(f.store.read().paused, true);
    f.h.pause(false);
    f.h.pause(true, 'shutdown');
    await runner.tick();
    assert.equal(f.store.read().paused, false);
    assert.equal(flow.get(job.key, 'main').stage, 2);
    assert.equal(flow.get(job.key, 'main').attempts, 0);
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('Пока сервер останавливается, стадия, снимающая паузу остановки, прерывается: задание возвращается в очередь, а не проваливается', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Stopping workflow', '', 'main');
    f.h.addTask(b.id, input());
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    await runner.tick();
    await runner.tick();
    f.h.pause(false);
    f.h.pause(true, 'shutdown');
    // Сервер, ведущий очередь, начал остановку: снять паузу нельзя.
    f.h.leader('server');
    f.h.markStopping('server', true);
    await runner.tick();
    const line = flow.get(job.key, 'main');
    assert.equal(line.status, 'queued', line.error);
    assert.equal(line.attempts, 0);
    assert.equal(f.store.read().pauseReason, 'shutdown');
    // Остановка закончилась: следующая стадия снимает паузу.
    executionOf(f.h).engine.release('server');
    await runner.tick();
    assert.equal(f.store.read().paused, false);
    assert.equal(flow.get(job.key, 'main').stage, 2);
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('Повторная пауза человека после старта workflow — его новое решение: цикл её не снимает', async () => {
  // Пауза, поставленная до старта workflow, — «очередь ещё не запускали», и
  // цикл её снимает. Повторное нажатие паузы после старта — новое решение
  // человека: время паузы обновляется, и цикл её не снимает.
  const f = fixture();
  const later = () => new Promise((r) => setTimeout(r, 5));
  try {
    const b = f.h.createBoard('Paused again', '', 'main');
    f.h.addTask(b.id, input());
    f.h.pause(true);
    await later();
    const flow = new LeadWorkflow(f.h);
    flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    await later();
    f.h.pause(true);
    const runner = new LeadRunner(f.h, f.root);
    for (let i = 0; i < 3; i++) await runner.tick();
    await runner.stop();
    assert.equal(f.store.read().paused, true, 'пауза человека не снята циклом');
    assert.equal(f.store.read().pauseReason, 'operator');
  } finally {
    f.cleanup();
  }
});

test('Отмена из принятой ревизии не останавливает workflow следующего этапа', async () => {
  const f = fixture();
  try {
    const plan = (title: string, keys: string[]) => ({
      title,
      description: 'Цель: ' + title,
      tasks: keys.map((key) => ({ ...input('Task ' + key), key, dependsOn: [], contracts: [] })),
    });
    const { boardId } = f.h.importPlan(plan('Release', ['done', 'dropped']));
    const [kept, dropped] = f.store.read().tasks;
    f.h.approve(boardId);
    f.h.cancel(dropped.id, 'Решено в контракте');
    complete(f.h, kept.id);
    f.h.accept(boardId, MERGED);
    f.h.importPlan(plan('Stage two', ['next']), boardId);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    await runner.tick();
    await runner.tick();
    await runner.tick();
    await runner.stop();
    const state = flow.get(job.key, 'main');
    assert.notEqual(state.status, 'failed', String(state.error));
    assert.equal(state.stage, 2);
    assert.equal(f.store.read().tasks.find((t) => t.title === 'Task next')!.status, 'ready');
    // Отмена человеком в самой ревизии этапа по-прежнему останавливает работу.
    f.h.cancel(
      f.store.read().tasks.find((t) => t.title === 'Task next')!.id,
      'Не нужна',
      'operator',
    );
    const again = new LeadRunner(f.h, f.root);
    await again.tick();
    await again.stop();
    const failed = flow.get(job.key, 'main');
    assert.equal(failed.status, 'failed');
    assert.match(String(failed.error), /остановлена человеком/);
  } finally {
    f.cleanup();
  }
});

test('Отмена ведущим (--by host) не останавливает задание доски и не называется остановкой человеком', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Scope cut', '', 'main');
    const dropped = f.h.addTask(b.id, input('Dropped by the lead'));
    const kept = f.h.addTask(b.id, input('Kept'));
    f.h.approve(b.id);
    f.h.cancel(dropped.id, 'Заменена новой задачей', 'host');
    assert.equal(f.store.read().tasks.find((t) => t.id === dropped.id)!.cancelledBy, 'host');
    // Повторная отмена другим актёром прежнего актёра не переписывает.
    f.h.cancel(dropped.id, 'again', 'operator');
    assert.equal(f.store.read().tasks.find((t) => t.id === dropped.id)!.cancelledBy, 'host');
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    for (let i = 0; i < 3; i++) await runner.tick();
    let state = flow.get(job.key, 'main');
    assert.notEqual(state.status, 'failed', String(state.error));
    assert.equal(state.stage, 2);
    complete(f.h, kept.id);
    const s = f.store.read();
    const live = s.tasks.filter((t) => t.status !== 'cancelled');
    assert.ok(live.every((t) => t.status === 'done'));
    // Стадия приёмки ведёт доску к приёмке без отменённой задачи.
    assert.deepEqual(loopOutlook(f.h, s, flow.get(job.key, 'main')), { step: 'accept' });
    await runner.stop();
    state = flow.get(job.key, 'main');
    assert.doesNotMatch(String(state.error ?? ''), /человеком/);
  } finally {
    f.cleanup();
  }
});

test('Живая задача, зависящая от отменённой ведущим, останавливает задание с этой причиной', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Orphan', '', 'main');
    const dropped = f.h.addTask(b.id, input('Dropped by the lead'));
    const orphan = f.h.addTask(b.id, input('Needs the dropped one', [dropped.id]));
    f.h.approve(b.id);
    f.h.cancel(dropped.id, 'Не нужна', 'host');
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    for (let i = 0; i < 3; i++) await runner.tick();
    await runner.stop();
    const state = flow.get(job.key, 'main');
    assert.equal(state.status, 'failed');
    assert.match(
      String(state.error),
      new RegExp(`${orphan.id}: зависит от задачи ${dropped.id}, отменённой ведущим`),
    );
    assert.doesNotMatch(String(state.error), /человеком/);
  } finally {
    f.cleanup();
  }
});

test('Отмена ведущим уже выданной и упавшей задачи останавливает задание, как отмена человеком', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Failed then cut', '', 'main');
    const failing = f.h.addTask(b.id, input('Fails its gate'));
    const kept = f.h.addTask(b.id, input('Kept'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, failing.id);
    f.h.fail(run.id, run.token, 'gate failed', false, 'gate');
    // Ведущий отменяет задачу, которую не удалось сделать зелёной.
    f.h.cancel(failing.id, 'Не удаётся, убираю из доски', 'host');
    complete(f.h, kept.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    assert.notDeepEqual(loopOutlook(f.h, f.store.read(), { ...job, stage: 2 }), {
      step: 'accept',
    });
    const runner = new LeadRunner(f.h, f.root);
    for (let i = 0; i < 3; i++) await runner.tick();
    await runner.stop();
    const state = flow.get(job.key, 'main');
    assert.equal(state.status, 'failed');
    assert.match(String(state.error), new RegExp(`${failing.id}: Работа остановлена человеком`));
    assert.notEqual(f.store.read().boards[0].revisions.at(-1)!.status, 'accepted');
  } finally {
    f.cleanup();
  }
});

test('Отмена без записанного актёра (прежняя версия) останавливает задание как отмена человеком', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Legacy cancel', '', 'main');
    const dropped = f.h.addTask(b.id, input('Cancelled before the actor was recorded'));
    f.h.addTask(b.id, input('Kept'));
    f.h.approve(b.id);
    f.h.cancel(dropped.id, 'Не нужна', 'host');
    f.store.change('fixture.legacy', (s) => {
      delete s.tasks.find((t) => t.id === dropped.id)!.cancelledBy;
    });
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    for (let i = 0; i < 3; i++) await runner.tick();
    await runner.stop();
    const state = flow.get(job.key, 'main');
    assert.equal(state.status, 'failed');
    assert.match(String(state.error), new RegExp(`${dropped.id}: Работа остановлена человеком`));
  } finally {
    f.cleanup();
  }
});

test('Повтор и возврат в черновик снимают актёра отмены; отмена без актёра — человеком', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Actor lifecycle', '', 'main');
    const t = f.h.addTask(b.id, input('Cancelled and back'));
    f.h.approve(b.id);
    const actor = () => f.store.read().tasks.find((x) => x.id === t.id)!.cancelledBy;
    f.h.cancel(t.id, 'Ведущий убрал', 'host');
    assert.equal(actor(), 'host');
    f.h.retry(t.id);
    assert.equal(actor(), undefined);
    f.h.cancel(t.id, 'Снова убрал', 'host');
    f.h.reopen(t.id, 'Возвращаю в черновик для правки');
    assert.equal(actor(), undefined);
    // Без актёра отмена записывается как отмена человеком.
    f.h.cancel(t.id);
    assert.equal(actor(), 'operator');
  } finally {
    f.cleanup();
  }
});

test('Реальный Git: задание доски с задачей, отменённой ведущим, принимает доску без неё', async () => {
  const seed = await demos.acquire();
  const root = seed.root;
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const lead = new LeadRunner(h, root);
  let scheduler: Scheduler | undefined;
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const b = h.createBoard('Board with a lead cancel', '', 'main');
    const dropped = h.addTask(b.id, input('Draft replaced by the lead'));
    h.addTask(b.id, input('Kept task'));
    // Черновик отменён ведущим до старта задания, как при замене задачи.
    h.cancel(dropped.id, 'Заменена новой задачей', 'host');
    const flow = new LeadWorkflow(h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    await lead.tick();
    await lead.tick();
    assert.notEqual(flow.get(job.key, 'main').status, 'failed', flow.get(job.key, 'main').error);
    scheduler = new Scheduler(h, root);
    await scheduler.init();
    await scheduler.drain();
    for (let i = 0; i < 3 && flow.get(job.key, 'main').status !== 'completed'; i++)
      await lead.tick();
    const state = flow.get(job.key, 'main');
    assert.equal(state.status, 'completed', state.error);
    assert.equal(store.read().boards[0].revisions.at(-1)!.status, 'accepted');
  } finally {
    await lead.stop();
    await scheduler?.stop();
    store.close();
    seed.release();
  }
});

test('ChangeSet не требует done от отменённой задачи доски', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const kept = f.h.addTask(b.id, input('Kept'));
    const dropped = f.h.addTask(b.id, input('Dropped'));
    f.h.approve(b.id);
    f.h.cancel(dropped.id, 'Решено в контракте');
    complete(f.h, kept.id);
    f.h.accept(b.id, MERGED);
    const snapshot = changeSnapshot(f.store.read(), {
      boardIds: [b.id],
    } as Parameters<typeof changeSnapshot>[1]);
    assert.deepEqual(
      snapshot.tasks.map((t) => t.id),
      [kept.id],
    );
  } finally {
    f.cleanup();
  }
});

/** Одобрение независимого ревью контракта (как `review-contract` в режиме агента). */
const reviewed = (root: string, id: string) => ({
  actor: 'agent' as const,
  authorRuntime: 'codex' as const,
  reviewerRuntime: 'claude' as const,
  artifact: join(root, 'decisions', id),
  digest: 'review-' + id,
});

test('Перенос базы только с документом контракта в одобренной ревью редакции снимает цикл с доказательством; другая редакция и файл приёмки рядом ждут человека, и ведущий это видит', async () => {
  const f = await baseCheckFixture();
  const { root, config, store, h, lead, commit, events, detail } = f;
  const doc = 'docs/contracts/api.md';
  const text = '# API v1\n\nGET /items returns the list of items.\n';
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    await mkdir(join(config.repository, 'docs', 'contracts'), { recursive: true });
    const b = h.createBoard('Reviewed contract board', '', 'main');
    h.addTask(b.id, input());
    const flow = new LeadWorkflow(h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    await lead.tick();
    await lead.tick();
    assert.equal(store.read().paused, false, 'workflow запустил очередь');
    const notes = () =>
      flow.get(job.key, job.owner).history.filter((x) => x.event === 'waiting:base-held');

    // (a) Документ, одобренный независимым ревью, перенесён ровно в этой
    // редакции: цикл снимает ожидание после gates и называет доказательство.
    const approved = h.contract('API v1', text, reviewed(root, 'review-1'), undefined, doc);
    h.holdForBaseUpdate();
    const first = await commit('ok', { [doc]: text });
    await lead.tick();
    let state = store.read();
    assert.equal(state.paused, false, 'одобренный документ снят циклом: ' + detail());
    assert.equal(events('base.check.held').length, 0);
    assert.equal(events('base.check.passed').length, 1, 'gates базы прошли до снятия');
    const lifted = events('base.checked').at(-1)!.data as {
      liftedBy?: string;
      reviewedContracts?: unknown[];
    };
    assert.equal(lifted.liftedBy, 'agent');
    assert.deepEqual(lifted.reviewedContracts, [
      {
        repositoryId: 'main',
        path: doc,
        blob: await git(config.repository, 'rev-parse', `${first}:${doc}`),
        contractId: approved.id,
        reviewId: 'review-1',
        authorRuntime: 'codex',
        reviewerRuntime: 'claude',
      },
    ]);
    assert.equal(notes().length, 0);

    // (b) Документ изменён после ревью: blob не тот, что одобрен, — ждёт человека.
    h.holdForBaseUpdate();
    await commit('ok 2', { [doc]: text + '\nEdited after the review.\n' });
    await lead.tick();
    state = store.read();
    assert.equal(state.paused, true, 'изменённый после ревью документ не снят');
    assert.equal(state.pauseReason, 'base-check');
    assert.ok(detail().startsWith(BASE_HELD_DETAIL), detail());
    assert.match(detail(), /main:docs\/contracts\/api\.md/);
    assert.equal(events('base.check.held').length, 1);
    assert.equal(events('base.check.started').length, 1, 'gates удержанного переноса не шли');

    // (c) Удержание видно ведущему: host.next — подтверждение оператора с
    // путями, пункт attention_list по умолчанию (ведущий), отметка в истории
    // задания — одна на удержание, а не на такт.
    const next = devcontourHandoff(h, {}).host.next!;
    assert.equal(next.action, 'operator', JSON.stringify(next));
    assert.equal(next.code, 'base-held');
    assert.deepEqual(next.params, { paths: ['main:docs/contracts/api.md'] });
    assert.equal(next.boardId, b.id);
    assert.match(next.detail, /^operator: confirm the base move/);
    const leadItems = new AgentService(h).execute({ operation: 'attention_list', input: {} })
      .items as { sourceKey: string; actor: string; reason: string }[];
    const item = leadItems.find((i) => i.sourceKey === 'wait:base-check:lead');
    assert.ok(item, JSON.stringify(leadItems.map((i) => i.sourceKey)));
    assert.equal(item.actor, 'lead');
    assert.match(item.reason, /Подтвердить перенос должен человек/);
    assert.match(item.reason, /main:docs\/contracts\/api\.md/);
    assert.equal(notes().length, 1, 'задание отметило ожидание человека');
    await lead.tick();
    await lead.tick();
    assert.equal(notes().length, 1, 'повторные такты той же отметки не добавляют');
    assert.equal(events('base.check.held').length, 1);
    // Решение человека.
    h.pause(false);

    // (d) Документ в новой одобренной редакции, но рядом файл приёмки
    // (protectedPaths демо-проекта): весь перенос ждёт человека.
    const v2 = text + '\nGET /items/:id returns one item.\n';
    h.contract('API v1', v2, reviewed(root, 'review-2'), undefined, doc);
    h.holdForBaseUpdate();
    await commit('ok 3', { [doc]: v2, 'verify.mjs': 'process.exit(0);\n' });
    await lead.tick();
    state = store.read();
    assert.equal(state.paused, true, 'файл приёмки рядом держит перенос');
    assert.match(detail(), /main:verify\.mjs/);
    assert.doesNotMatch(detail(), /main:docs\/contracts\/api\.md/, 'одобренный документ не назван');
    assert.equal(events('base.check.started').length, 1);
    assert.deepEqual(devcontourHandoff(h, {}).host.next?.params, { paths: ['main:verify.mjs'] });
    assert.equal(notes().length, 2, 'новое удержание — новая отметка');
    await lead.tick();
    assert.equal(notes().length, 2);
    h.pause(false);
  } finally {
    await f.cleanup();
  }
});

test('Доказательство ревью документа контракта: откат к прежней редакции, документ-файл приёмки, рабочий файл вместо blob, неполное или зависимое одобрение и удалённый документ переноса не снимают; новая редакция за время gates — тоже', async () => {
  const f = await baseCheckFixture();
  const { root, config, store, h, target, commit, events, detail } = f;
  const roots = { data: root, state: root };
  const doc = 'docs/contracts/api.md';
  const waiting = () => store.read().paused && store.read().pauseReason === 'base-check';
  const lifts = () =>
    events('base.checked').filter((e) => (e.data as { liftedBy?: string }).liftedBy).length;
  /** Перенос держит человек и называет путь; gates не шли, снятия нет. */
  const held = async (path: string, why: string) => {
    const started = events('base.check.started').length;
    const before = lifts();
    assert.equal(await checkBase(h, roots, () => {}), false, why);
    assert.ok(waiting(), why);
    assert.ok(detail().startsWith(BASE_HELD_DETAIL), `${why}: ${detail()}`);
    assert.ok(detail().includes(`main:${path}`), `${why}: ${detail()}`);
    assert.equal(events('base.check.started').length, started, `${why}: gates не шли`);
    assert.equal(lifts(), before, why);
    h.pause(false);
  };
  try {
    h.pause(false);
    await mkdir(join(config.repository, 'docs', 'contracts'), { recursive: true });
    const v1 = '# API\n\nFirst reviewed text.\n';
    const v2 = '# API\n\nSecond reviewed text.\n';
    h.contract('API', v1, reviewed(root, 'r-v1'), undefined, doc);
    h.contract('API', v2, reviewed(root, 'r-v2'), undefined, doc);
    // Последняя одобренная редакция снимается (контроль фикстуры).
    h.holdForBaseUpdate();
    await commit('ok', { [doc]: v2 });
    assert.equal(await checkBase(h, roots, () => {}), true, detail());
    assert.equal(lifts(), 1);

    // Откат к прежней, тоже одобренной редакции: не последняя — человек.
    h.holdForBaseUpdate();
    await commit('ok 2', { [doc]: v1 });
    await held(doc, 'откат к прежней редакции');

    // Рабочий файл совпадает с одобренным текстом, а в перенесённом commit —
    // другой: сверяется blob на базе, не рабочее дерево.
    h.holdForBaseUpdate();
    await commit('ok 3', { [doc]: v2 + 'Unreviewed edit.\n' });
    await writeFile(join(config.repository, doc), v2);
    await held(doc, 'рабочий файл вместо blob');
    await git(config.repository, 'checkout', '--', doc);

    // Одобрение без ревьюера, без решения ревью или ревью тем же runtime.
    const partial = [
      { actor: 'agent' as const, authorRuntime: 'codex' as const, artifact: join(root, 'x') },
      {
        actor: 'agent' as const,
        authorRuntime: 'codex' as const,
        reviewerRuntime: 'claude' as const,
      },
      { ...reviewed(root, 'r-same'), reviewerRuntime: 'codex' as const },
      { actor: 'agent' as const, reviewerRuntime: 'claude' as const, artifact: join(root, 'y') },
    ];
    for (const [i, approval] of partial.entries()) {
      const text = `# API\n\nPartial approval ${i}.\n`;
      h.contract('API', text, approval, undefined, doc);
      h.holdForBaseUpdate();
      await commit(i % 2 ? 'ok' : 'ok 2', { [doc]: text });
      await held(doc, 'неполное одобрение ' + JSON.stringify(approval));
    }

    // Документ контракта и одновременно файл приёмки (protectedPaths демо).
    const acceptance = 'process.exit(0);\n';
    h.contract('Acceptance', acceptance, reviewed(root, 'r-acc'), undefined, 'verify.mjs');
    h.holdForBaseUpdate();
    await commit('ok 3', { 'verify.mjs': acceptance });
    await held('verify.mjs', 'документ и файл приёмки');

    // Удалённый документ: одобренной редакции на базе нет.
    const v3 = '# API\n\nThird reviewed text.\n';
    h.contract('API', v3, reviewed(root, 'r-v3'), undefined, doc);
    h.holdForBaseUpdate();
    await commit('ok 4', { [doc]: v3 });
    assert.equal(await checkBase(h, roots, () => {}), true, detail());
    h.holdForBaseUpdate();
    await git(config.repository, 'rm', '-q', '--', doc);
    await git(config.repository, 'commit', '-qm', 'Drop the contract document');
    const from = await git(config.repository, 'rev-parse', target);
    const dropped = await git(config.repository, 'rev-parse', 'HEAD');
    await git(config.repository, 'update-ref', target, dropped);
    h.baseUpdated([{ repositoryId: 'main', from, to: dropped }]);
    await held(doc, 'удалённый документ');
    // git rm убрал и опустевший каталог.
    await mkdir(join(config.repository, 'docs', 'contracts'), { recursive: true });

    // Новая редакция документа за время gates: доказательство устарело,
    // ожидание остаётся; следующая проверка держит перенос человеку.
    const v4 = '# API\n\nFourth reviewed text.\n';
    const v5 = '# API\n\nFifth text, registered during the gates.\n';
    h.contract('API', v4, reviewed(root, 'r-v4'), undefined, doc);
    h.holdForBaseUpdate();
    await commit('ok', { [doc]: v4 });
    const passed = events('base.check.passed').length;
    let registered = false;
    const late = () => {
      if (!registered && events('base.check.passed').length === passed + 1) {
        registered = true;
        h.contract('API', v5, reviewed(root, 'r-v5'), undefined, doc);
      }
    };
    const before = lifts();
    assert.equal(await checkBase(h, roots, late), false);
    assert.ok(registered, 'редакция зарегистрирована после gates');
    assert.ok(waiting(), 'ожидание осталось');
    assert.equal(lifts(), before, 'снятия по устаревшему доказательству нет');
    await held(doc, 'новая редакция за время gates');
  } finally {
    await f.cleanup();
  }
});

test('Перенос базы с защищённым путём кириллицей ждёт человека: пути переноса читаются как есть, без экранирования git', async () => {
  const f = await baseCheckFixture();
  const { root, config, store, h, commit, events, detail } = f;
  const roots = { data: root, state: root };
  const cyrillic = 'приёмка/сценарии.md';
  try {
    h.pause(false);
    repository(h.config, 'main').protectedPaths.push(cyrillic);
    await mkdir(join(config.repository, 'приёмка'), { recursive: true });
    h.holdForBaseUpdate();
    await commit('ok', { [cyrillic]: '# Сценарии\n' });
    assert.equal(await checkBase(h, roots, () => {}), false, 'защищённый путь не снят gates');
    assert.equal(store.read().pauseReason, 'base-check');
    assert.ok(detail().startsWith(BASE_HELD_DETAIL), detail());
    assert.ok(detail().includes(`main:${cyrillic}`), detail());
    assert.equal(events('base.check.started').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('Документ контракта в одобренной редакции: одобрение оператора, прежняя редакция открытой задачи и режим оператора переноса не снимают', async () => {
  const f = await baseCheckFixture();
  const { root, config, store, h, commit, events, detail } = f;
  const roots = { data: root, state: root };
  const doc = 'docs/contracts/api.md';
  const waiting = () => store.read().paused && store.read().pauseReason === 'base-check';
  try {
    h.pause(false);
    await mkdir(join(config.repository, 'docs', 'contracts'), { recursive: true });
    // Одобрение человека (не независимое ревью) — не доказательство для цикла.
    const manual = '# Manual\n';
    h.contract('Manual', manual, { actor: 'operator' }, undefined, doc);
    h.holdForBaseUpdate();
    await commit('ok', { [doc]: manual });
    assert.equal(await checkBase(h, roots, () => {}), false);
    assert.ok(waiting());
    assert.match(detail(), /main:docs\/contracts\/api\.md/);
    h.pause(false);

    // Открытая задача закреплена за прежней редакцией документа: новая
    // одобренная редакция поменяла бы её договор без contract-change.
    const old = h.contract('API', '# API\n', reviewed(root, 'review-old'), undefined, doc);
    const b = h.createBoard('Pinned board', '', 'main');
    h.addTask(b.id, { ...input(), contracts: [old.id] });
    const fresh = '# API\n\nReviewed again.\n';
    h.contract('API', fresh, reviewed(root, 'review-new'), undefined, doc);
    h.holdForBaseUpdate();
    await commit('ok 2', { [doc]: fresh });
    assert.equal(await checkBase(h, roots, () => {}), false);
    assert.ok(waiting());
    assert.match(detail(), /main:docs\/contracts\/api\.md/);
    h.pause(false);
    store.change('fixture.drop-pinned', (s) => {
      s.tasks = s.tasks.filter((t) => !t.contracts.includes(old.id));
    });

    // Режим оператора: даже документ в одобренной ревью редакции цикл не снимает.
    h.config.approvalMode = 'operator';
    const third = '# API\n\nReviewed a third time.\n';
    h.contract('API', third, reviewed(root, 'review-third'), undefined, doc);
    h.pause(true, 'shutdown');
    await commit('ok 3', { [doc]: third });
    assert.equal(store.read().pauseReason, 'base-check');
    const started = events('base.check.started').length;
    assert.equal(await checkBase(h, roots, () => {}), false);
    assert.ok(waiting(), 'режим оператора: ожидание остаётся решением человека');
    assert.equal(events('base.check.started').length, started, 'gates не исполнялись');
    assert.equal(
      events('base.checked').filter((e) => (e.data as { liftedBy?: string }).liftedBy).length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
