// Присутствие ведущего агента: его обращения к агентскому API и пакет
// session-handoff — тоже его действия, даже если они только читают.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../src/application/agent.ts';
import { AttentionService } from '../src/application/attention.ts';
import { PreparationAgent } from '../src/application/preparation-agent.ts';
import { leadPresence } from '../src/application/quick-view.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import {
  LEAD_ACTIVITY_FILE,
  LEAD_MARK_SKEW_MS,
  leadActivityMark,
  markLeadActivity,
} from '../src/runner/lead-activity.ts';
import { LEAD_QUIET_MS } from '../src/runner/quick.ts';
import { command } from '../src/runner/process.ts';
import { preparationFixture } from './attention-fixture.ts';
import { config, fixture } from './helpers.ts';

const minutes = (n: number) => n * 60_000;

test('Отметка обращений ведущего: запись рядом с базой, испорченная или отсутствующая — нет отметки', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lead-mark-')));
  try {
    const store = { file: join(root, 'state.sqlite') };
    assert.equal(leadActivityMark(store), null);
    markLeadActivity(store, 'agent', 'project_context', new Date('2026-11-08T10:00:00.000Z'));
    assert.equal(leadActivityMark(store), '2026-11-08T10:00:00.000Z');
    writeFileSync(join(root, LEAD_ACTIVITY_FILE), '{"at":"не время"}');
    assert.equal(leadActivityMark(store), null);
    writeFileSync(join(root, LEAD_ACTIVITY_FILE), 'не JSON');
    assert.equal(leadActivityMark(store), null);
    // База в памяти: отметке негде жить, запись — без ошибки.
    markLeadActivity({ file: ':memory:' }, 'agent');
    assert.equal(leadActivityMark({ file: ':memory:' }), null);
    // Отметка из будущего дальше допустимого расхождения часов не учитывается.
    const now = Date.parse('2026-11-08T10:00:00.000Z');
    markLeadActivity(store, 'agent', 'x', new Date(now + LEAD_MARK_SKEW_MS - 1000));
    assert.ok(leadActivityMark(store, now), 'в пределах расхождения часов');
    markLeadActivity(store, 'agent', 'x', new Date(now + LEAD_MARK_SKEW_MS + 1000));
    assert.equal(leadActivityMark(store, now), null);
    markLeadActivity(store, 'agent', 'x', new Date('2099-01-01T00:00:00.000Z'));
    assert.equal(leadActivityMark(store), null);
    // Запись не удалась (на месте отметки — непустой каталог): временный файл не остаётся.
    rmSync(join(root, LEAD_ACTIVITY_FILE));
    mkdirSync(join(root, LEAD_ACTIVITY_FILE, 'blocker'), { recursive: true });
    markLeadActivity(store, 'agent', 'x');
    assert.deepEqual(
      readdirSync(root).filter((n) => n.startsWith(LEAD_ACTIVITY_FILE)),
      [LEAD_ACTIVITY_FILE],
    );
    // Каталога нет: запись по возможности, операция не падает.
    markLeadActivity({ file: join(root, 'missing', 'state.sqlite') }, 'agent');
    assert.equal(existsSync(join(root, 'missing')), false);
  } finally {
    assert.ok(root.includes('dc-lead-mark-'));
    rmSync(root, { recursive: true, force: true });
  }
});

test('leadPresence: свежая отметка обращения держит ведущего на связи при давних записях изменения', () => {
  const change = {
    id: 'PC-1',
    key: 'r-001.x',
    title: 'Изменение',
    createdAt: '2026-11-08T09:00:00.000Z',
    product: [],
    architecture: [],
    references: [],
    concept: [],
    design: [],
    activity: [{ at: '2026-11-08T09:00:00.000Z', stage: 'product' as const, note: 'Начал' }],
    questions: [],
    decisions: [],
  };
  const now = Date.parse('2026-11-08T10:00:00.000Z');
  assert.equal(leadPresence(change, [], now).present, false, 'журнал изменения час назад');
  const recent = new Date(now - minutes(2)).toISOString();
  assert.deepEqual(leadPresence(change, [], now, recent), {
    lastActivityAt: recent,
    present: true,
  });
  // Отметка старше порога тишины — по-прежнему не на связи.
  const stale = new Date(now - LEAD_QUIET_MS - 1000).toISOString();
  assert.equal(leadPresence(change, [], now, stale).present, false);
  // Без активного изменения — по одной отметке.
  assert.equal(leadPresence(undefined, [], now, recent).present, true);
  assert.deepEqual(leadPresence(undefined, [], now), { present: false, lastActivityAt: null });
});

