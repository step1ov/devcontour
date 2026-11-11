import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import fs, {
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, input } from './helpers.ts';
import { repositorySchema } from '../src/core/model.ts';
import { reviewPlan } from '../src/runner/agent-control.ts';
import { ContractChanges, type ContractChange } from '../src/runner/contract-change.ts';
import { adapters, type AgentAdapter } from '../src/runner/adapters.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { lockContextFile, planRepin } from '../src/runner/context.ts';
import { loadedDigest } from '../src/core/service.ts';
import { busyWork } from '../src/runner/reconfigure.ts';
import { Workspace } from '../src/core/workspace.ts';
import { Previews } from '../src/core/preview.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { loadConfig } from '../src/runner/config.ts';
import { serveReconfigure } from '../src/runner/reconfigure.ts';
import { reviewers, stage, withContextPack } from './contract-change-fixture.ts';

test('C-F01: a repin retry accepts only the planned result; an edit in the crash window is refused', async () => {
  for (const edit of [false, true]) {
    const s = await stage();
    const realRename = fs.renameSync;
    try {
      const ctx = await withContextPack(s);
      const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
        operation: ContractChange;
      };
      // Процесс падает сразу после записи файла, до сохранения шага.
      let crashed = false;
      fs.renameSync = function (from, to) {
        realRename(from, to);
        if (String(to) === ctx.path && !crashed) {
          crashed = true;
          throw new Error('crash after rename');
        }
      };
      syncBuiltinESMExports();
      const failed = await s.changes().advance(operation.id);
      fs.renameSync = realRename;
      syncBuiltinESMExports();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.next, 'context');
      const planned = s.changes().get(operation.id).config!;
      assert.equal(ctx.digest(), planned.after, 'файл записан до падения');
      if (edit) {
        // В окне сбоя кто-то правит файл: повтор не принимает это за результат.
        const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as Record<string, unknown>;
        writeFileSync(
          ctx.path,
          JSON.stringify({ ...raw, runTimeoutMs: Number(raw.runTimeoutMs) + 1 }, null, 2) + '\n',
        );
        const refused = await s.changes().advance(operation.id);
        assert.equal(refused.status, 'failed');
        assert.match(refused.error ?? '', /изменён вне операции: ожидался digest/);
        continue;
      }
      s.h.config = loadConfig(ctx.path);
      const done = await s.changes().advance(operation.id);
      assert.equal(done.status, 'completed', done.error);
      assert.ok(done.history.some((h) => h.event === 'already-repinned'));
    } finally {
      fs.renameSync = realRename;
      syncBuiltinESMExports();
      await s.remove();
    }
  }
});

test('C-F02/C-F15: an owner that loses the operation mid-write writes nothing; a context-lock started before a request does not write after it', async () => {
  const s = await stage();
  const realWriteFile = fsp.writeFile;
  try {
    const ctx = await withContextPack(s);
    const before = readFileSync(ctx.path, 'utf8');
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Операцию перехватывают, пока её шаг готовит новый файл: запись уже
    // подготовлена, а владения больше нет.
    fsp.writeFile = async function (...args: Parameters<typeof fsp.writeFile>) {
      await realWriteFile(...args);
      if (typeof args[0] === 'string' && args[0].startsWith(ctx.path + '.'))
        s.store.atomic(() => {
          const op = s.changes().get(operation.id);
          s.store.saveLocal('contract-change', op.owner, op.id, { ...op, token: 'other' });
        });
    } as typeof fsp.writeFile;
    syncBuiltinESMExports();
    const lost = await s.changes().advance(operation.id);
    fsp.writeFile = realWriteFile;
    syncBuiltinESMExports();
    assert.equal(lost.next, 'context');
    assert.equal(readFileSync(ctx.path, 'utf8'), before, 'потерявший владение не пишет');
    // context-lock прочёл файл до запроса операции; запрос появился, пока он
    // считал закрепление. Право на запись проверяется у самой записи.
    await assert.rejects(
      lockContextFile(s.h.config, ctx.path, 'HEAD', (write) => {
        s.h.requestReconfigure('CC-late', 'd'.repeat(64));
        s.store.atomic(() => {
          const pending = s.store.read().reconfigure;
          if (pending && !pending.appliedAt) throw new Error('применяет конфигурацию');
          write();
        });
      }),
      /применяет конфигурацию/,
    );
    assert.equal(readFileSync(ctx.path, 'utf8'), before, 'context-lock не записал');
  } finally {
    fsp.writeFile = realWriteFile;
    syncBuiltinESMExports();
    await s.remove();
  }
});

