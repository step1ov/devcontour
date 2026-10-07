import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence } from '../src/core/model.ts';
import { CheckCorpus } from '../src/core/check-store.ts';
import { caseHooks, submitCase } from '../src/runner/checks.ts';
import { command, git } from '../src/runner/process.ts';
import {
  check,
  checkProject,
  commit,
  fixture,
  knap,
  rejection,
  removeRoot,
} from './check-fixture.ts';

const zero = '{"items":[{"w":0,"v":5}],"cap":0}';
const weak = () => ({ 'check.mjs': check(120, { zeroWeights: false }) });

async function startTask(
  f: Awaited<ReturnType<typeof fixture>>,
  title = 'Optimal knapsack',
  properties = ['knapsack-optimal'],
) {
  const board = f.h.createBoard(title);
  const t = f.h.addTask(board.id, {
    title,
    description: 'Оптимум рюкзака по договору проверки.',
    role: 'backend',
    contracts: [f.contract!.id],
    acceptance: ['AC-optimal'],
    writePaths: ['src/'],
    properties,
  });
  f.h.approve(board.id);
  f.h.pause(false);
  return t;
}
const task = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.store.read().tasks.find((t) => t.id === id)!;
const lastRun = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.store.read().runs.findLast((r) => r.taskId === id)!;
const gateOf = (run: { evidence: Evidence[] }, phase = 'candidate') =>
  run.evidence.findLast((e) => e.gate === 'properties' && e.phase === phase)!;

