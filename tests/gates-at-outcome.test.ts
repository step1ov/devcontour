// Исход `runGatesAt` в проверке базы и проверке доски (поля harness
// 0.1.0-alpha.50 `interrupted`, `skipped`, `warnings`): прерванная проверка —
// не провал gates, хотя и не PASS; предупреждения пробы портов — в журнале.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/core/model.ts';
import { Store } from '../src/core/store.ts';
import {
  BOARD_COVERAGE,
  DevContour,
  boardCoverageKey,
  type BoardCoverage,
} from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { BASE_CHECK, checkBase, type BaseCheck } from '../src/runner/base-check.ts';
import { gatesOutcome, interruptionLine, outcomeFields } from '../src/runner/board-coverage.ts';
import { demoPool, testDemo } from './demo-pool.ts';
import { input } from './helpers.ts';

test('Исход runGatesAt: прерванный и неисполненные gates — не провал; предупреждения — короткими строками', () => {
  const outcome = gatesOutcome({
    failures: [
      { gate: 'lint', message: 'exit 1' },
      { gate: 'unit', message: 'прерван: истёк срок' },
      { gate: 'e2e', message: 'не исполнен: проверка прервана' },
    ],
    interrupted: { gate: 'unit', reason: 'истёк срок' },
    skipped: ['e2e'],
    warnings: ['port-shared:5000 ' + 'x'.repeat(1000)],
  });
  assert.deepEqual(outcome.failed, [{ gate: 'lint', message: 'exit 1' }]);
  assert.deepEqual(outcome.interrupted, { gate: 'unit', reason: 'истёк срок' });
  assert.deepEqual(outcome.skipped, ['e2e']);
  assert.equal(outcome.warnings.length, 1);
  assert.ok(outcome.warnings[0].startsWith('port-shared:5000'));
  assert.ok(outcome.warnings[0].length < 1000);
  assert.equal(interruptionLine('main', outcome), 'main/unit (истёк срок); не исполнены: e2e');
  assert.deepEqual(Object.keys(outcomeFields(outcome)).sort(), [
    'interrupted',
    'skipped',
    'warnings',
  ]);
  // Прежний результат (без новых полей) — как прежде: все непрошедшие — провал.
  const plain = gatesOutcome({ failures: [{ gate: 'unit', message: 'exit 1' }] });
  assert.deepEqual(plain.failed, [{ gate: 'unit', message: 'exit 1' }]);
  assert.equal(interruptionLine('main', plain), undefined);
  assert.deepEqual(outcomeFields(plain), {});
});

/** Gate, который ждёт `ms` и потом пишет JUnit; `only` — условие ожидания. */
const sleeper = (ms: number, only = 'true') =>
  `const{writeFileSync,mkdirSync}=require('node:fs');const done=()=>{mkdirSync('.reports',{recursive:true});writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="slow"/></testsuite>');process.exit(0)};if(${only})setTimeout(done,${ms});else done();`;

