import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirementProof, unprovenRequirements } from '../src/core/proof.ts';
import { junitSummary } from '../src/runner/gates.ts';
import type { Evidence } from '../src/core/model.ts';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupDemo } from '../src/demo.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { requirementSnapshot, requirementReport } from '../src/runner/requirements.ts';
import { input } from './helpers.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: 'E1',
    runId: 'R1',
    kind: 'test',
    phase: 'integration',
    sha: SHA,
    gate: 'unit',
    passed: true,
    createdAt: new Date().toISOString(),
    command: ['npm', 'test'],
    exitCode: 0,
    log: '',
    digest: 'd',
    summary: 'ok',
    ...over,
  };
}
const link = { id: 'REQ-1', gate: 'unit', testId: 'cart.total.applies discount' };

test('Подтверждён только тот критерий, чей названный тест выполнился на принятом SHA', () => {
  const proof = requirementProof(
    link,
    [evidence({ tests: [{ id: link.testId, status: 'passed' }] })],
    SHA,
  );
  assert.equal(proof.level, 'testcase');
});

test('Зелёная проверка без связанного теста остаётся прежним, более слабым уровнем', () => {
  // История не переписывается: прежние задачи читаются на своём уровне, и он
  // называется прямо, а не выдаётся за подтверждённый сценарий.
  const proof = requirementProof({ id: 'REQ-1', gate: 'unit' }, [evidence()], SHA);
  assert.equal(proof.level, 'gate');
  assert.match(proof.reason, /не связан с конкретным тестом/);
});

test('Ни посторонний зелёный тест, ни пропуск, ни повтор, ни чужой SHA не подтверждают критерий', () => {
  const cases: [string, Evidence[], string | undefined, RegExp][] = [
    // Зелёная проверка есть, но заявленного теста в ней не было.
    [
      'посторонний тест',
      [evidence({ tests: [{ id: 'cart.total.other', status: 'passed' }] })],
      SHA,
      /не выполнялся/,
    ],
    [
      'пропущенный',
      [evidence({ tests: [{ id: link.testId, status: 'skipped' }] })],
      SHA,
      /skipped/,
    ],
    ['упавший', [evidence({ tests: [{ id: link.testId, status: 'failed' }] })], SHA, /failed/],
    [
      'повтор id',
      [
        evidence({
          tests: [
            { id: link.testId, status: 'passed' },
            { id: link.testId, status: 'passed' },
          ],
        }),
      ],
      SHA,
      /встречается/,
    ],
    [
      'обрезанный манифест',
      [evidence({ tests: [{ id: link.testId, status: 'passed' }], testsTruncated: true })],
      SHA,
      /обрезан/,
    ],
    [
      'другой SHA',
      [evidence({ sha: OTHER, tests: [{ id: link.testId, status: 'passed' }] })],
      SHA,
      /не выполнялась/,
    ],
    [
      'фаза кандидата',
      [evidence({ phase: 'candidate', tests: [{ id: link.testId, status: 'passed' }] })],
      SHA,
      /не выполнялась/,
    ],
    [
      'проверка не прошла',
      [evidence({ passed: false, tests: [{ id: link.testId, status: 'failed' }] })],
      SHA,
      /не прошла/,
    ],
    ['без манифеста', [evidence()], SHA, /не сообщила/],
    ['результат не принят', [evidence()], undefined, /не принят/],
  ];
  for (const [name, given, sha, reason] of cases) {
    const proof = requirementProof(link, given, sha);
    assert.equal(proof.level, 'none', name);
    assert.match(proof.reason, reason, name);
  }
});

test('Приёмка спрашивает только те критерии, которые сами назвали свой тест', () => {
  const evidences = [evidence({ tests: [{ id: link.testId, status: 'passed' }] })];
  const full = {
    id: 'REQ-1',
    source: 'docs/spec.md',
    digest: 'f'.repeat(64),
    text: 'Скидка применяется к сумме корзины',
    gate: 'unit',
    scenario: 'Корзина со скидкой',
  };
  assert.deepEqual(unprovenRequirements([{ ...full, testId: link.testId }], evidences, SHA), []);
  assert.deepEqual(
    unprovenRequirements([full], evidences, SHA),
    [],
    'прежний уровень не спрашивается',
  );
  assert.equal(
    unprovenRequirements([{ ...full, testId: 'cart.total.missing' }], evidences, SHA).length,
    1,
  );
});

test('Манифест собирается из отчёта проверки с исходами каждого testcase', () => {
  const xml = `<?xml version="1.0"?>
<testsuite tests="3" failures="1" skipped="1">
  <testcase classname="cart.total" name="applies discount"/>
  <testcase classname="cart.total" name="rejects negative"><failure message="boom"/></testcase>
  <testcase classname="cart.total" name="pending"><skipped/></testcase>
</testsuite>`;
  const summary = junitSummary(xml);
  assert.deepEqual(summary.cases, [
    { id: 'cart.total.applies discount', status: 'passed' },
    { id: 'cart.total.rejects negative', status: 'failed' },
    { id: 'cart.total.pending', status: 'skipped' },
  ]);
  assert.equal(summary.truncated, false);
  // Повреждённый отчёт не даёт манифеста вовсе.
  assert.throws(() => junitSummary('<testsuite'), /Некорректный JUnit/);
});

test('На настоящем прогоне приёмка требует именно названный тест', async () => {
  // Проверка идёт через реальный gate с отчётом JUnit: манифест собирается из
  // того, что действительно выполнилось, а не подставляется в evidence руками.
  const root = await mkdtemp(join(tmpdir(), 'devcontour-proof-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
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
    const board = h.createBoard('Traceable catalogue');
    const task = h.addTask(board.id, {
      ...input(),
      requirements: [
        {
          ...snapshot.requirements[0],
          source: snapshot.source,
          gate: config.gates[0].id,
          scenario: 'Catalogue listing',
          testId: 'current-task-result',
        },
      ],
    });
    h.approve(board.id);
    const scheduler = new Scheduler(h, root);
    await scheduler.init();
    await updateBase(config, root);
    h.pause(false);
    await scheduler.drain();
    assert.equal(store.read().tasks[0].status, 'done');

    // Манифест пришёл из отчёта настоящей проверки.
    const run = store.read().runs.findLast((r) => r.taskId === task.id)!;
    const proved = run.evidence.find(
      (e) => e.gate === config.gates[0].id && e.phase === 'integration',
    )!;
    assert.deepEqual(
      proved.tests?.map((t) => t.id),
      ['dependency-artifacts', 'current-task-result'],
    );

    // Критерий называет тест, которого в отчёте нет: приёмка отказывает.
    store.change('fixture.rename', (s) => {
      s.tasks[0].requirements![0].testId = 'scenario-nobody-ran';
    });
    await assert.rejects(() => acceptBoard(h, board.id, 'codex'), /не подтверждён/);
    assert.equal(store.read().boards[0].revisions.at(-1)!.status, 'active');

    // Названный тест действительно выполнился — приёмка проходит.
    store.change('fixture.restore', (s) => {
      s.tasks[0].requirements![0].testId = 'current-task-result';
    });
    await acceptBoard(h, board.id, 'codex');
    assert.equal(store.read().boards[0].revisions.at(-1)!.status, 'accepted');

    const report = requirementReport(h, 'main');
    assert.equal(report.tasks[0].requirements[0].proof, 'testcase');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