test('C-F11/C-F12/C-F16/C-F17: a stale process accepts nothing even after the leader lease expires, a non-leader start changes nothing, and only pins change without a restart', async () => {
  const s = await stage();
  let stale: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    stale = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    // Действующий controller записал свою конфигурацию.
    assert.ok(s.h.leader('server'));
    s.h.recordConfig('server');
    // Операция применяет новое закрепление.
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    let finished = false;
    const advancing = s
      .changes()
      .advance(operation.id)
      .finally(() => (finished = true));
    while (!finished) {
      s.h.leader('server');
      serveReconfigure(s.h, ctx.path, 'server');
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal((await advancing).status, 'completed');
    const applied = s.store.read().appliedConfig;
    // Запуск отставшего процесса с другой конфигурацией, не ставшего лидером,
    // ничего не меняет.
    stale.recordConfig('other-start');
    assert.deepEqual(s.store.read().appliedConfig, applied);
    // Лидер остановился, lease истёк: отставший процесс всё равно не
    // утверждает план и не принимает ChangeSet, а став лидером — не
    // перезаписывает применённую конфигурацию своей.
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    const draft = stale.addTask(s.board.id, {
      ...input('Late draft'),
      role: 'qa',
    });
    assert.throws(() => stale!.approve(s.board.id, [draft.id]), /не с применённой политикой/);
    assert.throws(() => new Workspace(stale!).accept('CHG-none'), /не с применённой политикой/);
    assert.equal(stale.claim('stale-worker'), undefined);
    assert.ok(stale.leader('other-start'));
    stale.recordConfig('other-start');
    assert.deepEqual(s.store.read().appliedConfig, applied);
    // Без перезапуска меняется только закрепление: роли пакета — нет.
    const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as {
      contextPacks: { roles: string[] }[];
    };
    raw.contextPacks[0].roles = ['qa'];
    writeFileSync(ctx.path, JSON.stringify(raw, null, 2) + '\n');
    assert.throws(() => s.h.reconfigure(loadConfig(ctx.path)), /revision и digest/);
  } finally {
    stale?.store.close();
    await s.remove();
  }
});

test('C-F18: a server that loaded the previous configuration does not write it back on its first leader tick and catches up', async () => {
  const s = await stage();
  let server: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    // Сервер загрузил конфигурацию A и ещё не сделал первый тик.
    server = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    await new Promise((r) => setTimeout(r, 5));
    // Операция в это время применяет B (живого лидера нет — подтверждает сама).
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    assert.equal((await s.changes().advance(operation.id)).status, 'completed');
    const applied = s.store.read().appliedConfig!;
    assert.equal(applied.digest, loadedDigest(s.h.config));
    // Первый тик сервера: лидерство получено, но A не записывается обратно.
    assert.ok(server.leader('server'));
    server.recordConfig('server');
    assert.deepEqual(s.store.read().appliedConfig, applied);
    assert.equal(server.claim('server'), undefined, 'отставший сервер не выдаёт');
    // Сервер догоняет B из файла тем же правилом и снова работает.
    serveReconfigure(server, ctx.path, 'server');
    assert.equal(server.config.contextPacks[0].revision, s.sh('rev-parse', 'HEAD'));
    assert.doesNotThrow(() => server!.assertCurrentConfig());
  } finally {
    server?.store.close();
    await s.remove();
  }
});

