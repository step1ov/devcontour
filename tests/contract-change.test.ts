import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checksWarnings } from '../src/runner/agent-control.ts';
import {
  ContractChanges,
  clipAtBoundary,
  type ContractChange,
} from '../src/runner/contract-change.ts';
import { contractImpact } from '../src/runner/contract-impact.ts';
import { STALE_BASE, updateBase } from '../src/runner/base-update.ts';
import { type AgentAdapter, type AgentRequest } from '../src/runner/adapters.ts';
import { readyTasks } from '../src/core/graph.ts';
import { command } from '../src/runner/process.ts';
import { reviewers, stage } from './contract-change-fixture.ts';
import { withQuotedGitPaths } from './helpers.ts';

test('A contract change runs as one command: review, rebind, plan review, base and release', async () => {
  const s = await stage();
  try {
    s.h.pause(true);
    const started = await s.changes().start(s.proposal, 'codex');
    assert.equal(started.status, 'started');
    const done = await s.changes().advance((started as { operation: ContractChange }).operation.id);
    assert.equal(done.status, 'completed', done.error);
    const c2 = s.store.read().contracts.at(-1)!;
    assert.notEqual(c2.id, s.c1.id);
    assert.equal(done.contractId, c2.id);
    // Задача перепривязана к новой редакции и утверждена заново ревью плана.
    const api = s.task(s.api.id);
    assert.deepEqual(api.contracts, [c2.id]);
    assert.equal(api.status, 'ready');
    assert.equal(api.contractDigests[c2.id], c2.digest);
    // Зависимая задача удерживалась и отпущена, не перепривязываясь.
    assert.equal(s.task(s.screen.id).status, 'ready');
    // Принятая история не переписана: нужна корректировка.
    assert.deepEqual(s.task(s.shipped.id).contracts, [s.c1.id]);
    assert.deepEqual(done.corrections, [s.shipped.id]);
    assert.ok(
      s.store.read().tasks.every((t) => !t.hold),
      'удержание снято',
    );
    // База получила новую редакцию схемы — и только её.
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
    );
    assert.deepEqual(s.calls, ['contract / architecture decision', 'task plan']);
    assert.equal(s.store.read().paused, true, 'пауза оператора не снята');
    // Повтор команды по той же редакции ничего не меняет.
    assert.equal((await s.changes().start(s.proposal, 'codex')).status, 'unchanged');
  } finally {
    await s.remove();
  }
});

const staleBaseError = `TaskFailure: ${STALE_BASE}: main — main без 1 коммитов. Выполните devcontour base-update (ведущий агент — с --by host), иначе исполнитель получит дерево без подготовленной работы.`;

/** Пауза такта очереди — та же запись, что у планировщика (или пауза человека с той же ошибкой). */
const tickPause = (s: Awaited<ReturnType<typeof stage>>, error: string, reason?: 'operator') =>
  s.h.store.change('scheduler.error', (st) => {
    st.paused = true;
    st.pauseReason = reason;
    st.pausedAt = new Date().toISOString();
    return { error };
  });

