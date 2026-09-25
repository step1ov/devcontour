import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { config, input, fixture } from './helpers.ts';
import { Previews } from '../src/core/preview.ts';
import { AgentService } from '../src/application/agent.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, digest } from '../src/core/service.ts';
import { Workspace, changeSnapshot, snapshotDigest } from '../src/core/workspace.ts';
import { PreviewRunner } from '../src/runner/preview.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { chromium } from '@playwright/test';
import { command, git } from '../src/runner/process.ts';

// Локальное имя базового образа: сборка не ходит в реестр за метаданными,
// и тест не зависит от сети в момент сборки.
const BASE = 'devcontour-preview-test-base:1';
const dockerfile = (health: boolean) => `FROM ${BASE}
ARG DEVCONTOUR_RELEASE
RUN mkdir -p /www && echo "$DEVCONTOUR_RELEASE" > /www/version${health ? ' && echo ok > /www/health' : ''}
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
`;
const compose = `services:
  web:
    build:
      context: ./main
      args:
        DEVCONTOUR_RELEASE: \${DEVCONTOUR_RELEASE}
    ports:
      - "127.0.0.1:\${DEVCONTOUR_PREVIEW_PORT}:8080"
`;
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

test('Preview выкладывает проверенный релиз и не выдаёт старый или сломанный за новый', async (t) => {
  // Автор продукта оценивает работающий сервис. URL должен обслуживать
  // именно проверенный manifest; повтор не собирает второй раз; отказ
  // сборки или здоровья не даёт ложной готовности и не лишает автора
  // прежней версии; откат возвращает предыдущий релиз.
  const docker = await command(['docker', 'info', '--format', '{{.ServerVersion}}'], tmpdir());
  if (docker.code !== 0) {
    t.skip('Docker недоступен: ' + docker.stderr.trim().slice(0, 200));
    return;
  }
  let pulled = false;
  for (let attempt = 0; attempt < 3 && !pulled; attempt++)
    pulled =
      (await command(['docker', 'pull', '-q', 'busybox:1.36'], tmpdir(), { timeoutMs: 120000 }))
        .code === 0;
  assert.ok(pulled, 'базовый образ busybox недоступен');
  await command(['docker', 'tag', 'busybox:1.36', BASE], tmpdir());
  const root = await mkdtemp(join(tmpdir(), 'devcontour-preview-'));
  const repo = join(root, 'repo');
  const port = await freePort();
  const store = new Store(join(root, 'data', 'state.sqlite'));
  const runner = { current: undefined as PreviewRunner | undefined };
  try {
    await git(tmpdir(), 'init', '-q', '-b', 'main', repo);
    await writeFile(join(repo, 'Dockerfile'), dockerfile(true));
    await writeFile(join(repo, 'compose.preview.yml'), compose);
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'app');
    const c = config({
      repository: repo,
      preview: {
        compose: 'main/compose.preview.yml',
        service: 'web',
        port,
        health: { path: '/health', timeoutMs: 20000 },
        version: { path: '/version' },
        smoke: {
          command: [
            process.execPath,
            '-e',
            "fetch(process.env.PREVIEW_URL+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
          ],
          timeoutMs: 30000,
        },
      },
    });
    const h = new DevContour(store, c);
    const b = h.createBoard('Preview board');
    h.addTask(b.id, input());
    h.approve(b.id);
    const change = new Workspace(h).create({
      title: 'Preview change',
      description: 'Release to try',
      boardIds: [b.id],
    });
    // Успешная совместная проверка на данном SHA — тем же правилом, что
    // требует выкладка: digest manifest, политика и постановка.
    const verify = async () => {
      const sha = await git(repo, 'rev-parse', 'HEAD');
      const tree = await git(repo, 'rev-parse', 'HEAD^{tree}');
      const manifest = { main: { sha, tree } };
      store.change('fixture.verified', (s) => {
        const cs = s.changeSets.find((x) => x.id === change.id)!;
        cs.verifications.push({
          id: randomUUID(),
          token: randomUUID(),
          leaseUntil: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: 'passed',
          policyDigest: new Workspace(h).policyDigest(),
          specDigest: snapshotDigest(changeSnapshot(s, cs)),
          tasks: [],
          boards: [],
          manifest,
          manifestDigest: digest(manifest),
          evidence: [],
        });
      });
      return digest(manifest);
    };
    const serving = async () =>
      (await (await fetch(`http://127.0.0.1:${port}/version`)).text()).trim();
    const commit = async (health: boolean, note: string) => {
      await writeFile(join(repo, 'Dockerfile'), dockerfile(health) + `# ${note}\n`);
      await git(repo, 'add', '.');
      await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', note);
    };
    runner.current = new PreviewRunner(h, join(root, 'data'));

    // 1. Первый релиз: собран из manifest, выложен, здоров, сценарий подтверждён.
    const first = await verify();
    const a = await runner.current.deploy(change.id);
    assert.equal(a.status, 'confirmed', a.error);
    assert.equal(a.release, 'r' + first.slice(0, 12));
    assert.equal(await serving(), a.release, 'URL называет проверенный релиз');
    assert.ok(a.artifactDigest && a.images?.web?.startsWith('sha256:'));

    // 2. Повтор того же manifest ничего не собирает и не выкладывает.
    const again = await runner.current.deploy(change.id);
    assert.equal(again.id, a.id);
    assert.equal(store.read().previews!.length, 1);

    // 3. Новый релиз занимает URL; прежний снят, но сохранён для отката.
    await commit(true, 'second');
    await verify();
    const bRelease = await runner.current.deploy(change.id);
    assert.equal(bRelease.status, 'confirmed', bRelease.error);
    assert.equal(bRelease.previous, a.release);
    assert.equal(await serving(), bRelease.release);
    assert.equal(store.read().previews!.find((p) => p.id === a.id)!.status, 'retired');

    // 4. Сломанный релиз (нет /health) не выдаётся за готовый: отказ на
    // пробном порту, URL продолжает обслуживать прежний релиз.
    await commit(false, 'broken');
    await verify();
    await assert.rejects(runner.current.deploy(change.id), /Health/);
    const broken = store.read().previews!.at(-1)!;
    assert.equal(broken.status, 'failed');
    assert.equal(await serving(), bRelease.release, 'автор не лишился работающей версии');
    assert.equal(
      store.read().previews!.find((p) => p.id === bRelease.id)!.status,
      'confirmed',
      'прежний релиз по-прежнему обслуживает URL',
    );

    // 5. Релиз здоров на пробном порту, но не на публичном: его снимают и
    // автоматически возвращают прежний — URL снова обслуживает прежний релиз.
    await commit(true, 'fails-after-switch');
    await verify();
    const r = runner.current as unknown as {
      check: (p: unknown, port: number, env: unknown) => Promise<void>;
    };
    const original = r.check.bind(runner.current);
    r.check = async (p, checked, env) => {
      if (checked === port) throw new Error('Health: публичный порт не отвечает');
      return original(p, checked, env);
    };
    await assert.rejects(runner.current.deploy(change.id), /публичный порт/);
    r.check = original;
    const switchedFailure = store.read().previews!.at(-1)!;
    assert.equal(switchedFailure.status, 'failed');
    assert.equal(switchedFailure.rolledBack, true, 'откат выполнен');
    assert.equal(await serving(), bRelease.release, 'URL вернули прежнему релизу');

    // 6. Явный откат возвращает релиз, обслуживавший URL до текущего.
    const restored = await runner.current.rollback();
    assert.equal(restored.id, a.id);
    assert.equal(await serving(), a.release);
    assert.equal(store.read().previews!.find((p) => p.id === bRelease.id)!.status, 'retired');
    // Снятые релизы, кроме прежнего, удалены вместе с данными.
    const projects = (
      await command(['docker', 'compose', 'ls', '-a', '--format', 'json'], tmpdir())
    ).stdout;
    assert.equal(projects.includes(broken.project), false, 'сломанный релиз удалён');
  } finally {
    await runner.current?.stop();
    for (const p of store.read().previews ?? [])
      await command(['docker', 'compose', '-p', p.project, 'down', '-v'], tmpdir()).catch(
        () => undefined,
      );
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Выкладка preview требует актуальной проверки и не идёт дважды одновременно', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Preview board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const change = new Workspace(f.h).create({
      title: 'Preview change',
      description: 'Release to try',
      boardIds: [b.id],
    });
    // Без раздела preview — отказ сразу, а не молча в фоне.
    assert.throws(() => new PreviewRunner(f.h, f.root).deploy(change.id), /Preview не настроен/);
    f.h.config.preview = {
      compose: 'main/compose.yml',
      service: 'web',
      port: 45999,
      health: { path: '/health', timeoutMs: 1000 },
    };
    // Без успешной совместной проверки выкладывать нечего.
    assert.throws(() => new Previews(f.h).start(change.id, 'k'), /актуальной успешной проверки/);

    const manifest = { main: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) } };
    f.store.change('fixture.verified', (s) => {
      const cs = s.changeSets.find((x) => x.id === change.id)!;
      cs.verifications.push({
        id: randomUUID(),
        token: randomUUID(),
        leaseUntil: 0,
        startedAt: new Date().toISOString(),
        status: 'passed',
        policyDigest: new Workspace(f.h).policyDigest(),
        specDigest: snapshotDigest(changeSnapshot(s, cs)),
        tasks: [],
        boards: [],
        manifest,
        manifestDigest: digest(manifest),
        evidence: [],
      });
    });
    const first = new Previews(f.h).start(change.id, 'k');
    assert.equal(first.status, 'building');
    assert.throws(() => new Previews(f.h).start(change.id, 'k'), /уже выполняется/);

    // Процесс, который вёл выкладку, умер: по истечении lease попытка
    // считается проваленной, и новая может начаться.
    f.store.change('fixture.expire', (s) => {
      s.previews![0].leaseUntil = 0;
    });
    new Previews(f.h).start(change.id, 'k');
    const [expired] = f.store.read().previews!;
    assert.equal(expired.status, 'failed');
    assert.match(expired.error!, /Истёк срок/);

    // Агент видит выкладки без токенов владения.
    const status = new AgentService(f.h).execute({ operation: 'preview_status' });
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes('"token"'), false);
  } finally {
    f.cleanup();
  }
});