test('C-F19/C-F20/C-F21: staleness follows generations, not clocks; a snapshot read before an apply stays stale; a real restart with new fields becomes current', async () => {
  const s = await stage();
  const realNow = Date.now;
  let early: DevContour | undefined;
  let late: DevContour | undefined;
  let restarted: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    assert.ok(s.h.leader('server'));
    s.h.recordConfig('server');
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    // Часы процессов ушли на час вперёд, пока они загружали конфигурацию, а
    // потом откатились: момент загрузки «позже» применения. Правило по времени
    // на этом ошибается, поколения — нет.
    const frozen = realNow() + 3_600_000;
    Date.now = () => frozen;
    early = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    // CLI прочитал конфигурацию A до применения, а объект создаст после.
    const snapshotA = loadConfig(ctx.path);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    Date.now = realNow;
    assert.equal((await s.changes().advance(operation.id)).status, 'completed');
    Date.now = () => frozen;
    late = new DevContour(new Store(join(s.root, 'state.sqlite')), snapshotA);
    for (const stale of [early, late])
      assert.throws(() => stale.assertCurrentConfig(), /не с применённой политикой/);
    const applied = s.store.read().appliedConfig;
    assert.ok(early.leader('early'));
    early.recordConfig('early');
    assert.deepEqual(s.store.read().appliedConfig, applied, 'отставший не вернул A');
    Date.now = realNow;
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    // Настоящий перезапуск с новым полем: файл прочитан после правки.
    const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      ctx.path,
      JSON.stringify({ ...raw, runTimeoutMs: Number(raw.runTimeoutMs) + 1 }, null, 2) + '\n',
    );
    restarted = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    assert.doesNotThrow(() => restarted!.assertCurrentConfig());
    assert.ok(restarted.leader('restarted'));
    restarted.recordConfig('restarted');
    assert.equal(s.store.read().appliedConfig?.digest, loadedDigest(restarted.config));
    assert.equal(s.store.read().appliedConfig?.generation, (applied?.generation ?? 0) + 1);
  } finally {
    Date.now = realNow;
    early?.store.close();
    late?.store.close();
    restarted?.store.close();
    await s.remove();
  }
});

