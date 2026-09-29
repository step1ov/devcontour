import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
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

    // Все файловые источники сборки — внутри manifest, после разрешения
    // symlink; тома и сети не делятся с другими выкладками и не подключают
    // хост через драйвер. Внешний Dockerfile собирал образ, которого нет в
    // проверенном manifest.
    const outside = await mkdtemp(join(tmpdir(), 'devcontour-outside-'));
    await writeFile(join(outside, 'Dockerfile'), dockerfile());
    await symlink(join(outside, 'Dockerfile'), join(f.repo, 'Linked.Dockerfile'));
    // Внешний файл окружения: Compose прочитал бы его значения в environment
    // ещё при разборе, и ссылка на источник исчезла бы из вывода.
    const external = join(outside, 'external.env');
    await writeFile(external, 'OUTSIDE=outside-manifest-sentinel\n');
    await writeFile(join(outside, 'other.yml'), 'services:\n  side:\n    image: busybox:1.36\n');
    await symlink(external, join(f.repo, 'linked.env'));
    const withBuild = (line: string) =>
      compose().replace('      context: ./main\n', `      context: ./main\n${line}\n`);
    const refused: [string, string, RegExp][] = [
      [
        withBuild('      dockerfile: ../../outside/Dockerfile'),
        'relative dockerfile',
        /Dockerfile вне manifest/,
      ],
      [
        withBuild(`      dockerfile: ${join(outside, 'Dockerfile')}`),
        'absolute dockerfile',
        /Dockerfile вне manifest/,
      ],
      [
        withBuild('      dockerfile: Linked.Dockerfile'),
        'symlinked dockerfile',
        /Dockerfile вне manifest/,
      ],
      [
        compose('    volumes:\n      - data:/d\n') +
          `volumes:\n  data:\n    name: shared-preview\n    driver_opts:\n      type: none\n      o: bind\n      device: ${outside}\n`,
        'shared bind volume',
        /явное глобальное имя shared-preview.*параметры драйвера/,
      ],
      [
        compose('    networks:\n      - n\n') + 'networks:\n  n:\n    name: shared-net\n',
        'shared network',
        /сеть n: явное глобальное имя shared-net/,
      ],
      [compose(`    env_file: ${external}\n`), 'absolute env_file', /env_file вне manifest/],
      [
        compose('    env_file:\n      - path: ../../outside.env\n        required: false\n'),
        'relative env_file',
        /env_file вне manifest/,
      ],
      [compose('    env_file: ./main/linked.env\n'), 'symlinked env_file', /env_file вне manifest/],
      [
        compose('    env_file: ${HOME}/preview.env\n'),
        'env_file from variable',
        /env_file с подстановкой переменной/,
      ],
      [compose(`    label_file: ${external}\n`), 'external label_file', /label_file вне manifest/],
      [
        `include:\n  - ${join(outside, 'other.yml')}\n` + compose(),
        'external include',
        /include другого файла Compose/,
      ],
      [
        compose(`    extends:\n      file: ${join(outside, 'other.yml')}\n      service: side\n`),
        'external extends',
        /web: extends из другого файла Compose/,
      ],
    ];
    for (const [text, message, reason] of refused) {
      await f.commit({ 'compose.preview.yml': text }, message);
      await f.verify();
      await assert.rejects(f.runner.deploy(f.change.id), reason, message);
      assert.equal(f.store.read().previews!.at(-1)!.failure, 'compose-policy', message);
      assert.equal(await f.read('/variant'), 'A', `${message}: URL остался у прежней выкладки`);
    }
    await rm(join(f.repo, 'Linked.Dockerfile'));
    await rm(join(f.repo, 'linked.env'));

    // Неявный Dockerfile — тот же источник сборки: symlink наружу отклоняется
    // политикой, а не оставляется на усмотрение сборщика.
    await rm(join(f.repo, 'Dockerfile'));
    await symlink(join(outside, 'Dockerfile'), join(f.repo, 'Dockerfile'));
    await f.commit({ 'compose.preview.yml': compose() }, 'implicit dockerfile');
    await f.verify();
    await assert.rejects(f.runner.deploy(f.change.id), /web: Dockerfile вне manifest/);
    assert.equal(f.store.read().previews!.at(-1)!.failure, 'compose-policy');
    await rm(join(f.repo, 'Dockerfile'));
    await rm(outside, { recursive: true, force: true });

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
    // Файл окружения внутри manifest разрешён и доходит до контейнера.
    await f.commit(
      {
        Dockerfile: dockerfile(),
        'compose.preview.yml': compose('    env_file: ./main/local.env\n'),
        'local.env': 'LOCAL_INPUT=inside-manifest\n',
      },
      'fixed build',
    );
    f.h.config.preview!.smoke = { command: ['devcontour-no-such-smoke'], timeoutMs: 10000 };
    await f.verify();
    const c = await f.runner.deploy(f.change.id);
    assert.equal(c.status, 'unconfirmed');
    assert.equal(servingPreview(f.store.read())!.id, c.id);
    const container = (
      await command(
        ['docker', 'ps', '--filter', `label=com.docker.compose.project=${c.project}`, '-q'],
        tmpdir(),
      )
    ).stdout.trim();
    const envs = (
      await command(['docker', 'inspect', '--format', '{{json .Config.Env}}', container], tmpdir())
    ).stdout;
    assert.match(envs, /LOCAL_INPUT=inside-manifest/);

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

