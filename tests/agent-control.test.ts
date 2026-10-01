import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { complete, fixture, input } from './helpers.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { reviewContract, reviewPlan, acceptBoard } from '../src/runner/agent-control.ts';
import { contractImpact } from '../src/runner/contract-impact.ts';
import { digest, specDigest, supersededBy } from '../src/core/service.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';

function runtimes(action?: (r: AgentRequest) => void, blocking = false) {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    async execute(r) {
      action?.(r);
      return {
        data: {
          approved: true,
          summary: 'Explicit test fixture',
          findings: blocking ? [{ severity: 'blocking', message: 'Missing behavior' }] : [],
        },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      };
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

test('Agent contracts require another runtime, retain review proof and deduplicate repeated content', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const proposal = {
      title: 'Catalog API v1',
      content: 'GET /products returns a documented list and errors.',
    };
    let calls = 0;
    const r = await reviewContract(
      f.h,
      f.root,
      proposal,
      'codex',
      runtimes(() => {
        calls++;
      }),
    );
    assert.equal(r.status, 'approved');
    const contract = f.store.read().contracts[0];
    assert.equal(contract.approval?.authorRuntime, 'codex');
    assert.equal(contract.approval?.reviewerRuntime, 'claude');
    const saved = JSON.parse(await readFile(contract.approval.artifact + '/proposal.json', 'utf8'));
    assert.deepEqual(saved, proposal);
    await reviewContract(
      f.h,
      f.root,
      proposal,
      'codex',
      runtimes(() => {
        calls++;
      }),
    );
    assert.equal(calls, 1);
    assert.equal(f.store.read().contracts.length, 1);
  } finally {
    f.cleanup();
  }
});