test('F40: the base step lifts the runtime pause «base lags behind» once the base caught up; another runtime pause and an operator pause stay', async () => {
  for (const [error, reason, lifted] of [
    [staleBaseError, undefined, true],
    ['Error: provider is down', undefined, false],
    [staleBaseError, 'operator', false],
  ] as const) {
    const s = await stage();
    try {
      tickPause(s, error, reason);
      const started = await s.changes().start(s.proposal, 'codex');
      const id = (started as { operation: ContractChange }).operation.id;
      const done = await s.changes().advance(id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(
        s.sh('rev-parse', `refs/heads/${s.h.config.targetBranch}`),
        s.sh('rev-parse', 'HEAD'),
        'база равна рабочей ветке',
      );
      const state = s.store.read();
      assert.equal(state.paused, !lifted, error);
      if (reason) assert.equal(state.pauseReason, 'operator');
      // Снятие записано как действие операции, а не запуск человеком.
      const resumed = s.store
        .allEvents()
        .filter((e) => e.type === 'contract-change.queue-resumed')
        .map((e) => (e as unknown as { data: Record<string, unknown> }).data);
      assert.deepEqual(resumed, lifted ? [{ operation: id, reason: 'stale-base' }] : []);
    } finally {
      await s.remove();
    }
  }
});

test('F40: while a base still lags behind its working branch the pause stays; once moved it is lifted', async () => {
  const s = await stage();
  try {
    tickPause(s, staleBaseError);
    const lift = () =>
      (
        s.changes() as unknown as { liftStaleBasePause(op: { id: string }): Promise<boolean> }
      ).liftStaleBasePause({ id: 'CC-direct' });
    // Рабочая ветка впереди базы: снимать нечего.
    assert.equal(await lift(), false);
    assert.equal(s.store.read().paused, true);
    await updateBase(s.h.config, s.root);
    assert.equal(await lift(), true);
    assert.equal(s.store.read().paused, false);
  } finally {
    await s.remove();
  }
});

test('A revision without checks is warned about before the model call; a rejected review keeps a readable detail and a link to its full text', async () => {
  const s = await stage();
  try {
    s.h.pause(true);
    // Предупреждение видно до ревью: в отчёте влияния и при старте операции.
    const impact = await contractImpact(s.h, s.proposal);
    assert.equal(impact.warnings.length, 1);
    assert.equal(impact.warnings[0].code, 'checks-missing');
    assert.equal(impact.warnings[0].rule, 'verifiability');
    assert.match(impact.warnings[0].message, /утверждённого до появления checks/);
    assert.deepEqual(checksWarnings({ checks: { version: 1 } }, s.c1), []);
    const started = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
      warnings: { code: string }[];
    };
    assert.deepEqual(
      started.warnings.map((w) => w.code),
      ['checks-missing'],
    );
    assert.equal(s.calls.length, 0, 'предупреждение — до вызова модели');
    assert.ok(started.operation.history.some((h) => h.event === 'warning'));
    // Ревьюер отклоняет с длинным итогом: запись истории ограничена, но не
    // обрывается посреди слова, и полный текст доступен по ссылке.
    const summary = Array.from(
      { length: 40 },
      (_, i) => `Обязательство номер ${i} не объявлено в договоре проверки`,
    ).join('. ');
    const rejecting = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      execute: () =>
        Promise.resolve({
          data: { approved: false, summary, findings: [], discoveries: [] },
          log: 'Fixture only; no provider called',
          command: ['fixture'],
        }),
    });
    const failed = await new ContractChanges(s.h, s.root, {
      codex: rejecting('codex'),
      claude: rejecting('claude'),
    }).advance(started.operation.id);
    assert.equal(failed.status, 'failed');
    const entry = failed.history.at(-1)!;
    assert.equal(entry.step, 'review');
    assert.ok(entry.detail!.length <= 500, String(entry.detail!.length));
    assert.ok(entry.detail!.endsWith('…'), entry.detail);
    const kept = entry.detail!.slice(0, -1);
    const message = 'Независимое ревью отклонено: ' + summary;
    assert.ok(message.startsWith(kept), 'начало текста сохранено');
    assert.match(message.slice(kept.length), /^[.;\s]/, 'обрыв по границе фразы или слова');
    const attempt = s.store.read().contractAttempts!.find((a) => a.id === entry.review?.id);
    assert.ok(attempt, 'ссылка на попытку ревью');
    assert.equal(attempt.summary, summary, 'полный текст доступен по ссылке');
    assert.equal(entry.review!.artifact, attempt.artifact);
    assert.ok(failed.error!.length <= 1000 && failed.error!.endsWith('…'));
  } finally {
    await s.remove();
  }
});