test('C-F20/C-F22/C-F23/C-F24: the applied configuration is the only truth; adoption needs no other controller and an unchanged source', async () => {
  const s = await stage();
  const extra: DevContour[] = [];
  const open = (config: ReturnType<typeof loadConfig>) => {
    const h = new DevContour(new Store(join(s.root, 'state.sqlite')), config);
    extra.push(h);
    return h;
  };
  try {
    const ctx = await withContextPack(s);
    const textA = readFileSync(ctx.path, 'utf8');
    // Controller B работает: операция применила новое закрепление.
    assert.ok(s.h.leader('server'));
    s.h.recordConfig('server');
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    let finished = false;
    const advancing = s
      .changes()
      .advance(operation.id)
      .finally(() => (finished = true));
    while (!finished) {
      s.h.leader('server');
      serveReconfigure(s.h, ctx.path, 'server');
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal((await advancing).status, 'completed');
    s.store.change('fixture.live-leader', (st) => {
      st.leader = { owner: 'server', leaseUntil: Date.now() + 3_600_000 };
    });
    const applied = s.store.read().appliedConfig!;
    // C-F20: файл вернули к A, CLI прочитал его свежим — controller B жив.
    writeFileSync(ctx.path, textA);
    const cli = open(loadConfig(ctx.path));
    assert.throws(() => cli.assertCurrentConfig(), /работает controller server/);
    // C-F22: конфигурация без источника не вправе стать применённой даже без лидера.
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    const memory = open(structuredClone(loadConfig(ctx.path)));
    assert.throws(() => memory.assertCurrentConfig(), /источника нет/);
    // C-F24: запись своей конфигурации при получении лидерства внутри
    // отменённой транзакции не оставляет ни следа в базе, ни ложной
    // актуальности в процессе: после применения B другим процессом он отстал.
    assert.ok(cli.leader('cli'));
    assert.throws(() =>
      s.store.atomic(() => {
        cli.recordConfig('cli');
        throw new Error('rollback');
      }),
    );
    assert.deepEqual(s.store.read().appliedConfig, applied);
    s.store.change('fixture.no-leader-2', (st) => {
      st.leader = undefined;
    });
    // C-F23: временно недоступный файл — отказ с причиной; после восстановления
    // — тот же процесс без перезапуска записывает свою конфигурацию.
    renameSync(ctx.path, ctx.path + '.away');
    assert.throws(() => cli.assertCurrentConfig(), /не читается/);
    renameSync(ctx.path + '.away', ctx.path);
    cli.assertCurrentConfig();
    assert.equal(s.store.read().appliedConfig?.digest, loadedDigest(cli.config));
    assert.equal(s.store.read().appliedConfig?.generation, (applied.generation ?? 0) + 1);
  } finally {
    for (const h of extra) h.store.close();
    await s.remove();
  }
});

test('C-F25/C-F26/C-F27: adoption checks the bytes that were parsed, not file metadata, and a failed start record is retried', async () => {
  const s = await stage();
  const extra: DevContour[] = [];
  const open = (config: ReturnType<typeof loadConfig>) => {
    const h = new DevContour(new Store(join(s.root, 'state.sqlite')), config);
    extra.push(h);
    return h;
  };
  try {
    const ctx = await withContextPack(s);
    const textA = readFileSync(ctx.path, 'utf8');
    const statA = statSync(ctx.path);
    // Процесс со снимком A, загруженным до применения; копия A с её mtime.
    const old = open(loadConfig(ctx.path));
    execFileSync('cp', ['-p', ctx.path, ctx.path + '.a']);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    assert.equal((await s.changes().advance(operation.id)).status, 'completed');
    const applied = s.store.read().appliedConfig!;
    assert.notEqual(readFileSync(ctx.path, 'utf8'), textA, 'в файле B');
    // C-F25: у файла B прежние mtime (как после cp -p) — содержимое всё равно B.
    // touch -r переносит mtime с полной точностью; размер у A и B одинаков.
    execFileSync('touch', ['-r', ctx.path + '.a', ctx.path]);
    assert.equal(statSync(ctx.path).mtimeMs, statA.mtimeMs);
    assert.equal(statSync(ctx.path).size, statA.size);
    assert.throws(() => old.assertCurrentConfig(), /изменился после загрузки/);
    // C-F26: загрузчик разобрал байты A, а на диске уже B.
    const racing = open(loadConfig(ctx.path, textA));
    assert.throws(() => racing.assertCurrentConfig(), /изменился после загрузки/);
    assert.deepEqual(s.store.read().appliedConfig, applied, 'A не вернулась');
    // C-F27: законный перезапуск с новым полем; первая запись при старте не
    // удалась (файл временно недоступен), следующая — удалась.
    const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      ctx.path,
      JSON.stringify({ ...raw, runTimeoutMs: Number(raw.runTimeoutMs) + 1 }, null, 2) + '\n',
    );
    // Настоящий scheduler: первый тик не может записать конфигурацию, следующий — записывает.
    const restarted = open(loadConfig(ctx.path));
    restarted.pause(true);
    const scheduler = new Scheduler(restarted, s.root, { ...adapters, ...reviewers(s.calls) });
    try {
      await scheduler.init();
      renameSync(ctx.path, ctx.path + '.away');
      await scheduler.tick();
      assert.deepEqual(s.store.read().appliedConfig, applied);
      renameSync(ctx.path + '.away', ctx.path);
      await scheduler.tick();
      assert.equal(s.store.read().appliedConfig?.digest, loadedDigest(restarted.config));
    } finally {
      await scheduler.stop();
    }
  } finally {
    for (const h of extra) h.store.close();
    await s.remove();
  }
});

test('C-F24: a start record rolled back with its transaction leaves the process stale once the file changes back', async () => {
  const s = await stage();
  let edited: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    const textB = readFileSync(ctx.path, 'utf8');
    assert.ok(s.h.leader('server'));
    s.h.recordConfig('server');
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    const applied = s.store.read().appliedConfig!;
    // Процесс загрузил правку A'; его запись при получении лидерства откатилась.
    const raw = JSON.parse(textB) as Record<string, unknown>;
    writeFileSync(
      ctx.path,
      JSON.stringify({ ...raw, runTimeoutMs: Number(raw.runTimeoutMs) + 1 }, null, 2) + '\n',
    );
    edited = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    assert.ok(edited.leader('edited'));
    assert.throws(() =>
      s.store.atomic(() => {
        edited!.recordConfig('edited');
        throw new Error('rollback');
      }),
    );
    assert.deepEqual(s.store.read().appliedConfig, applied);
    // Файл вернули к применённой конфигурации: правка A' больше не намерение
    // оператора, процесс с ней отстал и ничего не принимает.
    writeFileSync(ctx.path, textB);
    s.store.change('fixture.no-leader-2', (st) => {
      st.leader = undefined;
    });
    assert.throws(() => edited!.assertCurrentConfig(), /не с применённой политикой/);
  } finally {
    edited?.store.close();
    await s.remove();
  }
});