test('AC10–AC12, AC18: the pinned oracle decides a reviewer example; wrong expectations, shell text, unknown properties and masked inputs never become normative', async () => {
  const p = await checkProject(weak());
  let reject = true;
  const f = await fixture(p, {
    reviewer: () =>
      reject
        ? rejection(
            // Ревьюер ошибся в ожидании: эталон даёт 5.
            { property: 'knapsack-optimal', input: zero, expected: '7', actual: '0' },
            {
              command: ['node', '-e', 'require("fs").writeFileSync("PWNED", "")'],
            },
          )
        : undefined,
  });
  try {
    f.write('src/knap.mjs', knap.zeroWeight);
    const t = await startTask(f);
    await f.scheduler.drain();
    const run = lastRun(f, t.id);
    assert.equal(run.failureKind, 'review', run.error);
    assert.equal(gateOf(run).passed, true, 'генератор без нулевых весов дефекта не видит');
    const reproduction = f.store.read().reproductions!.find((r) => r.taskId === t.id)!;
    assert.equal(reproduction.observed, false);
    // Контур сам проверил пример ревьюера эталоном (agent mode): ожидание
    // опровергнуто, нормативным оно не стало.
    const corpusAfterRun = new CheckCorpus(f.h).all()[0];
    assert.equal(corpusAfterRun.decisions.length, 1);
    assert.equal(corpusAfterRun.decisions[0].outcome, 'refuted');
    assert.equal(corpusAfterRun.decisions[0].origin.kind, 'review');
    assert.equal(corpusAfterRun.versions.length, 0);
    reject = false;
    const reviews = f.calls.review;
    const contracts = f.store.read().contracts.length;
    const approved = task(f, t.id).approvedDigest;

    // AC10: ожидание ревьюера неверно — опровергнуто, нормативным не стало.
    const wrong = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: zero,
      expected: '7',
      reproductionId: reproduction.id,
      key: 'case-wrong-expected',
      origin: 'review',
    });
    assert.equal(wrong.decision.outcome, 'refuted');
    assert.match(wrong.decision.reason, /опровергнуто эталоном: 5/);
    assert.equal(wrong.decision.observed?.expected, '5');
    assert.equal(wrong.version, null, 'версии корпуса нет');
    assert.equal(task(f, t.id).checkVersion, undefined);

    // AC11: верный пример подтверждён эталоном на дефектном SHA.
    const ok = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: '{ "cap": 0, "items": [ { "v": 5, "w": 0 } ] }',
      expected: '5',
      actual: '0',
      reproductionId: reproduction.id,
      key: 'case-zero-weight',
      origin: 'review',
    });
    assert.equal(ok.decision.outcome, 'confirmed', ok.decision.reason);
    assert.equal(
      ok.decision.input,
      '{"cap":0,"items":[{"v":5,"w":0}]}',
      'вход канонизирован: ключи отсортированы',
    );
    assert.equal(ok.decision.source.sha, run.candidateSha);
    assert.equal(ok.decision.observed?.repeats, 2);
    assert.deepEqual(ok.version?.number, 1);
    assert.equal(ok.decision.method?.gate, 'properties');
    assert.deepEqual(ok.decision.method?.artifacts.map((a) => a.path).sort(), [
      'check.mjs',
      'harness.mjs',
      'oracle.mjs',
    ]);
    assert.equal(f.calls.review, reviews, 'без вызова модели на подтверждение');
    assert.equal(f.store.read().contracts.length, contracts, 'без полного contract-change');
    const bound = task(f, t.id);
    assert.equal(bound.checkVersion?.number, 1);
    assert.equal(bound.approvedDigest, approved, 'утверждённый digest не переписан');
    const suite = new CheckCorpus(f.h).get(ok.suite);
    const version = suite.versions[0];
    // Версия корпуса — Git blob в репозитории компонента.
    const content = await git(p.repo, 'cat-file', 'blob', version.blob);
    assert.ok(content.includes('"expected":5'));
    // Повтор с тем же ключом возвращает прежний исход.
    const again = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: zero,
      key: 'case-zero-weight',
    });
    assert.equal(again.repeated, true);
    assert.equal(new CheckCorpus(f.h).get(ok.suite).decisions.length, 3);

    // AC12: shell-текст во входе — данные, а не команда; вне области — отказ.
    const shell = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: JSON.stringify({ items: '$(touch MARK)', cap: 0 }),
      key: 'case-shell',
    });
    assert.equal(shell.decision.outcome, 'rejected');
    assert.match(shell.decision.reason, /вне объявленной области/);
    const unknown = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'nope',
      input: zero,
      key: 'case-unknown',
    });
    assert.equal(unknown.decision.outcome, 'rejected');
    assert.match(unknown.decision.reason, /свойство nope не объявлено/);
    const masked = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: '{"items":[{"w":0,"v":"[REDACTED]"}],"cap":0}',
      key: 'case-masked',
    });
    assert.equal(masked.decision.outcome, 'rejected');
    assert.match(masked.decision.reason, /замаскирован/);
    const notJson = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: 'rm -rf /',
      key: 'case-not-json',
    });
    assert.equal(notJson.decision.outcome, 'rejected');
    for (const dir of [p.repo, p.root, process.cwd()]) {
      assert.equal(existsSync(join(dir, 'MARK')), false);
      assert.equal(existsSync(join(dir, 'PWNED')), false, 'команда воспроизведения не запускалась');
    }
    assert.equal(new CheckCorpus(f.h).get(ok.suite).versions.length, 1);

    // AC18: быстрый путь не удаляет, не заменяет ожидание и не меняет checker.
    for (const change of ['remove', 'replace-expected', 'tolerance', 'checker'] as const)
      await assert.rejects(
        submitCase(f.h, p.root, {
          taskId: t.id,
          property: 'knapsack-optimal',
          input: zero,
          key: 'case-change-' + change,
          change,
        }),
        /только добавляет подтверждённые случаи.*contract-change/s,
      );
    // Тот же вход с другим ожиданием — конфликт, а не выбор одного.
    const corpus = new CheckCorpus(f.h);
    const begun = corpus.begin({ suite: corpus.get(ok.suite) }, 'case-conflict');
    const conflict = corpus.record(
      corpus.get(ok.suite),
      'case-conflict',
      begun.token!,
      {
        property: 'knapsack-optimal',
        input: zero,
        inputHash: 'x',
        outcome: 'confirmed',
        reason: 'подделка',
        source: { sha: run.candidateSha! },
        observed: { expected: '6', actual: '0', equal: false, repeats: 2, durationsMs: [] },
        origin: { kind: 'agent' },
      },
      () => 'f'.repeat(40),
      { tasks: [t.id], actor: 'agent' },
    );
    assert.equal(conflict.decision.outcome, 'inconclusive');
    assert.match(conflict.decision.reason, /конфликт ожиданий/);
    const after = new CheckCorpus(f.h).get(ok.suite);
    assert.equal(after.versions.length, 1);
    assert.equal(after.cases[ok.decision.caseId!].expected, '5', 'принятое не переписано');
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC13, AC19: a confirmed defect stops the next candidate at the gate before any review, the executor self-check catches it, and the full corpus runs beyond 500 reproductions and 20 prompt cases', async () => {
  const p = await checkProject(weak());
  const f = await fixture(p, {
    selfCheck: true,
    reviewer: (_r, calls) =>
      calls.review === 1
        ? rejection({ property: 'knapsack-optimal', input: zero, expected: '5', actual: '0' })
        : undefined,
  });
  try {
    f.write('src/knap.mjs', knap.zeroWeight);
    const t = await startTask(f);
    await f.scheduler.drain();
    const first = lastRun(f, t.id);
    assert.equal(first.failureKind, 'review');
    // 25 подтверждённых случаев одного класса: больше, чем выдаёт подсказка.
    for (let v = 1; v <= 25; v++) {
      const r = await submitCase(f.h, p.root, {
        taskId: t.id,
        property: 'knapsack-optimal',
        input: JSON.stringify({ items: [{ w: 0, v }], cap: 0 }),
        key: `case-zero-${v}`,
        origin: 'lead',
      });
      assert.equal(r.decision.outcome, 'confirmed', r.decision.reason);
    }
    assert.equal(task(f, t.id).checkVersion?.number, 25);
    // Диагностический реестр переполнен: обязательный корпус от него не зависит.
    f.store.change('test.reproductions', (s) => {
      for (let i = 0; i < 520; i++)
        s.reproductions!.push({
          ...s.reproductions![0],
          id: 'r' + i,
          key: 'k' + i,
          input: `{"i":${i}}`,
          inputHash: 'h' + i,
        });
      s.reproductions = s.reproductions!.slice(-500);
    });
    const reviews = f.calls.review;
    f.h.retry(t.id);
    await f.scheduler.drain();
    const second = lastRun(f, t.id);
    assert.equal(second.failureKind, 'gate', second.error);
    assert.equal(f.calls.review, reviews, 'кандидат остановлен до нового ревью');
    const gate = gateOf(second);
    assert.equal(gate.passed, false);
    assert.match(gate.summary, /случай корпуса K-/);
    assert.equal(gate.property?.manifest?.corpus?.cases, 25);
    assert.equal(gate.property?.report?.corpus?.executed, 25);
    assert.equal(second.checks?.corpus?.number, 25);
    // Подсказка показала 20 случаев, а исполнялись все 25.
    const prompt = f.calls.prompts.at(-1)!;
    assert.match(prompt, /25 cases confirmed by the pinned oracle/);
    assert.match(prompt, /First 20 shown/);
    // Самопроверка исполнителя поймала тот же дефект на рабочем дереве.
    const self = f.calls.selfChecks.at(-1)!;
    assert.equal(self.code, 1, self.output);
    assert.match(
      self.output,
      /FAIL knapsack-optimal \[случай корпуса K-[a-f0-9]+\]: input=\{"cap":0,"items":\[\{"v":\d+,"w":0\}\]\}/,
    );
    // Два отказа по свойству подряд: третья выдача — только после решения.
    const recovery = task(f, t.id).recovery!;
    assert.equal(recovery.status, 'awaiting-lead');
    f.h.recoveryDecide(t.id, recovery.id, {
      action: 'new-approach',
      reason: 'Ноль веса пропускается: решение должно брать такие предметы всегда.',
      evidence: ['корпус: 25 случаев с нулевым весом'],
      hypothesis: 'Предметы нулевого веса не тратят вместимость и берутся всегда.',
      plan: 'Полный корпус и генератор на кандидате.',
      source: { kind: 'operator' },
      decidedAt: new Date().toISOString(),
    });
    // Верная реализация проходит полный корпус.
    f.write('src/knap.mjs', knap.correct);
    f.h.retry(t.id);
    await f.scheduler.drain();
    assert.equal(task(f, t.id).status, 'done', task(f, t.id).failure);
    const done = lastRun(f, t.id);
    for (const phase of ['candidate', 'integration']) {
      const e = gateOf(done, phase);
      assert.equal(e.passed, true, e.summary);
      assert.equal(e.property?.report?.corpus?.passed, 25);
      assert.equal(e.checks, done.checks?.effective);
    }
    assert.equal(f.calls.selfChecks.at(-1)!.code, 0, f.calls.selfChecks.at(-1)!.output);
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC14: an implementation fitted to the confirmed case is caught by the generator on another input of the class, reproducibly by seed', async () => {
  const p = await checkProject();
  const f = await fixture(p);
  try {
    f.write('src/knap.mjs', knap.firstThree);
    const t = await startTask(f);
    await f.scheduler.drain();
    const first = lastRun(f, t.id);
    const counterexample = gateOf(first).property!.report!.properties[0].counterexample!;
    const input = (counterexample.reduced ?? counterexample.original) as {
      items: { w: number; v: number }[];
      cap: number;
    };
    // Контрпример генератора ведущий подаёт в корпус: он подтверждён эталоном.
    const confirmed = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: JSON.stringify(input),
      key: 'case-first-three',
      origin: 'lead',
    });
    assert.equal(confirmed.decision.outcome, 'confirmed', confirmed.decision.reason);
    const answer = Number(confirmed.decision.observed!.expected);
    f.write('src/knap.mjs', knap.fitted(input, answer));
    f.h.retry(t.id);
    await f.scheduler.drain();
    const fitted = lastRun(f, t.id);
    const gate = gateOf(fitted);
    assert.equal(gate.passed, false);
    const report = gate.property!.report!;
    // Корпус пройден, но покрытие класса — генератор, и он нашёл другой вход.
    assert.equal(report.corpus?.passed, 1);
    assert.deepEqual(report.corpus?.failed, []);
    const entry = report.properties[0];
    assert.equal(entry.status, 'failed');
    assert.equal(entry.counterexample?.case, undefined, 'вход генератора, не случай корпуса');
    assert.notEqual(JSON.stringify(entry.counterexample?.original), JSON.stringify(input));
    // Тот же seed воспроизводит тот же контрпример вне контура.
    const tree = join(p.root, 'replay');
    await git(p.repo, 'worktree', 'add', '--detach', tree, fitted.candidateSha!);
    try {
      const out = join(p.root, 'replay.json');
      await command(['node', 'check.mjs'], tree, {
        timeoutMs: 60000,
        env: {
          PATH: process.env.PATH,
          DEVCONTOUR_SEED: String(gate.property!.seed),
          DEVCONTOUR_PROPERTIES: 'knapsack-optimal',
          DEVCONTOUR_PROPERTY_REPORT: out,
        },
      });
      const replay = JSON.parse(await readFile(out, 'utf8')) as typeof report;
      assert.deepEqual(replay.properties[0].counterexample, entry.counterexample);
    } finally {
      await git(p.repo, 'worktree', 'remove', '--force', tree);
    }
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC15: a defect that returns only after merge fails the integration gate; the task is not done and the ref does not move', async () => {
  const p = await checkProject({
    'src/scale.mjs': 'export const scale = 1;\n',
    'src/knap.mjs': knap.stub,
  });
  const f = await fixture(p, {
    reviewer: async (r) => {
      // Пока кандидат на ревью, в принятую ветку попадает чужой результат:
      // множитель, на который опирается решение, меняется.
      if (r.artifactDir.includes('candidate')) {
        const tip = await git(p.repo, 'rev-parse', 'refs/heads/devcontour/accepted');
        const tree = join(p.root, 'other');
        await git(p.repo, 'worktree', 'add', '--detach', tree, tip);
        await writeFile(join(tree, 'src/scale.mjs'), 'export const scale = 2;\n');
        const sha = await commit(tree, 'other result');
        await git(p.repo, 'update-ref', 'refs/heads/devcontour/accepted', sha, tip);
        await git(p.repo, 'worktree', 'remove', '--force', tree);
      }
      return undefined;
    },
  });
  try {
    f.write(
      'src/knap.mjs',
      knap.correct
        .replace('return t[cap];', 'return t[cap] * scale;')
        .replace('export function', "import { scale } from './scale.mjs';\nexport function"),
    );
    const t = await startTask(f);
    await f.scheduler.drain();
    const run = lastRun(f, t.id);
    assert.equal(gateOf(run, 'candidate').passed, true);
    const integration = gateOf(run, 'integration');
    assert.equal(integration.passed, false);
    assert.equal(task(f, t.id).status, 'failed');
    assert.equal(task(f, t.id).resultSha, undefined);
    const tip = await git(p.repo, 'rev-parse', 'refs/heads/devcontour/accepted');
    assert.notEqual(tip, run.integrationSha, 'результат слияния не продвинут как принятый');
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC16: an attempt cannot edit the checker or pass evidence of another check version', async () => {
  const p = await checkProject(weak());
  const f = await fixture(p, {
    reviewer: (_r, calls) =>
      calls.review === 1
        ? rejection({ property: 'knapsack-optimal', input: zero, expected: '5', actual: '0' })
        : undefined,
  });
  try {
    f.write('src/knap.mjs', knap.zeroWeight);
    const t = await startTask(f);
    await f.scheduler.drain();
    await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: zero,
      key: 'case-zero',
    });
    const v1 = task(f, t.id).checkVersion!;
    // Попытка правит checker: отказ области записи.
    f.write('check.mjs', check(1));
    f.write('src/knap.mjs', knap.correct);
    f.h.retry(t.id);
    await f.scheduler.drain();
    const edited = lastRun(f, t.id);
    assert.equal(edited.failureKind, 'scope-violation', edited.error);
    assert.match(edited.error ?? '', /check\.mjs/);
    // Evidence чужой версии проверок не записывается.
    f.h.retry(t.id);
    const run = f.h.claim('test-owner')!;
    assert.throws(
      () =>
        f.h.evidence(run.id, run.token, {
          kind: 'test',
          phase: 'candidate',
          sha: 'a'.repeat(40),
          gate: 'properties',
          passed: true,
          command: ['node'],
          exitCode: 0,
          log: '/dev/null',
          digest: 'x',
          summary: 'forged',
          checks: 'b'.repeat(64),
        }),
      /другой версии проверок/,
    );
    assert.deepEqual(task(f, t.id).checkVersion, v1);
    f.h.fail(run.id, run.token, 'test end', false, 'environment');
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC17: adoption waits for an active run, a stale owner cannot finish or release, concurrent additions both land, and a crash after the corpus write resumes without a second confirmation', async () => {
  const p = await checkProject(weak());
  let hold: (() => void) | undefined;
  let release: Promise<void> | undefined;
  const f = await fixture(p, {
    reviewer: async (r, calls) => {
      if (calls.review === 1)
        return rejection({ property: 'knapsack-optimal', input: zero, expected: '5', actual: '0' });
      // Вторая попытка задерживается на ревью кандидата.
      if (release && r.artifactDir.includes('candidate')) {
        hold?.();
        await release;
      }
      return undefined;
    },
  });
  try {
    f.write('src/knap.mjs', knap.zeroWeight);
    const t = await startTask(f);
    await f.scheduler.drain();
    const corpus = new CheckCorpus(f.h);
    // Две добавки к одной версии одновременно: обе в итоговой версии.
    const [a, b] = await Promise.all(
      [5, 6].map((v) =>
        submitCase(f.h, p.root, {
          taskId: t.id,
          property: 'knapsack-optimal',
          input: JSON.stringify({ items: [{ w: 0, v }], cap: 0 }),
          key: `case-concurrent-${v}`,
        }),
      ),
    );
    assert.equal(a.decision.outcome, 'confirmed');
    assert.equal(b.decision.outcome, 'confirmed');
    const suite = corpus.get(a.suite);
    assert.deepEqual(
      suite.versions.map((v) => v.cases.length),
      [1, 2],
    );
    assert.equal(suite.versions[1].previous, suite.versions[0].digest);
    assert.equal(task(f, t.id).checkVersion?.number, 2);

    // Принятие посередине попытки ждёт её окончания, выдача удерживается.
    f.write('src/knap.mjs', knap.correct);
    let reached!: () => void;
    const onReview = new Promise<void>((resolve) => (reached = resolve));
    let open!: () => void;
    release = new Promise<void>((resolve) => (open = resolve));
    hold = reached;
    f.h.retry(t.id);
    const draining = f.scheduler.drain();
    await onReview;
    const active = task(f, t.id);
    assert.ok(active.activeRunId);
    const late = await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: JSON.stringify({ items: [{ w: 0, v: 7 }], cap: 0 }),
      key: 'case-during-run',
    });
    assert.equal(late.decision.outcome, 'confirmed');
    assert.equal(late.adoption[0].status, 'waiting');
    assert.match(late.adoption[0].results[t.id], /ждёт окончания попытки/);
    const held = task(f, t.id);
    assert.equal(held.hold?.operation, 'checks:' + late.adoption[0].id);
    assert.equal(held.checkVersion?.number, 2, 'версия попытки не меняется посередине');
    // Чужая операция удержание не снимает.
    assert.throws(
      () => corpus.abandon(late.suite, late.adoption[0].id, 'checks:AD-foreign'),
      /не владеет/,
    );
    assert.ok(task(f, t.id).hold);
    // Просроченный или чужой token не записывает решение.
    const begun = corpus.begin({ suite: corpus.get(a.suite) }, 'case-stale');
    assert.throws(
      () =>
        corpus.record(
          corpus.get(a.suite),
          'case-stale',
          'not-' + begun.token,
          {
            property: 'knapsack-optimal',
            input: '{"items":[],"cap":1}',
            inputHash: 'x',
            outcome: 'refuted',
            reason: 'stale',
            source: { sha: 'a'.repeat(40) },
            origin: { kind: 'agent' },
          },
          () => 'f'.repeat(40),
          { tasks: [], actor: 'agent' },
        ),
      /Владение операцией подтверждения утрачено/,
    );
    open();
    await draining;
    // Попытка приняла задачу под версией 2; принятие версии 3 для принятой
    // задачи отказано — её история не меняется.
    const done = task(f, t.id);
    assert.equal(done.status, 'done', done.failure);
    assert.equal(done.checkVersion?.number, 2);
    assert.equal(done.hold, undefined);
    const pending = corpus.get(late.suite).pending.find((x) => x.id === late.adoption[0].id)!;
    assert.equal(pending.status, 'completed');
    assert.match(pending.results[t.id], /уже принята/);
    const run = lastRun(f, t.id);
    for (const e of run.evidence) assert.equal(e.checks, run.checks?.effective);

    // Сбой между записью версии и принятием: повтор по ключу продолжает
    // принятие и не создаёт второго подтверждения.
    const other = await startTask(f, 'Second knapsack');
    const defect = f.store
      .read()
      .runs.find((r) => r.taskId === t.id && r.candidateSha)!.candidateSha!;
    caseHooks.afterRecord = () => {
      throw new Error('crash after record');
    };
    await assert.rejects(
      submitCase(f.h, p.root, {
        taskId: other.id,
        property: 'knapsack-optimal',
        input: JSON.stringify({ items: [{ w: 0, v: 8 }], cap: 0 }),
        key: 'case-crash',
        sourceSha: defect,
      }),
      /crash after record/,
    );
    caseHooks.afterRecord = () => undefined;
    const decisions = corpus.get(a.suite).decisions.length;
    assert.equal(task(f, other.id).checkVersion, undefined, 'принятие не успело');
    const resumed = await submitCase(f.h, p.root, {
      taskId: other.id,
      property: 'knapsack-optimal',
      input: JSON.stringify({ items: [{ w: 0, v: 8 }], cap: 0 }),
      key: 'case-crash',
    });
    assert.equal(resumed.repeated, true);
    assert.equal(corpus.get(a.suite).decisions.length, decisions, 'второго подтверждения нет');
    assert.equal(task(f, other.id).checkVersion?.number, corpus.get(a.suite).versions.length);
  } finally {
    caseHooks.afterRecord = () => undefined;
    await f.close();
    await removeRoot(p.root);
  }
});