test('clipAtBoundary keeps short text and cuts long text at a sentence or word boundary', () => {
  assert.equal(clipAtBoundary('short text', 50), 'short text');
  assert.equal(clipAtBoundary('one two three four five', 12), 'one two…');
  assert.equal(
    clipAtBoundary('First sentence is here. Second one goes on and on', 30),
    'First sentence is here.…',
  );
  assert.equal(clipAtBoundary('x'.repeat(20), 10), 'x'.repeat(9) + '…');
  // Суррогатная пара не разрезается: эмодзи на границе уходит целиком.
  const cut = clipAtBoundary('x'.repeat(8) + '😀' + 'y'.repeat(10), 10);
  assert.equal(cut, 'x'.repeat(8) + '…');
  assert.ok(!/[\uD800-\uDBFF]…$/.test(cut));
});

test('contract-change exits non-zero when the operation fails, and still prints its JSON', async () => {
  const s = await stage();
  try {
    s.h.pause(true);
    // Процесс CLI читает конфигурацию с диска; модели он не вызывает: шаг
    // hold отказывает раньше ревью.
    const runtime = { runtime: 'codex' };
    await writeFile(
      join(s.root, 'config.json'),
      JSON.stringify({
        ...s.h.config,
        roles: Object.fromEntries(Object.keys(s.h.config.roles).map((r) => [r, runtime])),
        reviewer: { runtime: 'claude' },
      }),
    );
    const started = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Задачу держит другая операция: шаг hold отказывает без вызова модели.
    s.h.hold([s.api.id], 'CC-other', 'другая операция');
    const run = await command(
      [
        process.execPath,
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/cli.ts'),
        'contract-change',
        '--id',
        started.operation.id,
        '--data',
        s.root,
      ],
      process.cwd(),
      {
        timeoutMs: 120000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      },
    );
    if (!run.stdout) throw new Error(run.stderr);
    const out = JSON.parse(run.stdout) as { status: string; error?: string; version?: number };
    assert.equal(out.status, 'failed', run.stderr);
    assert.match(out.error ?? '', /другая операция|удерживает/);
    assert.equal(run.code, 1);
    // --file без значения — понятный отказ, а не чтение каталога.
    const missing = await command(
      [
        process.execPath,
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/cli.ts'),
        'contract-change',
        '--id',
        started.operation.id,
        '--revise',
        '--expected-version',
        String(out.version ?? 0),
        '--data',
        s.root,
        '--file',
      ],
      process.cwd(),
      {
        timeoutMs: 120000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      },
    );
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Укажите путь к файлу предложения/);
    assert.doesNotMatch(missing.stderr, /EISDIR/);
  } finally {
    await s.remove();
  }
});

test('The plan reviewer sees the base the tasks will run on: the base moves before the plan review', async () => {
  const s = await stage();
  try {
    // Рецензент плана читает базу в момент ревью: при обратном порядке он
    // видел прежнюю схему и отклонял план, которому новая ещё не досталась.
    const seen: string[] = [];
    const base = reviewers(s.calls);
    const planReader: AgentAdapter = {
      ...base.codex,
      execute(r: AgentRequest) {
        if (/Independently review this task plan\./.test(r.prompt))
          seen.push(s.sh('show', 'devcontour/accepted:schema.json'));
        return base.codex.execute(r);
      },
    };
    const changes = new ContractChanges(s.h, s.root, { codex: planReader, claude: planReader });
    const { operation } = (await changes.start(s.proposal, 'claude')) as {
      operation: ContractChange;
    };
    const done = await changes.advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.deepEqual(seen, ['{"price":"number"}']);
    const order = done.history.filter((h) => h.event === 'done').map((h) => h.step);
    assert.deepEqual(order, [
      'hold',
      'drain',
      'review',
      'rebind',
      'base',
      'context',
      'reconfigure',
      'plan',
      'release',
    ]);
  } finally {
    await s.remove();
  }
});

