import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockedError, type Task } from '../src/core/model.ts';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { demoPool } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import {
  adapters,
  cliArguments,
  reviewTransitions,
  type AgentRequest,
} from '../src/runner/adapters.ts';
import { git, command } from '../src/runner/process.ts';
import { runCheck } from 'devcontour-harness';
import { input, fixture, reapprove } from './helpers.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { ProjectMemory } from '../src/application/memory.ts';
import { repositories } from '../src/core/repositories.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { executionOf } from '../src/harness/execution.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { taskOwner } from '../src/core/sync-state.ts';
const demos = demoPool(setupDemo);
after(() => demos.close());
async function runtimeFixture() {
  const seed = await demos.acquire();
  const root = seed.root;
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const scheduler = new Scheduler(h, root);
  await scheduler.init();
  return {
    root,
    config,
    store,
    h,
    scheduler,
    cleanup: async () => {
      await scheduler.stop();
      store.close();
      seed.release();
    },
  };
}
test('Writer and both reviewers use the same memory snapshot despite a later knowledge correction', async () => {
  const f = await runtimeFixture();
  let scheduler: Scheduler | undefined;
  try {
    const task = f.store.read().tasks.find((t) => t.status === 'ready')!;
    const memory = new ProjectMemory(f.h);
    const record = memory.retain({
      repositoryId: 'main',
      kind: 'fact',
      subject: task.id,
      text: task.title + ' OriginalMemoryMarker',
      sources: ['README.md'],
    });
    const prompts: string[] = [];
    scheduler = new Scheduler(f.h, f.root, {
      ...adapters,
      demo: {
        ...adapters.demo,
        execute: async (request) => {
          if (request.task.id === task.id) {
            prompts.push(request.prompt);
            if (!request.review)
              memory.retain({
                repositoryId: 'main',
                kind: 'fact',
                subject: task.id,
                text: task.title + ' CorrectedMemoryMarker',
                sources: ['README.md'],
                supersedes: [record.id],
              });
          }
          return adapters.demo.execute(request);
        },
      },
    });
    await scheduler.init();
    f.h.pause(false);
    await scheduler.drain();
    const run = f.store.read().runs.find((r) => r.taskId === task.id)!;
    assert.equal(run.status, 'succeeded');
    assert.deepEqual(run.memory!.ids, [record.id]);
    assert.equal(prompts.length, 3);
    assert.ok(
      prompts.every(
        (p) => p.includes('OriginalMemoryMarker') && !p.includes('CorrectedMemoryMarker'),
      ),
    );
  } finally {
    await scheduler?.stop();
    await f.cleanup();
  }
});
test('Real git pipeline integrates concurrent siblings and verifies every candidate and merged SHA', async () => {
  const f = await runtimeFixture();
  try {
    f.h.pause(false);
    await f.scheduler.drain();
    const state = f.store.read();
    assert.ok(
      state.tasks.every((t) => t.status === 'done'),
      JSON.stringify(state.tasks),
    );
    const current = await git(f.config.repository, 'rev-parse', f.scheduler.target);
    for (const r of state.runs) {
      assert.equal(r.status, 'succeeded');
      assert.equal(r.evidence.length, 4);
      assert.notEqual(r.candidateSha, r.integrationSha);
      await git(f.config.repository, 'merge-base', '--is-ancestor', r.integrationSha!, current);
    }
    assert.equal(await git(f.config.repository, 'branch', '--show-current'), 'main');
    assert.equal(await git(f.config.repository, 'status', '--porcelain'), '');
    const b = state.boards[1];
    const firstTaskId = b.revisions[0].taskIds[0];
    const originalSha = state.tasks.find((t) => t.id === firstTaskId)!.resultSha;
    const unrelated = await git(
      f.config.repository,
      'commit-tree',
      await git(f.config.repository, 'rev-parse', `${current}^{tree}`),
      '-m',
      'Unintegrated test result',
    );
    f.store.change('fixture.unintegrated', (s) => {
      s.tasks.find((t) => t.id === firstTaskId)!.resultSha = unrelated;
    });
    await assert.rejects(acceptBoard(f.h, b.id, 'codex'), /merge-base/);
    assert.equal(f.store.read().boards[1].revisions[0].status, 'active');
    f.store.change('fixture.restore', (s) => {
      s.tasks.find((t) => t.id === firstTaskId)!.resultSha = originalSha;
    });
    f.config.approvalMode = 'operator';
    assert.equal((await acceptBoard(f.h, b.id, 'codex')).status, 'awaiting-operator');
    assert.equal(f.store.read().boards[1].revisions[0].status, 'active');
    f.config.approvalMode = 'agent';
    assert.equal((await acceptBoard(f.h, b.id, 'codex')).status, 'accepted');
    assert.equal(f.store.read().boards[1].revisions[0].acceptance?.actor, 'agent');
    f.h.correct(
      b.id,
      [b.revisions[0].taskIds[0]],
      'Change the search contract and rerun integration',
    );
    f.h.approve(b.id);
    await f.scheduler.drain();
    assert.ok(f.store.read().tasks.every((t) => t.status === 'done'));
  } finally {
    await f.cleanup();
  }
});
test('A missing required tool fails closed and never advances integration ref', async () => {
  const f = await runtimeFixture();
  try {
    const before = await git(f.config.repository, 'rev-parse', f.scheduler.target);
    f.config.gates[0].command = ['devcontour-tool-that-does-not-exist'];
    reapprove(f.h);
    f.h.pause(false);
    await f.scheduler.drain();
    const failed = f.store.read().tasks.filter((t) => t.status === 'failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].failure!, /ENOENT/);
    assert.equal(await git(f.config.repository, 'rev-parse', f.scheduler.target), before);
    assert.ok(
      f.store
        .read()
        .runs.at(-1)!
        .evidence.some((e) => !e.passed),
    );
  } finally {
    await f.cleanup();
  }
});
test('A reviewer refusal blocks publication', async () => {
  const f = await runtimeFixture();
  try {
    const rejected = {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          if (r.review)
            return {
              data: {
                approved: false,
                summary: 'Missing acceptance criterion',
                findings: [{ severity: 'blocking', message: 'No expected behaviour' }],
              },
              log: 'rejected',
              command: ['fixture-review'],
            };
          return adapters.demo.execute(r);
        },
      },
    };
    const scheduler = new Scheduler(f.h, f.root, rejected);
    const before = await git(f.config.repository, 'rev-parse', scheduler.target);
    f.h.pause(false);
    await scheduler.drain();
    assert.equal(
      f.store
        .read()
        .tasks.find((t) => t.status === 'failed')
        ?.failure?.includes('ревью'),
      true,
    );
    assert.equal(await git(f.config.repository, 'rev-parse', scheduler.target), before);
  } finally {
    await f.cleanup();
  }
});
test('A reviewer that creates an untracked file cannot approve an unchanged candidate', async () => {
  const f = await runtimeFixture();
  try {
    const priorRuns = new Set(f.store.read().runs.map((r) => r.id));
    const scheduler = new Scheduler(f.h, f.root, {
      ...adapters,
      demo: {
        ...adapters.demo,
        async execute(r: AgentRequest) {
          const result = await adapters.demo.execute(r);
          if (r.review) await writeFile(join(r.cwd, 'reviewer-created.txt'), 'unexpected write');
          return result;
        },
      },
    });
    const before = await git(f.config.repository, 'rev-parse', scheduler.target);
    f.h.pause(false);
    await scheduler.drain();
    assert.equal(await git(f.config.repository, 'rev-parse', scheduler.target), before);
    const reviews = f.store
      .read()
      .runs.filter((r) => !priorRuns.has(r.id))
      .flatMap((r) => r.evidence)
      .filter((e) => e.kind === 'review');
    assert.ok(reviews.length);
    assert.ok(reviews.every((e) => !e.passed));
    assert.ok(reviews.every((e) => e.inspection?.mode === 'diff-only'));
  } finally {
    await f.cleanup();
  }
});
test('Changes to gate policy files are rejected before commit', async () => {
  const f = await runtimeFixture();
  try {
    const modified = {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          const result = await adapters.demo.execute(r);
          if (!r.review) await writeFile(join(r.cwd, 'verify.mjs'), 'process.exit(0)');
          return result;
        },
      },
    };
    const scheduler = new Scheduler(f.h, f.root, modified);
    f.h.pause(false);
    await scheduler.drain();
    assert.match(f.store.read().tasks.find((t) => t.status === 'failed')!.failure!, /защищённые/);
  } finally {
    await f.cleanup();
  }
});
test('Тысячи посторонних файлов в кандидате не перечитывают состояние на каждый файл', async () => {
  const f = await runtimeFixture();
  try {
    const junk = {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          const result = await adapters.demo.execute(r);
          if (!r.review) {
            // Как хранилище пакетов, созданное установкой прямо в worktree.
            await mkdir(join(r.cwd, '.pnpm-store-fixture'), { recursive: true });
            for (let i = 0; i < 3000; i++)
              await writeFile(join(r.cwd, '.pnpm-store-fixture', `f${i}`), String(i));
          }
          return result;
        },
      },
    };
    const read = f.store.read.bind(f.store);
    let reads = 0;
    f.store.read = () => {
      reads++;
      return read();
    };
    const scheduler = new Scheduler(f.h, f.root, junk);
    f.h.pause(false);
    await scheduler.drain();
    f.store.read = read;
    assert.ok(reads < 3000, `состояние прочитано ${reads} раз`);
    assert.ok(
      !f.store.read().runs.some((r) => r.status === 'expired'),
      'попытка завершилась своим исходом, а не истечением владения',
    );
  } finally {
    await f.cleanup();
  }
});
test('Crash after Git publication is reconciled from persisted evidence without running models again', async () => {
  const f = await runtimeFixture();
  try {
    f.h.pause(false);
    await f.scheduler.drain();
    const last = f.store.read().runs.at(-1)!;
    f.store.change('test.crash', (s) => {
      const run = s.runs.find((r) => r.id === last.id)!;
      run.status = 'active';
      run.leaseUntil = 0;
      const t = s.tasks.find((t) => t.id === run.taskId)!;
      t.status = 'integrating';
      t.activeRunId = run.id;
      t.resultSha = undefined;
      return null;
    });
    await f.scheduler.tick();
    const recovered = f.store.read().runs.find((r) => r.id === last.id)!;
    assert.equal(recovered.status, 'succeeded');
    assert.notEqual(recovered.token, last.token);
    assert.equal(f.store.read().runs.length, 7);
  } finally {
    await f.cleanup();
  }
});
test('CLI adapters use structured outputs, stdin prompts and restricted review permissions', () => {
  const r = { review: true, model: 'configured-model' } as AgentRequest;
  const codex = cliArguments('codex', r, 'schema.json', 'result.json');
  // Ревьюер codex пишет только во временный каталог: граница — профиль прав.
  const permissions = codex.find((a) => a.startsWith('permissions.devcontour='))!;
  assert.match(permissions, /":tmpdir"="write"/);
  assert.deepEqual(
    [...permissions.matchAll(/"([^"]+)"="write"/g)].map((m) => m[1]).filter((p) => p !== ':tmpdir'),
    [],
  );
  assert.ok(codex.includes('configured-model'));
  assert.equal(codex.at(-1), '-');
  const claude = cliArguments('claude', r, 'schema.json', 'result.json');
  assert.ok(claude.includes('dontAsk'));
  // Без профиля ревьюер только читает: право запускать проверки даётся явно,
  // а не подразумевается.
  assert.ok(claude.includes('Read,Glob,Grep'));
  assert.ok(claude.includes('Edit,Write,NotebookEdit,Bash'));
  assert.ok(!claude.includes('--dangerously-skip-permissions'));
  // Прогон не наследует конфигурацию оператора: чужой MCP-сервер, не сумевший
  // авторизоваться, убивал ревью — работа была сделана и проверена, а
  // результат терялся из-за сервера, к контуру отношения не имеющего.
  assert.ok(codex.includes('--ignore-user-config'));
  assert.ok(codex.includes('mcp_servers={}'));
  assert.ok(claude.includes('--strict-mcp-config'));
  assert.deepEqual(
    claude.slice(claude.indexOf('--setting-sources'), claude.indexOf('--setting-sources') + 2),
    ['--setting-sources', ''],
  );
});
test('Уровень рассуждения передаётся codex как model_reasoning_effort', () => {
  const argv = (effort?: string) =>
    cliArguments(
      'codex',
      {
        review: false,
        prompt: 'p',
        cwd: '/tmp',
        artifactDir: '/tmp',
        task: {} as Task,
        model: 'gpt-6-astra',
        effort,
        signal: new AbortController().signal,
        timeoutMs: 1000,
      },
      '/tmp/schema.json',
      '/tmp/result.json',
    ).join(' ');
  assert.match(argv('low'), /--model gpt-6-astra/);
  assert.match(argv('low'), /model_reasoning_effort="low"/);
  assert.doesNotMatch(argv(), /model_reasoning_effort/);
});
test('Process timeout interrupts actual child processes', async () => {
  const r = await command([process.execPath, '-e', 'setInterval(()=>{},1000)'], process.cwd(), {
    timeoutMs: 80,
  });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
});

