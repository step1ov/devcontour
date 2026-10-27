/**
 * Пределы предложения контракта: artifacts ≤ 50, purpose ≤ 200 знаков,
 * underTest ≤ 50. Превышение — понятный отказ с названием предела,
 * элементов и величины превышения, а contract-impact называет его в отчёте
 * рядом с остальными предпроверками, без сырого массива zod.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { DomainError } from '../src/core/model.ts';
import { loadConfig } from '../src/runner/config.ts';
import { parseProposal, proposalLimitIssues, proposalLimits } from '../src/runner/agent-control.ts';
import { contractImpact } from '../src/runner/contract-impact.ts';
import { assertArtifactsInBase, pinArtifacts } from '../src/runner/contract-artifacts.ts';
import { agentInputs } from '../src/application/agent.ts';
import { command, git } from '../src/runner/process.ts';

const artifacts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    path: `golden/log-${i}.log`,
    purpose: 'Журнал сверки',
  }));

test('Пределы предложения: превышение называет предел, элементы и величину; в пределах — разбор проходит', () => {
  assert.deepEqual(proposalLimits, { artifacts: 50, purpose: 200, underTest: 50 });
  const list = artifacts(56);
  list[12] = { path: 'oracle/compare.ts', purpose: 'x'.repeat(215) };
  const issues = proposalLimitIssues({ title: 'T', file: 'c.md', artifacts: list });
  assert.deepEqual(issues, [
    { limit: 'artifacts', max: 50, actual: 56, over: 6 },
    {
      limit: 'purpose',
      max: 200,
      actual: 215,
      over: 15,
      index: 12,
      path: 'oracle/compare.ts',
    },
  ]);
  assert.throws(
    () => parseProposal({ title: 'T', file: 'c.md', artifacts: list }),
    (e: unknown) => {
      assert.ok(e instanceof DomainError, String(e));
      assert.match(e.message, /artifacts: 56 элементов при пределе 50, лишних 6/);
      assert.match(
        e.message,
        /artifacts\[12\]\.purpose \(oracle\/compare\.ts\): 215 знаков при пределе 200, длиннее на 15/,
      );
      assert.match(e.message, /protectedPaths/);
      assert.match(e.message, /сводный артефакт/);
      return true;
    },
  );
  // Ровно на пределе — допустимо; пробелы по краям purpose не считаются.
  const edge = artifacts(50);
  edge[0] = { path: 'a.log', purpose: ' ' + 'y'.repeat(200) + ' ' };
  assert.deepEqual(proposalLimitIssues({ artifacts: edge }), []);
  assert.equal(parseProposal({ title: 'T', file: 'c.md', artifacts: edge }).artifacts?.length, 50);
  const under = proposalLimitIssues({
    underTest: Array.from({ length: 52 }, (_, i) => `src/m${i}.ts`),
  });
  assert.deepEqual(under, [{ limit: 'underTest', max: 50, actual: 52, over: 2 }]);
  // Исправление underTest не предлагает каталогов: их underTest не принимает.
  assert.throws(
    () =>
      parseProposal({
        title: 'T',
        file: 'c.md',
        underTest: Array.from({ length: 52 }, (_, i) => `src/m${i}.ts`),
      }),
    (e: Error) =>
      /underTest: 52 элементов при пределе 50, лишних 2/.test(e.message) &&
      /каталоги underTest не принимает/.test(e.message) &&
      !/каталоги реализации вместо/.test(e.message),
  );
});

test('Пределы и там, где схему проверяет транспорт агентского API, и сверх запаса отчёта — понятным сообщением', async () => {
  // Транспорт (MCP) проверяет вход схемой до обработчика: сообщение схемы
  // само называет предел, величину и исправление.
  const revise = agentInputs.contract_change_revise.safeParse({
    id: 'CC-1',
    expectedVersion: 1,
    proposal: { title: 'T', file: 'c.md', artifacts: artifacts(56) },
  });
  assert.equal(revise.success, false);
  const messages = revise.error.issues.map((i) => i.message).join('\n');
  assert.match(messages, /artifacts: 56 элементов при пределе 50, лишних 6/);
  assert.match(messages, /protectedPaths/);
  // contract-impact читает предложение с запасом (×10); за ним — тот же
  // понятный отказ, а не массив схемы. До чтения репозитория.
  await assert.rejects(
    contractImpact({} as never, { title: 'T', file: 'c.md', artifacts: artifacts(501) }),
    (e: Error) =>
      e instanceof DomainError &&
      /artifacts: 501 элементов при пределе 50, лишних 451/.test(e.message),
  );
});

test('contract-impact (CLI) называет превышение пределов в отчёте; contract-change отказывает понятным сообщением без массива zod', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-limits-'));
  try {
    await setupDemo(root);
    const config = loadConfig(join(root, 'config.json'));
    const repo = config.repository;
    await mkdir(join(repo, 'golden'), { recursive: true });
    for (let i = 0; i < 56; i++) await writeFile(join(repo, `golden/log-${i}.log`), `log ${i}\n`);
    await writeFile(
      join(repo, 'contract.md'),
      '# Contract\n\nCatalog search returns stable results.\n',
    );
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'Contract');
    const list = artifacts(56);
    list[3] = { ...list[3], purpose: 'p'.repeat(230) };
    const proposal = { title: 'Catalog search', file: 'contract.md', artifacts: list };
    const file = join(root, 'proposal.json');
    await writeFile(file, JSON.stringify(proposal));

    const cli = (...args: string[]) =>
      command(
        [
          process.execPath,
          '--import',
          import.meta.resolve('tsx'),
          resolve('src/cli.ts'),
          ...args,
          '--data',
          root,
        ],
        root,
      );
    const impact = await cli('contract-impact', '--file', file);
    assert.equal(impact.code, 0, impact.stderr);
    assert.equal(impact.stderr, '', 'предупреждение SQLite не печатается');
    // Предпроверка `limits` — рядом с `closure`, в той же форме: найденное и
    // отказ, которым кончится изменение контракта.
    const report = JSON.parse(impact.stdout) as Awaited<ReturnType<typeof contractImpact>>;
    assert.deepEqual(
      report.limits.issues.map((i) => [i.limit, i.over]),
      [
        ['artifacts', 6],
        ['purpose', 30],
      ],
    );
    assert.equal(report.limits.issues[1].index, 3);
    assert.equal(report.limits.max.artifacts, 50);
    assert.match(report.limits.refusal ?? '', /лишних 6/);
    assert.equal(report.closure.refusal, undefined);
    assert.equal(report.applied, false);

    const change = await cli('contract-change', '--file', file, '--author-runtime', 'claude');
    assert.equal(change.code, 1);
    assert.match(change.stderr, /Предложение контракта превышает пределы/);
    assert.match(change.stderr, /artifacts\[3\]\.purpose \(golden\/log-3\.log\): 230 знаков/);
    assert.match(change.stderr, /protectedPaths/);
    assert.doesNotMatch(change.stderr, /too_big|"origin"|ExperimentalWarning/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Число вызовов Git у contract-impact не растёт с числом артефактов: прежде
 * каждый артефакт стоил пяти-шести процессов Git, и отчёт по 56 файлам под
 * нагрузкой полного прогона не укладывался в таймаут. Счёт — по вызовам, а
 * не по времени: он не зависит от нагрузки машины.
 */
