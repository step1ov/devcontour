// Пакет передачи контекста новой сессии ведущего агента: операция `handoff`
// и CLI `session-handoff` отдают пакет harness (`handoffPack`) над движком
// DevContour; вложенные чтения пакета идут одним снимком хранилища.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handoffPackSchema, type HandoffPack } from 'devcontour-harness/contracts';
import { complete, config, fixture, input } from './helpers.ts';
import { AgentService, capabilities } from '../src/application/agent.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { repositorySchema } from '../src/core/model.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';
import { projectionOptions } from '../src/harness/host.ts';
import { devcontourHandoff, fitHandoff } from '../src/application/handoff.ts';
import { command } from '../src/runner/process.ts';

const INTENT = 'Okapi intention: finish the payment board before the release';

/** Две выпущенные доски (задача принята, задача упала) и черновая. */
function boards(h: DevContour) {
  const a = h.createBoard('Board A', '', 'main');
  const done = h.addTask(a.id, input('Accepted task')).id;
  const failed = h.addTask(a.id, input('Failing task')).id;
  h.approve(a.id);
  const b = h.createBoard('Board B', '', 'main');
  const other = h.addTask(b.id, input('Other board task')).id;
  h.approve(b.id);
  const draft = h.createBoard('Draft board', '', 'main');
  h.addTask(draft.id, input('Draft task'));
  complete(h, done);
  h.pause(false);
  const run = h.claim(h.store.read().leader?.owner ?? 'test')!;
  h.fail(run.id, run.token, 'gate failed: expected 2, got 3', false, 'gate');
  h.pause(true);
  return { a: a.id, b: b.id, draft: draft.id, done, failed, other, failedTask: run.taskId };
}

type JsonHandoff = { format: 'json'; pack: HandoffPack; commands: Record<string, string> };
type MdHandoff = { format: 'md'; markdown: string; commands: Record<string, string> };
const status = (e: unknown) => (e as { status?: number }).status;

test('handoff: в каталоге только чтения со схемой входа; JSON по схеме harness, ничего не пишет', () => {
  const tool = capabilities().tools.find((t) => t.name === 'handoff')!;
  assert.ok(tool, 'операция handoff в каталоге');
  assert.equal(tool.readOnly, true);
  assert.match(tool.description, /new lead session/);
  assert.match(tool.description, /Read-only, no model calls/);
  const schema = tool.inputSchema as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['boardId', 'format', 'intentions']);
  const f = fixture();
  try {
    const ids = boards(f.h);
    const agent = new AgentService(f.h, f.root);
    const events = f.store.lastEventId();
    const revision = f.store.revision();
    const value = agent.execute({ operation: 'handoff', input: {} }) as unknown as JsonHandoff;
    assert.equal(value.format, 'json');
    const pack = handoffPackSchema.parse(value.pack);
    assert.equal(pack.handoffVersion, 1);
    assert.equal(pack.graphId, undefined);
    assert.equal(pack.summary.works, 4, 'черновые задачи не выпущены и в пакет не входят');
    assert.ok(pack.works.some((w) => w.id === ids.failedTask && w.status === 'failed'));
    assert.ok(pack.works.some((w) => w.id === ids.other));
    assert.ok(!pack.works.some((w) => w.id === ids.done), 'принятая задача не открыта');
    assert.ok(pack.failures.some((x) => x.workId === ids.failedTask));
    assert.ok(pack.queue.paused);
    assert.deepEqual(Object.keys(value.commands).sort(), ['harness resume', 'harness run']);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 65536);
    assert.equal(f.store.lastEventId(), events, 'операция ничего не пишет в журнал');
    assert.equal(f.store.revision(), revision, 'операция не меняет документ');
  } finally {
    f.cleanup();
  }
});