test('A stale run base that is a pure fast-forward moves on the next tick; a diverged one still stops the queue', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    const target = `refs/heads/${repo.targetBranch}`;
    const commit = async (name: string) => {
      await writeFile(join(repo.path, name), '# ' + name + '\n');
      await git(repo.path, 'add', name);
      await git(repo.path, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', name);
      return git(repo.path, 'rev-parse', 'HEAD');
    };
    const forwarded = () => f.store.events().filter((e) => e.type === 'base.fast-forwarded');
    // Исполнитель сразу отказывает: тик только выдаёт попытку, базу она не двигает.
    const idle = {
      ...adapters,
      demo: {
        ...adapters.demo,
        execute: () => Promise.reject(new BlockedError('исполнитель не нужен этой проверке')),
      },
    };

    // База начинает совпадать с рабочей веткой: дальше проверяется расхождение,
    // а не то, что демо-фикстура уже успела проинтегрировать.
    const start = await git(repo.path, 'rev-parse', 'HEAD');
    await git(repo.path, 'update-ref', target, start);

    // Ведущий агент готовит контракт на рабочей ветке. База прогонов его не
    // содержит, поэтому исполнитель получил бы дерево без контракта.
    const prepared = await commit('CONTRACT.md');

    // На остановленной очереди база не двигается: перенос — не решение о работе.
    const paused = new Scheduler(f.h, f.root, idle);
    await paused.init();
    f.h.pause(true);
    await paused.tick();
    assert.equal(await git(repo.path, 'rev-parse', target), start, 'пауза держит базу');
    await paused.stop();

    // Detached HEAD — не рабочая ветка: перемотки нет, прежняя остановка.
    await git(repo.path, 'checkout', '-q', '--detach', 'HEAD');
    const detached = new Scheduler(f.h, f.root, idle);
    await detached.init();
    f.h.pause(false);
    const before = f.store.read().runs.length;
    await assert.rejects(detached.tick(), /base-update/);
    assert.equal(await git(repo.path, 'rev-parse', target), start);
    assert.equal(f.store.read().runs.length, before, 'ни одного прогона на устаревшей базе');
    await detached.stop();
    await git(repo.path, 'checkout', '-q', '-');

    // Незавершённая операция изменения контракта ведёт перенос сама.
    const operation = (status: string) =>
      f.store.atomic(() =>
        f.store.saveLocal('contract-change', repo.id, 'CC-open', { id: 'CC-open', status }),
      );
    operation('waiting');
    const held = new Scheduler(f.h, f.root, idle);
    await held.init();
    f.h.pause(false);
    await assert.rejects(held.tick(), /base-update/);
    assert.equal(await git(repo.path, 'rev-parse', target), start, 'операция держит базу');
    await held.stop();
    operation('completed');

    // Чистая перемотка на работающей очереди — без ручного base-update.
    const scheduler = new Scheduler(f.h, f.root, idle);
    await scheduler.init();
    f.h.pause(false);
    await scheduler.tick();
    assert.equal(await git(repo.path, 'rev-parse', target), prepared, 'база перемотана');
    await git(repo.path, 'merge-base', '--is-ancestor', start, target);
    assert.deepEqual(await scheduler.baseDrift(), []);
    assert.deepEqual(forwarded().at(-1)?.data, {
      updated: [
        {
          repositoryId: repo.id,
          branch: await git(repo.path, 'symbolic-ref', '--short', 'HEAD'),
          from: start,
          to: prepared,
        },
      ],
    });
    assert.equal(forwarded().length, 1, 'перемотка — одно событие, не ручное вмешательство');
    // Как после ручного переноса: до проверки гейтами новая база не выдаётся.
    const checked = f.store.read();
    assert.equal(checked.paused, true);
    assert.equal(checked.pauseReason, 'base-check');
    assert.ok(checked.waits?.some((w) => w.kind === 'base-check'));
    assert.equal(checked.runs.length, before, 'выдачи до проверки базы нет');
    assert.equal(workflowMetrics(f.h).feedback.feedbackCost.automaticBaseUpdates, 1);
    await scheduler.stop();

    // Слияние: обе линии несут работу — принятый прогон в базе и новая
    // подготовка в рабочей ветке. Контур сводит их явной командой.
    await git(repo.path, 'update-ref', target, await git(repo.path, 'rev-parse', 'HEAD~1'));
    const accepted = join(f.root, 'worktrees', 'accepted-fixture');
    await git(repo.path, 'worktree', 'add', '--detach', accepted, target);
    await writeFile(join(accepted, 'ACCEPTED.md'), '# accepted\n');
    await git(accepted, 'add', 'ACCEPTED.md');
    await git(
      accepted,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '-m',
      'accepted',
    );
    await git(repo.path, 'update-ref', target, await git(accepted, 'rev-parse', 'HEAD'));
    await git(repo.path, 'worktree', 'remove', '--force', accepted);

    const acceptedTip = await git(repo.path, 'rev-parse', target);
    // Обе линии несут работу: автоматической перемотки нет, очередь стоит.
    const diverged = new Scheduler(f.h, f.root, idle);
    await diverged.init();
    f.h.pause(false);
    await assert.rejects(diverged.tick(), /base-update/);
    assert.equal(await git(repo.path, 'rev-parse', target), acceptedTip, 'принятое не потеряно');
    await diverged.stop();
    const merged = await updateBase(f.config, f.root);
    assert.equal(merged.updated[0].kind, 'merge');
    const tip = await git(repo.path, 'rev-parse', target);
    // Обе линии в базе. Проверять только рабочую ветку мало: разрушительный
    // перевод ссылки на её вершину прошёл бы такую проверку, потеряв принятое.
    await git(repo.path, 'merge-base', '--is-ancestor', prepared, tip);
    await git(repo.path, 'merge-base', '--is-ancestor', acceptedTip, tip);
    assert.notEqual(tip, prepared);
    assert.notEqual(tip, acceptedTip);
    assert.deepEqual(await new Scheduler(f.h, f.root).baseDrift(), []);
  } finally {
    await f.cleanup();
  }
});

