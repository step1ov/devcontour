import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { digestOf } from 'devcontour-harness';
import type { Config } from '../src/core/model.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { repositories } from '../src/core/repositories.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';
import { dataDoctor, newStateCheck } from '../src/runner/doctor.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { InputService, inputHolds } from '../src/application/input.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { AgentService } from '../src/application/agent.ts';
import { loadConfig } from '../src/runner/config.ts';
import { sharedCheckoutRoot } from './helpers.ts';

// База версии с обсуждениями задач, но до вопросов исполнителя
// (tests/fixtures/legacy-discussion/generate.ts, DevContour 0.4.0-alpha.17 с
// движком 0.1.0-alpha.36). Новый код читает её копии на том же пути, без
// setup, миграции и записи; вопросов исполнителя в ней нет и не появляется.
// Путь копии — канонический для платформы (как у tests/harness-legacy.test.ts):
// `legacy-discussion` записан на Linux по `/tmp/…`, `legacy-discussion-darwin`
// — на macOS по `/private/tmp/…`.
const canonicalPath = (path: string) => {
  try {
    return realpathSync(dirname(path)) === dirname(path);
  } catch {
    return false;
  }
};
const variant = ['legacy-discussion', 'legacy-discussion-darwin']
  .map((name) => fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url)))
  .map((dir) => ({ dir, root: readFileSync(join(dir, 'ROOT'), 'utf8').trim() }))
  .find((v) => canonicalPath(v.root));
if (!variant) throw new Error('Нет варианта legacy-discussion с каноническим путём на этой машине');
const fixtures = variant.dir;
const ROOT = variant.root;
const MARK = join(ROOT, '.devcontour-legacy-test');

/** Содержимое всех таблиц базы, кроме счётчика ревизий. */
function dump(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  const out = Object.fromEntries(
    tables
      .filter((t) => t !== 'revision')
      .map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]),
  );
  db.close();
  return JSON.stringify(out);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Удалить копию: только каталог с меткой этого теста. */
function release() {
  if (existsSync(MARK)) rmSync(ROOT, { recursive: true, force: true });
}

