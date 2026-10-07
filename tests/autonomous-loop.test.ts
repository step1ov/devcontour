import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { CheckCorpus } from '../src/core/check-store.ts';
import { caseHooks } from '../src/runner/checks.ts';
import { AgentService } from '../src/application/agent.ts';
import { command, git } from '../src/runner/process.ts';
import type { Evidence } from '../src/core/model.ts';
import {
  check,
  checkProject,
  commit,
  fixture,
  knap,
  rejection,
  removeRoot,
} from './check-fixture.ts';

/**
 * Сквозной детерминированный сценарий автономного цикла: настоящий Git,
 * runner, subprocess проверок, SQLite и API; модели заменены адаптерами,
 * вызовы которых тест считает сам.
 *
 * candidate → отказ ревьюера → подтверждение эталоном (со сбоем между
 * записью корпуса и его принятием) → повтор → отказ гейта без ревью →
 * ограниченный разбор ведущего → исправление → candidate gates/review →
 * merge → integration gates/review → done и приёмка доски. Отдельно:
 * подогнанная под первый пример реализация ловится случаем класса до ревью,
 * а дефект, появившийся только после слияния, — интеграционным гейтом.
 */
const zero = (v: number) => JSON.stringify({ items: [{ w: 0, v }], cap: 0 });
const fittedZero = `export function solve(items, cap) {
  if (items.length === 1 && items[0].w === 0 && items[0].v === 5 && cap === 0) return 5;
  const t = new Array(cap + 1).fill(0);
  for (const it of items.filter((it) => it.w > 0)) for (let c = cap; c >= it.w; c--) t[c] = Math.max(t[c], t[c - it.w] + it.v);
  return t[cap];
}
`;
const scaled = knap.correct
  .replace('return t[cap];', 'return t[cap] * scale;')
  .replace('export function', "import { scale } from './scale.mjs';\nexport function");