test('Потерявшая владение операция не трогает внешние ресурсы: откат, компенсация и уборка', async () => {
  // Настоящие Store, Previews и PreviewRunner; внешние действия Docker заменены
  // регистратором, чтобы гонку передачи владения можно было задать точно.
  const f = fixture();
  try {
    f.h.config.preview = {
      compose: 'main/compose.yml',
      service: 'web',
      port: 45998,
      health: { path: '/health', timeoutMs: 1000 },
    };
    const board = f.h.createBoard('Preview board');
    f.h.addTask(board.id, input());
    f.h.approve(board.id);
    const change = new Workspace(f.h).create({
      title: 'Preview change',
      description: 'Release to try',
      boardIds: [board.id],
    });
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
    const state = new Previews(f.h);
    /** Выкладка, завершённая другим владельцем, — обычным путём домена. */
    const finish = () => {
      const started = state.start(change.id);
      const p = state.begin(
        started.token,
        {
          changeSetId: change.id,
          verificationId: started.verificationId,
          manifestDigest: started.manifestDigest,
        },
        'k',
      );
      state.built(started.token, p.id, { web: 'sha256:fixture' });
      state.deployed(started.token, p.id);
      state.healthy(started.token, p.id);
      return state.finish(started.token, p.id);
    };
    /** Перехват: lease текущей операции истёк, новый владелец выложил своё. */
    const takeover = () => {
      f.store.change('fixture.expire', (s) => {
        s.previewLock!.leaseUntil = 0;
      });
      return finish();
    };
    const runner = (onProject: (id: string, action: string) => void) => {
      const r = new PreviewRunner(f.h, f.root) as unknown as Record<string, unknown>;
      const effects: { id: string; action: string; owner: boolean }[] = [];
      let token = '';
      r.assertDocker = async () => {};
      r.check = async () => {};
      r.project = (p: { id: string }, action: string) => {
        token ||= f.store.read().previewLock!.token;
        effects.push({ id: p.id, action, owner: state.owns(token) });
        onProject(p.id, action);
        return Promise.resolve('');
      };
      return { r, effects };
    };

    // 1. Откат: после остановки текущей выкладки владение перехвачено.
    const a = finish();
    const b = finish();
    let successor = '';
    const first = runner((id, action) => {
      if (id === b.id && action === 'stop' && !successor) successor = takeover().id;
    });
    await assert.rejects((first.r.rollback as () => Promise<unknown>)(), /Владение/);
    assert.deepEqual(
      first.effects.filter((e) => !e.owner),
      [],
      'после потери владения ни одного внешнего действия',
    );
    assert.equal(servingPreview(f.store.read())?.id, successor, 'URL у преемника');
    assert.equal(
      f.store.read().previews!.find((x) => x.id === successor)?.lost,
      undefined,
      'состояние преемника не тронуто',
    );

    // 2. Компенсация отката: прежняя не поднялась, во время компенсации
    // владение перехвачено — дальше ничего не запускается.
    const current = f.store.read().previews!.find((x) => x.id === successor)!;
    let second = '';
    const compensating = runner((id, action) => {
      if (id === current.previous && action === 'stop' && !second) second = takeover().id;
    });
    compensating.r.check = (p: { id: string }) =>
      p.id === current.previous
        ? Promise.reject(new Error('прежняя не отвечает'))
        : Promise.resolve();
    await assert.rejects((compensating.r.rollback as () => Promise<unknown>)());
    assert.deepEqual(
      compensating.effects.filter((e) => !e.owner),
      [],
    );
    assert.equal(servingPreview(f.store.read())?.id, second);
    assert.equal(f.store.read().previews!.find((x) => x.id === second)?.lost, undefined);

    // 3. Компенсация выкладки: переключение не удалось, во время снятия своей
    // выкладки владение перехвачено — прежнюю она уже не поднимает.
    const started = state.start(change.id);
    const p = state.begin(
      started.token,
      {
        changeSetId: change.id,
        verificationId: started.verificationId,
        manifestDigest: started.manifestDigest,
      },
      'k',
    );
    let third = '';
    const deploying = runner((id, action) => {
      if (id === p.id && action === 'down' && !third) third = takeover().id;
    });
    const context = await mkdtemp(join(tmpdir(), 'devcontour-context-'));
    deploying.r.materialize = () => Promise.resolve(context);
    deploying.r.assertCompose = async () => {};
    deploying.r.docker = () => Promise.resolve('sha256:fixture');
    deploying.r.compose = (_p: unknown, _c: string, args: string[], env: NodeJS.ProcessEnv) => {
      if (args[0] === 'config')
        return Promise.resolve(JSON.stringify({ services: { web: { build: {} } } }));
      if (args[0] === 'up' && env.DEVCONTOUR_PREVIEW_PORT === '45998')
        return Promise.reject(new Error('публичный порт занят'));
      return Promise.resolve('');
    };
    await assert.rejects(
      (
        deploying.r.build as (
          p: unknown,
          m: unknown,
          e: unknown,
          l: AbortSignal,
        ) => Promise<unknown>
      )(p, manifest, { env: {}, redact: (s: string) => s }, new AbortController().signal),
    );
    assert.deepEqual(
      deploying.effects.filter((e) => !e.owner),
      [],
      'прежнюю выкладку поднимает только владелец',
    );
    assert.equal(servingPreview(f.store.read())?.id, third);
    assert.equal(f.store.read().previews!.find((x) => x.id === third)?.lost, undefined);

    // 4. Уборка — тоже внешний эффект: без владения ничего не снимается.
    const cleanup = runner(() => {});
    const done = f.store.read().previews!.find((x) => x.id === third)!;
    await assert.rejects(
      (cleanup.r.retire as (e: unknown, c: unknown, l: AbortSignal) => Promise<void>)(
        { env: {}, redact: (s: string) => s },
        { ...done, token: 'expired-token' },
        new AbortController().signal,
      ),
      /Владение/,
    );
    assert.deepEqual(cleanup.effects, []);

    // 5. Переключение выкладки: пока останавливалась прежняя, владение
    // перехвачено — публичный порт новая уже не занимает.
    const next = state.start(change.id);
    const q = state.begin(
      next.token,
      {
        changeSetId: change.id,
        verificationId: next.verificationId,
        manifestDigest: next.manifestDigest,
      },
      'k',
    );
    let fifth = '';
    const switching = runner((id, action) => {
      if (id === q.previous && action === 'stop' && !fifth) fifth = takeover().id;
    });
    switching.r.materialize = () => Promise.resolve(context);
    switching.r.assertCompose = async () => {};
    switching.r.docker = () => Promise.resolve('sha256:fixture');
    switching.r.compose = (_p: unknown, _c: string, args: string[], env: NodeJS.ProcessEnv) => {
      if (args[0] === 'config')
        return Promise.resolve(JSON.stringify({ services: { web: { build: {} } } }));
      switching.effects.push({
        id: q.id,
        action: `${args.join(' ')} :${env.DEVCONTOUR_PREVIEW_PORT}`,
        owner: state.owns(next.token),
      });
      return Promise.resolve('');
    };
    await assert.rejects(
      (
        switching.r.build as (
          p: unknown,
          m: unknown,
          e: unknown,
          l: AbortSignal,
        ) => Promise<unknown>
      )(q, manifest, { env: {}, redact: (s: string) => s }, new AbortController().signal),
      /Владение/,
    );
    assert.ok(fifth, 'перехват произошёл во время остановки прежней');
    assert.deepEqual(
      switching.effects.filter((e) => !e.owner),
      [],
      'после потери владения публичный порт не занимается',
    );
    assert.equal(
      switching.effects.some((e) => e.action.endsWith(':45998')),
      false,
    );
    assert.equal(servingPreview(f.store.read())?.id, fifth, 'URL у преемника');
    assert.equal(f.store.read().previews!.find((x) => x.id === fifth)?.lost, undefined);

    // Без перехвата то же переключение проходит до конца: проверка владения
    // не мешает законной выкладке.
    const clean = state.start(change.id);
    const r = state.begin(
      clean.token,
      {
        changeSetId: change.id,
        verificationId: clean.verificationId,
        manifestDigest: clean.manifestDigest,
      },
      'k',
    );
    const legit = runner(() => {});
    legit.r.materialize = () => Promise.resolve(context);
    legit.r.assertCompose = async () => {};
    legit.r.docker = () => Promise.resolve('sha256:fixture');
    legit.r.compose = switching.r.compose;
    const deployed = await (
      legit.r.build as (
        p: unknown,
        m: unknown,
        e: unknown,
        l: AbortSignal,
      ) => Promise<{ id: string }>
    )(r, manifest, { env: {}, redact: (s: string) => s }, new AbortController().signal);
    assert.equal(servingPreview(f.store.read())?.id, deployed.id);
    await rm(context, { recursive: true, force: true });
    void a;
  } finally {
    f.cleanup();
  }
});

