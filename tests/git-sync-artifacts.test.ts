import { createHash, randomUUID } from 'node:crypto';
import { Preparation } from '../src/core/preparation.ts';
import { approvePreparation } from './preparation-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { DevContour, contractDigest, digest } from '../src/core/service.ts';
import { pinArtifacts } from '../src/runner/contract-artifacts.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { contractImpact } from '../src/runner/contract-impact.ts';
import { recordsFromState } from '../src/core/sync-state.ts';
import { canonical } from '../src/core/sync-model.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { repositorySchema, type ContractArtifact } from '../src/core/model.ts';
import { config, input } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import {
  requirementSnapshot,
  requirementReport,
  assertRequirementProof,
} from '../src/runner/requirements.ts';
import { fixture, git, rewrite } from './git-sync-fixture.ts';

test('Real runner checks and integration survive Git transfer without reusing local workers', async () => {
  const f = fixture();
  let scheduler: Scheduler | undefined;
  try {
    const a = f.create('alice');
    writeFileSync(join(a.repo, '.gitignore'), '.devcontour-local/\n.reports/\n');
    writeFileSync(
      join(a.repo, 'verify.mjs'),
      `import {writeFileSync,readdirSync} from 'node:fs'; if (!readdirSync('deliverables').length) process.exit(1); writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="deliverable"/></testsuite>');`,
    );
    git(a.repo, 'add', '.gitignore', 'verify.mjs');
    git(a.repo, 'commit', '-m', 'Real test gate');
    syncGit(a.h, { member: 'alice' });
    const board = a.h.createBoard('Actual runner board', '', 'main');
    const task = a.h.addTask(board.id, input());
    a.h.approve(board.id);
    syncGit(a.h);
    a.commit();
    scheduler = new Scheduler(a.h, join(a.workspace, '.devcontour-local'));
    await scheduler.init();
    a.h.pause(false);
    await scheduler.drain();
    await scheduler.stop();
    const result = a.store.read().tasks[0];
    assert.equal(result.status, 'done', result.failure);
    git(a.repo, 'merge', '--ff-only', 'devcontour/accepted');
    syncGit(a.h);
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    const restored = b.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(restored.status, 'done');
    assert.equal(restored.resultSha, result.resultSha);
    assert.equal(restored.sharedCompletion!.receipt.checks.length, 4);
    assert.equal(b.store.read().runs.length, 0);
  } finally {
    await scheduler?.stop();
    f.cleanup();
  }
});

test('Shared graph references component tasks without exporting their bodies into workspace Git or baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-multi-sync-'));
  let store: Store | undefined;
  try {
    const workspace = join(root, 'workspace');
    const paths = ['workspace', 'library', 'product'].map((id) => join(root, id));
    for (const path of paths) {
      mkdirSync(path);
      git(path, 'init', '-b', 'main');
      writeFileSync(join(path, '.gitignore'), '.devcontour-local/\n');
      git(path, 'add', '.gitignore');
      git(path, 'commit', '-m', 'baseline');
    }
    const repos = ['library', 'product'].map((id) =>
      repositorySchema.parse({
        id,
        name: id,
        path: join(root, id),
        kind: id,
        gates: config().gates,
      }),
    );
    const c = config({
      workspaceRoot: workspace,
      repository: repos[1].path,
      repositories: repos,
      storage: 'component',
    });
    store = new Store(join(workspace, '.devcontour-local/state.sqlite'), repos);
    const h = new DevContour(store, c),
      board = h.createBoard('Joint change');
    const library = h.addTask(board.id, {
      ...input('Private library requirement'),
      repositoryId: 'library',
    });
    h.addTask(board.id, {
      ...input('Private product requirement', [library.id]),
      repositoryId: 'product',
    });
    h.addTask(board.id, {
      ...input('Joint acceptance'),
      repositoryId: 'product',
      scope: 'workspace',
      relatedRepositories: ['library', 'product'],
    });
    syncGit(h, { member: 'alice' });
    const workspaceRecords = readdirSync(join(workspace, '.devcontour/tasks'))
      .map((file) => readFileSync(join(workspace, '.devcontour/tasks', file), 'utf8'))
      .join('');
    assert.ok(!workspaceRecords.includes('Private library requirement'));
    assert.ok(!workspaceRecords.includes('Private product requirement'));
    assert.match(workspaceRecords, /Joint acceptance/);
    assert.ok(!canonical(store.syncBaseline()).includes('Private library requirement'));
    assert.match(canonical(store.syncBaseline('library')), /Private library requirement/);
    assert.equal(syncGit(h).changes.length, 0);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('An initially empty shared board keeps its Git owner after tasks are added', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Initially empty board');
    syncGit(a.h, { member: 'alice' });
    a.h.addTask(board.id, input());
    syncGit(a.h);
    assert.equal(a.store.read().boards[0].scope, 'workspace');
    assert.ok(
      readFileSync(join(a.workspace, '.devcontour/boards', board.id + '.json'), 'utf8').includes(
        board.title,
      ),
    );
    assert.deepEqual(syncGit(a.h).changes, []);
  } finally {
    f.cleanup();
  }
});