// Фикстура ставит репозиторий в /tmp; тесты, пишущие файлы, берут свой каталог,
// иначе они пачкают общий и зависят друг от друга.
async function repositoryFixture(f: { h: { config: { repository: string; mode: string } } }) {
  const path = await mkdtemp(join(tmpdir(), 'devcontour-contract-'));
  f.h.config.repository = path;
  f.h.config.mode = 'local';
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

test('A contract proposal reads the document from the repository, not a copy of it', async () => {
  const f = fixture();
  const repo = await repositoryFixture(f);
  try {
    const relative = 'docs/contracts/catalog.md';
    const file = join(repo.path, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '# Catalog\n\nGET /products returns a documented list.\n');
    const proposal = { title: 'Catalog API v1', file: relative };

    const r = await reviewContract(f.h, f.root, proposal, 'codex', runtimes());
    assert.equal(r.status, 'approved');
    const contract = f.store.read().contracts[0];
    assert.match(contract.content, /GET \/products/);
    // Путь сохраняется: принятый digest относится к файлу в дереве, а не к
    // тексту, который когда-то скопировали в предложение.
    assert.equal(contract.source, relative);

    // Правка документа — другой контракт, а не повтор того же: дедупликация
    // идёт по содержимому, и снимок прошлой редакции её не обманывает.
    await writeFile(file, '# Catalog\n\nGET /products returns a list and errors.\n');
    await reviewContract(f.h, f.root, proposal, 'codex', runtimes());
    assert.equal(f.store.read().contracts.length, 2);
    assert.match(f.store.read().contracts[1].content, /errors/);
  } finally {
    await repo.remove();
    f.cleanup();
  }
});

test('A workspace whose repositories are not named main still reviews contracts', async () => {
  const f = fixture();
  const repo = await repositoryFixture(f);
  try {
    // Раньше ревью и разбор предложения молча брали «main». В workspace из
    // product и library это имя не существует, и путь, который работал,
    // начинал падать на несуществующем репозитории.
    f.h.config.repositories = [
      {
        id: 'product',
        name: 'Product',
        kind: 'product',
        path: repo.path,
        targetBranch: 'devcontour/accepted',
        gates: [],
        protectedPaths: [],
      },
    ] as typeof f.h.config.repositories;
    const relative = 'docs/contracts/catalog.md';
    await mkdir(join(repo.path, dirname(relative)), { recursive: true });
    await writeFile(join(repo.path, relative), '# Catalog\n\nGET /products.\n');

    const byFile = await reviewContract(
      f.h,
      f.root,
      { title: 'Catalog API v1', file: relative },
      'codex',
      runtimes(),
    );
    assert.equal(byFile.status, 'approved');
    const inline = await reviewContract(
      f.h,
      f.root,
      { title: 'Shared decision', content: 'Общая архитектурная запись.' },
      'codex',
      runtimes(),
    );
    assert.equal(inline.status, 'approved');
  } finally {
    await repo.remove();
    f.cleanup();
  }
});

test('A contract file outside the repository is refused', async () => {
  const f = fixture();
  const repo = await repositoryFixture(f);
  try {
    // Побег через символическую ссылку: путь относительный и без «..», но
    // ведёт наружу. Проверяется разрешённый путь, а не написанный.
    await mkdir(join(repo.path, 'docs'), { recursive: true });
    await symlink('/etc/hosts', join(repo.path, 'docs/escape.md'));
    await assert.rejects(
      reviewContract(f.h, f.root, { title: 'Escape', file: 'docs/escape.md' }, 'codex', runtimes()),
      /внутри репозитория/,
    );
    await assert.rejects(
      reviewContract(f.h, f.root, { title: 'Ghost', file: 'docs/none.md' }, 'codex', runtimes()),
      /не найден/,
    );
    // Ни текста, ни файла — и то и другое сразу тоже не предложение.
    await assert.rejects(
      reviewContract(f.h, f.root, { title: 'Neither' }, 'codex', runtimes()),
      /file/,
    );
    assert.equal(f.store.read().contracts.length, 0);
  } finally {
    await repo.remove();
    f.cleanup();
  }
});

test('Operator mode reviews but does not register contracts or approve draft tasks', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Operator mode');
    f.h.addTask(b.id, input());
    assert.equal(
      (
        await reviewContract(
          f.h,
          f.root,
          { title: 'Contract', content: 'Concrete agreed interface' },
          'claude',
          runtimes(),
        )
      ).status,
      'awaiting-operator',
    );
    assert.equal(
      (await reviewPlan(f.h, f.root, b.id, 'claude', runtimes())).status,
      'awaiting-operator',
    );
    assert.equal(f.store.read().contracts.length, 0);
    assert.equal(f.store.read().tasks[0].status, 'draft');
  } finally {
    f.cleanup();
  }
});

test('Blocking findings reject even approved=true and do not enable execution', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const b = f.h.createBoard('Blocked plan');
    f.h.addTask(b.id, input());
    await assert.rejects(
      reviewPlan(f.h, f.root, b.id, 'codex', runtimes(undefined, true)),
      /отклонено/,
    );
    assert.equal(f.store.read().tasks[0].status, 'draft');
    await assert.rejects(
      reviewContract(
        f.h,
        f.root,
        { title: 'API', content: 'Ambiguous' },
        'codex',
        runtimes(undefined, true),
      ),
      /отклонено/,
    );
    assert.equal(f.store.read().contracts.length, 0);
    // Отклонённая попытка стоила вызова модели и остаётся в состоянии с
    // находками: иначе процесс виден только файлами на диске.
    const attempts = f.store.read().contractAttempts ?? [];
    assert.equal(attempts.length, 2, 'план и контракт считаются оба');
    const contract = attempts.find((a) => a.title === 'API')!;
    assert.equal(contract.approved, false);
    assert.equal(contract.attempt, 1);
    assert.equal(contract.subject, 'contract / architecture decision');
    assert.ok(contract.findings.some((finding) => finding.severity === 'blocking'));
    assert.ok(contract.artifact.length > 0);
    // Вторая попытка того же контракта нумеруется по порядку: по этому номеру
    // видно, сходится процесс или кружит на месте.
    await assert.rejects(
      reviewContract(
        f.h,
        f.root,
        { title: 'API', content: 'Ambiguous, second try' },
        'codex',
        runtimes(undefined, true),
      ),
      /отклонено/,
    );
    const again = (f.store.read().contractAttempts ?? []).filter((a) => a.title === 'API');
    assert.deepEqual(
      again.map((a) => a.attempt),
      [1, 2],
    );
  } finally {
    f.cleanup();
  }
});