test('Обзор называет неисправность текущей выкладки, а не последнюю из истории', () => {
  const f = fixture();
  try {
    f.h.config.preview = {
      compose: 'main/compose.yml',
      service: 'web',
      port: 45997,
      health: { path: '/health', timeoutMs: 1000 },
    };
    const board = f.h.createBoard('Preview board');
    f.h.addTask(board.id, input());
    f.h.approve(board.id);
    const change = new Workspace(f.h).create({
      title: 'Preview change',
      description: 'Release to try',
      boardIds: [board.id],
    });
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
    const state = new Previews(f.h);
    const begin = () => {
      const started = state.start(change.id);
      const p = state.begin(
        started.token,
        {
          changeSetId: change.id,
          verificationId: started.verificationId,
          manifestDigest: started.manifestDigest,
        },
        'k',
      );
      return { token: started.token, p };
    };
    const finish = () => {
      const { token, p } = begin();
      state.built(token, p.id, { web: 'sha256:fixture' });
      state.deployed(token, p.id);
      state.healthy(token, p.id);
      return state.finish(token, p.id);
    };
    const outage = () =>
      authorOverview(f.h).decisions.find((d) => d.title === 'Версия в preview не отвечает');
    const markLost = (id: string, reason: string) => {
      const claim = state.start(change.id);
      state.lost(claim.token, id, reason);
      state.release(claim.token);
    };

    // Текущая выкладка потеряна и её никто не сменил — это текущий отказ.
    const a = finish();
    markLost(a.id, 'контейнер A пропал');
    assert.equal(outage()?.detail, 'контейнер A пропал');

    // A потеряна, затем B выложена успешно: B обслуживает URL, отказа нет;
    // потеря A осталась в истории.
    const b = finish();
    assert.equal(servingPreview(f.store.read())?.id, b.id);
    assert.equal(outage(), undefined, 'старая потеря не выдаётся за текущую');
    assert.equal(f.store.read().previews!.find((x) => x.id === a.id)?.lost, 'контейнер A пропал');

    // C не выложилась, B возвращена: URL у B, отказа «не отвечает» нет.
    const { token, p: c } = begin();
    state.fail(token, c.id, { error: 'сборка упала', failure: 'build', restored: true });
    assert.equal(servingPreview(f.store.read())?.id, b.id);
    assert.equal(outage(), undefined);

    // Теперь потеряна сама B — отказ снова текущий, с её причиной.
    markLost(b.id, 'контейнер B пропал');
    assert.equal(outage()?.detail, 'контейнер B пропал');
  } finally {
    f.cleanup();
  }
});