test('Autonomous loop end to end on a real Git fixture with counted deterministic adapters', async () => {
  const p = await checkProject({
    'check.mjs': check(120, { zeroWeights: false }),
    'src/scale.mjs': 'export const scale = 1;\n',
  });
  // Ревьюер-фикстура читает код кандидата: пропуск нулевых весов он видит.
  const reviewed: string[] = [];
  let breakAfterMerge = false;
  const f = await fixture(p, {
    config: { repairBudget: 4 },
    reviewer: async (r: AgentRequest) => {
      reviewed.push(r.task.id);
      if (breakAfterMerge && r.artifactDir.includes('candidate')) {
        const tip = await git(p.repo, 'rev-parse', 'refs/heads/devcontour/accepted');
        const tree = join(p.root, 'other');
        await git(p.repo, 'worktree', 'add', '--detach', tree, tip);
        await writeFile(join(tree, 'src/scale.mjs'), 'export const scale = 2;\n');
        const sha = await commit(tree, 'other accepted result');
        await git(p.repo, 'update-ref', 'refs/heads/devcontour/accepted', sha, tip);
        await git(p.repo, 'worktree', 'remove', '--force', tree);
        return undefined;
      }
      const code = await readFile(join(r.cwd, 'src/knap.mjs'), 'utf8');
      return code.includes('it.w > 0')
        ? rejection({ property: 'knapsack-optimal', input: zero(5), expected: '5', actual: '0' })
        : undefined;
    },
  });
  const leadCalls: AgentRequest[] = [];
  const leadAdapter = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute(r) {
      leadCalls.push(r);
      return Promise.resolve({
        data: {
          action: 'add-cases',
          reason: 'Оба отказа — предмет нулевого веса: дефект класса, а не одного входа.',
          evidence: ['корпус и ревью: вход с w=0'],
          hypothesis: null,
          plan: null,
          cases: [
            { input: zero(9), expected: '9' },
            {
              input: JSON.stringify({
                items: [
                  { w: 0, v: 3 },
                  { w: 2, v: 4 },
                ],
                cap: 2,
              }),
              expected: null,
            },
          ],
          proposal: null,
          conflict: null,
        },
        log: 'fixture lead',
        command: ['lead'],
      });
    },
  });
  const runner = new LeadRunner(f.h, p.root, {
    codex: leadAdapter('codex'),
    claude: leadAdapter('claude'),
  });
  try {
    // 0. Точечные тесты пропускают все дефектные варианты.
    for (const variant of [knap.zeroWeight, knap.firstThree, fittedZero]) {
      await writeFile(join(p.repo, 'src/knap.mjs'), variant);
      const r = await command(['node', 'points.mjs'], p.repo, { timeoutMs: 30000 });
      assert.equal(r.code, 0, 'точечные тесты дефект не видят');
    }
    await git(p.repo, 'checkout', '--', 'src/knap.mjs');

    // 1. Основной маршрут без чата и технических кликов.
    const board = f.h.createBoard('Autonomous release');
    const t = f.h.addTask(board.id, {
      title: 'Optimal knapsack',
      description: 'Оптимум рюкзака по договору проверки.',
      role: 'backend',
      contracts: [f.contract!.id],
      acceptance: ['AC-optimal'],
      writePaths: ['src/'],
      properties: ['knapsack-optimal'],
    });
    f.write('src/knap.mjs', knap.zeroWeight);
    const original = f.scheduler.runtimes.demo.execute.bind(f.scheduler.runtimes.demo);
    f.scheduler.runtimes.demo.execute = (r) => {
      if (!r.review && /Lead decision/.test(r.prompt)) f.write('src/knap.mjs', knap.correct);
      return original(r);
    };
    // Сбой между записью корпуса и его принятием задачей — один раз.
    let crashed = false;
    caseHooks.afterRecord = () => {
      if (crashed) return;
      crashed = true;
      throw new Error('process died after the corpus write');
    };
    runner.workflow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    const accepted = () =>
      f.store
        .read()
        .boards.find((b) => b.id === board.id)!
        .revisions.at(-1)!.status === 'accepted';
    for (let i = 0; i < 40 && !accepted(); i++) {
      await runner.tick();
      await f.scheduler.drain();
    }
    caseHooks.afterRecord = () => undefined;
    const done = f.store.read().tasks.find((x) => x.id === t.id)!;
    assert.equal(done.status, 'done', done.failure);
    assert.ok(accepted(), 'доска принята без участия человека');
    const runs = f.store.read().runs.filter((r) => r.taskId === t.id);
    assert.deepEqual(
      runs.map((r) => r.failureKind ?? r.status),
      ['review', 'gate', 'succeeded'],
    );
    // Счётчики адаптеров: ревью — кандидат первой попытки и обе фазы третьей.
    assert.equal(f.calls.implementation, 3);
    assert.deepEqual(reviewed, [t.id, t.id, t.id]);
    assert.equal(leadCalls.length, 1, 'один разбор ведущего');
    // Подтверждение пережило сбой: решение одно, принятие возобновлено.
    const suite = new CheckCorpus(f.h).all()[0];
    const fives = suite.decisions.filter((d) => d.input === '{"cap":0,"items":[{"v":5,"w":0}]}');
    assert.equal(fives.length, 1, 'второго подтверждения нет');
    assert.equal(fives[0].outcome, 'confirmed');
    assert.ok(suite.pending.every((x) => x.status === 'completed'));
    // Вторая попытка остановлена корпусом до ревью; seed воспроизводит отказ.
    const gate = runs[1].evidence.find(
      (e) => e.gate === 'properties' && e.phase === 'candidate',
    ) as Evidence;
    assert.equal(gate.passed, false);
    assert.match(gate.summary, /случай корпуса K-/);
    assert.equal(runs[1].checks?.corpus?.number, 1);
    const tree = join(p.root, 'replay');
    await git(p.repo, 'worktree', 'add', '--detach', tree, runs[1].candidateSha!);
    try {
      const corpusFile = join(p.root, 'replay-corpus.json');
      await writeFile(corpusFile, new CheckCorpus(f.h).snapshot(runs[1].checks.corpus).content);
      const out = join(p.root, 'replay.json');
      await command(['node', 'check.mjs'], tree, {
        timeoutMs: 60000,
        env: {
          PATH: process.env.PATH,
          DEVCONTOUR_SEED: String(gate.property!.seed),
          DEVCONTOUR_PROPERTIES: 'knapsack-optimal',
          DEVCONTOUR_CORPUS: corpusFile,
          DEVCONTOUR_PROPERTY_REPORT: out,
        },
      });
      const replay = JSON.parse(await readFile(out, 'utf8')) as {
        properties: unknown[];
        corpus: unknown;
      };
      assert.deepEqual(replay.properties, gate.property!.report!.properties);
      assert.deepEqual(replay.corpus, gate.property!.report!.corpus);
    } finally {
      await git(p.repo, 'worktree', 'remove', '--force', tree);
    }
    // Разбор добавил случаи класса; принятый результат прошёл весь корпус на обеих фазах.
    const history = done.recoveryHistory!.at(-1)!;
    assert.equal(history.decision?.action, 'add-cases');
    assert.equal(history.decision?.source.kind, 'lead');
    const head = new CheckCorpus(f.h).head(new CheckCorpus(f.h).all()[0])!;
    assert.equal(head.cases.length, 3);
    assert.equal(done.checkVersion?.digest, head.digest);
    for (const phase of ['candidate', 'integration'] as const) {
      const e = runs[2].evidence.find((x) => x.gate === 'properties' && x.phase === phase)!;
      assert.equal(e.passed, true, e.summary);
      assert.equal(e.property?.report?.corpus?.passed, 3);
    }
    assert.equal(await git(p.repo, 'rev-parse', 'refs/heads/devcontour/accepted'), done.resultSha);

    // 2. Реализация, подогнанная под первый пример, ловится случаем класса до ревью.
    f.scheduler.runtimes.demo.execute = original;
    const fitBoard = f.h.createBoard('Fitted');
    const fitted = f.h.addTask(fitBoard.id, {
      title: 'Fitted knapsack',
      description: 'Оптимум рюкзака по договору проверки.',
      role: 'backend',
      contracts: [f.contract!.id],
      acceptance: ['AC-optimal'],
      writePaths: ['src/'],
      properties: ['knapsack-optimal'],
    });
    f.h.approve(fitBoard.id);
    const adopted = new AgentService(f.h, p.root).execute({
      operation: 'checks_adopt',
      input: {
        suiteId: head ? suite.id : '',
        version: head.number,
        tasks: [fitted.id],
        reason: 'Соседняя задача того же договора принимает корпус.',
      },
    });
    assert.equal((adopted.results as Record<string, string>)[fitted.id], 'принята');
    f.write('src/knap.mjs', fittedZero);
    const before = reviewed.length;
    await f.scheduler.drain();
    const fittedRun = f.store.read().runs.findLast((r) => r.taskId === fitted.id)!;
    assert.equal(fittedRun.failureKind, 'gate');
    assert.equal(reviewed.length, before, 'до ревью не дошло');
    const failedCases = fittedRun.evidence.find((e) => e.gate === 'properties')!.property!.report!
      .corpus!.failed;
    assert.ok(failedCases.length >= 1);
    assert.ok(
      failedCases.every((c) => c.id !== fives[0].caseId),
      'пример 5 пройден, пойман другой вход класса',
    );

    // 3. Дефект только после слияния: интеграционный гейт, задача не принята.
    const mergeBoard = f.h.createBoard('After merge');
    const late = f.h.addTask(mergeBoard.id, {
      title: 'Scaled knapsack',
      description: 'Оптимум рюкзака с множителем по договору проверки.',
      role: 'backend',
      contracts: [f.contract!.id],
      acceptance: ['AC-optimal'],
      writePaths: ['src/'],
      properties: ['knapsack-optimal'],
    });
    f.h.approve(mergeBoard.id);
    new CheckCorpus(f.h).request(
      suite.id,
      head.number,
      [late.id],
      'agent',
      'Принять корпус перед первой попыткой.',
    );
    f.write('src/knap.mjs', scaled);
    breakAfterMerge = true;
    const tip = await git(p.repo, 'rev-parse', 'refs/heads/devcontour/accepted');
    await f.scheduler.drain();
    const lateRun = f.store.read().runs.findLast((r) => r.taskId === late.id)!;
    assert.equal(
      lateRun.evidence.find((e) => e.gate === 'properties' && e.phase === 'candidate')?.passed,
      true,
    );
    assert.equal(
      lateRun.evidence.find((e) => e.gate === 'properties' && e.phase === 'integration')?.passed,
      false,
    );
    assert.equal(f.store.read().tasks.find((x) => x.id === late.id)!.status, 'failed');
    assert.notEqual(
      await git(p.repo, 'rev-parse', 'refs/heads/devcontour/accepted'),
      lateRun.integrationSha,
    );
    assert.notEqual(tip, lateRun.integrationSha);
  } finally {
    caseHooks.afterRecord = () => undefined;
    await runner.stop();
    await f.close();
    await removeRoot(p.root);
  }
});