test('handoff: намерения доходят до пакета, Markdown — тот же пакет, пределы входа — 400', () => {
  const f = fixture();
  try {
    boards(f.h);
    const agent = new AgentService(f.h, f.root);
    const json = agent.execute({
      operation: 'handoff',
      input: { intentions: [INTENT, '  second  '] },
    }) as unknown as JsonHandoff;
    assert.deepEqual(handoffPackSchema.parse(json.pack).intentions, [INTENT, 'second']);
    const md = agent.execute({
      operation: 'handoff',
      input: { format: 'md', intentions: [INTENT] },
    }) as unknown as MdHandoff;
    assert.equal(md.format, 'md');
    assert.match(md.markdown, /^# Передача контекста/);
    assert.match(md.markdown, /## Намерения/);
    assert.ok(md.markdown.includes(INTENT));
    assert.ok(!('pack' in md));
    assert.throws(
      () =>
        agent.execute({
          operation: 'handoff',
          input: { intentions: Array.from({ length: 21 }, (_, i) => 'intent ' + i) },
        }),
      (e) => status(e) === 400,
    );
    assert.throws(
      () => agent.execute({ operation: 'handoff', input: { intentions: ['x'.repeat(1001)] } }),
      (e) => status(e) === 400,
    );
    assert.throws(
      () => agent.execute({ operation: 'handoff', input: { format: 'html' } }),
      (e) => status(e) === 400,
    );
  } finally {
    f.cleanup();
  }
});

test('handoff: boardId — граф harness той же доски; неизвестная доска — 404, черновая — 409', () => {
  const f = fixture();
  try {
    const ids = boards(f.h);
    const agent = new AgentService(f.h, f.root);
    const a = handoffPackSchema.parse(
      (agent.execute({ operation: 'handoff', input: { boardId: ids.a } }) as unknown as JsonHandoff)
        .pack,
    );
    assert.equal(a.graphId, ids.a);
    assert.equal(a.summary.works, 2);
    assert.ok(
      a.works.every((w) => w.id !== ids.other),
      'задачи другой доски не входят',
    );
    assert.ok(a.failures.every((x) => x.workId !== ids.other));
    const b = handoffPackSchema.parse(devcontourHandoff(f.h, { boardId: ids.b }));
    assert.equal(b.graphId, ids.b);
    assert.deepEqual(
      b.works.map((w) => w.id),
      [ids.other],
    );
    assert.deepEqual(b.failures, []);
    assert.throws(
      () => agent.execute({ operation: 'handoff', input: { boardId: 'missing' } }),
      (e) => status(e) === 404,
    );
    assert.throws(
      () => agent.execute({ operation: 'handoff', input: { boardId: ids.draft } }),
      (e) => status(e) === 409 && /не выпущена/.test((e as Error).message),
    );
  } finally {
    f.cleanup();
  }
});

test('handoff: предел ответа отбрасывает записи порядком пакета и считает их в truncated', () => {
  const f = fixture();
  try {
    boards(f.h);
    const pack = devcontourHandoff(f.h, { intentions: [INTENT, 'second intention'] });
    const size = (p: HandoffPack) => Buffer.byteLength(JSON.stringify(p));
    const fitted = fitHandoff(pack, (p) => size(p) <= size(pack) - 1);
    handoffPackSchema.parse(fitted);
    assert.equal(fitted.truncated.bySize, true);
    assert.equal(fitted.truncated.intentionsDropped, 1, 'первым уходит последнее намерение');
    assert.deepEqual(fitted.intentions, [INTENT]);
    assert.equal(pack.truncated.bySize, false, 'исходный пакет не меняется');
    const tight = fitHandoff(pack, (p) => size(p) <= 1500);
    handoffPackSchema.parse(tight);
    assert.deepEqual(tight.intentions, []);
    assert.deepEqual(tight.failures, []);
    assert.equal(tight.truncated.failures, pack.failures.length + pack.truncated.failures);
    assert.equal(
      tight.works.length + tight.truncated.works,
      pack.works.length + pack.truncated.works,
    );
  } finally {
    f.cleanup();
  }
});

test('ExecutionStore.read: вложенное чтение — тот же снимок и вид, без второго снимка Store', () => {
  const root = mkdtempSyncSafe();
  const file = join(root, 'state.sqlite');
  const h = new DevContour(new Store(file), config());
  const writer = new DevContour(new Store(file), config());
  try {
    h.createBoard('Before', '', 'main');
    const store = new DevContourExecutionStore(h.store, projectionOptions(h));
    let snapshots = 0;
    const snapshot = h.store.snapshot.bind(h.store);
    h.store.snapshot = <T>(read: () => T): T => {
      snapshots++;
      return snapshot(read);
    };
    const seen = store.read((outer) => {
      const before = store.stateOf(outer).boards.map((b) => b.title);
      // Другой процесс (соединение) пишет между чтениями внешнего снимка.
      writer.createBoard('Written meanwhile', '', 'main');
      const inner = store.read((v) => ({
        same: v === outer,
        titles: store.stateOf(v).boards.map((b) => b.title),
        deeper: store.read((w) => w === outer),
      }));
      return { before, ...inner };
    });
    assert.equal(snapshots, 1, 'вложенные чтения не открывают второй снимок');
    assert.equal(seen.same, true);
    assert.equal(seen.deeper, true);
    assert.deepEqual(seen.titles, seen.before, 'вложенное чтение видит внешний снимок');
    assert.ok(!seen.titles.includes('Written meanwhile'));
    // После внешнего чтения вид снят: следующее чтение — новый снимок.
    const after = store.read((v) => store.stateOf(v).boards.map((b) => b.title));
    assert.ok(after.includes('Written meanwhile'));
    assert.equal(snapshots, 2);
    // Исключение во вложенном чтении снимает вид внешнего.
    assert.throws(() =>
      store.read(() =>
        store.read(() => {
          throw new Error('inner');
        }),
      ),
    );
    store.read((v) => assert.ok(store.stateOf(v).boards.length >= 2));
    assert.equal(snapshots, 4);
    // Пакет передачи — одно чтение снимка Store на весь пакет (движок уже
    // собран первым вызовом: его сборка читает конфигурацию отдельно).
    devcontourHandoff(h);
    snapshots = 0;
    handoffPackSchema.parse(devcontourHandoff(h));
    assert.equal(snapshots, 1, 'пакет читается одним снимком');
  } finally {
    writer.store.close();
    h.store.close();
    rmFixture(root);
  }
});

test('handoff: компонентное хранение — центральная база и базы компонентов одним снимком', () => {
  const f = fixture();
  let store: Store | undefined;
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const repos = ['product', 'library'].map((id) => {
      const path = join(f.root, id);
      mkdirSync(path);
      return repositorySchema.parse({ id, name: id, path, gates: f.h.config.gates });
    });
    store = new Store(join(workspace, 'state.sqlite'), repos);
    const h = new DevContour(
      store,
      config({ storage: 'component', workspaceRoot: workspace, repositories: repos }),
    );
    const ids = repos.map((r) => {
      const board = h.createBoard(`Board of ${r.id}`, '', r.id);
      const task = h.addTask(board.id, { ...input(`Task of ${r.id}`), repositoryId: r.id });
      h.approve(board.id);
      return { board: board.id, task: task.id };
    });
    devcontourHandoff(h);
    let snapshots = 0;
    const snapshot = store.snapshot.bind(store);
    store.snapshot = <T>(read: () => T): T => {
      snapshots++;
      return snapshot(read);
    };
    const all = handoffPackSchema.parse(devcontourHandoff(h));
    assert.equal(snapshots, 1, 'базы компонентов читаются одним снимком');
    assert.deepEqual(all.works.map((w) => w.id).sort(), ids.map((i) => i.task).sort());
    const library = handoffPackSchema.parse(devcontourHandoff(h, { boardId: ids[1].board }));
    assert.deepEqual(
      library.works.map((w) => w.id),
      [ids[1].task],
    );
  } finally {
    store?.close();
    f.cleanup();
  }
});

test('session-handoff: CLI читает базу только для чтения, JSON и Markdown', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-handoff-')));
  const data = join(root, 'data');
  try {
    await mkdir(data);
    const c = config();
    await writeFile(join(data, 'config.json'), JSON.stringify(c));
    const h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    let ids: ReturnType<typeof boards>;
    try {
      ids = boards(h);
    } finally {
      h.store.close();
    }
    const digest = async () =>
      createHash('sha256')
        .update(await readFile(join(data, 'state.sqlite')))
        .digest('hex');
    const before = await digest();
    const cli = (...args: string[]) =>
      command(
        ['node', '--import', 'tsx', 'src/cli.ts', 'session-handoff', ...args, '--data', data],
        process.cwd(),
      );
    // Каталог данных без права записи: writer базу открыть не смог бы.
    const files = (await readdir(data)).map((n) => join(data, n));
    for (const file of files) await chmod(file, 0o444);
    await chmod(data, 0o555);
    let json, md, html;
    try {
      json = await cli('--board', ids.a, '--intent', INTENT);
      md = await cli('--format', 'md');
      html = await cli('--format', 'html');
    } finally {
      await chmod(data, 0o755);
      for (const file of files) await chmod(file, 0o644);
    }
    assert.equal(json.code, 0, json.stderr);
    const value = JSON.parse(json.stdout) as JsonHandoff;
    const pack = handoffPackSchema.parse(value.pack);
    assert.equal(pack.graphId, ids.a);
    assert.deepEqual(pack.intentions, [INTENT]);
    assert.ok(value.commands['harness run']);
    assert.equal(md.code, 0, md.stderr);
    assert.match(md.stdout, /^# Передача контекста/);
    assert.match(md.stdout, /## Команды в DevContour/);
    assert.notEqual(html.code, 0);
    assert.match(html.stderr, /json или md/);
    assert.equal(await digest(), before, 'база не изменилась');
  } finally {
    assert.ok(root.startsWith(await realpath(tmpdir())) && root.includes('dc-handoff-'));
    await rm(root, { recursive: true, force: true });
  }
});

function mkdtempSyncSafe() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dc-handoff-read-')));
}
/** Удаление только созданного здесь временного каталога. */
function rmFixture(root: string) {
  assert.ok(root.startsWith(realpathSync(tmpdir())) && root.includes('dc-handoff-read-'));
  rmSync(root, { recursive: true, force: true });
}