test('Agent plan approval is bound to reviewed specifications and preserves contract requirements', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const b = f.h.createBoard('Changed plan');
    const task = f.h.addTask(b.id, input());
    await assert.rejects(
      reviewPlan(
        f.h,
        f.root,
        b.id,
        'codex',
        runtimes(() => {
          f.h.editTask(
            task.id,
            { ...input(), description: 'A different requirement after the review started.' },
            specDigest(task),
          );
        }),
      ),
      /изменился/,
    );
    assert.equal(f.store.read().tasks[0].status, 'draft');
    const result = await reviewPlan(f.h, f.root, b.id, 'codex', runtimes());
    assert.equal(result.status, 'approved');
    assert.equal(f.store.read().tasks[0].approval?.actor, 'agent');
    const second = f.h.createBoard('Missing API contract');
    f.h.addTask(second.id, { ...input(), role: 'backend' });
    await assert.rejects(reviewPlan(f.h, f.root, second.id, 'codex', runtimes()), /контракт/);
    assert.equal(f.store.read().tasks.at(-1)!.status, 'draft');
    const third = f.h.createBoard('Task added during review');
    f.h.addTask(third.id, input());
    await assert.rejects(
      reviewPlan(
        f.h,
        f.root,
        third.id,
        'codex',
        runtimes(() => {
          f.h.addTask(third.id, input('A late addition'));
        }),
      ),
      /изменился/,
    );
    assert.ok(
      f.store
        .read()
        .tasks.slice(-2)
        .every((t) => t.status === 'draft'),
    );
  } finally {
    f.cleanup();
  }
});

test('Agent cannot accept a board containing unverified work', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Unfinished work');
    f.h.addTask(b.id, input());
    await assert.rejects(acceptBoard(f.h, b.id, 'codex'), /done/);
    assert.equal(f.store.read().boards[0].revisions[0].status, 'active');
  } finally {
    f.cleanup();
  }
});