test('Автор пробует проверенную версию в браузере и принимает её, не видя внутренних сущностей', async (t) => {
  // Полный пользовательский сценарий через настоящую панель, настоящий
  // сервер и настоящий Docker: обзор → выложить в preview → открыть
  // версию (URL называет проверенный релиз) → принять изменение. Проверка
  // ChangeSet подставлена записью с теми же digest, что даёт совместная
  // проверка: её собственный путь покрыт тестами workspace.
  const docker = await command(['docker', 'info', '--format', '{{.ServerVersion}}'], tmpdir());
  if (docker.code !== 0) {
    t.skip('Docker недоступен: ' + docker.stderr.trim().slice(0, 200));
    return;
  }
  await command(['docker', 'pull', '-q', 'busybox:1.36'], tmpdir(), { timeoutMs: 120000 });
  await command(['docker', 'tag', 'busybox:1.36', BASE], tmpdir());
  const root = await mkdtemp(join(tmpdir(), 'devcontour-preview-ui-'));
  const repo = join(root, 'repo');
  const port = await freePort();
  const store = new Store(join(root, 'data', 'state.sqlite'));
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let scheduler: Scheduler | undefined;
  try {
    await git(tmpdir(), 'init', '-q', '-b', 'main', repo);
    await writeFile(join(repo, 'Dockerfile'), dockerfile(true));
    await writeFile(join(repo, 'compose.preview.yml'), compose);
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'app');
    const h = new DevContour(
      store,
      config({
        repository: repo,
        preview: {
          compose: 'main/compose.preview.yml',
          service: 'web',
          port,
          health: { path: '/health', timeoutMs: 20000 },
          version: { path: '/version' },
        },
      }),
    );
    const b = h.createBoard('Каталог');
    h.addTask(b.id, input());
    h.approve(b.id);
    const change = new Workspace(h).create({
      title: 'Поиск по каталогу',
      description: 'Автор хочет попробовать поиск',
      boardIds: [b.id],
    });
    const sha = await git(repo, 'rev-parse', 'HEAD');
    const tree = await git(repo, 'rev-parse', 'HEAD^{tree}');
    const manifest = { main: { sha, tree } };
    store.change('fixture.verified', (s) => {
      const cs = s.changeSets.find((x) => x.id === change.id)!;
      cs.verifications.push({
        id: randomUUID(),
        token: randomUUID(),
        leaseUntil: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'passed',
        policyDigest: new Workspace(h).policyDigest(),
        specDigest: snapshotDigest(changeSnapshot(s, cs)),
        tasks: [],
        boards: [],
        manifest,
        manifestDigest: digest(manifest),
        evidence: [],
      });
    });
    scheduler = new Scheduler(h, join(root, 'data'));
    await scheduler.init();
    server = await serve(h, scheduler, { port: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url);

    // Обзор: продуктовое решение по проверенному изменению — сначала попробовать.
    await page.getByRole('heading', { name: 'Нужно ваше решение', exact: true }).waitFor();
    await page.getByText('Принять «Поиск по каталогу»').waitFor();
    await page.getByRole('button', { name: 'Выложить в preview' }).click();
    const open = page.getByRole('link', { name: 'Открыть версию' });
    await open.waitFor({ timeout: 180000 });
    const href = await open.getAttribute('href');
    assert.equal(href, `http://127.0.0.1:${port}`);
    const release = 'r' + digest(manifest).slice(0, 12);
    const version = await browser.newPage();
    await version.goto(href + '/version');
    assert.equal(
      (await version.textContent('body'))?.trim(),
      release,
      'по ссылке — проверенный релиз',
    );
    await version.close();

    // Попробовав, автор принимает изменение той же панелью.
    await page.getByRole('button', { name: 'Принять изменение' }).click();
    await page.getByText('Изменение принято').waitFor();
    assert.ok(store.read().changeSets[0].acceptance, 'изменение принято');
    // На экране не было внутренних идентификаторов вне раскрытий.
    const visible = await page.locator('main').innerText();
    assert.equal(/CHG-|T-[0-9a-f]{8}|R-[0-9a-f]{8}/.test(visible), false, visible.slice(0, 400));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await server.close();
    else await scheduler?.stop();
    for (const p of store.read().previews ?? [])
      await command(['docker', 'compose', '-p', p.project, 'down', '-v'], tmpdir()).catch(
        () => undefined,
      );
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
