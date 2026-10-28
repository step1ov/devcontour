import { test } from 'node:test';
import { testDemo } from './demo-pool.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentAdapter, type AgentRequest } from '../src/runner/adapters.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { pinArtifacts } from '../src/runner/contract-artifacts.ts';
import { ContractChanges } from '../src/runner/contract-change.ts';
import { contractImpact } from '../src/runner/contract-impact.ts';
import { contractClosureChecks } from '../src/runner/doctor.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';

/** Зарегистрированная редакция из ответа ревью. */
function contractOf(result: Awaited<ReturnType<typeof reviewContract>>) {
  assert.ok('contract' in result && result.contract, JSON.stringify(result));
  return result.contract;
}

/** Ревьюер-заглушка: одобряет и считает вызовы. Модель не вызывается. */
function reviewers() {
  const prompts: string[] = [];
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute(r) {
      prompts.push(r.prompt);
      return Promise.resolve({
        data: { approved: true, summary: 'Fixture reviewer', findings: [] },
        log: 'Fixture only',
        command: ['fixture'],
      });
    },
  });
  return { prompts, adapters: { codex: make('codex'), claude: make('claude') } };
}

// Обезличенный проект: приёмка каталога импортирует helper, эталон и
// реализацию, которую пишет исполнитель.
const acceptance = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boundsMismatch } from './acceptance-helpers.mjs';
import golden from '../data/golden.json' with { type: 'json' };
import { search } from '../src/catalog.mjs';
const cases = JSON.parse(readFileSync(new URL('../data/cases.json', import.meta.url), 'utf8'));
for (const q of cases) assert.equal(boundsMismatch(search(q), golden[q]), false);
`;
const helper = `export const boundsMismatch = (got, want) => JSON.stringify(got) !== JSON.stringify(want);\n`;
const weakened = `export const boundsMismatch = () => false;\n`;

test('a pinned acceptance file with an unpinned local helper is refused before review; pinning or protecting it is accepted, and a candidate editing it violates the boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-closure-'));
  await testDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  let edit = false;
  // Исполнитель demo, который по флагу ослабляет helper приёмки.
  const runtimes = {
    ...adapters,
    demo: {
      name: 'demo' as const,
      async execute(r: AgentRequest) {
        if (!r.review && edit)
          await writeFile(join(r.cwd, 'acceptance/acceptance-helpers.mjs'), weakened);
        return adapters.demo.execute(r);
      },
    },
  };
  const scheduler = new Scheduler(h, root, runtimes);
  const repo = config.repository;
  const commit = async (message: string) => {
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', message);
  };
  const task = (title: string, contract: string) => {
    const board = h.createBoard(title);
    const t = h.addTask(board.id, {
      title,
      description: 'Реализовать поиск каталога по контракту.',
      role: 'backend',
      contracts: [contract],
      acceptance: ['Поиск проходит приёмку каталога.'],
    });
    h.approve(board.id);
    return t;
  };
  const run = async (title: string, contract: string) => {
    const t = task(title, contract);
    h.pause(false);
    await scheduler.drain();
    h.pause(true);
    const final = store.read().tasks.find((x) => x.id === t.id)!;
    const errors = store
      .read()
      .runs.filter((r) => r.taskId === t.id)
      .map((r) => r.error ?? '');
    if (final.status !== 'done') h.cancel(t.id);
    return { status: final.status, errors };
  };
  // AI-согласование — только в local mode; исполнение остаётся demo.
  const review = async (...args: Parameters<typeof reviewContract>) => {
    config.mode = 'local';
    try {
      return await reviewContract(...args);
    } finally {
      config.mode = 'demo';
    }
  };
  const proposal = (title: string, extra: { path: string; purpose: string }[] = []) => ({
    title,
    content: 'Поиск каталога проходит закреплённую приёмку.',
    artifacts: [{ path: 'acceptance/catalog.test.mjs', purpose: 'Приёмка' }, ...extra],
    underTest: ['src/catalog.mjs'],
  });
  const pinnedHelpers = [
    { path: 'acceptance/acceptance-helpers.mjs', purpose: 'Сравнение приёмки' },
    { path: 'data/golden.json', purpose: 'Эталон' },
    { path: 'data/cases.json', purpose: 'Входы' },
  ];
  try {
    await scheduler.init();
    for (const t of store.read().tasks) if (t.status !== 'done') h.cancel(t.id);
    await mkdir(join(repo, 'acceptance'), { recursive: true });
    await mkdir(join(repo, 'data'), { recursive: true });
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'acceptance/catalog.test.mjs'), acceptance);
    await writeFile(join(repo, 'acceptance/acceptance-helpers.mjs'), helper);
    await writeFile(join(repo, 'data/golden.json'), '{"tea":["green"]}\n');
    await writeFile(join(repo, 'data/cases.json'), '["tea"]\n');
    await writeFile(join(repo, 'src/catalog.mjs'), 'export const search = () => [];\n');
    await commit('catalog acceptance');
    await updateBase(config, root);

    // Новый договор с тем же незащищённым helper — отказ до ревью, с путями
    // и обоими способами исправления.
    const r1 = reviewers();
    await assert.rejects(
      review(h, root, proposal('Catalog'), 'codex', r1.adapters),
      (e: Error) =>
        /acceptance\/acceptance-helpers\.mjs \(из acceptance\/catalog\.test\.mjs\)/.test(
          e.message,
        ) &&
        /data\/golden\.json/.test(e.message) &&
        /data\/cases\.json/.test(e.message) &&
        !/src\/catalog\.mjs/.test(e.message) &&
        /в artifacts контракта или в protectedPaths/.test(e.message),
    );
    assert.equal(r1.prompts.length, 0, 'ревьюер не вызван');
    // underTest: каталог, накрытый артефакт и объявление без artifacts —
    // отказы до ревью.
    for (const [bad, reason] of [
      [{ ...proposal('Catalog', pinnedHelpers), underTest: ['src/'] }, /не каталоги: src\//],
      [
        {
          ...proposal('Catalog', pinnedHelpers),
          underTest: ['src/catalog.mjs', 'acceptance/acceptance-helpers.mjs'],
        },
        /underTest накрывает закреплённые артефакты.*acceptance-helpers\.mjs/,
      ],
      [
        { title: 'Bare', content: 'Без приёмки.', underTest: ['src/catalog.mjs'] },
        /underTest без artifacts/,
      ],
    ] as const)
      await assert.rejects(review(h, root, bad, 'codex', r1.adapters), reason);
    const impactDir = await contractImpact(h, { ...proposal('Catalog'), underTest: ['src'] });
    assert.match(impactDir.closure.refusal ?? '', /не каталоги: src/);
    assert.equal(r1.prompts.length, 0, 'ревьюер не вызван');
    // Операция изменения контракта отказывает до удержания задач и ревью.
    const impact = await contractImpact(h, proposal('Catalog'));
    assert.match(impact.closure.refusal ?? '', /acceptance-helpers\.mjs/);
    // Предупреждение о договоре проверки — рядом с отказом, а не вместо него.
    assert.deepEqual(
      impact.warnings.map((w) => w.code),
      ['checks-missing'],
    );
    assert.deepEqual(impact.closure.exempted, [
      {
        path: 'src/catalog.mjs',
        from: 'acceptance/catalog.test.mjs',
        specifier: '../src/catalog.mjs',
      },
    ]);
    await assert.rejects(
      new ContractChanges(h, root, r1.adapters).start(proposal('Catalog'), 'codex'),
      /acceptance-helpers\.mjs/,
    );
    assert.equal(r1.prompts.length, 0);

    // Helper и данные закреплены артефактами — ревью и утверждение.
    const r2 = reviewers();
    const pinned = await review(h, root, proposal('Catalog', pinnedHelpers), 'codex', r2.adapters);
    assert.equal(pinned.status, 'approved', JSON.stringify(pinned));
    assert.ok(r2.prompts.length > 0);
    // Ревьюер видит, какие файлы underTest достигнуты и кем, и правило для них.
    assert.match(r2.prompts[0], /"underTestImports"/);
    assert.match(r2.prompts[0], /"from": ?"acceptance\/catalog\.test\.mjs"/);
    assert.match(r2.prompts[0], /must be implementation under test, not acceptance logic/);
    const contract = contractOf(pinned);
    assert.deepEqual(contract.underTest, ['src/catalog.mjs']);
    // Реализацию под тестом исполнитель пишет; заявить её иначе — другой договор.
    const widened = await review(
      h,
      root,
      { ...proposal('Catalog', pinnedHelpers), underTest: ['src/catalog.mjs', 'src/format.mjs'] },
      'codex',
      reviewers().adapters,
    );
    assert.equal(widened.status, 'approved');
    assert.notEqual(contractOf(widened).digest, contract.digest);

    // Кандидат, правящий закреплённый helper, нарушает границу задачи.
    edit = true;
    const guarded = await run('Edits helper', contractOf(widened).id);
    assert.notEqual(guarded.status, 'done');
    assert.ok(
      guarded.errors.some((e) => /защищённые файлы: acceptance\/acceptance-helpers\.mjs/.test(e)),
      JSON.stringify(guarded.errors),
    );
    edit = false;

    // Тот же helper под protectedPaths компонента — тоже принят.
    config.protectedPaths.push('acceptance/', 'data/');
    const r3 = reviewers();
    const protectedOnly = await review(
      h,
      root,
      proposal('Catalog protected'),
      'codex',
      r3.adapters,
    );
    assert.equal(protectedOnly.status, 'approved', JSON.stringify(protectedOnly));
    // Doctor не предупреждает о действующих договорах с полным закреплением.
    assert.deepEqual(
      (await contractClosureChecks(config, store.read().contracts)).map((c) => c.status),
      ['passed'],
    );
    config.protectedPaths.splice(-2);

    // Договор, утверждённый до проверки замыкания: закреплена только приёмка.
    // Он продолжает работать, и правка helper проходит — это и есть дыра,
    // которую doctor называет предупреждением, не блокируя очередь.
    const legacyPin = await pinArtifacts({ id: 'main', path: repo }, [
      { path: 'acceptance/catalog.test.mjs', purpose: 'Приёмка' },
    ]);
    const legacy = h.contract(
      'Catalog legacy',
      'Поиск каталога проходит закреплённую приёмку.',
      undefined,
      undefined,
      undefined,
      legacyPin.artifacts,
    );
    edit = true;
    const hole = await run('Legacy contract', legacy.id);
    assert.equal(hole.status, 'done', JSON.stringify(hole.errors));
    edit = false;
    const doctor = await contractClosureChecks(config, store.read().contracts);
    const warned = doctor.find((c) => c.id === `contract-closure:${legacy.id}:main`);
    assert.equal(warned?.status, 'not-checked', JSON.stringify(doctor));
    assert.match(warned.detail, /acceptance\/acceptance-helpers\.mjs/);
    assert.match(warned.detail, /data\/golden\.json/);
    assert.match(warned.detail, /data\/cases\.json/);
    // Повтор того же договора — «уже утверждён» с предупреждением, не отказ.
    const r0 = reviewers();
    const again = await review(
      h,
      root,
      {
        title: 'Catalog legacy',
        content: 'Поиск каталога проходит закреплённую приёмку.',
        artifacts: [{ path: 'acceptance/catalog.test.mjs', purpose: 'Приёмка' }],
      },
      'codex',
      r0.adapters,
    );
    assert.equal(again.status, 'already-approved');
    assert.match(String(again.warning), /acceptance-helpers\.mjs/);
  } finally {
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