test('A runtime that emitted work spends the attempt; one that never started does not', async () => {
  // Классификация принадлежит адаптеру и читается из вывода самого runtime.
  // Отсутствие кандидата отказа не доказывает: агент мог править файлы и
  // упасть по таймауту, истратив прогон.
  const { cliAdapter } = await import('../src/runner/adapters.ts');
  const { BlockedError } = await import('../src/core/model.ts');
  const dir = await mkdtemp(join(tmpdir(), 'devcontour-runtime-'));
  const request = (script: string) => ({
    cwd: dir,
    artifactDir: dir,
    prompt: 'ignored',
    review: false,
    task: {} as never,
    signal: AbortSignal.timeout(20_000),
    timeoutMs: 20_000,
    execution: {
      // Только временный каталог: иначе отсутствующий фейковый runtime
      // находит настоящий claude в системе, и тест проверяет не то.
      env: { PATH: dir },
      redact: (v: string) => v,
    },
    script,
  });
  try {
    // Ненастоящий claude: сделал ход агента и упал — работа шла.
    await writeFile(
      join(dir, 'claude'),
      '#!/bin/sh\necho \'{"type":"assistant","message":{"content":[]}}\'\nexit 1\n',
      { mode: 0o755 },
    );
    await assert.rejects(
      cliAdapter('claude').execute(request('noisy')),
      (error: Error) => !(error instanceof BlockedError) && /кодом 1/.test(error.message),
    );

    // Тот же код выхода, но ходов не было: только system и result, как у
    // незалогиненного claude. Работа не начиналась.
    await writeFile(
      join(dir, 'claude'),
      '#!/bin/sh\necho \'{"type":"system","subtype":"init"}\'\n' +
        'echo \'{"type":"result","is_error":true,"result":"Not logged in"}\'\nexit 1\n',
      { mode: 0o755 },
    );
    await assert.rejects(
      cliAdapter('claude').execute(request('silent')),
      (error: Error) => error instanceof BlockedError,
    );

    // Нечего запускать — тоже отказ окружения, хотя приходит ошибкой запуска.
    await rm(join(dir, 'claude'));
    await assert.rejects(
      cliAdapter('claude').execute(request('missing')),
      (error: Error) => error instanceof BlockedError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Ревью плана читает ветку интеграции и видит статус внешней зависимости', async () => {
  const f = fixture();
  const repo = await repositoryFixture(f);
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo.path, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
        encoding: 'utf8',
      }).trim();
    git('init', '-q', '-b', 'main');
    await writeFile(join(repo.path, 'solve.ts'), 'notImplemented\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'main');
    git('checkout', '-q', '-b', 'devcontour/accepted');
    await writeFile(join(repo.path, 'solve.ts'), 'implemented\n');
    git('commit', '-qam', 'accepted');
    const accepted = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');

    const first = f.h.createBoard('Принятое ядро');
    const core = f.h.addTask(first.id, input('Ядро'));
    f.h.approve(first.id);
    complete(f.h, core.id);
    const b = f.h.createBoard('Следующая часть');
    f.h.addTask(b.id, input('Границы', [core.id]));

    let seen = '';
    let prompt = '';
    let cwd = '';
    await reviewPlan(
      f.h,
      f.root,
      b.id,
      'claude',
      runtimes((r) => {
        cwd = r.cwd;
        prompt = r.prompt;
        seen = readFileSync(join(r.cwd, 'solve.ts'), 'utf8');
      }),
    );
    // Ревьюер видит то, от чего ответвятся задачи, а не отставший checkout.
    assert.equal(seen, 'implemented\n');
    assert.match(prompt, new RegExp(`devcontour/accepted at ${accepted}`));
    assert.match(prompt, /"externalDependencies"/);
    assert.match(prompt, new RegExp(`"id": "${core.id}"[\\s\\S]*"status": "done"`));
    // Рабочая копия ревью удаляется, checkout человека не тронут.
    assert.equal(existsSync(cwd), false);
    assert.doesNotMatch(git('worktree', 'list'), /review-checkouts/);
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  } finally {
    await repo.remove();
    f.cleanup();
  }
});

test('Ревью плана выпускает только выбранные черновики, остальные ждут разбора', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const b = f.h.createBoard('Находки');
    const triaged = f.h.addTask(b.id, input('Разобранная'));
    const pending = f.h.addTask(b.id, input('Неразобранная'));
    const seen: string[] = [];
    const result = await reviewPlan(
      f.h,
      f.root,
      b.id,
      'claude',
      runtimes((r) => seen.push(r.prompt)),
      undefined,
      [triaged.id],
    );
    assert.equal(result.status, 'approved');
    const status = (id: string) => f.store.read().tasks.find((t) => t.id === id)!.status;
    assert.equal(status(triaged.id), 'ready');
    assert.equal(status(pending.id), 'draft');
    assert.ok(
      seen.every((p) => !p.includes('Неразобранная')),
      'в предложение не входит',
    );
    await assert.rejects(
      reviewPlan(f.h, f.root, b.id, 'claude', runtimes(), undefined, [triaged.id]),
      /Не черновики этой доски/,
    );
  } finally {
    f.cleanup();
  }
});

