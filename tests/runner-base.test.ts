import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockedError } from '../src/core/model.ts';
import { readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, reviewTransitions, type AgentRequest } from '../src/runner/adapters.ts';
import { git } from '../src/runner/process.ts';
import { input } from './helpers.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { repositories } from '../src/core/repositories.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { executionOf } from '../src/harness/execution.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { taskOwner } from '../src/core/sync-state.ts';
import { runtimeFixture } from './runner-fixture.ts';

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
    // Событие harness: сдвиг базы перемоткой очереди — актёр controller.
    assert.deepEqual(
      executionOf(f.h)
        .store.events(0, 500)
        .filter((e) => e.type === 'base.moved')
        .map((e) => (e as { payload?: { by?: string } }).payload?.by),
      ['controller'],
    );
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
    await assert.rejects(diverged.tick(), (e: Error) => {
      assert.match(e.message, /base-update/);
      // Продуктовые коммиты: перенос снимут gates, человек не нужен.
      assert.doesNotMatch(e.message, /подтверждение оператора/);
      return true;
    });
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
        // После переноса такую базу подтверждает только человек (D42):
        // остановка называет этот шаг заранее, а не только base-update.
        assert.match(
          e.message,
          /После переноса очередь продолжит только подтверждение оператора \(main:[^)]+\): «Подтвердить и запустить» в «Внимании»/,
          label,
        );
        return true;
      });
      assert.equal(await base(), from, label + ': база не сдвинута');
      await s.stop();
    };
    // Защищённый путь компонента — из его конфигурации.
    const guarded = repo.protectedPaths[0];
    const protectedFile = guarded.endsWith('/') ? guarded + 'guard.txt' : guarded;
    // Каталог контура, закоммиченный ссылкой: путь без «/» — тот же каталог.
    await sync();
    await symlink('elsewhere', join(repo.path, '.devcontour'));
    await git(repo.path, 'add', '.devcontour');
    await git(repo.path, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'link');
    await refused('symlink .devcontour', /main:\.devcontour[^/]/);
    await git(repo.path, 'rm', '-q', '.devcontour');
    await git(
      repo.path,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '-m',
      'unlink',
    );
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
      const { sensitive } = await (
        s as unknown as { fastForwardBase(d: unknown): Promise<{ sensitive: string[] }> }
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
