import { syncPreparation } from '../src/runner/git-sync.ts';
import { WorkspaceAgent } from '../src/application/preparation-agent.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Preparation, developmentBinding } from '../src/core/preparation.ts';
import { PreparationAgent } from '../src/application/preparation-agent.ts';
import { startWorkspace, preparationStore, requirePreparation } from '../src/runner/start.ts';
import { fixture, input, config } from './helpers.ts';
import {
  architecture,
  concept,
  design,
  product,
  references,
  approvePreparation,
  approveStage,
  approveProductOnly,
} from './preparation-fixture.ts';

// Re-approves the whole design track against whatever architecture is current.
function approveDesignTrack(
  p: Preparation,
  f: {
    store: {
      read: () => {
        preparation?: {
          changes: {
            references: { digest: string }[];
            concept: { digest: string }[];
            design: { digest: string }[];
          }[];
        };
      };
    };
  },
  id: string,
) {
  const at = (stage: 'references' | 'concept' | 'design') =>
    f.store.read().preparation!.changes[0][stage].at(-1)?.digest ?? null;
  p.execute('preparation_references', {
    changeId: id,
    expectedDigest: at('references'),
    reason: 'Референсы для текущей архитектуры',
    content: references,
  });
  approveStage(p, id, 'references');
  p.execute('preparation_concept', {
    changeId: id,
    expectedDigest: at('concept'),
    reason: 'Концепт для текущих референсов',
    content: concept,
  });
  approveStage(p, id, 'concept');
  p.execute('preparation_design', {
    changeId: id,
    expectedDigest: at('design'),
    reason: 'Дизайн-система для текущего концепта',
    content: design,
  });
  approveStage(p, id, 'design');
}
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { specDigest } from '../src/core/service.ts';

test('Product and architecture require distinct operator decisions; no agent or queue bypass', () => {
  const f = fixture(),
    p = new Preparation(f.store),
    agent = new PreparationAgent(f.store);
  try {
    assert.throws(() =>
      p.execute('preparation_architecture', {
        changeId: 'missing',
        expectedDigest: null,
        reason: 'Invalid early change',
        content: architecture,
      }),
    );
    assert.equal(f.store.read().preparation, undefined);
    p.enable();
    const b = f.h.createBoard('Разработка чата');
    assert.throws(() => f.h.addTask(b.id, input()), /изменение продукта/);
    p.execute('preparation_create', { title: 'Модерация чата' });
    const id = f.store.read().preparation!.activeChangeId!;
    assert.throws(
      () =>
        p.execute('preparation_architecture', {
          changeId: id,
          expectedDigest: null,
          reason: 'Architecture',
          content: architecture,
        }),
      /продуктовую/,
    );
    p.execute('preparation_product', {
      changeId: id,
      expectedDigest: null,
      reason: 'Initial brief',
      content: { ...product, questions: ['Нужно ли удалять сообщения?'] },
    });
    let digest = f.store.read().preparation!.changes[0].product.at(-1)!.digest;
    assert.throws(
      () =>
        p.execute('preparation_submit', { changeId: id, stage: 'product', expectedDigest: digest }),
      /вопросы/,
    );
    p.execute('preparation_product', {
      changeId: id,
      expectedDigest: digest,
      reason: 'Questions resolved',
      content: product,
    });
    digest = f.store.read().preparation!.changes[0].product.at(-1)!.digest;
    assert.throws(
      () =>
        p.decide({
          changeId: id,
          stage: 'product',
          expectedDigest: digest,
          decision: 'approve',
          comment: '',
        }),
      /не ожидает/,
    );
    approveStage(p, id, 'product');
    assert.throws(() => f.h.pause(false), /архитектуру/);
    assert.throws(() => f.h.addTask(b.id, input()), /архитектуру/);
    assert.throws(() =>
      agent.execute({ operation: 'preparation_decide', input: { approved: true } }),
    );
    p.execute('preparation_architecture', {
      changeId: id,
      expectedDigest: null,
      reason: 'Architecture chosen',
      content: architecture,
    });
    const archDigest = f.store.read().preparation!.changes[0].architecture.at(-1)!.digest;
    p.execute('preparation_submit', {
      changeId: id,
      stage: 'architecture',
      expectedDigest: archDigest,
    });
    p.decide({
      changeId: id,
      stage: 'architecture',
      expectedDigest: archDigest,
      decision: 'request-changes',
      comment: 'Добавить сравнение альтернатив',
    });
    assert.throws(() => f.h.pause(false), /архитектуру/);
    p.execute('preparation_architecture', {
      changeId: id,
      expectedDigest: archDigest,
      reason: 'Alternatives clarified',
      content: architecture,
    });
    approveStage(p, id, 'architecture');
    // Development also waits for the three design approvals.
    assert.throws(() => f.h.pause(false), /референсы/);
    assert.throws(() => f.h.addTask(b.id, input()), /референсы/);
    approveDesignTrack(p, f, id);
    const t = f.h.addTask(b.id, input());
    assert.equal(t.preparation?.changeId, id);
    f.h.approve(b.id);
    f.h.pause(false);
    const r = f.h.claim('worker')!;
    assert.equal(r.taskId, t.id);
    assert.throws(
      () =>
        p.execute('preparation_product', {
          changeId: id,
          expectedDigest: digest,
          reason: 'Late scope change',
          content: product,
        }),
      /дождитесь/,
    );
  } finally {
    f.cleanup();
  }
});