test('C-F28: a component config reached through a switched symlink does not keep the right to adopt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-component-link-'));
  const extra: DevContour[] = [];
  try {
    const repo = join(root, 'product');
    await mkdir(repo);
    // Component config — symlink на файл A внутри репозитория. Поля компонента
    // берутся только из файла, поэтому имя и gates лежат в нём.
    await writeFile(
      join(repo, 'component.a.json'),
      JSON.stringify({ name: 'Product', gates: config().gates, protectedPaths: ['a.txt'] }),
    );
    await writeFile(
      join(repo, 'component.b.json'),
      JSON.stringify({ name: 'Product', gates: config().gates, protectedPaths: ['b.txt'] }),
    );
    symlinkSync('component.a.json', join(repo, 'devcontour.component.json'));
    const base = config();
    const path = join(root, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        repository: repo,
        repositories: [
          repositorySchema.parse({
            id: 'product',
            name: 'Product',
            path: repo,
            configFile: 'devcontour.component.json',
            gates: base.gates,
          }),
        ],
      }),
    );
    const store = () => new Store(join(root, 'state.sqlite'));
    const viaLink = new DevContour(store(), loadConfig(path));
    extra.push(viaLink);
    // Ссылка переключена на B; файл A цел. Процесс, загрузивший B, применил её.
    rmSync(join(repo, 'devcontour.component.json'));
    symlinkSync('component.b.json', join(repo, 'devcontour.component.json'));
    const b = new DevContour(store(), loadConfig(path));
    extra.push(b);
    assert.ok(b.leader('b'));
    b.recordConfig('b');
    b.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    const applied = b.store.read().appliedConfig;
    assert.throws(() => viaLink.assertCurrentConfig(), /теперь ведёт к другому файлу/);
    assert.deepEqual(b.store.read().appliedConfig, applied);
  } finally {
    for (const h of extra) h.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('C-F31: a repository directory reached through a switched symlink does not keep the right to adopt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-repo-link-'));
  const extra: DevContour[] = [];
  try {
    await mkdir(join(root, 'repo-a'));
    await mkdir(join(root, 'repo-b'));
    // Компонент задан прямо в config.json, без component config; его каталог —
    // symlink на repo-a.
    symlinkSync('repo-a', join(root, 'repo'));
    const base = config();
    const path = join(root, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        repository: join(root, 'repo'),
        repositories: [
          repositorySchema.parse({
            id: 'product',
            name: 'Product',
            path: join(root, 'repo'),
            gates: base.gates,
          }),
        ],
      }),
    );
    const store = () => new Store(join(root, 'state.sqlite'));
    const viaA = new DevContour(store(), loadConfig(path));
    extra.push(viaA);
    // Ссылка переключена на repo-b; config.json цел. Свежий процесс применил B.
    unlinkSync(join(root, 'repo'));
    symlinkSync('repo-b', join(root, 'repo'));
    const b = new DevContour(store(), loadConfig(path));
    extra.push(b);
    assert.notEqual(loadedDigest(b.config), loadedDigest(viaA.config));
    assert.ok(b.leader('b'));
    b.recordConfig('b');
    b.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    const applied = b.store.read().appliedConfig;
    assert.throws(() => viaA.assertCurrentConfig(), /теперь ведёт к другому файлу/);
    assert.deepEqual(b.store.read().appliedConfig, applied);
  } finally {
    for (const h of extra) h.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('C-F30: a configuration edited in memory after loading does not keep the right to adopt', async () => {
  const s = await stage();
  let edited: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    assert.ok(s.h.leader('server'));
    s.h.recordConfig('server');
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    const applied = s.store.read().appliedConfig;
    // Объект, загруженный из неизменного файла, изменили на месте.
    const loaded = loadConfig(ctx.path);
    loaded.runTimeoutMs += 2;
    edited = new DevContour(new Store(join(s.root, 'state.sqlite')), loaded);
    assert.throws(() => edited!.assertCurrentConfig(), /изменена в памяти/);
    assert.deepEqual(s.store.read().appliedConfig, applied);
  } finally {
    edited?.store.close();
    await s.remove();
  }
});