test('Проверка базы, прерванная сроком фазы: запись passed=false с interrupted, событие failed с причиной, ожидание называет прерывание, а не провал', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-base-interrupted-'));
  try {
    await testDemo(root);
    const c = loadConfig(join(root, 'config.json'));
    c.gates = [
      {
        id: 'slow',
        kind: 'test',
        timeoutMs: 30000,
        command: [process.execPath, '-e', sleeper(20000)],
        report: { type: 'junit', path: '.reports/slow.xml' },
      },
    ] as Config['gates'];
    // Срок фазы короче gate: harness прерывает проверку своим пределом.
    c.runTimeoutMs = 2000;
    const store = new Store(join(root, 'interrupted-base.sqlite'));
    const h = new DevContour(store, c);
    try {
      const target = 'refs/heads/' + c.targetBranch;
      await writeFile(join(c.repository, 'base.txt'), 'moved');
      await git(c.repository, 'add', '--', 'base.txt');
      await git(c.repository, 'commit', '-qm', 'Base moved');
      const sha = await git(c.repository, 'rev-parse', 'HEAD');
      const from = await git(c.repository, 'rev-parse', target);
      await git(c.repository, 'update-ref', target, sha);
      h.baseUpdated([{ repositoryId: 'main', from, to: sha }]);
      assert.ok(h.leader('server'));
      const cleared = await checkBase(h, { data: root, state: root }, () => {
        h.leader('server');
      });
      assert.equal(cleared, false, 'прерванная проверка ожидание не снимает');
      const record = store.localRecord<BaseCheck>(BASE_CHECK, 'main', sha)!;
      assert.equal(record.passed, false);
      assert.equal(record.interrupted?.gate, 'slow', JSON.stringify(record));
      assert.ok(record.interrupted?.reason);
      assert.equal(record.tries, 2, 'прерывание сроком повторяется один раз, как провал');
      const closing = store
        .allEvents()
        .filter((e) => e.type === 'base.check.failed')
        .map(
          (e) =>
            e.data as {
              reason?: string;
              interrupted?: { gate?: string };
              failures?: string[];
            },
        );
      assert.equal(closing.length, 2);
      for (const e of closing) {
        assert.equal(e.reason, 'interrupted');
        assert.equal(e.interrupted?.gate, 'slow');
        assert.deepEqual(e.failures, ['slow'], 'failures — для совместимости, как прежде');
      }
      const wait = store.read().waits?.find((w) => w.kind === 'base-check');
      assert.match(String(wait?.detail), /^Проверка базы прервана: main\/slow \(/);
      assert.doesNotMatch(String(wait?.detail), /не пройдена/);
      assert.ok(store.read().paused, 'выдача по-прежнему ждёт');
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const demos = demoPool(testDemo);
after(() => demos.close());

test('Проверка доски, прерванная сроком фазы: отказ приёмки называет прерывание, событие и запись — interrupted, passed не выдаётся', async () => {
  const seed = await demos.acquire();
  const { root } = seed;
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const gate = (id: string, script: string) => ({
      id,
      kind: 'test' as const,
      command: [process.execPath, '-e', script],
      timeoutMs: 60_000,
      report: { type: 'junit' as const, path: `.reports/${id}.xml` },
    });
    // `slow` ждёт только в проверке доски (runId BC-…); задачи его не исполняют.
    config.gates = [
      gate('unit', sleeper(0, 'false')),
      gate('slow', sleeper(20000, "String(process.env.DEVCONTOUR_RUN_ID).startsWith('BC-')")),
    ];
    const board = h.createBoard('Scoped release');
    h.addTask(board.id, { ...input('Part A'), gates: ['unit'] });
    h.approve(board.id);
    const runtimes = {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          if (r.review)
            return {
              data: { approved: true, summary: 'Looks fine', findings: [] },
              log: 'fixture',
              command: ['fixture'],
            };
          await writeFile(join(r.cwd, `part-${r.task.id}.txt`), r.task.title + '\n');
          return {
            data: { completed: true, summary: 'Implemented' },
            log: 'fixture',
            command: ['fixture'],
          };
        },
      },
    };
    const scheduler = new Scheduler(h, root, runtimes);
    await scheduler.init();
    await updateBase(config, root);
    h.pause(false);
    await scheduler.drain();
    await scheduler.stop();
    assert.ok(store.read().tasks.every((t) => t.status === 'done'));
    const head = store.read().tasks[0].resultSha!;
    // Эксплуатационный срок фазы короче gate доски.
    h.config.runTimeoutMs = 2000;
    await assert.rejects(
      acceptBoard(h, board.id, 'codex', false, undefined, { root }),
      (e: Error) => {
        assert.match(e.message, /^Проверка доски на итоговом SHA прервана: main\/slow \(/);
        assert.ok(e.message.includes(`на ${head}`), e.message);
        assert.doesNotMatch(e.message, /не пройдена/);
        return true;
      },
    );
    const closing = store.events().find((e) => e.type === 'board.coverage.failed')!.data as {
      reason?: string;
      interrupted?: { gate?: string };
      failures?: string[];
    };
    assert.equal(closing.reason, 'interrupted');
    assert.equal(closing.interrupted?.gate, 'slow');
    assert.deepEqual(closing.failures, ['slow']);
    const record = store.localRecord<BoardCoverage>(
      BOARD_COVERAGE,
      'main',
      boardCoverageKey(board.id, 1),
    )!;
    assert.equal(record.interrupted?.gate, 'slow');
    assert.equal(record.failure?.gate, 'slow', 'прерванная проверка не выглядит прошедшей');
    assert.equal(store.read().boards[0].revisions.at(-1)!.status, 'active');
  } finally {
    store.close();
    seed.release();
  }
});