test('Auto fast-forward refuses commits that touch acceptance or contour files and every guard holds', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    const target = `refs/heads/${repo.targetBranch}`;
    const commit = async (name: string, text = '# ' + name + '\n') => {
      await mkdir(join(repo.path, name, '..'), { recursive: true });
      await writeFile(join(repo.path, name), text);
      await git(repo.path, 'add', name);
      await git(repo.path, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', name);
      return git(repo.path, 'rev-parse', 'HEAD');
    };
    const idle = {
      ...adapters,
      demo: {
        ...adapters.demo,
        execute: () => Promise.reject(new BlockedError('исполнитель не нужен этой проверке')),
      },
    };
    const base = () => git(repo.path, 'rev-parse', target);
    const sync = async () =>
      git(repo.path, 'update-ref', target, await git(repo.path, 'rev-parse', 'HEAD'));
    // Попытки нужны как образец: тик на совпадающей базе выдаёт и сразу закрывает их.
    await sync();
    const warm = new Scheduler(f.h, f.root, idle);
    await warm.init();
    f.h.pause(false);
    await warm.drain();
    await warm.stop();
    const sample = f.store.read().runs.at(-1)!;
    assert.ok(sample, 'образец попытки');

    // Закреплённый артефакт контракта: коммит, его меняющий, базой сам не становится.
    f.store.change('test.contract', (st) => {
      st.contracts.push({
        id: 'C-pin',
        title: 'Приёмка',
        content: 'x',
        digest: 'a'.repeat(64),
        source: 'docs/contracts/pin.md',
        artifacts: [
          {
            repositoryId: repo.id,
            path: 'acceptance/pin.test.js',
            purpose: 'приёмка',
            revision: 'b'.repeat(40),
            blob: 'c'.repeat(40),
            digest: 'd'.repeat(64),
          },
        ],
      } as never);
      return {};
    });
    const refused = async (label: string, pattern: RegExp) => {
      const s = new Scheduler(f.h, f.root, idle);
      await s.init();
      f.h.pause(false);
      const from = await base();
      await assert.rejects(s.tick(), (e: Error) => {
        assert.match(e.message, /base-update/, label);
        assert.match(e.message, pattern, label);
        return true;
      });
      assert.equal(await base(), from, label + ': база не сдвинута');
      await s.stop();
    };
    // Защищённый путь компонента — из его конфигурации.
    const guarded = repo.protectedPaths[0];
    const protectedFile = guarded.endsWith('/') ? guarded + 'guard.txt' : guarded;
    for (const file of [
      'acceptance/pin.test.js',
      'docs/contracts/pin.md',
      protectedFile,
      '.devcontour/notes.md',
    ]) {
      await sync();
      await commit(file);
      await refused(file, new RegExp('main:' + file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    }

    // Закреплённая редакция артефакта открытой работы на новой вершине должна совпадать.
    await sync();
    const open = f.store.read().tasks.find((t) => !['done', 'cancelled'].includes(t.status))!;
    f.store.change('test.pin', (st) => {
      st.tasks.find((t) => t.id === open.id)!.contracts.push('C-pin');
      st.contracts.find((c) => c.id === 'C-pin')!.artifacts![0].path = 'acceptance/other.test.js';
      return {};
    });
    await commit('src/product-a.js');
    await refused('stale pin', /main:acceptance\/other\.test\.js/);
    f.store.change('test.unpin', (st) => {
      const t = st.tasks.find((x) => x.id === open.id)!;
      t.contracts = t.contracts.filter((c) => c !== 'C-pin');
      return {};
    });

    // Охрана внутри: прямой вызов перемотки на продуктовом коммите.
    const s = new Scheduler(f.h, f.root, idle);
    await s.init();
    f.h.pause(false);
    assert.ok(f.h.leader(s.owner), 'роль controller у проверяемого процесса');
    const forward = async () => {
      const from = await base();
      const sensitive = await (
        s as unknown as { fastForwardBase(d: unknown): Promise<string[]> }
      ).fastForwardBase(await s.baseDrift());
      return { moved: (await base()) !== from, sensitive };
    };
    // Идёт попытка (видна снаружи) — перемотки нет.
    f.store.change('test.run', (st) => {
      st.runs.push({
        ...structuredClone(sample),
        id: 'R-live',
        status: 'active',
        leaseUntil: Date.now() + 60_000,
      });
      return {};
    });
    assert.equal((await forward()).moved, false, 'активная попытка держит базу');
    // Та же попытка видна только транзакции сдвига — её проверка держит базу.
    const read = f.h.store.read.bind(f.h.store);
    f.h.store.read = () => {
      const st = read();
      st.runs = st.runs.filter((r) => r.id !== 'R-live');
      return st;
    };
    try {
      assert.equal((await forward()).moved, false, 'проверка в транзакции сдвига');
    } finally {
      f.h.store.read = read;
    }
    f.store.change('test.run-done', (st) => {
      st.runs = st.runs.filter((r) => r.id !== 'R-live');
      return {};
    });
    // Роль controller утрачена — перемотки нет.
    executionOf(f.h).engine.release(s.owner);
    assert.equal((await forward()).moved, false, 'без роли controller база не двигается');
    assert.ok(f.h.leader(s.owner));
    // Остановленная очередь — перемотки нет (проверка в транзакции сдвига).
    f.h.pause(true);
    assert.equal((await forward()).moved, false, 'пауза держит базу');
    f.h.pause(false);
    // Ожидающее применение конфигурации — перемотки нет.
    f.store.change('test.reconfigure', (st) => {
      st.reconfigure = {
        operation: 'OP-1',
        digest: 'e'.repeat(64),
        requestedAt: new Date().toISOString(),
      };
      return {};
    });
    assert.equal((await forward()).moved, false, 'применение конфигурации держит базу');
    f.store.change('test.reconfigure-done', (st) => {
      delete st.reconfigure;
      return {};
    });
    // Без препятствий продуктовый коммит перематывается — и ставит base-check.
    assert.deepEqual(await forward(), { moved: true, sensitive: [] });
    assert.equal(f.store.read().pauseReason, 'base-check');
    await s.stop();
  } finally {
    await f.cleanup();
  }
});

test('Acceptance records the proven SHA, so a base update cannot slip unverified work in', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    const target = `refs/heads/${repo.targetBranch}`;
    await git(repo.path, 'update-ref', target, await git(repo.path, 'rev-parse', 'HEAD'));
    const scheduler = new Scheduler(f.h, f.root);
    await scheduler.init();
    const board = f.h.createBoard('Проверяемая доска');
    const task = f.h.addTask(board.id, input('Задача с доказательством'));
    f.h.approve(board.id);
    f.h.pause(false);
    await scheduler.drain();
    const proven = f.store.read().tasks.find((t) => t.id === task.id)!.resultSha!;
    assert.ok(proven, 'задача должна завершиться интеграцией');

    // Перенос базы двигает вершину ветки подготовкой, которую гейты не видели.
    // Приёмка, читавшая вершину, закрепила бы её как проверенную работу.
    await writeFile(join(repo.path, 'REGRESSION.md'), '# not proven by any gate\n');
    await git(repo.path, 'add', 'REGRESSION.md');
    await git(
      repo.path,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '-m',
      'unproven',
    );
    await updateBase(f.config, f.root);
    const tip = await git(repo.path, 'rev-parse', target);
    assert.notEqual(tip, proven, 'вершина ушла вперёд непроверенным коммитом');

    const accepted = await acceptBoard(f.h, board.id, 'codex');
    assert.equal(accepted.status, 'accepted');
    const snapshot = f.store
      .read()
      .boards.find((b) => b.id === board.id)!
      .revisions.at(-1)!.snapshot!;
    assert.equal(snapshot.sha, proven, 'принят доказанный SHA, а не вершина ветки');
    assert.notEqual(snapshot.sha, tip);
  } finally {
    await f.cleanup();
  }
});