test('C-F16: a config edit made before the context step is not taken over by the operation', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    const roles = s.h.config.contextPacks[0].roles;
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const stopped = await s
      .changes((step) => {
        if (step === 'base') {
          const raw = JSON.parse(readFileSync(ctx.path, 'utf8')) as {
            contextPacks: { roles: string[] }[];
          };
          raw.contextPacks[0].roles = ['qa'];
          writeFileSync(ctx.path, JSON.stringify(raw, null, 2) + '\n');
        }
      })
      .advance(operation.id);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.error ?? '', /отличается от действующей конфигурации процесса/);
    assert.deepEqual(s.h.config.contextPacks[0].roles, roles, 'роли не подхвачены');
  } finally {
    await s.remove();
  }
});

test('C-F03/C-F04: a fixed config file is applied on retry, and an expired verification does not hold the drain', async () => {
  const s = await stage();
  let server: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    server = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    // Истёкшая совместная проверка осталась active.
    s.store.change('fixture.expired-verification', (st) => {
      st.changeSets.push({
        id: 'CHG-expired',
        title: 'expired',
        description: '',
        boardIds: [],
        createdAt: new Date().toISOString(),
        verifications: [
          {
            id: 'V-expired',
            token: 'expired-verification-token-0001',
            leaseUntil: Date.now() - 1000,
            startedAt: new Date().toISOString(),
            status: 'active',
            policyDigest: 'a'.repeat(64),
            specDigest: 'b'.repeat(64),
            tasks: [],
            boards: [],
            evidence: [],
          },
        ],
      });
    });
    assert.deepEqual(busyWork(s.h), []);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    ContractChanges.reconfigureWaitMs = 1000;
    // Сервер жив, но запрос не обработал: операция ждёт его подтверждения.
    // Лидерство не истекает, пока идут шаги операции на медленной машине.
    server.leader('server');
    s.store.change('fixture.live-leader', (st) => {
      st.leader = { owner: 'server', leaseUntil: Date.now() + 3_600_000 };
    });
    const waiting = await s.changes().advance(operation.id);
    assert.equal(waiting.status, 'waiting', waiting.error);
    assert.deepEqual(waiting.waitingFor, ['reconfigure']);
    // Сервер отказал (например, файл был испорчен) — отказ записан в запросе.
    const request = s.store.read().reconfigure!;
    server.settleReconfigure(request.operation, request.digest, 'server', 'файл испорчен');
    // Повтор операции снимает прежний отказ, и исправный сервер применяет.
    let finished = false;
    const retry = s
      .changes()
      .advance(operation.id)
      .finally(() => (finished = true));
    while (!finished) {
      server.leader('server');
      serveReconfigure(server, ctx.path, 'server');
      await new Promise((r) => setTimeout(r, 50));
    }
    const done = await retry;
    assert.equal(done.status, 'completed', done.error);
    assert.equal(s.store.read().reconfigure, undefined);
  } finally {
    ContractChanges.reconfigureWaitMs = 30000;
    server?.store.close();
    await s.remove();
  }
});

test('C-F05/C-F07: a verification and a process from the previous configuration accept nothing after it changed', async () => {
  const s = await stage();
  let stale: DevContour | undefined;
  try {
    const ctx = await withContextPack(s);
    const verificationPolicy = new Workspace(s.h).policyDigest();
    s.h.leader('server');
    s.h.recordConfig('server');
    // Сервер остановился: операция подтверждает применение сама.
    s.store.change('fixture.no-leader', (st) => {
      st.leader = undefined;
    });
    // Второй процесс с прежней конфигурацией.
    stale = new DevContour(new Store(join(s.root, 'state.sqlite')), loadConfig(ctx.path));
    s.h.pause(false);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
    assert.notEqual(new Workspace(s.h).policyDigest(), verificationPolicy, 'проверка устарела');
    // Применённая конфигурация записана; прежний процесс попыток не выдаёт.
    assert.equal(s.store.read().appliedConfig?.digest, loadedDigest(s.h.config));
    // Лидера нет — прежний процесс всё равно попыток не выдаёт.
    assert.equal(stale.claim('stale-worker'), undefined);
    const run = s.h.claim('worker');
    assert.ok(run, 'актуальный процесс выдаёт');
    assert.throws(
      () => stale!.phase(run.id, run.token, 'integrating', { candidateSha: 'c' }),
      /не с применённой политикой|Политика изменилась/,
    );
  } finally {
    stale?.store.close();
    await s.remove();
  }
});

