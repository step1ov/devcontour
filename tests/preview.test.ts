import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { config, input, fixture } from './helpers.ts';
import { Previews, servingPreview } from '../src/core/preview.ts';
import { AgentService } from '../src/application/agent.ts';
import { authorOverview } from '../src/application/overview.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, digest } from '../src/core/service.ts';
import { Workspace, changeSnapshot, snapshotDigest } from '../src/core/workspace.ts';
import { PreviewRunner } from '../src/runner/preview.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { chromium } from '@playwright/test';
import { command, git } from '../src/runner/process.ts';
import type { PreviewConfig } from '../src/core/integrations.ts';

// Локальное имя базового образа: сборка не ходит в реестр за метаданными,
// и тест не зависит от сети в момент сборки.
const BASE = 'devcontour-preview-test-base:1';
// Приложение отдаёт свой релиз, содержимое проверенного файла и вариант
// сборки: по ним видно, что именно обслуживает URL.
const dockerfile = (health = true) => `FROM ${BASE}
ARG DEVCONTOUR_RELEASE
ARG VARIANT=A
COPY content.txt /www/content
RUN echo "$DEVCONTOUR_RELEASE" > /www/version && echo "$VARIANT" > /www/variant${health ? ' && echo ok > /www/health' : ''}
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
`;
const compose = (extra = '') => `services:
  web:
    build:
      context: ./main
      args:
        DEVCONTOUR_RELEASE: \${DEVCONTOUR_RELEASE}
        VARIANT: \${VARIANT:-A}
    ports:
      - "127.0.0.1:\${DEVCONTOUR_PREVIEW_PORT}:8080"
${extra}`;
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function dockerReady(t: TestContext) {
  const docker = await command(['docker', 'info', '--format', '{{.ServerVersion}}'], tmpdir());
  if (docker.code !== 0) {
    t.skip('Docker недоступен: ' + docker.stderr.trim().slice(0, 200));
    return false;
  }
  // Образ уже есть локально — сеть не нужна; иначе несколько попыток загрузки.
  let pulled = (await command(['docker', 'image', 'inspect', 'busybox:1.36'], tmpdir())).code === 0;
  for (let attempt = 0; attempt < 3 && !pulled; attempt++)
    pulled =
      (await command(['docker', 'pull', '-q', 'busybox:1.36'], tmpdir(), { timeoutMs: 120000 }))
        .code === 0;
  assert.ok(pulled, 'базовый образ busybox недоступен');
  await command(['docker', 'tag', 'busybox:1.36', BASE], tmpdir());
  return true;
}