test('An operation started with the previous step order continues by it', async () => {
  const s = await stage();
  try {
    // Операция прежнего порядка остановилась перед ревью планов (индекс 4):
    // при новом порядке тот же индекс — перенос базы, и без учёта порядка
    // операция, уже прошедшая план, пропустила бы перенос.
    const legacy = s.changes((step) => {
      if (step === 'rebind') throw new Error('stop after rebind');
    });
    const { operation } = (await legacy.start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    await legacy.advance(operation.id);
    const stopped = s.changes().get(operation.id);
    assert.equal(stopped.step, 4);
    s.store.atomic(() => {
      const { order, ...rest } = s.changes().get(operation.id);
      void order;
      s.store.saveLocal('contract-change', rest.owner, rest.id, rest);
    });
    assert.equal(s.changes().view(s.changes().get(operation.id)).next, 'plan');
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    const order = done.history.filter((h) => h.event === 'done').map((h) => h.step);
    assert.deepEqual(order, ['hold', 'drain', 'review', 'rebind', 'plan', 'base', 'release']);
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
      'перенос базы не пропущен',
    );
  } finally {
    await s.remove();
  }
});

test('A contract change resumes after a crash without repeating the review, and a live owner is not overtaken', async () => {
  const s = await stage();
  try {
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Сбой процесса сразу после ревью: владение осталось, lease ещё действует.
    class Crash extends Error {}
    await s
      .changes((step) => {
        if (step === 'review') throw new Crash('process died');
      })
      .advance(operation.id)
      .catch(() => undefined);
    // Сбой в точке после шага записан как отказ; моделируем «процесс умер»:
    // запись осталась running с действующим lease.
    s.store.atomic(() =>
      s.store.saveLocal('contract-change', operation.owner, operation.id, {
        ...s.changes().get(operation.id),
        status: 'running',
        token: 'dead-process',
        leaseUntil: Date.now() + 60000,
      }),
    );
    // Пока lease жив, другой процесс не перехватывает операцию.
    const blocked = await s.changes().advance(operation.id);
    assert.equal(blocked.status, 'running');
    assert.equal(blocked.next, 'rebind');
    // Lease истёк — операция продолжается с сохранённого шага.
    s.store.atomic(() =>
      s.store.saveLocal('contract-change', operation.owner, operation.id, {
        ...s.changes().get(operation.id),
        leaseUntil: Date.now() - 1,
      }),
    );
    const resumed = await s.changes().advance(operation.id);
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(s.store.read().contracts.length, 2, 'новая редакция одна');
    assert.equal(
      s.calls.filter((c) => c.startsWith('contract')).length,
      1,
      'ревью контракта не повторялось',
    );
  } finally {
    await s.remove();
  }
});

test('A contract change waits for running attempts, refuses concurrent changes and goes stale when the branch moves', async () => {
  const s = await stage();
  try {
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Вторая операция по другой редакции того же контракта — отказ.
    await writeFile(join(s.repo, 'schema.json'), '{"price":"decimal"}\n');
    s.sh('commit', '-qam', 'another revision');
    await assert.rejects(s.changes().start(s.proposal, 'codex'), /по другой редакции/);
    s.sh('reset', '-q', '--hard', 'HEAD~1');
    // Та же редакция — та же операция.
    const again = await s.changes().start(s.proposal, 'codex');
    assert.equal(again.status, 'existing');

    // Идущая попытка: операция ждёт, а не отменяет её.
    s.store.change('fixture.running', (st) => {
      st.tasks.find((t) => t.id === s.api.id)!.activeRunId = 'R-running';
    });
    const waiting = await s.changes().advance(operation.id);
    assert.equal(waiting.status, 'waiting');
    assert.deepEqual(waiting.waitingFor, [s.api.id]);
    assert.ok(s.task(s.screen.id).hold, 'зависимые задачи удержаны');
    s.store.change('fixture.finished', (st) => {
      st.tasks.find((t) => t.id === s.api.id)!.activeRunId = undefined;
    });

    // Конкурент сдвинул рабочую ветку до ревью — операция устарела.
    await writeFile(join(s.repo, 'other.txt'), 'competitor\n');
    s.sh('add', 'other.txt');
    s.sh('commit', '-qm', 'competitor');
    const stale = await s.changes().advance(operation.id);
    assert.equal(stale.status, 'stale');
    assert.match(stale.error ?? '', /сдвинулась/);
    assert.equal(s.store.read().contracts.length, 1, 'ревью не проводилось');
    const abandoned = s.changes().abandon(operation.id);
    assert.equal(abandoned.status, 'abandoned');
    assert.ok(
      s.store.read().tasks.every((t) => !t.hold),
      'отмена снимает удержание',
    );
  } finally {
    await s.remove();
  }
});