test('Product decisions and task bindings round-trip between independent component clones without moving local task bodies', () => {
  const f = fixture();
  try {
    const a = f.create('product-a');
    const changeId = approvePreparation(new Preparation(a.store));
    const board = a.h.createBoard('Approved product work', '', 'main');
    const task = a.h.addTask(board.id, { ...input(), featureId: 'member-block' });
    a.h.approve(board.id);
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('product-b', a);
    syncGit(b.h, { member: 'bob' });
    assert.equal(b.store.read().preparation?.changes[0].id, changeId);
    assert.deepEqual(b.store.read().tasks[0].preparation, task.preparation);
    // Карта продукта считает готовность по этой связи: она переезжает с задачей.
    assert.equal(b.store.read().tasks[0].featureId, 'member-block');
    assert.equal(b.store.read().preparation?.changes[0].architecture[0].status, 'approved');
    const shared = readFileSync(
      join(a.workspace, '.devcontour/preparations/workspace-preparation.json'),
      'utf8',
    );
    assert.ok(!shared.includes(task.description));
    const prior = JSON.stringify(b.store.read());
    const path = join(b.workspace, '.devcontour/preparations/workspace-preparation.json');
    const altered = JSON.parse(readFileSync(path, 'utf8'));
    altered.data.changes[0].product[0].decision.comment = 'Rewritten history';
    writeFileSync(path, JSON.stringify(altered));
    assert.throws(() => syncGit(b.h, { member: 'bob' }), /неизменяема/);
    assert.equal(JSON.stringify(b.store.read()), prior);
  } finally {
    f.cleanup();
  }
});

test("A contract's document path survives export into Git", () => {
  const f = fixture();
  try {
    const a = f.create('alice');
    a.h.contract(
      'Каталог',
      '# Каталог\n\nGET /products возвращает список.\n',
      { actor: 'operator' },
      'main',
      'docs/contracts/catalog.md',
    );
    // Путь к документу — часть происхождения контракта. Без него клон
    // восстанавливает текст, не зная, какому файлу в дереве он отвечает.
    const record = Object.values(recordsFromState(a.h, a.store.read()).get('main')!).find(
      (r) => r.kind === 'contract',
    )!;
    assert.equal(
      (record.data as { source?: string }).source,
      'docs/contracts/catalog.md',
      'путь контракта должен уходить в Git вместе с текстом',
    );
  } finally {
    f.cleanup();
  }
});