/** Занять путь копии; копия умершего процесса узнаётся по метке, чужой каталог не трогается. */
async function acquire() {
  for (let i = 0; ; i++) {
    try {
      mkdirSync(ROOT);
      writeFileSync(MARK, String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (existsSync(MARK) && !alive(Number(readFileSync(MARK, 'utf8')))) {
        release();
        continue;
      }
      if (!existsSync(MARK) && i > 50) throw new Error(`${ROOT} занят каталогом без метки теста`);
      if (i > 1200) throw new Error(`${ROOT} занят другим процессом тестов`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

type Kind = 'central' | 'component';
interface Expected {
  source: { devcontour: string; harness: string; commit: string };
  tasks: Record<string, { id: string; status: string; spec: string; approvedPolicy: string }>;
  planPolicy: string;
  runs: { accepted: string; unfinished: string; continued: string };
  usage: string[];
  discussion: Record<string, string[]>;
  openRequests: string[];
}

function copy(kind: Kind) {
  const root = join(ROOT, kind);
  cpSync(join(fixtures, kind), root, { recursive: true });
  mkdirSync(join(root, 'app'), { recursive: true });
  renameSync(join(root, 'app.git'), join(root, 'app', '.git'));
  execFileSync('git', ['reset', '-q', '--hard'], { cwd: join(root, 'app') });
  const data = kind === 'central' ? root : join(root, 'coordinator');
  const files =
    kind === 'central'
      ? [join(root, 'state.sqlite')]
      : [join(data, 'state.sqlite'), join(root, 'app', '.devcontour-local', 'state.sqlite')];
  const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8')) as Expected;
  return { kind, root, data, app: join(root, 'app'), files, expected };
}
type Copy = ReturnType<typeof copy>;

function configOf(c: Copy): Config {
  // Рабочие деревья — не в кэше пользователя: корень дописывается в файл
  // конфигурации копии (не в базу), как в tests/harness-legacy.test.ts.
  const path = join(c.data, 'config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (!raw.checkoutRoot) {
    raw.checkoutRoot = sharedCheckoutRoot();
    writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  }
  return loadConfig(path);
}

function workspace(c: Copy) {
  const config = configOf(c);
  const store = new Store(
    join(c.data, 'state.sqlite'),
    c.kind === 'component' ? repositories(config) : undefined,
  );
  return { config, store, h: new DevContour(store, config) };
}

async function withLegacy(kind: Kind, body: (c: Copy) => Promise<void> | void) {
  await acquire();
  try {
    await body(copy(kind));
  } finally {
    release();
  }
}

/**
 * Полнота базы: каждый вид записи, ради которого она записана, в ней есть.
 * Без этого тест чтения прошёл бы и на базе, где вида нет вовсе.
 */
function assertComplete(c: Copy) {
  const e = c.expected;
  assert.deepEqual(e.source, {
    devcontour: '0.4.0-alpha.17',
    harness: '0.1.0-alpha.36',
    commit: 'aee0ed9',
  });
  // Состояние — тем же Store, только для чтения: в component задачи и
  // попытки лежат в базе компонента.
  const reader = new Store(
    join(c.data, 'state.sqlite'),
    c.kind === 'component' ? [{ id: 'app', path: c.app }] : undefined,
    false,
    undefined,
    true,
  );
  const state = reader.read();
  reader.close();
  const run = (id: string) => state.runs.find((r) => r.id === id);
  assert.ok(run(e.runs.unfinished)?.partial, 'незавершённая попытка с черновиком');
  assert.equal(run(e.runs.continued)?.continuedFrom?.runId, e.runs.unfinished, 'продолжение');
  assert.ok(run(e.runs.accepted), 'принятая попытка');
  assert.equal(state.tasks.length, 3);
  for (const t of state.tasks) assert.match(t.approvedPolicy ?? '', /^[0-9a-f]{64}$/);
  // Обсуждение лежит у владельца задачи: в component — в базе компонента.
  const owner = c.files.at(-1)!;
  const local = new DatabaseSync(owner, { readOnly: true });
  const rows = local.prepare('SELECT author, kind FROM discussion').all() as {
    author: string;
    kind: string;
  }[];
  const usage = local
    .prepare("SELECT key FROM local_workflow WHERE namespace='usage' ORDER BY key")
    .all() as { key: string }[];
  local.close();
  const kinds = rows.map((r) => `${r.author}:${r.kind}`);
  for (const k of ['operator:note', 'lead:note', 'operator:change-request', 'lead:disposition'])
    assert.ok(kinds.includes(k), `в базе нет записи обсуждения ${k}`);
  assert.deepEqual(
    usage.map((u) => u.key),
    e.usage,
    'учёт вызовов',
  );
  assert.equal(e.openRequests.length, 1, 'открытое обращение');
}

for (const kind of ['central', 'component'] as const) {
  test(`D03-C ${kind}: база с обсуждениями до вопросов исполнителя читается без записи и без вопросов`, () =>
    withLegacy(kind, (c) => {
      assertComplete(c);
      const e = c.expected;
      const before = c.files.map(dump);

      // Адаптер движка: попытки с черновиком и продолжением, учёт вызовов, вопросов нет.
      const raw = new DevContourExecutionStore(
        new Store(
          join(c.data, 'state.sqlite'),
          kind === 'component' ? [{ id: 'app', path: c.app }] : undefined,
        ),
        { policyDigest: () => digestOf('policy') },
      );
      const attempts = raw.read((v) => v.attempts());
      const unfinished = attempts.find((a) => a.id === e.runs.unfinished)!;
      assert.equal(unfinished.status, 'failed');
      assert.equal(unfinished.failureKind, 'timeout');
      assert.deepEqual(unfinished.partial?.files, ['src/greet.mjs']);
      const continued = attempts.find((a) => a.id === e.runs.continued)!;
      assert.equal(continued.status, 'active');
      assert.ok(continued.leaseUntil < Date.now(), 'срок владения истёк');
      assert.deepEqual(continued.continuedFrom, {
        runId: e.runs.unfinished,
        kind: 'unfinished',
        reason: 'timeout',
        applied: true,
        files: ['src/greet.mjs'],
      });
      assert.equal(attempts.find((a) => a.id === e.runs.accepted)!.status, 'succeeded');
      for (const a of attempts) assert.equal(a.contextSnapshot, undefined);
      assert.deepEqual(
        raw
          .read((v) => v.locals('usage'))
          .map((x) => x.value.id)
          .sort(),
        e.usage,
      );
      assert.deepEqual(
        raw.read((v) => v.locals('input-requests')),
        [],
      );
      raw.close();

      const { store, h, config } = workspace(c);
      // Утверждённые задачи: закреплённая политика прочитана как записана и
      // совпадает с политикой плана новой версии — повторного утверждения нет.
      const state = store.read();
      for (const [title, t] of Object.entries(e.tasks)) {
        const task = state.tasks.find((x) => x.id === t.id)!;
        assert.equal(task.title, title);
        assert.equal(task.status, t.status, title);
        assert.equal(task.approvedPolicy, t.approvedPolicy, title);
        assert.equal(h.approvalStale(task), false, `${title}: утверждение не устарело`);
        assert.equal(task.inputContext, undefined, title);
      }
      for (const r of state.runs) assert.equal(r.inputPolicy, undefined);

      // Обсуждение: заметки, обработанное и открытое обращения — как записаны.
      const discussion = new DiscussionService(h);
      for (const [taskId, kinds] of Object.entries(e.discussion)) {
        const thread = discussion.read({ taskId });
        assert.deepEqual(
          thread.messages.map((m) => `${m.author}:${m.kind}`),
          kinds,
          taskId,
        );
        assert.equal(thread.messages.length, kinds.length);
        assert.equal(thread.version, thread.messages.at(-1)!.seq);
      }
      assert.deepEqual(
        discussion.inbox({}).requests.map((r) => r.id),
        e.openRequests,
      );
      const agent = new AgentService(h, c.data);
      const listed = agent.execute({ operation: 'attention_list', input: {} }) as {
        items: { source: string; evidence?: { id: string }[] }[];
      };
      const requests = listed.items.filter((i) => i.source === 'discussion-request');
      assert.deepEqual(
        requests.flatMap((i) => (i.evidence ?? []).map((x) => x.id)),
        e.openRequests,
      );

      // Вопросов исполнителя нет ни в одном пути чтения.
      assert.deepEqual(new InputService(h).list().requests, []);
      assert.equal(inputHolds(h).size, 0);
      assert.deepEqual(agent.execute({ operation: 'input_list', input: {} }), { requests: [] });
      const handoff = devcontourHandoff(h, {});
      assert.equal(handoff.pack.inputs?.length ?? 0, 0);
      assert.ok(
        !['answer-input', 'apply-input', 'close-follow-up'].includes(
          handoff.host.next?.action ?? '',
        ),
      );
      store.close();

      // Doctor: база совместима, опись называет только обсуждения.
      const doctor = dataDoctor(config, c.data);
      assert.equal(doctor.compatible, true);
      const messages = Object.values(e.discussion).reduce((n, k) => n + k.length, 0);
      assert.deepEqual(
        doctor.checks.find((x) => x.id === 'compat:new-state'),
        newStateCheck({
          quickIntakes: 0,
          setupProposals: 0,
          expansions: 0,
          discussions: messages,
          standIns: 0,
          rulings: 0,
          attentionMarks: 0,
          inputRequests: 0,
          openInputRequests: 0,
          quickSetupMarks: 0,
        }),
      );
      assert.deepEqual(c.files.map(dump), before, 'чтение не записало ничего');
    }));
}