test('Revisions invalidate architecture and stale decisions, plans and task attempts', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const id = approvePreparation(p),
      before = f.store.read().preparation!.changes[0];
    const b = f.h.createBoard('План первой версии');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const original = specDigest(t);
    p.execute('preparation_product', {
      changeId: id,
      expectedDigest: before.product.at(-1)!.digest,
      reason: 'Изменились критерии',
      content: {
        ...product,
        features: [
          {
            ...product.features[0],
            acceptance: [{ releaseId: 'r1', text: 'Блокировка имеет срок действия.' }],
          },
          ...product.features.slice(1),
        ],
      },
    });
    assert.throws(
      () =>
        p.decide({
          changeId: id,
          stage: 'product',
          expectedDigest: before.product.at(-1)!.digest,
          decision: 'approve',
          comment: '',
        }),
      /Версия изменилась/,
    );
    assert.throws(
      () => new LeadWorkflow(f.h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' }),
      /продуктовую/,
    );
    approveStage(p, id, 'product');
    assert.throws(() => developmentBinding(f.store.read()), /архитектуру/);
    p.execute('preparation_architecture', {
      changeId: id,
      expectedDigest: before.architecture.at(-1)!.digest,
      reason: 'Новая постановка',
      content: architecture,
    });
    approveStage(p, id, 'architecture');
    // Development also waits for the three design approvals.
    assert.throws(() => f.h.pause(false), /референсы/);
    assert.throws(() => f.h.addTask(b.id, input()), /референсы/);
    approveDesignTrack(p, f, id);
    f.h.pause(false);
    assert.throws(() => f.h.claim('worker'), /не связана/);
    assert.equal(specDigest(f.store.read().tasks[0]), original);
    assert.equal(f.store.read().preparation!.changes[0].product[0].status, 'approved');
  } finally {
    f.cleanup();
  }
});

test('C1/C2 validation blocks incomplete and contradictory architecture', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const id = approvePreparation(p);
    const invalids = [
      { ...architecture, c2: undefined },
      { ...architecture, c2: { ...architecture.c2!, systemId: 'other' } },
      {
        ...architecture,
        c1: {
          ...architecture.c1!,
          relationships: [
            { from: 'missing', to: 'chat', description: 'Missing endpoint', technology: '' },
          ],
        },
      },
      {
        ...architecture,
        c2: {
          ...architecture.c2!,
          nodes: architecture.c2!.nodes.map((n) =>
            n.kind === 'container' ? { ...n, technology: '' } : n,
          ),
        },
      },
    ];
    for (const content of invalids) {
      const expectedDigest = f.store.read().preparation!.changes[0].architecture.at(-1)!.digest;
      p.execute('preparation_architecture', {
        changeId: id,
        expectedDigest,
        reason: 'Invalid diagram fixture',
        content,
      });
      const digest = f.store.read().preparation!.changes[0].architecture.at(-1)!.digest;
      assert.throws(() =>
        p.execute('preparation_submit', {
          changeId: id,
          stage: 'architecture',
          expectedDigest: digest,
        }),
      );
      assert.equal(f.store.read().preparation!.changes[0].architecture.at(-1)!.status, 'draft');
    }
  } finally {
    f.cleanup();
  }
});