test('A contract change does not move base work that is not part of the contract, and holds stay consistent', async () => {
  const s = await stage();
  try {
    // Посторонняя работа уже лежит в рабочей ветке к началу операции.
    execFileSync('sh', ['-c', 'echo x > unrelated.txt'], { cwd: s.repo });
    s.sh('add', 'unrelated.txt');
    s.sh('commit', '-qm', 'unrelated');
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const failed = await s.changes().advance(operation.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.next, 'base');
    assert.match(failed.error ?? '', /вне контракта: unrelated\.txt/);
    // База не тронута, задачи удержаны: выдача не начнёт работу без схемы.
    assert.notEqual(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
    );
    assert.equal(s.task(s.api.id).hold?.operation, operation.id);
    assert.equal(
      readyTasks(s.store.read()).some((t) => t.id === s.api.id),
      false,
      'выдача пропускает удержанную задачу',
    );
    // Чужое удержание — конфликт для другой операции.
    assert.throws(() => s.h.hold([s.api.id], 'CC-other', 'test'), /другая операция/);
  } finally {
    await s.remove();
  }
});

test('Work reverted within the branch does not stop the base move; a file renamed onto an artifact does', async () => {
  const s = await stage();
  try {
    // Посторонняя правка и её отмена: итог ветки — только изменение контракта.
    execFileSync('sh', ['-c', 'echo x > scratch.txt'], { cwd: s.repo });
    s.sh('add', 'scratch.txt');
    s.sh('commit', '-qm', 'scratch');
    s.sh('rm', '-q', 'scratch.txt');
    s.sh('commit', '-qm', 'revert scratch');
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
    );
  } finally {
    await s.remove();
  }
  const r = await stage();
  try {
    // Посторонний файл переименован в новый артефакт: Git показал бы только
    // новый путь, а удаление прежнего — тоже изменение вне контракта.
    await writeFile(join(r.repo, 'notes.txt'), 'notes about types\n');
    r.sh('add', 'notes.txt');
    r.sh('commit', '-qm', 'notes');
    r.sh('branch', '-f', 'devcontour/accepted', 'HEAD');
    r.sh('mv', 'notes.txt', 'types.txt');
    r.sh('commit', '-qm', 'rename notes into a new artifact');
    const proposal = {
      ...r.proposal,
      artifacts: [...r.proposal.artifacts, { path: 'types.txt', purpose: 'Типы' }],
    };
    const { operation } = (await r.changes().start(proposal, 'codex')) as {
      operation: ContractChange;
    };
    const failed = await r.changes().advance(operation.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /вне контракта: notes\.txt/);
  } finally {
    await r.remove();
  }
});

test('A contract artifact with a Cyrillic path moves to the base: it is not work outside the contract', async () => {
  await withQuotedGitPaths(async () => {
    const s = await stage();
    try {
      // Новый артефакт кириллицей: экранированный git путь не совпал бы с
      // путём артефакта, и операция отказала бы «вне контракта».
      await writeFile(join(s.repo, 'типы.txt'), 'типы ответа\n');
      s.sh('add', 'типы.txt');
      s.sh('commit', '-qm', 'cyrillic artifact');
      const proposal = {
        ...s.proposal,
        artifacts: [...s.proposal.artifacts, { path: 'типы.txt', purpose: 'Типы' }],
      };
      const { operation } = (await s.changes().start(proposal, 'codex')) as {
        operation: ContractChange;
      };
      const done = await s.changes().advance(operation.id);
      assert.equal(done.status, 'completed', done.error);
      assert.equal(
        s.sh('rev-parse', 'devcontour/accepted:типы.txt'),
        s.sh('rev-parse', 'HEAD:типы.txt'),
      );
    } finally {
      await s.remove();
    }
  });
});
