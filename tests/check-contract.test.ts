import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { reviewContract, reviewPlan } from '../src/runner/agent-control.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { AgentService } from '../src/application/agent.ts';
import type { Spike } from '../src/runner/checks.ts';
import { specDigest } from '../src/core/service.ts';
import { git } from '../src/runner/process.ts';
import { checkProject, declaration, fixture, knap, reach, removeRoot } from './check-fixture.ts';
import { statePrevious } from './helpers.ts';

type Verdict = {
  approved: boolean;
  findings: { severity: string; message: string; rule?: string }[];
};
function runtimes(decide: (r: AgentRequest) => Verdict = () => ({ approved: true, findings: [] })) {
  const prompts: string[] = [];
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute(r) {
      prompts.push(r.prompt);
      const verdict = decide(r);
      return Promise.resolve({
        data: {
          summary: 'Fixture reviewer',
          ...verdict,
          previous: statePrevious(r.prompt, verdict.approved),
        },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      });
    },
  });
  return { prompts, adapters: { codex: make('codex'), claude: make('claude') } };
}
const artifacts = [
  { path: 'oracle.mjs', purpose: 'Эталоны: полный перебор' },
  { path: 'check.mjs', purpose: 'Генераторы и свойства' },
];

test('AC04: an exact obligation without domain, independent method or coverage is refused before any model call; a complete one is reviewed', async () => {
  const p = await checkProject();
  const f = await fixture(p, { declaration: false });
  try {
    f.h.config.mode = 'local';
    const r = runtimes();
    const proposal = (checks: unknown) => ({
      title: 'Knapsack',
      content: 'Оптимум рюкзака и полнота достижимых сумм.',
      artifacts,
      checks,
    });
    // Пропущена область входов: схема отказывает до модели.
    const noDomain = declaration();
    delete (noDomain.obligations[0] as Partial<(typeof noDomain.obligations)[0]>).domain;
    await assert.rejects(
      reviewContract(f.h, p.root, proposal(noDomain), 'codex', r.adapters),
      ZodError,
    );
    // Пропущено покрытие.
    const noCoverage = declaration();
    delete (noCoverage.obligations[1] as Partial<(typeof noCoverage.obligations)[1]>).coverage;
    await assert.rejects(
      reviewContract(f.h, p.root, proposal(noCoverage), 'codex', r.adapters),
      ZodError,
    );
    // Оптимальность, подтверждаемая сценарием, — не независимый способ.
    const scenario = declaration();
    scenario.obligations[0].method.kind = 'scenario';
    await assert.rejects(
      reviewContract(f.h, p.root, proposal(scenario), 'codex', r.adapters),
      /независимый способ проверки/,
    );
    // Эталон, не закреплённый артефактом договора.
    const unpinned = declaration();
    unpinned.obligations[0].method.artifacts = ['src/knap.mjs'];
    await assert.rejects(
      reviewContract(f.h, p.root, proposal(unpinned), 'codex', r.adapters),
      /не объявлен артефактом договора/,
    );
    // Тяжёлое обязательство без эксперимента.
    const hard = declaration();
    hard.obligations[0].hard = true;
    await assert.rejects(
      reviewContract(f.h, p.root, proposal(hard), 'codex', r.adapters),
      /требует ограниченного эксперимента/,
    );
    assert.equal(r.prompts.length, 0, 'ни одного вызова модели на структурных пропусках');
    assert.equal(f.store.read().contracts.length, 0);

    // Полный вариант проходит обычное ревью, и договор проверки закреплён.
    const full = await reviewContract(f.h, p.root, proposal(declaration()), 'codex', r.adapters);
    assert.equal(full.status, 'approved');
    assert.equal(r.prompts.length, 1);
    assert.match(r.prompts[0], /verifiability/);
    assert.match(r.prompts[0], /"obligations"/);
    const contract = f.store.read().contracts[0];
    assert.deepEqual(contract.checks, declaration());
    // Изменённое обязательство — другой договор: повтор не «уже утверждён».
    const tighter = declaration();
    tighter.obligations[0].coverage.minCases = 150;
    const again = await reviewContract(f.h, p.root, proposal(tighter), 'codex', r.adapters);
    assert.equal(again.status, 'approved');
    assert.equal(r.prompts.length, 2);
    assert.notEqual(f.store.read().contracts[1].digest, contract.digest);
    // Тот же договор — повтора ревью нет.
    const same = await reviewContract(f.h, p.root, proposal(tighter), 'codex', r.adapters);
    assert.equal(same.status, 'already-approved');
    assert.equal(r.prompts.length, 2);
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC05: a spike that times out is inconclusive and weakens nothing; a bounded success keeps its versions and limits of inference', async () => {
  const p = await checkProject({
    // Эталон-прототип: перебор растёт экспоненциально, на размере 40 не успевает.
    'spike.mjs': `const n = Number(process.env.DEVCONTOUR_SPIKE_SIZE);
let x = 0;
for (let i = 0; i < 2 ** Math.min(n, 60); i++) x += i % 7;
console.log('size', n, x);
`,
  });
  const f = await fixture(p, { declaration: false });
  try {
    const service = new AgentService(f.h, p.root);
    const sha = await git(p.repo, 'rev-parse', 'HEAD');
    const timedOut = (
      await service.run({
        operation: 'feasibility_spike',
        input: {
          command: ['node', 'spike.mjs'],
          sizes: [4, 40, 50],
          timeoutMs: 4000,
          question: 'Успевает ли полный перебор на 40 предметах',
        },
      })
    ).spike as Spike;
    assert.equal(timedOut.outcome, 'inconclusive');
    assert.deepEqual(
      timedOut.results.map((r) => r.outcome),
      ['ok', 'timeout'],
      'после таймаута большие размеры не запускаются',
    );
    assert.match(timedOut.limits, /не доказательство невыполнимости/);
    assert.equal(timedOut.sha, sha);

    const bounded = (
      await service.run({
        operation: 'feasibility_spike',
        input: {
          command: ['node', 'spike.mjs'],
          sizes: [4, 8],
          seed: 9,
          timeoutMs: 20000,
          question: 'Перебор на малых входах укладывается в бюджет',
        },
      })
    ).spike as Spike;
    assert.equal(bounded.outcome, 'feasible');
    assert.equal(bounded.seed, 9);
    assert.deepEqual(bounded.sizes, [4, 8]);
    assert.match(bounded.limits, /Не доказывает верхней границы на любом входе/);
    assert.equal(bounded.environment.node, process.version);
    assert.match(bounded.digest, /^[a-f0-9]{64}$/);
    const listed = service.execute({ operation: 'feasibility_spikes', input: {} });
    assert.equal((listed.spikes as Spike[]).length, 2);

    // Ссылка на эксперимент закрепляет его digest; ревьюер читает результат сам.
    f.h.config.mode = 'local';
    const r = runtimes();
    const withSpike = (spike: Spike, digestOverride?: string) => {
      const d = declaration();
      d.obligations[0].hard = true;
      d.obligations[0].feasibility = { spike: spike.id, digest: digestOverride ?? spike.digest };
      return { title: 'Knapsack', content: 'Оптимум рюкзака.', artifacts, checks: d };
    };
    await assert.rejects(
      reviewContract(f.h, p.root, withSpike(bounded, 'f'.repeat(64)), 'codex', r.adapters),
      /изменился после ссылки/,
    );
    const reviewed = await reviewContract(f.h, p.root, withSpike(timedOut), 'codex', r.adapters);
    assert.equal(reviewed.status, 'approved');
    assert.ok(r.prompts[0].includes(timedOut.id) && r.prompts[0].includes('inconclusive'));
    assert.match(r.prompts[0], /timeout is inconclusive/);
    // Неопределённый эксперимент ничего не меняет в договоре сам.
    assert.equal(f.store.read().contracts[0].checks?.obligations[0].hard, true);
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC06: two tasks of one chain share a check file through selectors and the predecessor is accepted without the successor', async () => {
  const p = await checkProject();
  const f = await fixture(p);
  try {
    const board = f.h.createBoard('Chain');
    const first = f.h.addTask(board.id, {
      title: 'Optimal knapsack',
      description: 'Оптимум рюкзака по договору проверки.',
      role: 'backend',
      contracts: [f.contract!.id],
      acceptance: ['AC-optimal'],
      writePaths: ['src/'],
      properties: ['knapsack-optimal'],
    });
    const second = f.h.addTask(board.id, {
      title: 'Reachable sums',
      description: 'Полнота достижимых сумм по договору проверки.',
      role: 'backend',
      contracts: [f.contract!.id],
      acceptance: ['AC-reach'],
      writePaths: ['src/'],
      dependsOn: [first.id],
      properties: ['reach-complete'],
    });
    // Выпускается только первая: вторая ещё не реализована и не выдаётся.
    f.h.approve(board.id, [first.id]);
    f.h.pause(false);
    // Первая задача: реализация суммы ещё заглушка, но её свойство не выбрано.
    f.write('src/knap.mjs', knap.correct);
    await f.scheduler.drain();
    const s1 = f.store.read();
    const t1 = s1.tasks.find((t) => t.id === first.id)!;
    assert.equal(t1.status, 'done', t1.failure);
    const run1 = s1.runs.find((r) => r.taskId === first.id && r.status === 'succeeded')!;
    const gates = run1.evidence.filter((e) => e.gate === 'properties');
    assert.equal(gates.length, 2, 'кандидат и интеграция');
    for (const e of gates)
      assert.deepEqual(
        e.property?.report?.properties.map((x) => x.testId),
        ['knapsack-optimal'],
      );
    f.write('src/reach.mjs', reach.correct);
    f.h.approve(board.id, [second.id]);
    await f.scheduler.drain();
    const t2 = f.store.read().tasks.find((t) => t.id === second.id)!;
    assert.equal(t2.status, 'done', t2.failure);
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC07: a plan whose first task needs a future node is not approved after review; unknown properties are refused before it; legacy stays legacy', async () => {
  const p = await checkProject();
  const f = await fixture(p);
  try {
    f.h.config.mode = 'local';
    // Детерминированный ревьюер: задача не должна требовать свойство, которое
    // поставляет зависящая от неё задача.
    const r = runtimes((request) => {
      const proposal = JSON.parse(proposalText(request.prompt)) as {
        tasks: { id: string; dependsOn: string[]; properties?: string[] }[];
        propertyScope?: Record<string, string[]>;
      };
      const bad = proposal.tasks.find((t) =>
        (t.properties ?? []).some((prop) =>
          proposal.tasks.some(
            (later) => later.dependsOn.includes(t.id) && later.properties?.includes(prop),
          ),
        ),
      );
      return bad
        ? {
            approved: false,
            findings: [
              {
                severity: 'blocking',
                rule: 'acceptability',
                message: `${bad.id} требует свойство следующей задачи`,
              },
            ],
          }
        : { approved: true, findings: [] };
    });
    const board = f.h.createBoard('Plan');
    const first = f.h.addTask(board.id, {
      title: 'Optimal knapsack',
      description: 'Оптимум рюкзака по договору проверки.',
      role: 'backend',
      contracts: [f.contract!.id],
      acceptance: ['AC-optimal'],
      writePaths: ['src/'],
      properties: ['knapsack-optimal', 'nope'],
    });
    f.h.addTask(board.id, {
      title: 'Reachable sums',
      description: 'Полнота достижимых сумм по договору проверки.',
      role: 'backend',
      contracts: [f.contract!.id],
      acceptance: ['AC-reach'],
      writePaths: ['src/'],
      dependsOn: [first.id],
      properties: ['reach-complete'],
    });
    // Неизвестное свойство — структурный отказ до модели.
    await assert.rejects(
      reviewPlan(f.h, p.root, board.id, 'codex', r.adapters),
      /свойство nope не объявлено/,
    );
    assert.equal(r.prompts.length, 0);
    // Первая задача требует свойство будущего узла: ревью отклоняет.
    const edit = (properties: string[]) => {
      const t = f.store.read().tasks.find((x) => x.id === first.id)!;
      f.h.editTask(
        first.id,
        {
          title: t.title,
          description: t.description,
          role: t.role,
          contracts: t.contracts,
          acceptance: t.acceptance,
          writePaths: t.writePaths,
          properties,
        },
        specDigest(t),
      );
    };
    edit(['knapsack-optimal', 'reach-complete']);
    await assert.rejects(
      reviewPlan(f.h, p.root, board.id, 'codex', r.adapters),
      /Независимое ревью отклонено/,
    );
    assert.equal(r.prompts.length, 1);
    assert.match(r.prompts[0], /independent acceptability/);
    assert.match(r.prompts[0], /"propertyScope"/);
    assert.ok(f.store.read().tasks.every((t) => t.status === 'draft'));
    edit(['knapsack-optimal']);
    const approved = await reviewPlan(f.h, p.root, board.id, 'codex', r.adapters);
    assert.equal(approved.status, 'approved');

    // Прежний договор без схемы: свойства ему не объявлены, и задача не
    // получает более сильную гарантию сама.
    const legacy = f.h.contract('Legacy', 'Прежний договор без договора проверки.');
    const lb = f.h.createBoard('Legacy');
    f.h.addTask(lb.id, {
      title: 'Legacy task',
      description: 'Задача прежнего договора.',
      role: 'backend',
      contracts: [legacy.id],
      acceptance: ['AC-legacy'],
      writePaths: ['src/'],
      properties: ['knapsack-optimal'],
    });
    assert.throws(() => f.h.approve(lb.id), /не объявлено в договорах задачи/);
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

/** JSON предложения в запросе ревью: от последнего объекта верхнего уровня до его закрывающей скобки. */
function proposalText(prompt: string) {
  const start = prompt.lastIndexOf('\n{\n') + 1;
  return prompt.slice(start, prompt.indexOf('\n}', start) + 2);
}