test('contract-impact и закрепление спрашивают Git постоянное число раз; отказы и сверка базы — как по одному', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-git-calls-'));
  try {
    await setupDemo(root);
    const repo = loadConfig(join(root, 'config.json')).repository;
    await mkdir(join(repo, 'golden'), { recursive: true });
    for (let i = 0; i < 56; i++) await writeFile(join(repo, `golden/log-${i}.log`), `log ${i}\n`);
    await writeFile(join(repo, 'contract.md'), '# Contract\n\nStable results.\n');
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'Contract');
    // Обёртка git на PATH записывает каждый вызов и передаёт его настоящему git.
    const real = (await command(['sh', '-c', 'command -v git'], root)).stdout.trim();
    const bin = join(root, 'bin'),
      log = join(root, 'git-calls.log');
    await mkdir(bin);
    await writeFile(join(bin, 'git'), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${real}" "$@"\n`, {
      mode: 0o755,
    });
    const calls = async (n: number) => {
      const file = join(root, `proposal-${n}.json`);
      await writeFile(
        file,
        JSON.stringify({ title: 'Catalog search', file: 'contract.md', artifacts: artifacts(n) }),
      );
      await writeFile(log, '');
      const r = await command(
        [
          process.execPath,
          '--import',
          import.meta.resolve('tsx'),
          resolve('src/cli.ts'),
          'contract-impact',
          '--file',
          file,
          '--data',
          root,
        ],
        root,
        { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
      );
      assert.equal(r.code, 0, r.stderr);
      const report = JSON.parse(r.stdout) as Awaited<ReturnType<typeof contractImpact>>;
      assert.equal(report.changes.artifacts.length, n);
      assert.deepEqual(report.base.missing.length, n + 1, 'база ещё не получила документ и файлы');
      return (await readFile(log, 'utf8')).split('\n').filter(Boolean).length;
    };
    const few = await calls(2);
    const many = await calls(56);
    assert.ok(few > 0, 'обёртка git действительно вызывалась');
    assert.equal(many, few, `вызовов Git: ${few} на 2 артефакта, ${many} на 56`);

    // Те же отказы и тот же порядок, что при проверке по одному.
    const owner = { id: 'main', path: repo };
    const list = artifacts(56);
    const report = await pinArtifacts(owner, list);
    assert.equal(report.artifacts.length, 56);
    assert.equal(report.artifacts[40].path, 'golden/log-40.log');
    assert.equal(report.artifacts[40].blob, await git(repo, 'rev-parse', 'HEAD:golden/log-40.log'));
    assert.equal(
      report.artifacts[40].digest,
      createHash('sha256').update('log 40\n').digest('hex'),
    );
    assert.deepEqual(report.contents[7], {
      path: 'golden/log-7.log',
      purpose: 'Журнал сверки',
      content: 'log 7\n',
    });
    await writeFile(join(repo, 'golden/new.log'), 'new\n');
    await writeFile(join(repo, 'golden/log-30.log'), 'dirty\n');
    // Ранний неотслеживаемый файл опережает поздний отказ файловой системы
    // и поздний изменённый файл.
    await assert.rejects(
      pinArtifacts(owner, [
        ...list.slice(0, 5),
        { path: 'golden/new.log', purpose: 'x' },
        ...list.slice(5),
        { path: 'golden/absent.log', purpose: 'x' },
      ]),
      /не в Git: golden\/new\.log/,
    );
    await assert.rejects(
      pinArtifacts(owner, [...list, { path: 'golden/absent.log', purpose: 'x' }]),
      /изменён после коммита — закоммитьте его до ревью контракта: golden\/log-30\.log/,
    );
    await assert.rejects(
      pinArtifacts(owner, [list[0], { path: 'golden/absent.log', purpose: 'x' }, list[30]]),
      /не найден: golden\/absent\.log/,
    );
    await assert.rejects(pinArtifacts(owner, [list[0], list[0]]), /указан дважды/);
    await git(repo, 'checkout', '--', 'golden/log-30.log');

    // Сверка базы пакетом: blob на месте — не устаревший, другой или
    // отсутствующий — устаревший.
    const head = await git(repo, 'rev-parse', 'HEAD');
    assert.deepEqual(await assertArtifactsInBase(repo, head, report.artifacts), []);
    const forged = report.artifacts.map((a, i) =>
      i === 3 ? { ...a, blob: report.artifacts[4].blob } : i === 9 ? { ...a, path: 'gone.log' } : a,
    );
    assert.deepEqual(await assertArtifactsInBase(repo, head, forged), [
      'golden/log-3.log',
      'gone.log',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