test('C-F06/C-F09: nothing new starts while the configuration is applied, and a shutdown over the operation pause stays', async () => {
  const s = await stage();
  try {
    s.h.requestReconfigure('CC-x', 'e'.repeat(64));
    assert.throws(() => new Previews(s.h).start('CHG-none'), /применяет конфигурацию/);
    const job = 'f'.repeat(64);
    s.store.atomic(() =>
      s.store.saveLocal('lead', undefined, job, {
        key: job,
        kind: 'board',
        id: 'B',
        authorRuntime: 'codex',
        inputDigest: 'b'.repeat(64),
        startedAt: new Date().toISOString(),
        stage: 0,
        status: 'queued',
        attempts: 0,
        maxAttempts: 3,
        history: [],
      }),
    );
    assert.equal(new LeadWorkflow(s.h).claim(job), undefined);
    s.h.clearReconfigure('CC-x');
    // Shutdown поверх паузы операции забирает её: операция её не снимает.
    s.h.pause(false);
    s.h.operationPause('CC-y');
    s.h.pause(true, 'shutdown');
    s.h.operationResume('CC-y');
    assert.equal(s.store.read().paused, true);
    assert.equal(s.store.read().pauseReason, 'shutdown');
  } finally {
    await s.remove();
  }
});

test('C-F10: a plan review read under the previous context is not approved after the context changed', async () => {
  const s = await stage();
  try {
    const ctx = await withContextPack(s);
    const draft = s.h.addTask(s.board.id, {
      ...input('Draft'),
      role: 'backend',
      contracts: [s.c1.id],
    });
    const next = loadConfig(
      ctx.path,
      await planRepin(s.h.config, readFileSync(ctx.path, 'utf8'), ['contracts'], 'HEAD'),
    );
    // Пока ревьюер читает план, контекст перезакрепляют.
    const changing = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      execute() {
        s.h.reconfigure(next);
        return Promise.resolve({
          data: { approved: true, summary: 'Fixture', findings: [], discoveries: [] },
          log: 'Fixture only; no provider called',
          command: ['fixture'],
        });
      },
    });
    await assert.rejects(
      reviewPlan(
        s.h,
        s.root,
        s.board.id,
        'codex',
        { codex: changing('codex'), claude: changing('claude') },
        () => {},
        [draft.id],
      ),
      /План изменился во время ревью/,
    );
    assert.equal(s.task(draft.id).status, 'draft');
  } finally {
    await s.remove();
  }
});

test('C-F08: the expected digest covers component config files, not only config.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-component-digest-'));
  try {
    const repo = join(root, 'product');
    await mkdir(repo);
    const component = join(repo, 'devcontour.component.json');
    await writeFile(
      component,
      JSON.stringify({ name: 'Product', gates: config().gates, protectedPaths: ['a.txt'] }),
    );
    const base = config();
    const path = join(root, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        repository: repo,
        repositories: [
          repositorySchema.parse({
            id: 'product',
            name: 'Product',
            path: repo,
            configFile: 'devcontour.component.json',
            gates: base.gates,
          }),
        ],
      }),
    );
    const text = readFileSync(path, 'utf8');
    const first = loadedDigest(loadConfig(path));
    // Главный файл не менялся, component config — да: digest другой.
    await writeFile(
      component,
      JSON.stringify({ name: 'Product', gates: config().gates, protectedPaths: ['b.txt'] }),
    );
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.notEqual(loadedDigest(loadConfig(path)), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