test('The scheduler classifies a refusal itself: a runtime that never ran refunds, one that worked does not', async () => {
  const f = await runtimeFixture();
  const refusing = (error: Error) => ({
    ...adapters,
    demo: {
      ...adapters.demo,
      name: 'demo' as const,
      execute: () => Promise.reject(error),
    },
  });
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const refused = f.h.addTask(board.id, input('Задача с отказом окружения'));
    f.h.approve(board.id);
    f.h.pause(false);

    // Отказ окружения приходит исключением из runtime — классифицирует его
    // scheduler, а не вызывающий. Тест, подставляющий флаг руками, прошёл бы
    // и с удалённой классификацией.
    const blocked = new Scheduler(f.h, f.root, refusing(new BlockedError('demo: Not logged in')));
    await blocked.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === refused.id)!.status, 'failed');
    assert.equal(f.store.read().tasks.find((t) => t.id === refused.id)!.attempt, 0);
    assert.equal(f.store.read().runs.at(-1)!.blocked, true);
    await blocked.stop();

    // Обычный сбой исполнителя попытку расходует.
    f.h.retry(refused.id);
    f.h.pause(false);
    const failing = new Scheduler(f.h, f.root, refusing(new Error('demo: не справился')));
    await failing.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === refused.id)!.attempt, 1);
    assert.equal(f.store.read().runs.at(-1)!.blocked, undefined);
    await failing.stop();
  } finally {
    await f.cleanup();
  }
});

test('A task runs its own scope of proof, not every gate the profile declares', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    // Гейт соседней, ещё не сделанной задачи. Раньше он ложился на любую
    // задачу компонента: параллельная декомпозиция не могла пройти, пока не
    // сделаны все соседи, хотя область доказательства у каждой своя.
    const failing = {
      id: 'sibling-tests',
      kind: 'test' as const,
      command: ['sh', '-c', 'exit 1'],
      timeoutMs: 60_000,
      report: { type: 'junit' as const, path: '.reports/junit.xml' },
      artifacts: [],
    };
    f.h.config.gates = [...f.h.config.gates, failing];
    f.h.config.repositories = [];

    const board = f.h.createBoard('Доска с областями');
    const own = f.h.config.gates.filter((g) => g.id !== failing.id).map((g) => g.id);
    const scoped = f.h.addTask(board.id, { ...input('Задача со своей областью'), gates: own });
    f.h.approve(board.id);
    f.h.pause(false);
    const scheduler = new Scheduler(f.h, f.root);
    await scheduler.drain();

    const done = f.store.read().tasks.find((t) => t.id === scoped.id)!;
    assert.equal(done.status, 'done', done.failure);
    const run = f.store.read().runs.find((r) => r.taskId === scoped.id)!;
    assert.ok(
      !run.evidence.some((e) => e.gate === failing.id),
      'чужой gate не должен выполняться в прогоне задачи',
    );
    await scheduler.stop();
  } finally {
    await f.cleanup();
  }
});

test('A refusal that will repeat on every task stops the queue instead of burning budgets', async () => {
  const f = await runtimeFixture();
  const refusing = (message: string) => ({
    ...adapters,
    demo: {
      ...adapters.demo,
      name: 'demo' as const,
      execute: () => Promise.reject(new Error(message)),
    },
  });
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const first = f.h.addTask(board.id, input('Первая задача'));
    const second = f.h.addTask(board.id, input('Вторая задача'));
    f.h.approve(board.id);
    f.h.pause(false);

    // Кончился лимит сессии провайдера: причина вне контура и одна для всех задач. Очередь,
    // которая продолжит перебор, сожжёт бюджет попыток каждой из них.
    const scheduler = new Scheduler(
      f.h,
      f.root,
      refusing(
        "demo: runtime завершился с кодом 1: You've hit your session limit · resets 2:40am (Europe/Moscow)",
      ),
    );
    await scheduler.drain();
    const state = f.store.read();
    assert.equal(state.paused, true, 'выдача остановлена');
    assert.equal(
      state.runs.filter((r) => r.taskId === second.id).length,
      0,
      'вторая задача не выдавалась',
    );
    // Провайдер задачу не пробовал: попытка возвращается.
    assert.equal(state.tasks.find((t) => t.id === first.id)!.attempt, 0);
    assert.equal(state.tasks.find((t) => t.id === first.id)!.failureKind, 'provider-auth');
    assert.equal(state.tasks.find((t) => t.id === second.id)!.attempt, 0);
    assert.match(
      (f.store.events().find((e) => e.type === 'scheduler.error')?.data as { error: string }).error,
      /session limit/,
    );
    await scheduler.stop();
  } finally {
    await f.cleanup();
  }
});

test('An empty candidate is refused before an independent review is spent on it', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const task = f.h.addTask(board.id, {
      ...input('Задача с областью записи'),
      writePaths: ['src'],
    });
    f.h.approve(board.id);
    f.h.pause(false);

    // Исполнитель отчитался «сделано», не изменив ни файла. Гейты на таком
    // кандидате зелены — они были зелены и до него, — а всю проверку принимает
    // на себя независимое ревью: пустой коммит стоил полного ревью, чтобы
    // услышать «diff пуст».
    let reviews = 0;
    const idle = {
      ...adapters,
      demo: {
        ...adapters.demo,
        name: 'demo' as const,
        execute: (request: AgentRequest) => {
          if (request.review) reviews++;
          return Promise.resolve({
            data: request.review
              ? { approved: true, summary: 'Нечего смотреть', findings: [], discoveries: [] }
              : { completed: true, summary: 'Всё уже готово', discoveries: [] },
            log: '',
            command: ['fixture'],
          });
        },
      },
    };
    const scheduler = new Scheduler(f.h, f.root, idle);
    await scheduler.drain();
    const failed = f.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.failure ?? '', /Изменений нет/);
    assert.equal(reviews, 0, 'ревью на пустом кандидате не запускается');
    await scheduler.stop();
  } finally {
    await f.cleanup();
  }
});

