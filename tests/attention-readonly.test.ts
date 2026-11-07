import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscussionService } from '../src/application/discussion.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { repositorySchema } from '../src/core/model.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { serve } from '../src/server/http.ts';
import { AttentionService } from '../src/application/attention.ts';
import { adapters } from '../src/runner/adapters.ts';
import { AgentService } from '../src/application/agent.ts';
import { PreparationAgent } from '../src/application/preparation-agent.ts';
import { dumpDatabase, fileStamps, preparationFixture } from './attention-fixture.ts';
import { config, fixture, input } from './helpers.ts';

// D04-E: чтение центра внимания не пишет ни строк, ни событий, ни ревизии.

test('Запись источника внутри чтения падает и ничего не оставляет (структурная защита GET)', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', { changeId: f.changeId, add: [{ text: 'Вопрос?' }] });
    const path = join(f.root, 'state.sqlite');
    const before = dumpDatabase(path);
    const revision = f.store.revision();
    const writing = new AttentionService(f.store, undefined, {
      sources: [
        {
          id: 'prep-question',
          collect: (ctx) => {
            ctx.store.atomic(() => ctx.store.saveLocal('attention', undefined, 'leak', { v: 1 }));
            return [];
          },
        },
      ],
    });
    await assert.rejects(writing.active());
    assert.equal(f.store.revision(), revision);
    assert.equal(dumpDatabase(path), before);
    // Без записывающего источника чтение работает и тоже ничего не меняет.
    const view = await new AttentionService(f.store, undefined).active();
    assert.equal(view.items.length, 1);
    assert.equal(view.revision, revision);
    assert.equal(dumpDatabase(path), before);
  } finally {
    f.cleanup();
  }
});

test('После setup чтение во всех фазах (идёт, сбой, пауза, план оператора) не пишет и не зовёт модели', async () => {
  const f = fixture();
  const saved = { ...adapters };
  for (const name of Object.keys(adapters) as (keyof typeof adapters)[])
    adapters[name] = {
      ...saved[name],
      execute: () => {
        throw new Error('runtime adapter must not be called by a read');
      },
    };
  try {
    const path = join(f.root, 'state.sqlite');
    const pure = async (phase: string) => {
      const before = dumpDatabase(path);
      const revision = f.store.revision();
      const events = f.store.lastEventId();
      const stamps = fileStamps(f.root);
      const view = await new AttentionService(f.store, f.h).active();
      await new AttentionService(f.store, f.h).active({ actor: 'lead' });
      new AttentionService(f.store, f.h).history();
      assert.equal(dumpDatabase(path), before, phase);
      assert.equal(f.store.revision(), revision, phase);
      assert.equal(f.store.lastEventId(), events, phase);
      assert.deepEqual(fileStamps(f.root), stamps, phase);
      return view;
    };
    const b = f.h.createBoard('Board');
    const root = f.h.addTask(b.id, input('Root task'));
    f.h.addTask(b.id, input('Dependent task', [root.id]));
    f.h.approve(b.id);
    await pure('approved');
    f.h.pause(false);
    const run = f.h.claim('test')!;
    await pure('running');
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    assert.ok((await pure('failed')).items.some((i) => i.source === 'work'));
    f.h.pause(true);
    assert.ok((await pure('paused')).items.some((i) => i.source === 'queue'));
    f.h.config.approvalMode = 'operator';
    f.h.addTask(b.id, input('Draft task'));
    assert.ok((await pure('operator plan')).items.some((i) => i.source === 'plan'));
  } finally {
    Object.assign(adapters, saved);
    f.cleanup();
  }
});

test('attention_list: карточки ведущего без отметок оператора, до setup и после; чтение ничего не пишет', () => {
  const prep = preparationFixture();
  try {
    prep.p.execute('preparation_question', {
      changeId: prep.changeId,
      add: [{ text: 'Нужна ли история?' }],
    });
    const q = prep.store.read().preparation!.changes[0].questions[0];
    prep.p.answer({ changeId: prep.changeId, questionId: q.id, text: 'Да' });
    const before = dumpDatabase(join(prep.root, 'state.sqlite'));
    const result = new PreparationAgent(prep.store).execute({ operation: 'attention_list' });
    const items = result.items as Record<string, unknown>[];
    assert.equal(items.length, 1);
    assert.equal(items[0].source, 'prep-answer-pending');
    assert.equal(items[0].actor, 'lead');
    assert.equal('state' in items[0], false, 'отметки оператора — не данные ведущего');
    assert.equal(dumpDatabase(join(prep.root, 'state.sqlite')), before);
  } finally {
    prep.cleanup();
  }
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Root task'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    f.h.pause(true);
    const before = dumpDatabase(join(f.root, 'state.sqlite'));
    const agent = new AgentService(f.h);
    const lead = agent.execute({ operation: 'attention_list', input: {} });
    const operator = agent.execute({
      operation: 'attention_list',
      input: { actor: 'operator', limit: 1 },
    });
    assert.equal(dumpDatabase(join(f.root, 'state.sqlite')), before);
    assert.deepEqual(
      (lead.items as { sourceKey: string; actor: string }[]).map((i) => [i.sourceKey, i.actor]),
      [[`work:${t.id}`, 'lead']],
    );
    assert.deepEqual(
      (operator.items as { sourceKey: string }[]).map((i) => i.sourceKey),
      ['queue'],
    );
    assert.throws(
      () => agent.execute({ operation: 'attention_list', input: { limit: 51 } }),
      /limit/,
    );
  } finally {
    f.cleanup();
  }
});

