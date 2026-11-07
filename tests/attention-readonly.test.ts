import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AttentionService } from '../src/application/attention.ts';
import { adapters } from '../src/runner/adapters.ts';
import { AgentService } from '../src/application/agent.ts';
import { PreparationAgent } from '../src/application/preparation-agent.ts';
import { dumpDatabase, fileStamps, preparationFixture } from './attention-fixture.ts';
import { fixture, input } from './helpers.ts';

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

test('attention_list: карточки ведущего без отметок оператора, до setup и после; чтение ничего не пишет', async () => {
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