test('Центр внимания: ведущий на связи после обращения через агентский API до setup, хотя изменение давно не менялось', () => {
  const f = preparationFixture();
  try {
    const later = Date.now() + minutes(60);
    const view = (now: number) =>
      new AttentionService(f.store, undefined, { now: () => now }).view({}, new Map());
    assert.equal(view(later).lead.present, false, 'записи изменения старше порога');
    // Ведущий читает центр внимания через агентский API — это его обращение.
    new PreparationAgent(f.store).execute({ operation: 'attention_list' });
    const mark = leadActivityMark(f.store);
    assert.ok(mark && Math.abs(Date.parse(mark) - Date.now()) < minutes(1), String(mark));
    assert.equal(view(Date.parse(mark) + minutes(5)).lead.present, true);
    assert.equal(view(Date.parse(mark) + minutes(5)).lead.lastActivityAt, mark);
  } finally {
    f.cleanup();
  }
});

test('AgentService: операции только для чтения (execute и run) отмечают обращение ведущего; база не меняется', async () => {
  const f = fixture();
  try {
    const agent = new AgentService(f.h, f.root);
    assert.equal(leadActivityMark(f.store), null);
    const revision = f.store.revision();
    agent.execute({ operation: 'attention_list', input: {} });
    const first = leadActivityMark(f.store);
    assert.ok(first);
    assert.equal(f.store.revision(), revision, 'отметка — не запись состояния');
    markLeadActivity(f.store, 'agent', 'old', new Date('2026-01-01T00:00:00.000Z'));
    await agent.run({ operation: 'project_context', input: {} });
    const second = leadActivityMark(f.store);
    assert.ok(second && second > '2026-01-01T00:00:00.000Z', String(second));
    assert.equal(f.store.revision(), revision);
    // Отказ схемы — не обращение с операцией: отметку ставит только разобранный запрос.
    markLeadActivity(f.store, 'agent', 'old', new Date('2026-01-01T00:00:00.000Z'));
    assert.throws(() => agent.execute({ operation: 'no_such_operation' }));
    assert.equal(leadActivityMark(f.store), '2026-01-01T00:00:00.000Z');
  } finally {
    f.cleanup();
  }
});

test('CLI session-handoff отмечает обращение ведущего; база по-прежнему только читается', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lead-handoff-')));
  const data = join(root, 'data');
  try {
    mkdirSync(data);
    const c = config();
    writeFileSync(join(data, 'config.json'), JSON.stringify(c));
    const h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    try {
      h.createBoard('Board', '', 'main');
    } finally {
      h.store.close();
    }
    const store = { file: join(data, 'state.sqlite') };
    const cli = () =>
      command(
        ['node', '--import', 'tsx', 'src/cli.ts', 'session-handoff', '--data', data],
        process.cwd(),
      );
    assert.equal(leadActivityMark(store), null);
    // Байты базы и файлов её журнала до и после пакета.
    const database = () =>
      readdirSync(data)
        .filter((n) => n.startsWith('state.sqlite'))
        .sort()
        .map((n) => [
          n,
          createHash('sha256')
            .update(readFileSync(join(data, n)))
            .digest('hex'),
        ]);
    const before = database();
    const done = await cli();
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(database(), before, 'база только читается');
    const mark = leadActivityMark(store);
    assert.ok(mark && Math.abs(Date.parse(mark) - Date.now()) < minutes(2), String(mark));
  } finally {
    assert.ok(root.includes('dc-lead-handoff-'));
    rmSync(root, { recursive: true, force: true });
  }
});