test('A contract pins its normative artifacts: a changed schema is a new contract that needs review', async () => {
  const f = fixture();
  const repo = await repositoryFixture(f);
  const sh = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
      cwd: repo.path,
    });
  try {
    sh('init', '-q', '-b', 'main');
    await mkdir(join(repo.path, 'docs/contracts'), { recursive: true });
    await writeFile(
      join(repo.path, 'docs/contracts/catalog.md'),
      '# Catalog\n\nSee schema.json.\n',
    );
    await writeFile(join(repo.path, 'schema.json'), '{"price":"string"}\n');
    sh('add', '.');
    sh('commit', '-qm', 'contract');
    const proposal = {
      title: 'Catalog API v1',
      file: 'docs/contracts/catalog.md',
      artifacts: [{ path: 'schema.json', purpose: 'Схема ответа' }],
    };
    const prompts: string[] = [];
    const count = () => runtimes((r) => prompts.push(r.prompt));

    const first = (await reviewContract(f.h, f.root, proposal, 'codex', count())) as {
      status: string;
      warning?: string;
    };
    assert.equal(first.status, 'approved');
    assert.equal(first.warning, undefined);
    const pinned = f.store.read().contracts[0];
    assert.equal(pinned.artifacts?.[0].path, 'schema.json');
    assert.match(pinned.artifacts?.[0].revision ?? '', /^[a-f0-9]{40}$/);
    assert.notEqual(pinned.digest, digest(pinned.content), 'digest охватывает артефакты');
    // Ревьюер видит закреплённое содержимое артефакта, а не только ссылку.
    assert.match(prompts[0], /\\"price\\":\\"string\\"/);

    // Тот же текст и та же схема — повтор без нового ревью.
    assert.equal(
      (await reviewContract(f.h, f.root, proposal, 'codex', count())).status,
      'already-approved',
    );
    assert.equal(prompts.length, 1);

    // Схема изменилась, документ прежний: раньше это отвечало «уже
    // утверждено» с прежним digest, и задачи шли по другому договору.
    await writeFile(join(repo.path, 'schema.json'), '{"price":"number"}\n');
    sh('commit', '-qam', 'schema');
    const second = await reviewContract(f.h, f.root, proposal, 'codex', count());
    assert.equal(second.status, 'approved');
    assert.equal(prompts.length, 2, 'изменённый артефакт прошёл ревью');
    const [c1, c2] = f.store.read().contracts;
    assert.notEqual(c1.digest, c2.digest);
    assert.equal(c1.content, c2.content);
    assert.equal(supersededBy(f.store.read().contracts, c1.id)?.id, c2.id);

    // Незакоммиченная правка не закрепляется: ревью видело бы то, чего нет
    // в истории.
    await writeFile(join(repo.path, 'schema.json'), '{"price":"boolean"}\n');
    await assert.rejects(reviewContract(f.h, f.root, proposal, 'codex', count()), /закоммитьте/);
    sh('checkout', '--', 'schema.json');
    const refuse = async (artifacts: { path: string; purpose: string }[], reason: RegExp) =>
      assert.rejects(
        reviewContract(f.h, f.root, { ...proposal, artifacts }, 'codex', count()),
        reason,
      );
    await symlink('/etc/hosts', join(repo.path, 'hosts.json'));
    await refuse([{ path: 'hosts.json', purpose: 'x' }], /symlink/);
    await writeFile(join(repo.path, 'untracked.json'), '{}');
    await refuse([{ path: 'untracked.json', purpose: 'x' }], /не в Git/);
    await refuse([{ path: 'none.json', purpose: 'x' }], /не найден/);
    await refuse(
      [
        { path: 'schema.json', purpose: 'x' },
        { path: 'schema.json', purpose: 'y' },
      ],
      /дважды/,
    );
    assert.equal(prompts.length, 2, 'отказы — до ревью');

    // Подмена во время ревью: ревьюер видел одну редакцию, в дереве другая.
    await writeFile(join(repo.path, 'schema.json'), '{"price":"decimal"}\n');
    sh('commit', '-qam', 'decimal');
    await assert.rejects(
      reviewContract(
        f.h,
        f.root,
        proposal,
        'codex',
        runtimes(() => {
          execFileSync('sh', ['-c', 'echo \'{"price":"int"}\' > schema.json'], { cwd: repo.path });
          sh('commit', '-qam', 'during review');
        }),
      ),
      /изменились во время ревью/,
    );
    assert.equal(f.store.read().contracts.length, 2);

    // Контракт без артефактов — прежний договор с видимым предупреждением.
    const legacy = (await reviewContract(
      f.h,
      f.root,
      { title: 'Legacy', content: 'Only text.' },
      'codex',
      count(),
    )) as { warning?: string; contract: { digest: string; artifacts?: unknown } };
    assert.match(legacy.warning ?? '', /только документ/);
    assert.equal(legacy.contract.artifacts, undefined);
    assert.equal(legacy.contract.digest, digest('Only text.'));
  } finally {
    await repo.remove();
    f.cleanup();
  }
});