test('Empty workspace serves immediately, survives restart and attaches real Git configuration at the same URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-start-')),
    workspace = join(root, 'workspace');
  let app = await startWorkspace(workspace, { port: 0, workspaceMode: 'separate' });
  const headers = { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' };
  const post = (path: string, body: unknown, origin?: string) =>
    fetch(app.url + path, {
      method: 'POST',
      headers: { ...headers, ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(app.url + '/')).status, 200);
    assert.equal((await fetch(app.url + '/api/state')).status, 409);
    assert.equal(existsSync(join(workspace, '.devcontour-local/config.json')), false);
    assert.throws(
      () => requirePreparation(join(workspace, '.devcontour-local')),
      /изменение продукта/,
    );
    assert.equal(
      (await post('/api/preparation/decision', {}, 'https://other.example')).status,
      403,
    );
    assert.equal(
      (await post('/api/agent', { operation: 'queue_set', input: { paused: false } })).status,
      409,
    );
    const store = preparationStore(join(workspace, '.devcontour-local'));
    approvePreparation(new Preparation(store));
    store.close();
    await app.close();
    app = await startWorkspace(workspace, { port: 0, workspaceMode: 'separate' });
    const early = await (await fetch(app.url + '/api/preparation')).json();
    assert.equal(early.developmentReady, true);
    assert.equal(early.engineConnected, false);
    const repo = join(root, 'product');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        },
      });
    git('init', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'Product fixture');
    git('add', '.');
    git('commit', '-m', 'initial');
    const cfg = config({
      repository: repo,
      workspaceRoot: realpathSync(workspace),
      targetBranch: 'devcontour/integration',
      storage: 'component',
    });
    writeFileSync(join(workspace, '.devcontour-local/config.json'), JSON.stringify(cfg));
    const deadline = Date.now() + 20000;
    let connected = false;
    while (Date.now() < deadline) {
      const state = await (await fetch(app.url + '/api/preparation')).json();
      if (state.startupError) throw new Error(state.startupError);
      if (state.engineConnected) {
        connected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(connected, true);
    assert.equal((await fetch(app.url + '/api/state')).status, 200);
    assert.equal(
      new WorkspaceAgent(join(workspace, '.devcontour-local')).execute({
        operation: 'preparation_status',
      }).enabled,
      true,
    );
    assert.equal(
      (
        await post('/api/agent', {
          operation: 'board_create',
          input: { title: 'Реальная разработка' },
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await fetch(app.url + '/api/preparation')).json()).current.product.status,
      'approved',
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Before stack selection, preparation sync uses real Git clones and rejects concurrent edits without partial import', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-preparation-sync-'));
  const aPath = join(root, 'a'),
    bPath = join(root, 'b');
  mkdirSync(aPath);
  const git = (path: string, ...args: string[]) =>
    execFileSync('git', ['-C', path, ...args], {
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
  git(aPath, 'init', '-b', 'main');
  writeFileSync(join(aPath, '.gitignore'), '.devcontour-local/\n');
  git(aPath, 'add', '.');
  git(aPath, 'commit', '-m', 'initial');
  const a = preparationStore(join(aPath, '.devcontour-local'));
  let b: ReturnType<typeof preparationStore> | undefined;
  try {
    const p = new Preparation(a);
    approvePreparation(p);
    syncPreparation(a, aPath, 'alice');
    git(aPath, 'add', '.devcontour');
    git(aPath, 'commit', '-m', 'product approved');
    git(root, 'clone', '--no-local', aPath, bPath);
    b = preparationStore(join(bPath, '.devcontour-local'));
    new Preparation(b).enable();
    syncPreparation(b, bPath, 'bob');
    assert.equal(developmentBinding(b.read())?.changeId, developmentBinding(a.read())?.changeId);
    new Preparation(b).execute('preparation_create', { title: 'Local new change' });
    p.execute('preparation_create', { title: 'Peer new change' });
    syncPreparation(a, aPath, 'alice');
    git(aPath, 'add', '.devcontour');
    git(aPath, 'commit', '-m', 'new change');
    git(bPath, 'pull', '--ff-only');
    const before = JSON.stringify(b.read());
    assert.throws(() => syncPreparation(b!, bPath, 'bob'), /Конфликт/i);
    assert.equal(JSON.stringify(b.read()), before);
  } finally {
    a.close();
    b?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Agent progress, operator answers and recorded decisions are durable and gate submission', () => {
  const f = fixture(),
    p = new Preparation(f.store),
    agent = new PreparationAgent(f.store);
  try {
    p.execute('preparation_create', { title: 'Модерация чата' });
    const id = f.store.read().preparation!.activeChangeId!;

    // Progress is visible before any revision exists.
    agent.execute({
      operation: 'preparation_progress',
      input: { changeId: id, note: 'Читаю ТЗ: разделы 1–7' },
    });
    let view = p.status(id);
    assert.equal(view.enabled && view.agentActivity?.note, 'Читаю ТЗ: разделы 1–7');
    assert.equal(view.enabled && view.current!.activity.length, 1);

    agent.execute({
      operation: 'preparation_question',
      input: {
        changeId: id,
        add: [{ text: 'Какой первичный рынок?', why: 'Влияет на GDPR', options: ['ЕС', 'РФ'] }],
      },
    });
    view = p.status(id);
    assert.ok(view.enabled);
    const question = view.current!.questions[0];
    assert.equal(question.status, 'open');
    assert.equal(view.enabled && view.changes[0].open, 1);

    // A recorded decision cannot close a question the operator has not answered.
    assert.throws(
      () =>
        agent.execute({
          operation: 'preparation_resolve',
          input: {
            changeId: id,
            questionId: question.id,
            statement: 'Берём ЕС',
            rationale: 'Так решил агент',
          },
        }),
      /дождитесь ответа/,
    );
    // The agent cannot answer on the operator's behalf.
    assert.throws(() =>
      agent.execute({
        operation: 'preparation_answer',
        input: { changeId: id, questionId: question.id, text: 'ЕС' },
      }),
    );

    p.execute('preparation_product', {
      changeId: id,
      expectedDigest: null,
      reason: 'Initial brief',
      content: product,
    });
    const digest = f.store.read().preparation!.changes[0].product.at(-1)!.digest;
    assert.throws(
      () =>
        p.execute('preparation_submit', { changeId: id, stage: 'product', expectedDigest: digest }),
      /открытые вопросы/,
    );

    p.answer({ changeId: id, questionId: question.id, text: 'ЕС, хостинг во Франкфурте' });
    view = p.status(id);
    assert.equal(
      view.enabled && view.current!.questions[0].answer?.text,
      'ЕС, хостинг во Франкфурте',
    );
    assert.throws(
      () => p.answer({ changeId: id, questionId: question.id, text: 'Передумал' }),
      /уже закрыт/,
    );
    assert.throws(() =>
      agent.execute({
        operation: 'preparation_question',
        input: { changeId: id, withdraw: [question.id] },
      }),
    );

    agent.execute({
      operation: 'preparation_resolve',
      input: {
        changeId: id,
        questionId: question.id,
        statement: 'Первичный рынок — ЕС',
        rationale: 'Ответ пользователя: хостинг во Франкфурте',
      },
    });
    view = p.status(id);
    assert.equal(view.enabled && view.current!.decisions[0].questionId, question.id);
    p.execute('preparation_submit', { changeId: id, stage: 'product', expectedDigest: digest });
    assert.equal(p.status(id).enabled && p.status(id).current!.product!.status, 'in-review');

    // A decision that no longer holds is struck out, not erased, and the
    // strike-out itself cannot be taken back or rewritten afterwards.
    const journal = () => {
      const s = p.status(id);
      assert.ok(s.enabled);
      return s.current!.decisions;
    };
    const decision = journal()[0];
    agent.execute({
      operation: 'preparation_resolve',
      input: {
        changeId: id,
        withdraw: [{ id: decision.id, reason: 'Рынок пересмотрен после ответа пользователя' }],
      },
    });
    const struck = journal();
    assert.equal(struck.length, 1);
    assert.equal(struck[0].statement, 'Первичный рынок — ЕС');
    assert.equal(struck[0].withdrawn!.reason, 'Рынок пересмотрен после ответа пользователя');
    assert.throws(
      () =>
        agent.execute({
          operation: 'preparation_resolve',
          input: { changeId: id, withdraw: [{ id: decision.id, reason: 'Ещё раз' }] },
        }),
      /уже отозвано/,
    );
    // Withdrawing needs either a decision to record or decisions to strike.
    assert.throws(
      () => agent.execute({ operation: 'preparation_resolve', input: { changeId: id } }),
      /решение и обоснование/,
    );

    // The journal survives a reopened store and stays immutable.
    const saved = f.store.read().preparation!.changes[0];
    assert.equal(saved.decisions.length, 1);
    assert.ok(saved.decisions[0].withdrawn);
    assert.equal(saved.questions[0].answer!.text, 'ЕС, хостинг во Франкфурте');
  } finally {
    f.cleanup();
  }
});

test('Releases carry ordered SemVer versions; personas are optional but must resolve', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    p.execute('preparation_create', { title: 'Модерация чата' });
    const id = f.store.read().preparation!.activeChangeId!;
    const save = (content: unknown, expected: string | null = null) =>
      p.execute('preparation_product', {
        changeId: id,
        expectedDigest: expected,
        reason: 'Проверка правил релизов и персон',
        content,
      });
    const submit = () => {
      const digest = f.store.read().preparation!.changes[0].product.at(-1)!.digest;
      p.execute('preparation_submit', { changeId: id, stage: 'product', expectedDigest: digest });
      return digest;
    };

    // A release list that does not ascend is rejected on submission.
    save({
      ...product,
      releases: [
        { ...product.releases[0], version: '0.2.0' },
        { ...product.releases[1], version: '0.1.0' },
      ],
    });
    assert.throws(submit, /возрастать по SemVer/);
    let digest = f.store.read().preparation!.changes[0].product.at(-1)!.digest;

    // A prerelease sorts below the release that follows it.
    save(
      {
        ...product,
        releases: [
          { ...product.releases[0], version: '1.0.0-beta.1' },
          { ...product.releases[1], version: '1.0.0' },
        ],
      },
      digest,
    );
    digest = submit();

    // Personas may be omitted entirely.
    save(
      {
        ...product,
        personas: [],
        features: product.features.map((feature) => ({
          ...feature,
          scenarios: feature.scenarios.map(({ text }) => ({ text })),
        })),
      },
      digest,
    );
    digest = submit();
    assert.equal(f.store.read().preparation!.changes[0].product.at(-1)!.content.personas.length, 0);

    // A scenario may not point at a persona that is not described.
    save(
      {
        ...product,
        personas: [],
        features: product.features.map((feature) => ({
          ...feature,
          scenarios: feature.scenarios.map(({ text }) => ({ personaId: 'ghost', text })),
        })),
      },
      digest,
    );
    assert.throws(submit, /несуществующую персону/);
  } finally {
    f.cleanup();
  }
});

test('Each change owns a folder in docs/changes, keyed and indexed', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-projection-'));
  const store = preparationStore(join(root, '.devcontour-local'));
  try {
    const p = new Preparation(store);
    p.execute('preparation_create', { title: 'Модерация чата' });
    const change = store.read().preparation!.changes[0];
    const id = change.id;

    // The key is readable and ordered; the UUID stays internal.
    assert.equal(change.key, 'r-001.moderatsiya-chata');
    const directory = join(root, 'docs', 'changes', change.key);

    p.execute('preparation_product', {
      changeId: id,
      expectedDigest: null,
      reason: 'Первичная постановка',
      content: product,
    });
    assert.equal(store.projectionError, undefined);

    const brief = readFileSync(join(directory, 'brief.md'), 'utf8');
    assert.match(brief, /поручение/);
    const markdown = readFileSync(join(directory, 'product.md'), 'utf8');
    assert.match(markdown, /Версия 1 · черновик агента/);
    assert.match(markdown, new RegExp(product.features[0].title));
    assert.match(markdown, new RegExp(product.releases[0].version));
    assert.match(readFileSync(join(directory, 'architecture.md'), 'utf8'), /после утверждения/);
    assert.match(readFileSync(join(directory, 'journal.md'), 'utf8'), /Принятые решения/);
    assert.match(
      readFileSync(join(root, 'docs', 'changes', 'README.md'), 'utf8'),
      /r-001\.moderatsiya-chata/,
    );

    // The JSON projection carries the durable record, not runtime telemetry.
    const saved = JSON.parse(readFileSync(join(directory, 'change.json'), 'utf8'));
    assert.equal(saved.product[0].content.features.length, product.features.length);
    assert.equal('activity' in saved, false);

    // brief.md belongs to the operator and is never overwritten.
    writeFileSync(join(directory, 'brief.md'), 'Моё поручение своими словами.\n');
    // A progress note must not touch the projected files at all.
    const stamp = statSync(join(directory, 'change.json')).mtimeMs;
    p.execute('preparation_progress', { changeId: id, note: 'Изучаю ограничения' });
    assert.equal(statSync(join(directory, 'change.json')).mtimeMs, stamp);

    // Before the operator decides, the projection shows the version awaiting them.
    const digest = store.read().preparation!.changes[0].product.at(-1)!.digest;
    p.execute('preparation_submit', { changeId: id, stage: 'product', expectedDigest: digest });
    assert.match(
      readFileSync(join(directory, 'product.md'), 'utf8'),
      /Версия 1 · ожидает решения пользователя/,
    );

    // And after they decide, the decision and its comment are in the file.
    p.decide({
      changeId: id,
      stage: 'product',
      expectedDigest: digest,
      decision: 'approve',
      comment: 'Границы релизов понятны',
    });
    const decided = readFileSync(join(directory, 'product.md'), 'utf8');
    assert.match(decided, /Версия 1 · утверждено/);
    assert.match(decided, /Решение пользователя .*Границы релизов понятны/);
    assert.equal(
      readFileSync(join(directory, 'brief.md'), 'utf8'),
      'Моё поручение своими словами.\n',
    );

    // A second change gets the next number and its own folder.
    p.execute('preparation_create', { title: 'Экспорт отчётов', slug: 'reports-export' });
    const second = store.read().preparation!.changes[1];
    assert.equal(second.key, 'r-002.reports-export');
    assert.ok(existsSync(join(root, 'docs', 'changes', second.key, 'product.md')));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('C3 is optional, scoped to a real container and consistent with C2', () => {
  const f = fixture(),
    p = new Preparation(f.store);
  try {
    const id = approveProductOnly(p);
    const container = architecture.c2!.nodes.find((n) => n.kind === 'container')!;
    const component = {
      id: 'load-engine',
      name: 'Модуль расчёта',
      kind: 'component' as const,
      description: 'Считает достижимые веса без зависимостей от UI и хранилища.',
      technology: 'TypeScript',
    };
    const save = (c3: unknown, expected: string | null) =>
      p.execute('preparation_architecture', {
        changeId: id,
        expectedDigest: expected,
        reason: 'Проверка правил C3',
        content: { ...architecture, c3 },
      });
    const submit = () => {
      const digest = f.store.read().preparation!.changes[0].architecture.at(-1)!.digest;
      p.execute('preparation_submit', {
        changeId: id,
        stage: 'architecture',
        expectedDigest: digest,
      });
      return digest;
    };

    // Omitting C3 entirely stays valid: the level is optional.
    save([], null);
    let digest = submit();

    // A diagram must name a container that exists on C2.
    save(
      [
        {
          containerId: 'ghost-container',
          nodes: [component, { ...container }],
          relationships: [{ from: component.id, to: container.id, description: 'Использует' }],
        },
      ],
      digest,
    );
    assert.throws(submit, /контейнер вне C2/);
    digest = f.store.read().preparation!.changes[0].architecture.at(-1)!.digest;

    // A neighbour drawn on C3 must be the same element as on C2.
    save(
      [
        {
          containerId: container.id,
          nodes: [component, { ...container, name: 'Переименованный' }],
          relationships: [{ from: component.id, to: container.id, description: 'Использует' }],
        },
      ],
      digest,
    );
    assert.throws(submit, /должны совпадать с C2/);
    digest = f.store.read().preparation!.changes[0].architecture.at(-1)!.digest;

    // A consistent diagram passes and reaches the operator.
    save(
      [
        {
          containerId: container.id,
          nodes: [component, { ...container }],
          relationships: [{ from: component.id, to: container.id, description: 'Использует' }],
        },
      ],
      digest,
    );
    submit();
    const saved = f.store.read().preparation!.changes[0].architecture.at(-1)!;
    assert.equal(saved.status, 'in-review');
    assert.equal(saved.content.c3.length, 1);
  } finally {
    f.cleanup();
  }
});