test('A retry is told where the previous review objected, not only that it did', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const task = f.h.addTask(board.id, input('Задача с замечанием'));
    f.h.approve(board.id);
    f.h.pause(false);

    const prompts: string[] = [];
    const runtimes = (approve: boolean) => ({
      ...adapters,
      demo: {
        ...adapters.demo,
        name: 'demo' as const,
        execute: async (request: AgentRequest) => {
          if (request.review) {
            prompts.push(request.prompt);
            return {
              data: {
                approved: approve,
                summary: 'Порядок выбора нарушен',
                discoveries: [],
                findings: approve
                  ? []
                  : [
                      {
                        severity: 'blocking',
                        message: 'Списки сохраняют порядок обхода: нужна канонизация',
                        path: 'src/assembly.ts',
                        line: 296,
                      },
                    ],
                // Повтор с исправлением закрывает выданную находку по её ID.
                previous: reviewTransitions(
                  request.findings,
                  approve,
                  approve ? 'Канонизация списков на месте' : 'Порядок обхода не канонизирован',
                ),
              },
              log: '',
              command: ['fixture'],
            };
          }
          prompts.push(request.prompt);
          return adapters.demo.execute(request);
        },
      },
    });
    const rejecting = new Scheduler(f.h, f.root, runtimes(false));
    await rejecting.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === task.id)!.status, 'failed');
    await rejecting.stop();

    // Следующая попытка получает саму находку — путь, строку и формулировку, а
    // не только «ревью отклонило». Без этого круг повторяется с тем же
    // замечанием, что и случилось на живом продукте дважды подряд.
    prompts.length = 0;
    f.h.retry(task.id);
    f.h.pause(false);
    const retrying = new Scheduler(f.h, f.root, runtimes(true));
    await retrying.drain();
    const implementation = prompts.find((p) => p.includes('Previous attempts'))!;
    assert.ok(implementation, 'попытка получает историю прошлых прогонов');
    assert.match(implementation, /нужна канонизация/);
    assert.match(implementation, /src\/assembly\.ts/);
    assert.match(implementation, /296/);
    // Находка получила ID controller и закрыта повторным ревью по этому ID с
    // основанием, а не забыта одобрением.
    const reviews = f.store
      .read()
      .runs.filter((r) => r.taskId === task.id)
      .flatMap((r) => r.evidence)
      .filter((e) => e.kind === 'review');
    const issued = reviews.flatMap((e) => e.findings ?? []).find((x) => x.id);
    assert.ok(issued?.id, 'находке выдан ID');
    assert.equal(issued.status, 'open');
    const closing = reviews.find((e) => e.passed)!;
    assert.equal(closing.reviewRound?.protocol, 'valid');
    assert.deepEqual(
      closing.reviewRound?.transitions?.map((t) => [t.id, t.from, t.to, t.basis]),
      [[issued.id, 'open', 'closed', 'Канонизация списков на месте']],
    );
    assert.equal(f.store.read().tasks.find((t) => t.id === task.id)!.status, 'done');
    await retrying.stop();
  } finally {
    await f.cleanup();
  }
});
test('Ответ ревьюера вне протокола находок — не замечание к коду; адаптер без протокола сохраняет прежнюю приёмку', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const task = f.h.addTask(board.id, input('Задача с находкой ревью'));
    f.h.approve(board.id);
    f.h.pause(false);
    let writes = 0;
    let reviews = 0;
    const runtimes = (
      verdict: (request: AgentRequest) => Record<string, unknown>,
      protocol: boolean,
    ) => ({
      ...adapters,
      demo: {
        name: 'demo' as const,
        ...(protocol ? { reviewProtocol: 1 as const } : {}),
        execute: async (request: AgentRequest) => {
          if (request.task?.id !== task.id) return adapters.demo.execute(request);
          if (!request.review) {
            writes++;
            return adapters.demo.execute(request);
          }
          reviews++;
          return {
            data: { summary: 'fixture', discoveries: [], ...verdict(request) },
            log: '',
            command: ['fixture'],
          };
        },
      },
    });
    const drain = async (runtime: ReturnType<typeof runtimes>) => {
      const scheduler = new Scheduler(f.h, f.root, runtime);
      await scheduler.drain();
      await scheduler.stop();
    };
    const current = () => f.store.read().tasks.find((t) => t.id === task.id)!;
    const evidenceOf = (attempt: number) =>
      f.store
        .read()
        .runs.filter((r) => r.taskId === task.id && r.attempt === attempt)
        .flatMap((r) => r.evidence)
        .filter((e) => e.kind === 'review');

    // Отказ по существу выдаёт находку с ID controller.
    await drain(
      runtimes(
        () => ({
          approved: false,
          findings: [{ severity: 'blocking', message: 'Нет обработки пустого ввода' }],
        }),
        true,
      ),
    );
    assert.equal(current().failureKind, 'review');
    const [issued] = evidenceOf(1).flatMap((e) => e.findings ?? []);
    assert.ok(issued?.id);

    // Одобрение, забывшее выданную находку, — ошибка протокола: ограниченный
    // повтор reviewer без нового writer, затем остановка без автоповтора.
    f.h.retry(task.id);
    f.h.pause(false);
    reviews = 0;
    writes = 0;
    await drain(runtimes(() => ({ approved: true, findings: [], previous: [] }), true));
    assert.equal(current().status, 'failed');
    assert.equal(current().failureKind, 'review-protocol');
    assert.match(current().failure ?? '', /REVIEW_PROTOCOL_INVALID/);
    assert.equal(reviews, 2, 'один дополнительный вызов reviewer');
    assert.equal(writes, 1, 'writer не вызывается ради повтора reviewer');
    const invalid = evidenceOf(2);
    assert.deepEqual(
      invalid.map((e) => [e.passed, e.reviewRound?.protocol, e.reviewRound?.call]),
      [
        [false, 'invalid', 1],
        [false, 'invalid', 2],
      ],
    );
    assert.ok(
      invalid.every((e) =>
        e.reviewRound?.issues?.some((i) => i.reason === 'missing' && i.path === 'previous'),
      ),
    );
    // Выдачу останавливает только остановка scheduler теста, не отказ.
    assert.equal(f.store.read().pauseReason, 'shutdown');
    assert.deepEqual(f.store.read().pauseFailures ?? [], [], 'выдача не останавливается отказом');

    // Адаптер без протокола (runtime хоста прежней версии): переходы не
    // требуются, одобрение принимается как в alpha.5, раунд помечен legacy.
    f.h.retry(task.id);
    f.h.pause(false);
    await drain(runtimes(() => ({ approved: true, findings: [] }), false));
    assert.equal(current().status, 'done', current().failure);
    const accepted = f.store
      .read()
      .runs.filter((r) => r.taskId === task.id)
      .flatMap((r) => r.evidence)
      .filter((e) => e.kind === 'review' && e.passed);
    assert.ok(accepted.length);
    assert.ok(accepted.every((e) => e.reviewRound?.mode === 'legacy'));
  } finally {
    await f.cleanup();
  }
});
test('Замечание ревью про HTTP 401 не останавливает выдачу как отказ провайдера', async () => {
  const f = await runtimeFixture();
  try {
    // Ревью говорит о поведении разрабатываемого приложения. Сам рантайм
    // отработал и вернул структурированный вердикт: внешнего отказа нет.
    // Разбор этого текста вторым проходом делал из замечания отказ провайдера
    // и останавливал очередь навсегда — повтор назначался и никогда не
    // выдавался, потому что класс review паузу снимать не вправе.
    const scheduler = new Scheduler(f.h, f.root, {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          if (r.review)
            return {
              data: {
                approved: false,
                summary: 'Missing handling for HTTP 401 Unauthorized in the client',
                findings: [
                  { severity: 'blocking', message: 'Unauthorized response is not handled' },
                ],
              },
              log: 'rejected',
              command: ['fixture-review'],
            };
          return adapters.demo.execute(r);
        },
      },
    });
    f.h.pause(false);
    await scheduler.drain();

    const state = f.store.read();
    const failed = state.tasks.find((t) => t.status === 'failed')!;
    assert.equal(failed.failureKind, 'review');
    assert.equal(state.paused, false, 'выдача продолжается: внешнего отказа не было');
    assert.deepEqual(state.pauseFailures ?? [], []);
  } finally {
    await f.cleanup();
  }
});
test('Провал проверки несёт свою причину: разные ошибки не считаются одной', async () => {
  // Полный вывод лежит в артефакте, но исполнителю следующей попытки он
  // недоступен, а в отказ попадало только «Код выхода 1». Два несвязанных
  // провала одной проверки выглядели одной причиной, и предел одинаковых
  // повторов исчерпывался впустую.
  const fingerprints: string[] = [];
  for (const marker of ['EXPECTED_TOTAL_WRONG', 'MISSING_REQUIRED_FIELD']) {
    const f = await runtimeFixture();
    try {
      f.h.config.gates[0].command = ['sh', '-c', `echo ${marker} >&2; exit 1`];
      reapprove(f.h);
      f.h.pause(false);
      await new Scheduler(f.h, f.root).drain();

      const failed = f.store.read().tasks.find((t) => t.status === 'failed')!;
      assert.match(failed.failure!, new RegExp(marker), 'причина названа в отказе');
      const run = f.store.read().runs.findLast((r) => r.taskId === failed.id)!;
      assert.match(
        run.evidence.find((e) => !e.passed)!.summary,
        new RegExp(marker),
        'причина доходит до подсказки следующей попытки через evidence',
      );
      fingerprints.push(failed.failureFingerprint!);
    } finally {
      await f.cleanup();
    }
  }
  assert.notEqual(fingerprints[0], fingerprints[1], 'разные причины — разные отпечатки');
});
test('Текст провала из отчёта проходит тот же redact, что и вывод команды', async () => {
  // Отчёт пишет раннер, и секрет попадает туда так же легко, как в вывод:
  // в сообщение провала, в том числе на границе обрезки, и в имя testcase.
  const f = await runtimeFixture();
  const secret = 'gate-secret-value-7310-abcdefgh';
  process.env.DEVCONTOUR_TEST_GATE_SECRET = secret;
  try {
    f.h.config.environment = {
      inherit: [],
      values: {},
      secrets: { GATE_TOKEN: 'DEVCONTOUR_TEST_GATE_SECRET' },
    };
    f.h.config.gates[0].command = [
      process.execPath,
      '-e',
      `const t=process.env.GATE_TOKEN;require('fs').mkdirSync('.reports',{recursive:true});require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase classname="auth" name="LEAKS_TOKEN"><failure message="'+'p'.repeat(184)+t+'"/></testcase><testcase name="case-'+t+'"><failure message="named"/></testcase></testsuite>');process.exit(1)`,
    ];
    f.h.config.gates[0].report = { type: 'junit', path: '.reports/unit.xml' };
    reapprove(f.h);
    f.h.pause(false);
    await new Scheduler(f.h, f.root).drain();
    const failed = f.store.read().tasks.find((t) => t.status === 'failed')!;
    const run = f.store.read().runs.findLast((r) => r.taskId === failed.id)!;
    const evidence = run.evidence.find((e) => !e.passed)!;
    assert.match(evidence.summary, /LEAKS_TOKEN/, 'причина из отчёта дошла');
    assert.ok(evidence.tests?.length, 'манифест упавшей проверки записан');
    // Ни целиком, ни префиксом — ни в сводке, ни в манифесте, ни в отказе.
    const stored = JSON.stringify(f.store.read());
    for (const piece of [secret, secret.slice(0, 12)])
      assert.ok(!stored.includes(piece), `в состоянии нет «${piece}»`);
  } finally {
    delete process.env.DEVCONTOUR_TEST_GATE_SECRET;
    await f.cleanup();
  }
});
test('Проверка исполняется в песочнице: полезное работает, запрещённое отклоняется', async () => {
  // Прежде проверка шла обычным процессом хоста: читала базу контура,
  // писала рядом с worktree и ходила в сеть, а сверка HEAD и отслеживаемых
  // файлов после неё этого не видела. Сама проверка записывает в отчёт, что
  // удалось; внешняя сверка ниже не доверяет её словам.
  const f = await runtimeFixture();
  try {
    const outside = join(f.root, 'outside-write.txt');
    const script = `
const fs=require('fs'),net=require('net'),https=require('https'),path=require('path');
const cases=[];const ok=(id,v)=>cases.push('<testcase name="'+id+'">'+(v?'':'<failure message="'+id+'"/>')+'</testcase>');
const tryDo=(f)=>{try{f();return true}catch{return false}};
ok('reads-own-worktree', tryDo(()=>fs.readdirSync('.')));
ok('writes-scratch', tryDo(()=>fs.writeFileSync(path.join(process.env.TMPDIR,'t'),'x')));
ok('controller-db-hidden', !tryDo(()=>fs.readFileSync(${JSON.stringify(join(f.root, 'state.sqlite'))})));
ok('write-outside-denied', !tryDo(()=>fs.writeFileSync(${JSON.stringify(outside)},'x')));
ok('source-checkout-hidden', !tryDo(()=>fs.readFileSync(${JSON.stringify(join(f.config.repository, 'verify.mjs'))})));
ok('git-in-own-worktree', tryDo(()=>require('child_process').execFileSync('git',['status','--porcelain'],{stdio:'pipe'})));
const done=()=>{fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite>'+cases.join('')+'</testsuite>');process.exit(0)};
const s=net.createServer(c=>c.end('pong')).listen(0,'127.0.0.1',()=>{
  net.connect(s.address().port,'127.0.0.1').on('data',()=>{ok('localhost-works',true);s.close();
    https.get('https://example.com',{timeout:5000},()=>{ok('egress-denied',false);done()}).on('error',()=>{ok('egress-denied',true);done()}).on('timeout',function(){this.destroy()});
  }).on('error',()=>{ok('localhost-works',false);done()});
});`;
    f.h.config.gates[0].command = [process.execPath, '-e', script];
    f.h.config.gates[0].report = { type: 'junit', path: '.reports/isolation.xml' };
    reapprove(f.h);
    f.h.pause(false);
    await new Scheduler(f.h, f.root).drain();

    // Демо-фикстура приходит с уже выполненными задачами: берётся прогон,
    // созданный этим запуском.
    const run = f.store.read().runs.at(-1)!;
    const task = f.store.read().tasks.find((t) => t.id === run.taskId)!;
    const evidence = run.evidence.find((e) => e.gate === f.h.config.gates[0].id)!;
    assert.deepEqual(
      Object.fromEntries((evidence.tests ?? []).map((t) => [t.id, t.status])),
      {
        'reads-own-worktree': 'passed',
        'writes-scratch': 'passed',
        'controller-db-hidden': 'passed',
        'write-outside-denied': 'passed',
        'source-checkout-hidden': 'passed',
        'git-in-own-worktree': 'passed',
        'localhost-works': 'passed',
        'egress-denied': 'passed',
      },
      evidence.summary,
    );
    assert.equal(existsSync(outside), false, 'внешняя сверка: файла вне worktree нет');
    assert.equal(task.status, 'done', task.failure);
    // Политика записана рядом с артефактами проверки — видно, чем её ограничили.
    const policy = JSON.parse(
      await readFile(
        join(f.root, 'artifacts', run.id, 'candidate', f.h.config.gates[0].id, 'isolation.json'),
        'utf8',
      ),
    );
    assert.ok(policy.filesystem.denyRead.some((p: string) => p.endsWith('/.ssh')));
  } finally {
    await f.cleanup();
  }
});
// «Без механизма песочницы проверка не запускается; снять изоляцию можно
// только явно» — гарантия runner harness: tests/isolation.test.ts пакета (T29),
// отказ без запуска команды и явный режим none. Путь отчёта через symlink,
// разбор JUnit, распознавание отказа сети и причины провала gate —
// tests/gates.test.ts пакета.
// Предел времени: возврат к очистке по close повесил бы тест на унаследованном
// pipe — регресс должен быть провалом, а не зависанием. Шесть исходов идут
// около двух минут; предел с запасом на нагрузку полного прогона.
test(
  'Проверка не оставляет процессов — ни по таймауту, ни при отмене, ни при падении',
  { timeout: 600_000 },
  async () => {
    // Сигнал группе не достаёт потомка, сменившего группу и сессию: такой
    // процесс переживал проверку и продолжал вычисление. Каждый исход — с
    // отсоединившимся потомком внутри песочницы; живость проверяется по PID.
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Кроме обычного потомка — два обхода: потомок с очищенным окружением (без
    // метки) и потомок, унаследовавший stdout/stderr, из-за которого close не
    // наступал, и очистка не начиналась.
    for (const outcome of [
      'timeout',
      'cancel',
      'crash',
      'success',
      'clean-env',
      'inherited-pipes',
    ] as const) {
      const f = await runtimeFixture();
      try {
        const spawnOrphan =
          outcome === 'clean-env'
            ? `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}});c.unref();console.log('ORPHAN-PID:'+c.pid);`
            : outcome === 'inherited-pipes'
              ? `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});c.unref();console.log('ORPHAN-PID:'+c.pid);`
              : `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();console.log('ORPHAN-PID:'+c.pid);`;
        const tail = {
          timeout: 'setInterval(()=>{},1000)',
          cancel: 'setInterval(()=>{},1000)',
          crash: 'process.exit(2)',
          success:
            "require('fs').mkdirSync('.reports',{recursive:true});require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name=\\'ok\\'/></testsuite>')",
          'clean-env':
            "require('fs').mkdirSync('.reports',{recursive:true});require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name=\\'ok\\'/></testsuite>')",
          'inherited-pipes':
            "require('fs').mkdirSync('.reports',{recursive:true});require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name=\\'ok\\'/></testsuite>')",
        }[outcome];
        f.h.config.gates[0].command = [process.execPath, '-e', spawnOrphan + tail];
        // Таймаут с запасом на старт node под нагрузкой полного прогона: при
        // 4 с проверка иногда истекала раньше, чем потомок успевал запуститься.
        f.h.config.gates[0].timeoutMs = outcome === 'timeout' ? 15000 : 60000;
        reapprove(f.h);
        f.h.pause(false);
        const scheduler = new Scheduler(f.h, f.root);
        const draining = scheduler.drain();
        if (outcome === 'cancel') {
          // Отмена приходит, когда потомок уже запущен.
          for (
            let i = 0;
            i < 100 &&
            !f.store.read().runs.some((r) => r.status === 'active' && r.phase === 'verifying');
            i++
          )
            await new Promise((r) => setTimeout(r, 100));
          // Фиксированной паузы под нагрузкой не хватало: отмена приходила до
          // старта потомка. Ждём его PID в логе проверки (до 30 с).
          const active = f.store.read().runs.find((r) => r.status === 'active')!;
          const liveLog = join(
            f.root,
            'artifacts',
            active.id,
            'candidate',
            f.h.config.gates[0].id + '.log',
          );
          for (let i = 0; i < 300; i++) {
            const text = await readFile(liveLog, 'utf8').catch(() => '');
            if (/ORPHAN-PID:\d+/.test(text)) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          f.h.cancel(active.taskId);
        }
        await draining;
        await scheduler.stop();
        // PID потомка — из лога проверки: worktree и scratch к этому моменту
        // удалены, а лог остаётся в артефактах.
        const run = f.store.read().runs.at(-1)!;
        const log = await readFile(
          join(f.root, 'artifacts', run.id, 'candidate', f.h.config.gates[0].id + '.log'),
          'utf8',
        );
        const pid = Number(/ORPHAN-PID:(\d+)/.exec(log)?.[1]);
        assert.ok(pid > 0, `${outcome}: потомок был запущен`);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(alive(pid), false, `${outcome}: отсоединившийся потомок ${pid} завершён`);
      } finally {
        await f.cleanup();
      }
    }
  },
);
test('Проверка повторяется, только если песочница отказала до запуска команды', async () => {
  // Повтор по тексту stderr перезапускал уже начавшуюся команду: её первый
  // провал терялся, а побочные эффекты удваивались. Признак — метка старта,
  // которую обёртка создаёт внутри песочницы перед exec.
  const f = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'devcontour-retry-'));
  try {
    const count = join(dir, 'count.txt');
    const run = (argv: string[], env: NodeJS.ProcessEnv) =>
      runCheck(f.h, {
        argv,
        cwd: dir,
        env,
        signal: new AbortController().signal,
        timeoutMs: 30_000,
        write: [dir],
        readable: [],
        controller: [],
        settingsDir: join(dir, 'settings'),
      });
    // Команда начала работу, напечатала ту же строку, что sandbox-runtime
    // при отказе, и упала: это её провал, повтора нет.
    const started = await run(
      [
        process.execPath,
        '-e',
        `const fs=require('fs');fs.appendFileSync(${JSON.stringify(count)},'x');console.error("Error: Shell 'bash' not found in PATH");process.exit(1)`,
      ],
      { PATH: process.env.PATH, HOME: process.env.HOME },
    );
    assert.equal(started.code, 1);
    assert.equal(started.attempts, 1);
    assert.equal(await readFile(count, 'utf8'), 'x', 'команда выполнилась ровно один раз');

    // Песочница отказала до старта (в PATH нет даже `which`): повторы идут,
    // а команда не выполнялась ни разу.
    const refused = await run(
      [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(count)},'y')`],
      { PATH: '/nonexistent', HOME: process.env.HOME },
    );
    assert.notEqual(refused.code, 0);
    assert.equal(refused.attempts, 3, 'отказ до старта повторяется');
    assert.equal(await readFile(count, 'utf8'), 'x', 'непосредственно команда не запускалась');
  } finally {
    f.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Граница закрывает исходные checkout всех репозиториев, оставляя их .git', async () => {
  // Работа идёт в своём worktree; чужое рабочее дерево исполнителю и
  // проверке не нужно. В демо-фикстуре репозиторий лежит внутри каталога
  // контура, поэтому здесь проверяется сама граница, а её исполнение — в
  // тесте песочницы проверки выше.
  const f = await runtimeFixture();
  try {
    const boundary = new Scheduler(f.h, f.root).boundary('main');
    assert.ok(boundary.hidden.includes(f.config.repository), 'исходный checkout закрыт');
    assert.ok(boundary.hidden.includes(f.root), 'каталог контура закрыт');
    assert.deepEqual(boundary.readable, [join(f.config.repository, '.git')]);
  } finally {
    await f.cleanup();
  }
});

// Сбой проверяющего после готового кандидата — обрыв транспорта, как у живого
// codex: реализация уже прошла проверки, отказ ничего не говорит о коде.
async function reuseFixture() {
  const f = await runtimeFixture();
  const repo = repositories(f.config)[0];
  await git(
    repo.path,
    'update-ref',
    `refs/heads/${repo.targetBranch}`,
    await git(repo.path, 'rev-parse', 'HEAD'),
  );
  // Демо-задачи сливались бы параллельно и сдвигали базу: тогда основания
  // расходятся честно, и сценарий проверял бы не то.
  f.store.change('test.isolate', (s) => {
    for (const t of s.tasks) t.status = 'cancelled';
    return {};
  });
  const board = f.h.createBoard('Доска');
  const task = f.h.addTask(board.id, input('Задача со сбоем ревьюера'));
  f.h.approve(board.id);
  f.h.pause(false);
  const writes: string[] = [];
  const reviews: string[] = [];
  const runtimes = (review: 'crash' | 'reject' | 'approve') => ({
    ...adapters,
    demo: {
      ...adapters.demo,
      name: 'demo' as const,
      execute: async (request: AgentRequest) => {
        if (request.task?.id !== task.id) return adapters.demo.execute(request);
        if (!request.review) {
          writes.push(request.cwd);
          return adapters.demo.execute(request);
        }
        reviews.push(request.cwd);
        if (review === 'crash')
          throw new Error(
            'codex: runtime завершился с кодом -1: ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed',
          );
        return {
          data: {
            approved: review === 'approve',
            summary: review === 'approve' ? 'ok' : 'Критерий не выполнен',
            discoveries: [],
            findings:
              review === 'approve' ? [] : [{ severity: 'blocking', message: 'Нет поведения' }],
            previous: reviewTransitions(
              request.findings,
              review === 'approve',
              review === 'approve' ? 'Поведение есть' : 'Поведения по-прежнему нет',
            ),
          },
          log: '',
          command: ['fixture'],
        };
      },
    },
  });
  const drain = async (review: 'crash' | 'reject' | 'approve') => {
    const scheduler = new Scheduler(f.h, f.root, runtimes(review));
    await scheduler.drain();
    await scheduler.stop();
  };
  const retry = () => {
    f.h.retry(task.id);
    f.h.pause(false);
  };
  const runs = () => f.store.read().runs.filter((r) => r.taskId === task.id);
  const current = () => f.store.read().tasks.find((t) => t.id === task.id)!;
  return { ...f, repo, task, writes, reviews, drain, retry, runs, current };
}

test('После обрыва ревьюера повтор берёт готового кандидата и заново проверяет его', async () => {
  const f = await reuseFixture();
  try {
    await f.drain('crash');
    const [first] = f.runs();
    assert.equal(f.current().status, 'failed');
    assert.equal(first.failureKind, 'environment', 'обрыв канала — отказ окружения');
    assert.ok(first.candidateSha && first.implementationBasis);
    assert.equal(f.writes.length, 1);

    f.retry();
    await f.drain('approve');
    const second = f.runs()[1];
    assert.equal(f.current().status, 'done');
    assert.equal(f.writes.length, 1, 'код не пишется заново');
    assert.deepEqual(second.reusedFrom, { runId: first.id, candidateSha: first.candidateSha });
    assert.equal(second.candidateSha, first.candidateSha);
    assert.notEqual(second.token, first.token, 'новая попытка — новое владение');
    // Проверки и ревью кандидата исполнены новой попыткой, а не взяты у старой.
    assert.ok(
      second.evidence.some((e) => e.kind === 'test' && e.phase === 'candidate' && e.passed),
      'проверки кандидата прогнаны заново',
    );
    assert.ok(
      second.evidence.some((e) => e.kind === 'review' && e.phase === 'candidate' && e.passed),
    );
    assert.ok(second.timings!.some((t) => t.stage === 'implementation-reuse'));
    assert.ok(!second.timings!.some((t) => t.stage === 'implementation'));
    // Прежняя попытка со своими тратами осталась как была.
    assert.equal(f.runs()[0].status, 'failed');
    const metrics = workflowMetrics(f.h, taskOwner(f.current()));
    assert.equal(metrics.reuse.attempts, 1);
    assert.ok(metrics.reuse.implementationMsNotRepeated > 0, 'цена неповторённой реализации');
    assert.equal(metrics.attempts.find((a) => a.id === second.id)!.reusedFrom, first.id);
    assert.ok(metrics.phases.implementation.lostMs > 0, 'реализация упавшей попытки учтена');
    assert.ok(metrics.phases['implementation-reuse'].durationMs >= 0);
  } finally {
    await f.cleanup();
  }
});

test('Кандидат не берётся, если сдвинулась база, ревью отклонило код или reuse выключен', async () => {
  const f = await reuseFixture();
  try {
    // Сдвинутая база: основания разошлись — код пишется с нуля.
    await f.drain('crash');
    const tip = await git(f.repo.path, 'rev-parse', `refs/heads/${f.repo.targetBranch}`);
    const moved = await git(
      f.repo.path,
      'commit-tree',
      `${tip}^{tree}`,
      '-p',
      tip,
      '-m',
      'another accepted change',
    );
    await git(f.repo.path, 'update-ref', `refs/heads/${f.repo.targetBranch}`, moved, tip);
    f.retry();
    await f.drain('crash');
    assert.equal(f.writes.length, 2, 'новая база — новая реализация');
    assert.equal(f.runs()[1].reusedFrom, undefined);

    // Отказ ревью по существу: кандидат плох, повтор пишет код заново.
    f.retry();
    await f.drain('reject');
    assert.equal(f.runs()[2].reusedFrom?.runId, f.runs()[1].id, 'после обрыва — взят');
    assert.equal(f.writes.length, 2);
    assert.equal(f.runs()[2].failureKind, 'review');
    f.h.retry(f.task.id, { reason: 'продолжение теста за пределом попыток' });
    f.h.pause(false);
    await f.drain('crash');
    assert.equal(f.writes.length, 3, 'отклонённый кандидат не переиспользуется');
    assert.equal(f.runs()[3].reusedFrom, undefined);

    // Выключенная настройка возвращает прежнее поведение.
    f.h.config.reuseImplementation = false;
    f.h.retry(f.task.id, { reason: 'продолжение теста за пределом попыток' });
    f.h.pause(false);
    await f.drain('approve');
    assert.equal(f.writes.length, 4);
    assert.equal(f.runs()[4].reusedFrom, undefined);
    assert.equal(f.current().status, 'done');
  } finally {
    await f.cleanup();
  }
});

test('Взятый кандидат проходит ту же проверку области, что и новый', async () => {
  const f = await reuseFixture();
  try {
    await f.drain('crash');
    const [first] = f.runs();
    // Запись о кандидате подменена: коммит поверх той же базы меняет
    // защищённый файл. Совпавшие основания не делают такой код допустимым.
    const worktree = join(f.root, 'tamper');
    await git(f.repo.path, 'worktree', 'add', '--detach', worktree, first.baseSha!);
    await writeFile(join(worktree, 'verify.mjs'), 'process.exit(0);\n');
    await git(worktree, 'add', '-A');
    await git(worktree, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'x');
    const tampered = await git(worktree, 'rev-parse', 'HEAD');
    f.store.change('test.tamper', (s) => {
      s.runs.find((r) => r.id === first.id)!.candidateSha = tampered;
      return {};
    });
    const before = await git(f.repo.path, 'rev-parse', `refs/heads/${f.repo.targetBranch}`);
    f.retry();
    await f.drain('approve');
    const second = f.runs()[1];
    assert.equal(second.reusedFrom?.candidateSha, tampered);
    assert.equal(f.current().status, 'failed');
    assert.equal(second.failureKind, 'scope-violation');
    assert.equal(f.reviews.length, 1, 'ревью на недопустимого кандидата не тратится');
    assert.equal(await git(f.repo.path, 'rev-parse', `refs/heads/${f.repo.targetBranch}`), before);
  } finally {
    await f.cleanup();
  }
});

test('Проверка, которой песочница закрыла сеть, — отказ окружения, а не провал кода', async () => {
  const f = await runtimeFixture();
  try {
    const networkCommand = [
      'sh',
      '-c',
      'echo "GET https://registry.npmjs.org/-/ping"; curl -sS -o /dev/null https://registry.npmjs.org/-/ping',
    ];
    // Проверка с сетью — отдельная проверка вида check рядом с test gate профиля.
    f.h.config.gates.push({
      ...f.h.config.gates[0],
      id: 'network-check',
      kind: 'check',
      report: undefined,
      command: networkCommand,
    });
    reapprove(f.h);
    f.h.pause(false);
    await new Scheduler(f.h, f.root).drain();
    const run = f.store.read().runs.at(-1)!;
    assert.equal(run.failureKind, 'environment', run.error);
    assert.match(run.error!, /registry\.npmjs\.org/);
    assert.match(run.error!, /isolation\.domains/);
  } finally {
    await f.cleanup();
  }
});

test('Попытка, оборванная по времени, оставляет черновик, и повтор начинает с него', async () => {
  const f = await reuseFixture();
  try {
    const draftFile = `deliverables/draft-${f.task.id}.txt`;
    const seen: { draft?: string; told: boolean }[] = [];
    const runtimes = (attempt: 'timeout' | 'finish') => ({
      ...adapters,
      demo: {
        ...adapters.demo,
        name: 'demo' as const,
        execute: async (request: AgentRequest) => {
          if (request.task?.id !== f.task.id || request.review)
            return adapters.demo.execute(request);
          const path = join(request.cwd, draftFile);
          seen.push({
            draft: await readFile(path, 'utf8').catch(() => undefined),
            told: request.prompt.includes('ran out of time'),
          });
          if (attempt === 'finish') {
            // Доделанная работа заменяет черновик: демо-проверка знает только
            // свой результат.
            await rm(path, { force: true });
            return adapters.demo.execute(request);
          }
          await mkdir(join(request.cwd, 'deliverables'), { recursive: true });
          await writeFile(path, 'половина работы');
          throw new Error(
            'claude: runtime завершился с кодом 143 (исчерпан лимит времени прогона: 1 с). Лог: /tmp/x',
          );
        },
      },
    });
    let scheduler = new Scheduler(f.h, f.root, runtimes('timeout'));
    await scheduler.drain();
    await scheduler.stop();
    const [first] = f.runs();
    assert.equal(first.failureKind, 'timeout');
    assert.deepEqual(first.partial?.files, [draftFile]);
    assert.equal(first.candidateSha, undefined, 'черновик — не кандидат');

    f.retry();
    scheduler = new Scheduler(f.h, f.root, runtimes('finish'));
    await scheduler.drain();
    await scheduler.stop();
    const second = f.runs()[1];
    assert.equal(f.current().status, 'done');
    assert.deepEqual(seen, [
      { draft: undefined, told: false },
      { draft: 'половина работы', told: true },
    ]);
    assert.deepEqual(second.continuedFrom, {
      runId: first.id,
      kind: 'unfinished',
      reason: 'timeout',
      applied: true,
      files: [draftFile],
    });
    // Черновик под прежнюю постановку не выбрасывается, но помечается — правило
    // reuse harness (tests/reuse.test.ts пакета: «переутверждение помечает»).
  } finally {
    await f.cleanup();
  }
});

test('Кандидат, отклонённый ревью, — отправная точка повтора, а не выброшенная работа', async () => {
  const f = await reuseFixture();
  try {
    const deliverable = `deliverables/${f.task.id}.json`;
    const seen: { present: boolean; told: boolean }[] = [];
    const runtimes = (review: 'reject' | 'approve') => ({
      ...adapters,
      demo: {
        ...adapters.demo,
        name: 'demo' as const,
        execute: async (request: AgentRequest) => {
          if (request.task?.id !== f.task.id) return adapters.demo.execute(request);
          if (!request.review) {
            seen.push({
              present: await readFile(join(request.cwd, deliverable), 'utf8').then(
                () => true,
                () => false,
              ),
              told: request.prompt.includes('rejected by review'),
            });
            return adapters.demo.execute(request);
          }
          return {
            data: {
              approved: review === 'approve',
              summary: review === 'approve' ? 'ok' : 'Нет поведения',
              discoveries: [],
              findings:
                review === 'approve' ? [] : [{ severity: 'blocking', message: 'Нет поведения' }],
              previous: reviewTransitions(
                request.findings,
                review === 'approve',
                review === 'approve' ? 'Поведение есть' : 'Поведения по-прежнему нет',
              ),
            },
            log: '',
            command: ['fixture'],
          };
        },
      },
    });
    let scheduler = new Scheduler(f.h, f.root, runtimes('reject'));
    await scheduler.drain();
    await scheduler.stop();
    const [first] = f.runs();
    assert.equal(first.failureKind, 'review');
    f.retry();
    scheduler = new Scheduler(f.h, f.root, runtimes('approve'));
    await scheduler.drain();
    await scheduler.stop();
    assert.equal(f.current().status, 'done');
    assert.deepEqual(seen, [
      { present: false, told: false },
      { present: true, told: true },
    ]);
    assert.deepEqual(f.runs()[1].continuedFrom, {
      runId: first.id,
      kind: 'candidate',
      reason: 'review',
      applied: true,
      files: [deliverable],
    });
  } finally {
    await f.cleanup();
  }
});

test('Предел времени — на фазу: долгая реализация не отнимает время у ревью', async (t) => {
  // Двигаем только таймер бюджета фазы: Git, gates, heartbeat и их таймеры
  // остаются настоящими. Каждая фаза тратит 4 с из 6, сумма — больше 6 с.
  // Реальные sleep оставляли лишь 2 с на Git/изоляцию и падали под нагрузкой.
  const f = await reuseFixture();
  const budget = 6_000;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let clock = 0;
  const timers = new Map<NodeJS.Timeout, { at: number; fire: () => void }>();
  try {
    f.h.config.runTimeoutMs = budget;
    t.mock.method(
      globalThis,
      'setTimeout',
      (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms !== budget) return nativeSetTimeout(callback, ms, ...args);
        const timer = nativeSetTimeout(() => {}, 2 ** 31 - 1);
        timer.unref();
        timers.set(timer, { at: clock + budget, fire: () => callback(...args) });
        return timer;
      },
    );
    t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => {
      if (timer && typeof timer === 'object') timers.delete(timer);
      nativeClearTimeout(timer);
    });
    const spend = () => {
      assert.ok(timers.size > 0, 'таймер бюджета действительно установлен');
      clock += 4_000;
      for (const [timer, pending] of timers) {
        if (pending.at > clock) continue;
        timers.delete(timer);
        nativeClearTimeout(timer);
        pending.fire();
      }
    };
    const scheduler = new Scheduler(f.h, f.root, {
      ...adapters,
      demo: {
        ...adapters.demo,
        name: 'demo' as const,
        execute: async (request: AgentRequest) => {
          if (request.task?.id === f.task.id) spend();
          return adapters.demo.execute(request);
        },
      },
    });
    await scheduler.drain();
    await scheduler.stop();
    assert.equal(f.current().status, 'done', f.runs()[0]?.error);
    assert.ok(clock > budget, 'сумма фаз превысила один бюджет');
    assert.equal(timers.size, 0, 'таймер завершённой попытки снят');
  } finally {
    for (const timer of timers.keys()) nativeClearTimeout(timer);
    t.mock.restoreAll();
    await f.cleanup();
  }
});