test('A blocking feasibility finding returns the contract with its own reason and carries into the next round', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const prompts: string[] = [];
    let verdict: 'infeasible' | 'bounded' = 'infeasible';
    const make = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      execute(r) {
        prompts.push(r.prompt);
        return Promise.resolve({
          data:
            verdict === 'infeasible'
              ? {
                  approved: false,
                  summary: 'Exact optimum without input bounds',
                  findings: [
                    {
                      severity: 'blocking',
                      message: 'O-2: exact optimum for any n in O(n log n); no size bound',
                      rule: 'feasibility',
                    },
                  ],
                }
              : { approved: true, summary: 'Bounded', findings: [] },
          log: 'Fixture only; no provider called',
          command: ['fixture'],
        });
      },
    });
    const both = { codex: make('codex'), claude: make('claude') };
    const proposal = { title: 'Packing', content: 'O-2: return the optimal packing for any n.' };
    await assert.rejects(
      reviewContract(f.h, f.root, proposal, 'codex', both),
      /невыполнимы или неизмеримы.*O-2.*ограничения области входов/s,
    );
    // Ревьюер контракта получил чек-лист выполнимости.
    assert.match(prompts[0], /input domain and size limits/);
    assert.match(prompts[0], /Hardness alone is not infeasibility/);
    const attempt = f.store.read().contractAttempts!.at(-1)!;
    assert.equal(attempt.findings[0].rule, 'feasibility');

    // Следующий раунд видит прежнюю находку с её классом.
    verdict = 'bounded';
    const bounded = {
      ...proposal,
      content: 'O-2: optimal packing for n ≤ 20; beyond that, refuse.',
    };
    assert.equal((await reviewContract(f.h, f.root, bounded, 'codex', both)).status, 'approved');
    assert.match(prompts[1], /\[feasibility\] O-2/);
  } finally {
    f.cleanup();
  }
});