/** Репозиторий, workspace и ChangeSet, который проверяется на текущем HEAD. */
async function stage(preview: Partial<PreviewConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-preview-'));
  const repo = join(root, 'repo');
  const port = await freePort();
  const store = new Store(join(root, 'data', 'state.sqlite'));
  await git(tmpdir(), 'init', '-q', '-b', 'main', repo);
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) await writeFile(join(repo, name), content);
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', message);
  };
  await commit(
    { Dockerfile: dockerfile(), 'compose.preview.yml': compose(), 'content.txt': 'A\n' },
    'app',
  );
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
        ...preview,
      },
    }),
  );
  const b = h.createBoard('Preview board');
  h.addTask(b.id, input());
  h.approve(b.id);
  const change = new Workspace(h).create({
    title: 'Preview change',
    description: 'Release to try',
    boardIds: [b.id],
  });
  // Успешная совместная проверка на данном SHA — тем же правилом, что требует
  // выкладка: digest manifest, политика и постановка.
  const verify = async (sha?: string) => {
    sha ??= await git(repo, 'rev-parse', 'HEAD');
    const tree = await git(repo, 'rev-parse', `${sha}^{tree}`);
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
    return 'r' + digest(manifest).slice(0, 12);
  };
  const read = async (path: string) => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}${path}`)).text()).trim();
    } catch {
      return '';
    }
  };
  /** Образ, из которого фактически запущен входной сервис выкладки. */
  const runningImage = async (project: string) => {
    const id = (
      await command(
        ['docker', 'ps', '--filter', `label=com.docker.compose.project=${project}`, '-q'],
        tmpdir(),
      )
    ).stdout.trim();
    return (
      await command(['docker', 'inspect', '--format', '{{.Image}}', id], tmpdir())
    ).stdout.trim();
  };
  const runner = new PreviewRunner(h, join(root, 'data'));
  return {
    root,
    repo,
    port,
    store,
    h,
    change,
    commit,
    verify,
    read,
    runningImage,
    runner,
    async cleanup() {
      await runner.stop();
      for (const p of store.read().previews ?? [])
        await command(['docker', 'compose', '-p', p.project, 'down', '-v'], tmpdir()).catch(
          () => undefined,
        );
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Preview выкладывает именно проверенный manifest, повтор проверяет себя на деле, откат возвращает свою выкладку', async (t) => {
  if (!(await dockerReady(t))) return;
  const f = await stage();
  try {
    // Проверен коммит A. После проверки появились коммит B и незакоммиченная
    // правка C: в сборку не должно попасть ни то, ни другое.
    const releaseA = await f.verify();
    await f.commit({ 'content.txt': 'B\n' }, 'later');
    await writeFile(join(f.repo, 'content.txt'), 'C\n');
    const a = await f.runner.deploy(f.change.id);
    assert.equal(a.status, 'unconfirmed', a.error);
    assert.equal(a.release, releaseA);
    assert.equal(await f.read('/version'), releaseA, 'URL называет проверенный релиз');
    assert.equal(
      await f.read('/content'),
      'A',
      'собран проверенный коммит, не HEAD и не рабочие файлы',
    );
    assert.equal(
      await f.runningImage(a.project),
      a.images!.web,
      'URL обслуживает записанный образ',
    );

    // Повтор того же manifest ничего не собирает.
    const again = await f.runner.deploy(f.change.id);
    assert.equal(again.id, a.id);
    assert.equal(f.store.read().previews!.length, 1);
    // Выкладка упала — повтор не выдаёт старое здоровье за текущее, а поднимает её.
    await command(['docker', 'compose', '-p', a.project, 'stop'], tmpdir());
    assert.equal(await f.read('/version'), '');
    const revived = await f.runner.deploy(f.change.id);
    assert.equal(revived.id, a.id);
    assert.equal(await f.read('/version'), releaseA, 'выкладка поднята и проверена');

    // Проверен новый код: новая выкладка занимает URL, прежняя снята, но сохранена.
    await git(f.repo, 'checkout', '--', 'content.txt');
    const releaseB = await f.verify();
    const b = await f.runner.deploy(f.change.id);
    assert.equal(b.previous, a.id);
    assert.equal(await f.read('/version'), releaseB);
    assert.equal(await f.read('/content'), 'B');
    assert.equal(f.store.read().previews!.find((p) => p.id === a.id)!.status, 'retired');

    // Явный откат возвращает именно ту выкладку, что обслуживала URL до этого.
    const restored = await f.runner.rollback();
    assert.equal(restored.id, a.id);
    assert.equal(await f.read('/version'), releaseA);
    assert.equal(await f.runningImage(a.project), a.images!.web);
    assert.equal(servingPreview(f.store.read())!.id, a.id);
  } finally {
    await f.cleanup();
  }
});

test('Preview не обходит границы: настройки, Compose, секреты, сборка, сценарий и неудачный откат', async (t) => {
  if (!(await dockerReady(t))) return;
  const secret = 'preview-secret-value-4411';
  process.env.DEVCONTOUR_TEST_PREVIEW_SECRET = secret;
  const f = await stage({
    environment: {
      inherit: [],
      values: { VARIANT: 'A' },
      secrets: { SECRET: 'DEVCONTOUR_TEST_PREVIEW_SECRET' },
    },
    smoke: {
      command: [process.execPath, '-e', 'console.log("token " + process.env.SECRET)'],
      timeoutMs: 30000,
    },
  });
  try {
    await f.verify();
    const a = await f.runner.deploy(f.change.id);
    assert.equal(a.status, 'confirmed', a.error);
    // Секрет из окружения не остаётся ни в логе сценария, ни в состоянии.
    assert.equal(JSON.stringify(f.store.read()).includes(secret), false, 'секрет снят redaction');
    assert.match(a.smoke!.log, /token /);

    // Тот же manifest, другие настройки: отдельная выкладка со своим
    // проектом и образом; откат возвращает прежнюю вместе с её образом.
    f.h.config.preview!.environment!.values.VARIANT = 'B';
    const b = await f.runner.deploy(f.change.id);
    assert.notEqual(b.project, a.project);
    assert.equal(await f.read('/variant'), 'B');
    const back = await f.runner.rollback();
    assert.equal(back.id, a.id);
    assert.equal(await f.read('/variant'), 'A');
    assert.equal(await f.runningImage(a.project), a.images!.web, 'откат вернул свой артефакт');

    // Compose, монтирующий каталог хоста, не собирается и не запускается.
    await f.commit(
      { 'compose.preview.yml': compose('    volumes:\n      - ./main:/src\n') },
      'bind mount',
    );
    await f.verify();
    await assert.rejects(f.runner.deploy(f.change.id), /границы preview/);
    assert.equal(f.store.read().previews!.at(-1)!.failure, 'compose-policy');
    assert.equal(await f.read('/variant'), 'A', 'URL остался у прежней выкладки');

    // Здоровая по /health выкладка, которая называет чужой релиз, URL не
    // получает: принадлежность проверяется не только ответом health.
    await f.commit(
      {
        'compose.preview.yml': compose(),
        Dockerfile: dockerfile().replace('echo "$DEVCONTOUR_RELEASE"', 'echo WRONG'),
      },
      'wrong version',
    );
    await f.verify();
    await assert.rejects(f.runner.deploy(f.change.id), /не называет релиз/);
    assert.equal(f.store.read().previews!.at(-1)!.failure, 'health');
    assert.equal(await f.read('/variant'), 'A', 'URL остался у прежней выкладки');

    // Ошибка сборки — техническая, а не «нужен Docker».
    await f.commit(
      { 'compose.preview.yml': compose(), Dockerfile: dockerfile() + 'NOTACOMMAND x\n' },
      'broken build',
    );
    await f.verify();
    await assert.rejects(f.runner.deploy(f.change.id));
    assert.equal(f.store.read().previews!.at(-1)!.failure, 'build');
    const overview = authorOverview(f.h);
    assert.equal(
      overview.decisions.some((d) => d.kind === 'access'),
      false,
    );
    assert.ok(
      overview.decisions.some((d) => d.kind === 'technical' && /не собрался/.test(d.title)),
    );

    // Сценарий, который не запустился, — «не подтверждено», без отката здоровой выкладки.
    await f.commit({ Dockerfile: dockerfile() }, 'fixed build');
    f.h.config.preview!.smoke = { command: ['devcontour-no-such-smoke'], timeoutMs: 10000 };
    await f.verify();
    const c = await f.runner.deploy(f.change.id);
    assert.equal(c.status, 'unconfirmed');
    assert.equal(servingPreview(f.store.read())!.id, c.id);

    // Откат к выкладке, которой больше нет, не удаётся — URL возвращают
    // текущей выкладке, и состояние это отражает.
    const previous = f.store.read().previews!.find((p) => p.id === c.previous)!;
    await command(['docker', 'compose', '-p', previous.project, 'down', '-v'], tmpdir());
    await assert.rejects(f.runner.rollback(), /текущая выкладка возвращена/);
    assert.equal(await f.runningImage(c.project), c.images!.web);
    assert.equal(servingPreview(f.store.read())!.id, c.id);
    assert.equal(f.store.read().previewLock, undefined, 'блокировка освобождена');
  } finally {
    delete process.env.DEVCONTOUR_TEST_PREVIEW_SECRET;
    await f.cleanup();
  }
});

test('Выкладка и откат ограждены: одна операция за раз, устаревшая ничего не меняет', () => {
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
    const previews = new Previews(f.h);
    // Без успешной совместной проверки выкладывать нечего.
    assert.throws(() => previews.start(change.id), /актуальной успешной проверки/);

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
    const first = previews.start(change.id);
    const p = previews.begin(
      first.token,
      {
        changeSetId: change.id,
        verificationId: first.verificationId,
        manifestDigest: first.manifestDigest,
      },
      'k',
    );
    assert.throws(() => previews.start(change.id), /уже выполняется/);

    // Владение истекло: попытка больше ничего не записывает — ни сборку, ни
    // здоровье, — и новая операция её перехватывает.
    f.store.change('fixture.expire', (s) => {
      s.previewLock!.leaseUntil = 0;
    });
    assert.equal(previews.owns(first.token), false);
    assert.throws(() => previews.built(first.token, p.id, { web: 'sha256:x' }), /устарела/);
    assert.throws(() => previews.healthy(first.token, p.id), /устарела/);
    const second = previews.start(change.id);
    assert.equal(f.store.read().previews![0].status, 'failed');
    assert.equal(f.store.read().previews![0].failure, 'lease');
    // Пока идёт выкладка, откат не начинается.
    assert.throws(() => previews.startRollback(), /Нет предыдущей|уже выполняется/);
    previews.release(second.token);

    // Агент видит выкладки без токенов владения.
    const status = new AgentService(f.h).execute({ operation: 'preview_status' });
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes('"token"'), false);
  } finally {
    f.cleanup();
  }
});

test('Автор пробует проверенную версию в браузере и принимает её, не видя внутренних сущностей', async (t) => {
  // Полный пользовательский сценарий через настоящую панель, сервер и
  // Docker: обзор → выложить в preview → открыть версию (URL называет
  // проверенный релиз) → доказательства → принять изменение. Проверка
  // ChangeSet подставлена записью с теми же digest, что даёт совместная
  // проверка: её собственный путь покрыт тестами workspace.
  if (!(await dockerReady(t))) return;
  const f = await stage();
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const scheduler = new Scheduler(f.h, join(f.root, 'data'));
  try {
    // Длинное допустимое название: вёрстка не должна обрезать действие.
    f.store.change('fixture.title', (s) => {
      s.changeSets[0].title = 'Поиск' + 'x'.repeat(175);
    });
    const release = await f.verify();
    await scheduler.init();
    server = await serve(f.h, scheduler, { port: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.url);

    await page.getByRole('heading', { name: 'Нужно ваше решение', exact: true }).waitFor();
    const deploy = page.getByRole('button', { name: 'Выложить в preview' });
    // Кнопка целиком в пределах экрана — не обрезана и не растянута.
    const box = (await deploy.boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
    await deploy.click();
    const open = page.getByRole('link', { name: 'Открыть версию' });
    await open.waitFor({ timeout: 180000 });
    const href = await open.getAttribute('href');
    const version = await browser.newPage();
    await version.goto(href + '/version');
    assert.equal(
      (await version.textContent('body'))?.trim(),
      release,
      'по ссылке — проверенный релиз',
    );
    await version.close();

    // Доказательства доступны по раскрытию и ведут к проверке изменения.
    await page.getByText('Доказательства').click();
    await page.getByText(release).waitFor();
    await page.getByRole('button', { name: 'Открыть проверку' }).click();
    await page.waitForFunction(
      (id) => document.activeElement?.id === 'changeset-' + id,
      f.change.id,
    );
    await page.getByRole('tab', { name: 'Обзор' }).click();

    // Попробовав, автор принимает изменение; фокус остаётся на сообщении об итоге.
    const accept = page.getByRole('button', { name: 'Принять изменение' });
    await accept.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Изменение принято').waitFor();
    assert.ok(f.store.read().changeSets[0].acceptance, 'изменение принято');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'status');
    const visible = await page.locator('main').innerText();
    assert.equal(/CHG-|T-[0-9a-f]{8}|R-[0-9a-f]{8}/.test(visible), false, visible.slice(0, 400));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await server.close();
    else await scheduler.stop();
    await f.cleanup();
  }
});