test('Pinned contract artifacts travel through Git sync between clones and a substituted pin is refused', async () => {
  const f = fixture();
  try {
    const a = f.create('artifacts-a');
    syncGit(a.h, { member: 'alice' });
    writeFileSync(join(a.repo, 'schema.json'), '{"price":"number"}\n');
    writeFileSync(join(a.repo, 'other.json'), '{"price":"boolean"}\n');
    git(a.repo, 'add', '.');
    git(a.repo, 'commit', '-m', 'Schema');
    const pinned = await pinArtifacts({ id: 'main', path: a.repo }, [
      { path: 'schema.json', purpose: 'Схема ответа' },
    ]);
    const contract = a.h.contract(
      'Каталог',
      'Ответ по schema.json.',
      { actor: 'operator' },
      'main',
      undefined,
      pinned.artifacts,
    );
    syncGit(a.h);
    a.commit();
    // Независимый клон получает закрепление через Git.
    const b = f.create('artifacts-b', a);
    syncGit(b.h, { member: 'bob' });
    assert.deepEqual(
      b.store.read().contracts.find((c) => c.id === contract.id)?.artifacts,
      pinned.artifacts,
    );
    // Подмена в переносимой записи: другой blob того же репозитория.
    const other = git(a.repo, 'rev-parse', 'HEAD:other.json');
    type Pin = { data: { content: string; digest: string; artifacts: ContractArtifact[] } };
    const tampered = (name: string, change: (record: Pin) => void) => {
      const peer = f.create(name, a);
      const file = readdirSync(join(peer.repo, '.devcontour'), { recursive: true })
        .map((x) => join(peer.repo, '.devcontour', String(x)))
        .find((x) => x.endsWith('.json') && readFileSync(x, 'utf8').includes(contract.id))!;
      rewrite(file, (value) => change(value as Pin));
      git(peer.repo, 'commit', '-am', 'Tamper');
      return peer;
    };
    // Только blob: digest контракта охватывает blob и расходится.
    const onlyBlob = tampered('artifacts-c', (r) => {
      r.data.artifacts[0].blob = other;
    });
    assert.throws(() => syncGit(onlyBlob.h, { member: 'carol' }), /digest контракта/);
    // Blob и согласованно пересчитанный digest: подмену ловит сверка с Git.
    const consistent = tampered('artifacts-d', (r) => {
      r.data.artifacts[0].blob = other;
      r.data.digest = contractDigest(r.data.content, r.data.artifacts, 2);
    });
    assert.throws(() => syncGit(consistent.h, { member: 'dave' }), /подменено/);
    assert.equal(consistent.store.read().contracts.length, 0, 'импорт не применён');
    // Убранная версия закрепления у уже известного контракта — изменение
    // утверждённой записи, а не повод выгрузить историю, которую следующий
    // клон не примет.
    const file = readdirSync(join(a.repo, '.devcontour'), { recursive: true })
      .map((x) => join(a.repo, '.devcontour', String(x)))
      .find((x) => x.endsWith('.json') && readFileSync(x, 'utf8').includes(contract.id))!;
    rewrite(file, (value: { data: { pinVersion?: number } }) => {
      delete value.data.pinVersion;
    });
    git(a.repo, 'commit', '-am', 'Drop pin version');
    assert.throws(() => syncGit(a.h), /неизменяем|digest контракта/);
    git(a.repo, 'reset', '-q', '--hard', 'HEAD~1');
    // Поля вне digest ловит только сравнение всей записи: другое название
    // или дата утверждения давали клоны с разными контрактами.
    for (const [field, value] of [
      ['title', 'Переименованный каталог'],
      ['approvedAt', '2020-01-01T00:00:00.000Z'],
    ] as const) {
      rewrite(file, (record: { data: Record<string, unknown> }) => {
        record.data[field] = value;
      });
      git(a.repo, 'commit', '-am', 'Change ' + field);
      assert.throws(() => syncGit(a.h), /неизменяем/, field);
      git(a.repo, 'reset', '-q', '--hard', 'HEAD~1');
      assert.equal(
        a.store.read().contracts.find((c) => c.id === contract.id)?.title,
        'Каталог',
        `${field}: локальная запись не тронута`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test('A contract with underTest round-trips between clones, and a changed underTest list is refused', async () => {
  const f = fixture();
  try {
    const a = f.create('under-test-a');
    syncGit(a.h, { member: 'alice' });
    mkdirSync(join(a.repo, 'tests'));
    writeFileSync(join(a.repo, 'tests/accept.mjs'), "import { run } from '../src/run.mjs';\n");
    git(a.repo, 'add', '.');
    git(a.repo, 'commit', '-m', 'Acceptance');
    const pinned = await pinArtifacts({ id: 'main', path: a.repo }, [
      { path: 'tests/accept.mjs', purpose: 'Приёмка' },
    ]);
    const contract = a.h.contract(
      'Запуск',
      'Приёмка запуска.',
      { actor: 'operator' },
      'main',
      undefined,
      pinned.artifacts,
      undefined,
      ['src/run.mjs'],
    );
    assert.notEqual(
      contract.digest,
      contractDigest('Приёмка запуска.', pinned.artifacts, 2),
      'underTest входит в digest',
    );
    syncGit(a.h);
    a.commit();
    const b = f.create('under-test-b', a);
    syncGit(b.h, { member: 'bob' });
    const received = b.store.read().contracts.find((c) => c.id === contract.id);
    assert.deepEqual(received?.underTest, ['src/run.mjs']);
    assert.equal(received?.digest, contract.digest);
    // Другой список underTest при прежнем digest — подмена договора.
    const c = f.create('under-test-c', a);
    const file = readdirSync(join(c.repo, '.devcontour'), { recursive: true })
      .map((x) => join(c.repo, '.devcontour', String(x)))
      .find((x) => x.endsWith('.json') && readFileSync(x, 'utf8').includes(contract.id))!;
    rewrite(file, (value: { data: { underTest: string[] } }) => {
      value.data.underTest = ['src/run.mjs', 'tests/accept-helpers.mjs'];
    });
    git(c.repo, 'commit', '-am', 'Widen underTest');
    assert.throws(() => syncGit(c.h, { member: 'carol' }), /digest контракта/);
    assert.equal(c.store.read().contracts.length, 0, 'импорт не применён');
  } finally {
    f.cleanup();
  }
});

test('Contracts pinned by the first formula keep syncing, stay approved and are still checked against Git', async () => {
  const f = fixture();
  try {
    const a = f.create('legacy-a');
    syncGit(a.h, { member: 'alice' });
    // Файл с переводом строки в конце: первая формула брала digest
    // обрезанного текста, и байтовая сверка его бы отвергла.
    const schema = '{"price":"number"}\n';
    writeFileSync(join(a.repo, 'schema.json'), schema);
    writeFileSync(join(a.repo, 'other.json'), '{"price":"boolean"}\n');
    git(a.repo, 'add', '.');
    git(a.repo, 'commit', '-m', 'Schema');
    const revision = git(a.repo, 'rev-parse', 'HEAD');
    const artifacts: ContractArtifact[] = [
      {
        repositoryId: 'main',
        path: 'schema.json',
        purpose: 'Схема ответа',
        revision,
        blob: git(a.repo, 'rev-parse', 'HEAD:schema.json'),
        digest: digest(schema.trim()),
      },
    ];
    const content = 'Ответ по schema.json.';
    // Формула первой версии записана здесь независимо от contractDigest:
    // тест, считающий «старую» запись той же функцией, прошёл бы и при
    // ошибочном выборе формулы в ней.
    const firstFormula = (text: string, pins: ContractArtifact[]) =>
      createHash('sha256')
        .update(
          JSON.stringify({
            content: text,
            artifacts: pins.map((a) => ({
              repositoryId: a.repositoryId,
              path: a.path,
              purpose: a.purpose,
              digest: a.digest,
            })),
          }),
        )
        .digest('hex');
    // Запись, как её сохранил прежний код: без версии и без blob в digest.
    const legacy = a.store.change('fixture.legacy-contract', (s) => {
      const c = {
        id: 'C-' + randomUUID(),
        repositoryId: 'main',
        title: 'Каталог',
        content,
        artifacts,
        digest: firstFormula(content, artifacts),
        approvedAt: new Date().toISOString(),
        approval: { actor: 'operator' as const },
      };
      s.contracts.push(c);
      return c;
    });
    // Утверждённая задача держит digest старой записи.
    const board = a.h.createBoard('Каталог', '', 'main');
    const task = a.h.addTask(board.id, { ...input(), role: 'backend', contracts: [legacy.id] });
    a.h.approve(board.id);
    const approved = a.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(approved.contractDigests[legacy.id], legacy.digest);
    syncGit(a.h);
    a.commit();
    // Существующая история синхронизируется и переносится в новый клон.
    const b = f.create('legacy-b', a);
    syncGit(b.h, { member: 'bob' });
    const imported = b.store.read().contracts.find((c) => c.id === legacy.id)!;
    assert.equal(imported.digest, legacy.digest, 'digest истории не переписан');
    assert.equal(imported.pinVersion, undefined);
    const moved = b.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(moved.approvedDigest, approved.approvedDigest, 'утверждение задачи перенесено');
    assert.equal(moved.contractDigests[legacy.id], legacy.digest);
    // Тот же договор не требует нового ревью и не выглядит изменённым.
    const proposal = {
      title: 'Каталог',
      content,
      repositoryId: 'main',
      artifacts: [{ path: 'schema.json', purpose: 'Схема ответа' }],
    };
    assert.equal(
      (await reviewContract(a.h, join(f.root, 'legacy-review'), proposal, 'codex')).status,
      'already-approved',
    );
    assert.equal((await contractImpact(a.h, proposal)).status, 'unchanged');
    // Подмена blob в записи первой формулы ловится сверкой с Git.
    const peer = f.create('legacy-c', a);
    const file = readdirSync(join(peer.repo, '.devcontour'), { recursive: true })
      .map((x) => join(peer.repo, '.devcontour', String(x)))
      .find((x) => x.endsWith('.json') && readFileSync(x, 'utf8').includes(legacy.id))!;
    rewrite(
      file,
      (value: { data: { content: string; digest: string; artifacts: ContractArtifact[] } }) => {
        value.data.artifacts[0].blob = git(a.repo, 'rev-parse', 'HEAD:other.json');
        value.data.digest = firstFormula(value.data.content, value.data.artifacts);
      },
    );
    git(peer.repo, 'commit', '-am', 'Tamper');
    assert.throws(() => syncGit(peer.h, { member: 'carol' }), /подменено/);
    // У записи первой формулы blob не входит в digest: подмена blob у уже
    // известного контракта сохраняет digest, а сверка с Git идёт только для
    // новых. Её ловит сравнение всей записи.
    const known = readdirSync(join(a.repo, '.devcontour'), { recursive: true })
      .map((x) => join(a.repo, '.devcontour', String(x)))
      .find((x) => x.endsWith('.json') && readFileSync(x, 'utf8').includes(legacy.id))!;
    rewrite(known, (value: { data: { artifacts: ContractArtifact[] } }) => {
      value.data.artifacts[0].blob = git(a.repo, 'rev-parse', 'HEAD:other.json');
    });
    git(a.repo, 'commit', '-am', 'Swap blob of a known record');
    assert.throws(() => syncGit(a.h), /неизменяем/);
  } finally {
    f.cleanup();
  }
});

test('Независимый клон получает манифест testcases и подтверждает критерий тем же уровнем', async () => {
  const f = fixture();
  try {
    const a = f.create('alice');
    writeFileSync(
      join(a.repo, 'spec.md'),
      '## REQ-test: Observed behaviour\nNamed testcase must run.\n',
    );
    git(a.repo, 'add', '.');
    git(a.repo, 'commit', '-m', 'Requirement');
    syncGit(a.h, { member: 'alice' });
    const board = a.h.createBoard('Proof transfer', '', 'main');
    const snap = requirementSnapshot(a.repo, 'spec.md');
    const t = a.h.addTask(board.id, {
      ...input(),
      requirements: [
        {
          ...snap.requirements[0],
          source: snap.source,
          gate: 'test',
          scenario: 'Observed behaviour',
          testId: 'named-case',
        },
      ],
    });
    a.h.approve(board.id);
    a.h.pause(false);
    const r = a.h.claim('fixture')!;
    const sha = git(a.repo, 'rev-parse', 'HEAD');
    git(a.repo, 'update-ref', 'refs/heads/' + a.h.config.targetBranch, sha);
    a.h.phase(r.id, r.token, 'integrating', { candidateSha: sha, integrationSha: sha });
    for (const phase of ['candidate', 'integration'] as const) {
      for (const gate of ['test', 'requirement-source', 'independent-review'])
        a.h.evidence(r.id, r.token, {
          kind: gate === 'independent-review' ? 'review' : 'test',
          phase,
          sha,
          gate,
          passed: true,
          exitCode: 0,
          command: ['fixture'],
          log: '',
          digest: digest('fixture'),
          summary: 'fixture',
          tests:
            gate === 'test'
              ? [
                  { id: 'named-case', status: 'passed' },
                  // Evidence прежней версии хранило имя без предела длины.
                  // Receipt переносит его хешем с пометкой, а не падает.
                  { id: 'x'.repeat(1001), status: 'passed' },
                ]
              : undefined,
        });
    }
    a.h.finish(r.id, r.token, sha);
    const taskA = a.store.read().tasks.find((x) => x.id === t.id)!;
    assertRequirementProof(a.h, taskA);
    assert.equal(requirementReport(a.h, 'main').tasks[0].requirements[0].proof, 'testcase');
    a.h.pause(true);
    syncGit(a.h);
    a.commit();
    const b = f.create('bob', a);
    git(b.repo, 'update-ref', 'refs/heads/' + b.h.config.targetBranch, sha);
    syncGit(b.h, { member: 'bob' });
    const taskB = b.store.read().tasks.find((x) => x.id === t.id)!;
    const proofB = requirementReport(b.h, 'main').tasks[0].requirements[0];
    // Receipt несёт манифест: в другом клоне критерий подтверждён тем же
    // уровнем, а не падает до «проверка не сообщила, какие тесты выполнились».
    assert.equal(taskB.id, t.id);
    assert.equal(taskB.status, 'done');
    const integration = taskB.sharedCompletion!.receipt.checks.find(
      (c) => c.gate === 'test' && c.phase === 'integration',
    )!;
    assert.deepEqual(integration.tests, [
      { id: 'named-case', status: 'passed' },
      {
        id: 'sha256:' + createHash('sha256').update('x'.repeat(1001)).digest('hex'),
        status: 'passed',
        opaque: true,
      },
    ]);
    assert.equal(proofB.proof, 'testcase', proofB.proofReason);
    assertRequirementProof(b.h, taskB);
  } finally {
    f.cleanup();
  }
});

test('Receipt, чей manifest не подтверждает названный testcase, не импортируется как done', async () => {
  const f = fixture();
  try {
    const a = f.create('alice');
    writeFileSync(
      join(a.repo, 'spec.md'),
      '## REQ-test: Observed behaviour\nNamed testcase must run.\n',
    );
    git(a.repo, 'add', '.');
    git(a.repo, 'commit', '-m', 'Requirement');
    syncGit(a.h, { member: 'alice' });
    const board = a.h.createBoard('Proof transfer', '', 'main');
    const snap = requirementSnapshot(a.repo, 'spec.md');
    const t = a.h.addTask(board.id, {
      ...input(),
      requirements: [
        {
          ...snap.requirements[0],
          source: snap.source,
          gate: 'test',
          scenario: 'Observed behaviour',
          testId: 'named-case',
        },
      ],
    });
    a.h.approve(board.id);
    a.h.pause(false);
    const r = a.h.claim('fixture')!;
    const sha = git(a.repo, 'rev-parse', 'HEAD');
    git(a.repo, 'update-ref', 'refs/heads/' + a.h.config.targetBranch, sha);
    a.h.phase(r.id, r.token, 'integrating', { candidateSha: sha, integrationSha: sha });
    for (const phase of ['candidate', 'integration'] as const) {
      for (const gate of ['test', 'requirement-source', 'independent-review'])
        a.h.evidence(r.id, r.token, {
          kind: gate === 'independent-review' ? 'review' : 'test',
          phase,
          sha,
          gate,
          passed: true,
          exitCode: 0,
          command: ['fixture'],
          log: '',
          digest: digest('fixture'),
          summary: 'fixture',
          tests: gate === 'test' ? [{ id: 'named-case', status: 'passed' }] : undefined,
        });
    }
    a.h.finish(r.id, r.token, sha);
    const taskA = a.store.read().tasks.find((x) => x.id === t.id)!;
    assertRequirementProof(a.h, taskA);
    assert.equal(requirementReport(a.h, 'main').tasks[0].requirements[0].proof, 'testcase');
    a.h.pause(true);
    syncGit(a.h);
    a.commit();
    const receipts = join(a.repo, '.devcontour', 'receipts');
    for (const file of readdirSync(receipts))
      rewrite(join(receipts, file), (record) => {
        for (const check of record.data.checks)
          if (check.tests) check.tests = [{ id: 'unrelated', status: 'passed' }];
      });
    a.commit();
    // Доверенная история Git, но receipt противоречит постановке: названного
    // теста в его manifest нет. Импорт отказывает целиком и ничего не меняет:
    // задача не становится done и не открывает зависимые.
    const b = f.create('bob', a);
    git(b.repo, 'update-ref', 'refs/heads/' + b.h.config.targetBranch, sha);
    assert.throws(() => syncGit(b.h, { member: 'bob' }), /named-case.*не выполнялся/);
    assert.equal(
      b.store.read().tasks.some((x) => x.id === t.id && x.status === 'done'),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test('Independent clone sync transfers ChangeSet definition without local acceptance or joint budget checkpoint', () => {
  const f = fixture();
  try {
    const a = f.create('budget-a');
    syncGit(a.h, { member: 'alice' });
    const board = a.h.createBoard('Joint definition', '', 'main');
    const change = new Workspace(a.h).create({
      title: 'Joint acceptance',
      description: 'Local joint history stays in its controller',
      boardIds: [board.id],
    });
    a.store.change('fixture.local-acceptance', (s) => {
      s.changeSets[0].acceptance = {
        at: '2026-01-01T00:00:00.000Z',
        verificationId: 'local-proof',
        digest: 'e'.repeat(64),
        approval: { actor: 'agent' },
        jointBudgetCheckpoint: {
          verificationId: 'local-proof',
          settledVerificationIds: ['local-proof'],
        },
      };
    });
    const local = structuredClone(a.store.read().changeSets[0].acceptance);
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('budget-b', a);
    syncGit(b.h, { member: 'bob' });
    const imported = b.store.read().changeSets.find((c) => c.id === change.id)!;
    assert.equal(imported.acceptance, undefined);
    assert.deepEqual(imported.verifications, []);
    const files = git(a.workspace, 'ls-files', '.devcontour');
    for (const file of files.split('\n').filter(Boolean)) {
      const text = readFileSync(join(a.workspace, file), 'utf8');
      assert.ok(!text.includes('jointBudgetCheckpoint'));
      assert.ok(!text.includes('local-proof'));
    }
    syncGit(a.h, { member: 'alice' });
    assert.deepEqual(a.store.read().changeSets[0].acceptance, local);
  } finally {
    f.cleanup();
  }
});

test('Git identity is refused before parsing when it is above its size limit', () => {
  const f = fixture();
  try {
    const a = f.create('oversized-identity');
    syncGit(a.h, { member: 'alice' });
    const file = join(a.repo, '.devcontour/identity.json');
    writeFileSync(file, readFileSync(file, 'utf8').trimEnd().padEnd(1000));
    syncGit(a.h, { dryRun: true });
    writeFileSync(file, readFileSync(file, 'utf8').padEnd(1001));
    assert.throws(() => syncGit(a.h, { dryRun: true }), /Недопустимый файл состояния/);
  } finally {
    f.cleanup();
  }
});