test('Contract impact names changes, affected and transitive tasks, base state and reviews without changing anything', async () => {
  const f = fixture();
  const repo = await repositoryFixture(f);
  const sh = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
      cwd: repo.path,
    });
  try {
    sh('init', '-q', '-b', 'main');
    await mkdir(join(repo.path, 'docs/contracts'), { recursive: true });
    await writeFile(
      join(repo.path, 'docs/contracts/catalog.md'),
      '# Catalog\n\nSee schema.json.\n',
    );
    await writeFile(join(repo.path, 'schema.json'), '{"price":"string"}\n');
    sh('add', '.');
    sh('commit', '-qm', 'contract');
    sh('branch', 'devcontour/accepted');
    const proposal = {
      title: 'Catalog API v1',
      file: 'docs/contracts/catalog.md',
      artifacts: [{ path: 'schema.json', purpose: 'Схема ответа' }],
    };
    await reviewContract(f.h, f.root, proposal, 'codex', runtimes());
    const contract = f.store.read().contracts[0];
    const board = f.h.createBoard('Catalog');
    const api = f.h.addTask(board.id, {
      ...input('API'),
      role: 'backend',
      contracts: [contract.id],
    });
    const screen = f.h.addTask(board.id, {
      ...input('Screen', [api.id]),
      role: 'frontend',
      contracts: [],
    });
    const report = f.h.addTask(board.id, { ...input('Report', [screen.id]) });
    const shipped = f.h.addTask(f.h.createBoard('Shipped').id, {
      ...input('Shipped API'),
      role: 'backend',
      contracts: [contract.id],
    });
    f.store.change('fixture.done', (s) => {
      s.tasks.find((t) => t.id === shipped.id)!.status = 'done';
    });

    // Неизменное предложение — ничего не затронуто.
    const same = await contractImpact(f.h, proposal);
    assert.equal(same.status, 'unchanged');
    assert.deepEqual(same.requiredReviews, []);

    await writeFile(join(repo.path, 'schema.json'), '{"price":"number"}\n');
    sh('commit', '-qam', 'schema');
    const events = f.store.eventCount();
    const impact = await contractImpact(f.h, proposal);
    assert.equal(impact.status, 'changed');
    assert.equal(impact.changes.document, false);
    assert.deepEqual(
      impact.changes.artifacts.map((a) => [a.path, a.change]),
      [['schema.json', 'changed']],
    );
    const direct = Object.fromEntries(impact.tasks.direct.map((t) => [t.id, t.action]));
    assert.deepEqual(direct, { [api.id]: 'rebind-after-review', [shipped.id]: 'correction' });
    // Потребители — транзитивно по зависимостям, а не только прямые.
    assert.deepEqual(
      impact.tasks.transitive.map((t) => t.id),
      [screen.id, report.id],
    );
    // База ещё не содержит новой редакции схемы.
    assert.deepEqual(impact.base.missing, ['schema.json']);
    assert.equal(impact.base.behind, 1);
    assert.deepEqual(
      impact.requiredReviews.map((r) => r.kind),
      ['contract', 'plan'],
    );
    // Отчёт только читает.
    assert.equal(f.store.eventCount(), events);
    assert.equal(f.store.read().contracts.length, 1);
    assert.equal(impact.applied, false);

    // Правка, скрытая от status через assume-unchanged, в отчёт не попадает:
    // документ читается из HEAD, а не из рабочего дерева.
    sh('update-index', '--assume-unchanged', 'docs/contracts/catalog.md');
    await writeFile(join(repo.path, 'docs/contracts/catalog.md'), '# Catalog hidden\n');
    const hidden = await contractImpact(f.h, proposal);
    assert.equal(hidden.changes.document, false, 'текст HEAD, а не рабочего файла');
    assert.equal(hidden.proposed.digest, impact.proposed.digest);
    sh('update-index', '--no-assume-unchanged', 'docs/contracts/catalog.md');
    await writeFile(join(repo.path, 'docs/contracts/catalog.md'), '# Catalog v2\n');
    await assert.rejects(contractImpact(f.h, proposal), /закоммитьте/);
    // Игнорируемый черновик «не изменён» для status, но его нет в HEAD.
    await writeFile(join(repo.path, '.gitignore'), 'draft.md\n');
    await writeFile(join(repo.path, 'draft.md'), '# Draft contract\n');
    await assert.rejects(
      contractImpact(f.h, { title: 'Draft', file: 'draft.md' }),
      /не закоммичен/,
    );
  } finally {
    await repo.remove();
    f.cleanup();
  }
});

test('An artifact digest covers its exact bytes: a whitespace-only change needs a new review', async () => {
  const f = fixture();
  const repo = await repositoryFixture(f);
  const sh = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
      cwd: repo.path,
    });
  try {
    sh('init', '-q', '-b', 'main');
    await writeFile(join(repo.path, 'schema.json'), '{"price":"number"}');
    sh('add', '.');
    sh('commit', '-qm', 'schema');
    const proposal = {
      title: 'Catalog',
      content: 'Ответ по schema.json.',
      artifacts: [{ path: 'schema.json', purpose: 'Схема' }],
    };
    let calls = 0;
    const count = () => runtimes(() => calls++);
    await reviewContract(f.h, f.root, proposal, 'codex', count());
    // Только конечный перевод строки: blob другой — и договор другой.
    await writeFile(join(repo.path, 'schema.json'), '{"price":"number"}\n\n');
    sh('commit', '-qam', 'trailing newline');
    const second = await reviewContract(f.h, f.root, proposal, 'codex', count());
    assert.equal(second.status, 'approved');
    assert.equal(calls, 2);
    const [c1, c2] = f.store.read().contracts;
    assert.notEqual(c1.artifacts![0].digest, c2.artifacts![0].digest);
    assert.equal(
      c2.artifacts![0].digest,
      createHash('sha256').update('{"price":"number"}\n\n').digest('hex'),
      'digest — по точным байтам blob',
    );
  } finally {
    await repo.remove();
    f.cleanup();
  }
});