test('Чистота чтения: обсуждение, бюджет, компонентное хранение и HTTP GET после setup', async () => {
  // Компонентное хранение: обращения и сбои в базах компонентов.
  const root = mkdtempSync(join(tmpdir(), 'devcontour-attention-component-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const repos = ['product', 'library'].map((id) => {
    const path = join(root, id);
    mkdirSync(path);
    return repositorySchema.parse({ id, name: id, path, gates: config().gates });
  });
  const store = new Store(join(workspace, 'state.sqlite'), repos);
  const sqlite = () => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name);
        if (name.isDirectory()) walk(path);
        else if (name.name.endsWith('.sqlite')) out.push(path);
      }
    };
    walk(root);
    return out.sort();
  };
  try {
    const h = new DevContour(
      store,
      config({ storage: 'component', workspaceRoot: workspace, repositories: repos }),
    );
    h.config.budgets = { workspace: { usd: 0.01 }, onUnknown: 'stop' };
    const tasks = repos.map((r) => {
      const board = h.createBoard(`Board of ${r.id}`, '', r.id);
      const id = h.addTask(board.id, { ...input(`Task of ${r.id}`), repositoryId: r.id }).id;
      h.approve(board.id);
      return id;
    });
    const discussion = new DiscussionService(h);
    discussion.post(
      {
        taskId: tasks[1],
        kind: 'change-request',
        text: 'Нужен ночной режим',
        idempotencyKey: 'attention-pure-1',
        expectedVersion: 0,
      },
      'operator',
    );
    store.atomic(() =>
      store.saveLocal('usage', undefined, 'U1', {
        id: 'U1',
        stage: 'implementation',
        runtime: 'codex',
        model: 'fixture-model',
        runtimeVersion: null,
        startedAt: new Date().toISOString(),
        outcome: 'returned',
        promptBytes: 1,
        promptDigest: 'd'.repeat(64),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 1,
          complete: true,
          source: 'fixture',
        },
        costUsd: 1,
        costSource: 'provider-reported',
      }),
    );
    const files = sqlite();
    assert.ok(files.length >= 2, 'компонентные базы созданы');
    const before = dumpDatabase(...files);
    const revision = store.revision();
    const view = await new AttentionService(store, h).active();
    new AttentionService(store, h).history();
    new AttentionService(store, h).agentList({});
    assert.equal(dumpDatabase(...files), before);
    assert.equal(store.revision(), revision);
    const sources = new Set(view.items.map((i) => i.source));
    assert.ok(sources.has('discussion-request'));
    assert.ok(sources.has('budget'));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }

  // HTTP GET после setup: работающий сервер, данные и журнал не меняются.
  const f = fixture();
  const scheduler = new Scheduler(f.h, f.root);
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('Root task'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    f.h.pause(true);
    const app = await serve(f.h, scheduler, { port: 0 });
    try {
      // Запуск сервера пишет свою роль; сравнивается установившееся состояние.
      await new Promise((r) => setTimeout(r, 300));
      const revision = f.store.revision();
      const events = f.store.lastEventId();
      const state = JSON.stringify(f.store.read().tasks);
      for (const query of ['', '?view=history', '?actor=lead']) {
        const response = await fetch(app.url + '/api/attention' + query);
        assert.equal(response.status, 200);
      }
      assert.equal(f.store.revision(), revision);
      assert.equal(f.store.lastEventId(), events);
      assert.equal(JSON.stringify(f.store.read().tasks), state);
    } finally {
      await app.close();
    }
  } finally {
    f.cleanup();
  }
});

test('attention_list укладывается в 64 KiB: длинный список режется с конца и назван в truncated', () => {
  const f = fixture();
  try {
    const long = 'Очень длинная причина карточки ведущего агента. '.repeat(10);
    const service = new AttentionService(f.store, f.h, {
      sources: [
        {
          id: 'board',
          collect: () =>
            Array.from({ length: 50 }, (_, i) => ({
              sourceKey: `board:B-${i}`,
              occurrenceId: 'o',
              sourceVersion: 'v',
              source: 'board' as const,
              category: 'technical' as const,
              actor: 'lead' as const,
              title: long,
              reason: long,
              since: new Date(0).toISOString(),
              subject: { kind: 'board' as const, id: `B-${i}`, href: '/' },
              covered: Array.from({ length: 20 }, (_, n) => `T-${i}-${n}-`.padEnd(80, 'x')),
            })),
        },
      ],
    });
    const result = service.agentList({ limit: 50 });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
    assert.ok(result.items.length > 0 && result.items.length < 50);
    assert.equal(result.truncated?.count, result.counts.active - result.items.length);
  } finally {
    f.cleanup();
  }
});
