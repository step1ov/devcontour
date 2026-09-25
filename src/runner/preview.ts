import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DevContour } from '../core/service.ts';
import { DomainError } from '../core/model.ts';
import { Previews, type Preview, type PreviewFailure } from '../core/preview.ts';
import { repository } from '../core/repositories.ts';
import { command } from './process.ts';
import { executionEnvironment } from './environment.ts';
import { runCheck } from './gates.ts';

/** Свободный порт на loopback для пробного запуска выкладки. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port')),
      );
    });
  });
}

/** Отказ с причиной по месту возникновения. */
export class PreviewError extends Error {
  constructor(
    readonly failure: PreviewFailure,
    message: string,
  ) {
    super(message);
  }
}

type Redact = (value: string) => string;
type Execution = { env: NodeJS.ProcessEnv; redact: Redact };
type ComposeService = {
  build?: { context?: string; additional_contexts?: Record<string, string> };
  ports?: { host_ip?: string; published?: string; target?: number }[];
  volumes?: { type?: string; source?: string }[];
  env_file?: ({ path?: string } | string)[];
  privileged?: boolean;
  network_mode?: string;
  pid?: string;
  ipc?: string;
  userns_mode?: string;
  cap_add?: string[];
  devices?: unknown[];
  security_opt?: string[];
  image?: string;
};

/**
 * Выкладка проверенного ChangeSet в локальный preview.
 *
 * Порядок выбран так, чтобы ни один отказ не выглядел готовностью и не лишал
 * автора работающей версии: новая выкладка сначала поднимается на временном
 * порту и проходит health, сверку версии и образов; только потом прежняя
 * останавливается, а новая занимает публичный порт и проверяется снова. Если
 * на публичном порту она не здорова, её снимают и возвращают прежнюю.
 *
 * Каждый внешний эффект выполняется только при действующем владении URL:
 * потерявшая его попытка не трогает ни URL, ни чужие выкладки.
 */
export class PreviewRunner {
  readonly state: Previews;
  private pending = new Set<Promise<unknown>>();
  constructor(
    readonly h: DevContour,
    readonly root: string,
  ) {
    this.state = new Previews(h);
  }
  /** Ключ workspace в именах compose-проектов: разные workspace не делят проекты. */
  private key() {
    return createHash('sha256').update(this.root).digest('hex').slice(0, 8);
  }
  private execution(): Execution {
    return executionEnvironment([this.h.config.environment, this.h.config.preview?.environment]);
  }
  /** Внешний эффект — только при действующем владении URL. */
  private guard(token: string, lost?: AbortSignal) {
    if (lost?.aborted || !this.state.owns(token))
      throw new PreviewError('lease', 'Владение выкладкой потеряно: внешние действия остановлены');
  }
  private async docker(
    args: string[],
    env: NodeJS.ProcessEnv,
    redact: Redact,
    failure: PreviewFailure = 'unknown',
    timeoutMs = 600000,
  ) {
    const result = await command(['docker', ...args], this.root, { env, timeoutMs, redact });
    if (result.code !== 0 || result.timedOut)
      throw new PreviewError(
        failure,
        redact(
          `docker ${args.slice(0, 4).join(' ')}: ${(result.stderr || result.stdout).trim().slice(-1200)}`,
        ),
      );
    return result.stdout;
  }
  /** Docker доступен — иначе это вопрос доступа, а не дефект выкладки. */
  private async assertDocker({ env, redact }: Execution) {
    const info = await command(['docker', 'info', '--format', '{{.ServerVersion}}'], this.root, {
      env,
      redact,
      timeoutMs: 30000,
    });
    if (info.code !== 0)
      throw new PreviewError(
        'docker-unavailable',
        'Docker недоступен: ' + redact(info.stderr.trim()).slice(0, 300),
      );
  }
  /** Действие над созданным проектом по имени — без compose-файла. */
  private project(
    p: Pick<Preview, 'project'>,
    action: 'stop' | 'start' | 'down',
    { env, redact }: Execution,
  ) {
    return this.docker(
      ['compose', '-p', p.project, action, ...(action === 'down' ? ['-v'] : [])],
      env,
      redact,
      'switch',
    );
  }
  private compose(
    p: Pick<Preview, 'project'>,
    context: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    redact: Redact,
    failure: PreviewFailure,
  ) {
    const config = this.h.config.preview!;
    return this.docker(
      [
        'compose',
        '-p',
        p.project,
        '--project-directory',
        context,
        '-f',
        join(context, config.compose),
        ...args,
      ],
      env,
      redact,
      failure,
    );
  }
  /**
   * Корень сборки из manifest: каждый компонент на своём проверенном SHA в
   * `<repositoryId>/`. Берётся только закоммиченное содержимое — рабочие
   * файлы checkout и более поздние коммиты в сборку не попадают.
   */
  async materialize(manifest: Record<string, { sha: string }>) {
    const context = await realpath(await mkdtemp(join(tmpdir(), 'dc-preview-')));
    for (const [id, { sha }] of Object.entries(manifest)) {
      const dest = join(context, id);
      await mkdir(dest, { recursive: true });
      const archive = join(context, `.${id}.tar`);
      const repo = repository(this.h.config, id);
      const made = await command(['git', 'archive', '--format=tar', '-o', archive, sha], repo.path);
      if (made.code !== 0)
        throw new PreviewError('build', `git archive ${id}@${sha}: ${made.stderr.trim()}`);
      // -m: время изменения — время распаковки, а не коммита. BuildKit
      // сравнивает файлы контекста по времени и размеру: два коммита одной
      // секунды с файлом того же размера давали кешированный слой прежнего
      // содержимого, и URL обслуживал не проверенный код.
      const unpacked = await command(['tar', '-xmf', archive, '-C', dest], context);
      if (unpacked.code !== 0)
        throw new PreviewError('build', `tar ${id}: ${unpacked.stderr.trim()}`);
      await rm(archive, { force: true });
    }
    return context;
  }
  /**
   * Compose исполняется с правами пользователя Docker, поэтому его смысл
   * ограничен явно — до сборки и запуска. Разрешено: контекст сборки и файлы
   * окружения внутри проверенного manifest; порт только у входного сервиса и
   * только на loopback с назначенным номером; именованные тома этого проекта.
   * Запрещено всё, что выходит за выкладку: bind-mount хоста (в том числе
   * сокет Docker), внешние тома и сети, privileged, host-сеть, pid и ipc,
   * добавленные capabilities и устройства.
   */
  private async assertCompose(
    p: Pick<Preview, 'project'>,
    context: string,
    manifest: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
    redact: Redact,
  ) {
    const config = this.h.config.preview!;
    const raw = JSON.parse(
      await this.compose(
        p,
        context,
        ['config', '--no-normalize', '--format', 'json'],
        env,
        redact,
        'compose-policy',
      ),
    ) as {
      services?: Record<string, ComposeService>;
      volumes?: Record<string, { external?: unknown } | null>;
      networks?: Record<string, { external?: unknown } | null>;
      configs?: Record<string, { file?: string } | null>;
      secrets?: Record<string, { file?: string } | null>;
    };
    const roots = Object.keys(manifest).map((id) => join(context, id));
    const inside = (path?: string) =>
      !!path && roots.some((r) => path === r || path.startsWith(r + sep));
    const problems: string[] = [];
    const services = raw.services ?? {};
    if (!services[config.service]) problems.push(`нет входного сервиса ${config.service}`);
    for (const [name, s] of Object.entries(services)) {
      if (s.build) {
        if (!inside(s.build.context))
          problems.push(`${name}: контекст сборки вне проверенного manifest`);
        for (const extra of Object.values(s.build.additional_contexts ?? {}))
          if (!inside(extra)) problems.push(`${name}: дополнительный контекст вне manifest`);
      }
      for (const file of s.env_file ?? []) {
        const path = typeof file === 'string' ? file : file.path;
        if (!inside(path)) problems.push(`${name}: env_file вне manifest`);
      }
      for (const v of s.volumes ?? [])
        if (v.type !== 'volume' && v.type !== 'tmpfs')
          problems.push(`${name}: том типа ${v.type ?? 'неизвестного'}`);
      if (s.privileged) problems.push(`${name}: privileged`);
      for (const [key, value] of [
        ['network_mode', s.network_mode],
        ['pid', s.pid],
        ['ipc', s.ipc],
        ['userns_mode', s.userns_mode],
      ] as const)
        if (value) problems.push(`${name}: ${key}=${value}`);
      if (s.cap_add?.length) problems.push(`${name}: cap_add`);
      if (s.devices?.length) problems.push(`${name}: devices`);
      if (s.security_opt?.length) problems.push(`${name}: security_opt`);
      const ports = s.ports ?? [];
      if (name !== config.service && ports.length)
        problems.push(`${name}: публикует порт, хотя входной сервис — ${config.service}`);
      if (name === config.service) {
        if (ports.length !== 1) problems.push(`${name}: должен публиковать ровно один порт`);
        for (const port of ports)
          if (port.host_ip !== '127.0.0.1' || port.published !== env.DEVCONTOUR_PREVIEW_PORT)
            problems.push(
              `${name}: порт должен быть 127.0.0.1:\${DEVCONTOUR_PREVIEW_PORT}, а не ${port.host_ip ?? '*'}:${port.published}`,
            );
      }
    }
    for (const [kind, entries] of [
      ['том', raw.volumes],
      ['сеть', raw.networks],
    ] as const)
      for (const [name, entry] of Object.entries(entries ?? {}))
        if (entry?.external) problems.push(`внешний ${kind} ${name}`);
    for (const [kind, entries] of [
      ['config', raw.configs],
      ['secret', raw.secrets],
    ] as const)
      for (const [name, entry] of Object.entries(entries ?? {}))
        if (entry?.file && !inside(entry.file)) problems.push(`${kind} ${name}: файл вне manifest`);
    if (problems.length)
      throw new PreviewError(
        'compose-policy',
        'Compose выходит за границы preview: ' + problems.join('; '),
      );
  }
  /** Ждать ответа 2xx; итог — последняя причина неудачи или undefined. */
  private async unhealthy(url: string, path: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let last = 'нет ответа';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url + path, { signal: AbortSignal.timeout(3000) });
        if (response.ok) return undefined;
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return `${path}: ${last}`;
  }
  /**
   * URL обслуживает именно эта выкладка: порт держит её compose-проект, её
   * контейнеры запущены из записанных образов, а если настроен путь версии —
   * приложение само называет релиз. Старое приложение по тому же URL за новое
   * не сойдёт, и выкладка того же manifest с другими настройками — тоже.
   */
  private async assertServes(p: Preview, port: number, { env, redact }: Execution) {
    const owners = (
      await this.docker(
        [
          'ps',
          '--filter',
          `publish=${port}`,
          '--format',
          '{{.Label "com.docker.compose.project"}}',
        ],
        env,
        redact,
        'health',
      )
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (owners.length !== 1 || owners[0] !== p.project)
      throw new PreviewError(
        'health',
        `Порт ${port} обслуживает не выкладка ${p.project}: ${owners.join(', ') || 'никто'}`,
      );
    const containers = (
      await this.docker(
        [
          'ps',
          '--filter',
          `label=com.docker.compose.project=${p.project}`,
          '--format',
          '{{.Label "com.docker.compose.service"}} {{.ID}}',
        ],
        env,
        redact,
        'health',
      )
    )
      .split('\n')
      .map((line) => line.trim().split(' '))
      .filter((parts) => parts.length === 2);
    if (!containers.some(([service]) => service === this.h.config.preview!.service))
      throw new PreviewError('health', 'Входной сервис выкладки не запущен');
    for (const [service, id] of containers) {
      const image = (
        await this.docker(['inspect', '--format', '{{.Image}}', id], env, redact, 'health')
      ).trim();
      if (p.images?.[service] !== image)
        throw new PreviewError(
          'health',
          `Сервис ${service} запущен не из записанного образа выкладки: ${image}`,
        );
    }
    const version = this.h.config.preview!.version;
    if (version) {
      const body = await (
        await fetch(`http://127.0.0.1:${port}${version.path}`, {
          signal: AbortSignal.timeout(5000),
        })
      ).text();
      if (!body.includes(p.release))
        throw new PreviewError(
          'health',
          `${version.path} не называет релиз ${p.release}: ${body.slice(0, 200)}`,
        );
    }
  }
  private async check(p: Preview, port: number, execution: Execution) {
    const config = this.h.config.preview!;
    const failure = await this.unhealthy(
      `http://127.0.0.1:${port}`,
      config.health.path,
      config.health.timeoutMs,
    );
    if (failure) throw new PreviewError('health', 'Health: ' + failure);
    await this.assertServes(p, port, execution);
  }
  /** Поддерживать владение, пока идёт операция; потеря — сигнал остановиться. */
  private keepAlive(token: string) {
    const lost = new AbortController();
    const timer = setInterval(
      () => {
        try {
          this.state.heartbeat(token);
        } catch {
          lost.abort();
        }
      },
      Math.max(1000, this.h.config.leaseMs / 3),
    );
    return { lost: lost.signal, stop: () => clearInterval(timer) };
  }
  /**
   * Начать выкладку. Захват в домене — синхронно: отказ (нет настроек,
   * операция уже идёт, нет актуальной проверки) приходит вызывающему сразу.
   */
  deploy(changeSetId: string): Promise<Preview> {
    if (!this.h.config.preview)
      throw new DomainError('Preview не настроен: добавьте раздел preview в config');
    const started = this.state.start(changeSetId);
    const work = this.deployRun(changeSetId, started);
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }
  private async deployRun(
    changeSetId: string,
    started: ReturnType<Previews['start']>,
  ): Promise<Preview> {
    const config = this.h.config.preview!;
    const { token } = started;
    const alive = this.keepAlive(token);
    const execution = this.execution();
    const input = {
      changeSetId,
      verificationId: started.verificationId,
      manifestDigest: started.manifestDigest,
    };
    let p: Preview | undefined;
    try {
      await this.assertDocker(execution);
      // Повтор того же manifest и политики: не собирать заново, но и не
      // выдавать историческое здоровье за текущее — проверить на деле и при
      // необходимости поднять остановленную выкладку.
      if (started.reusable) {
        const reuse = started.reusable;
        try {
          try {
            await this.check(reuse, config.port, execution);
          } catch {
            this.guard(token, alive.lost);
            await this.project(reuse, 'start', execution);
            await this.check(reuse, config.port, execution);
          }
          return this.state.reused(token, reuse.id, started.verificationId);
        } catch (error) {
          this.state.lost(
            token,
            reuse.id,
            'Выкладка не отвечает и не восстановилась: ' +
              execution.redact(error instanceof Error ? error.message : String(error)),
          );
        }
      }
      p = this.state.begin(token, input, this.key());
      return await this.build(p, started.manifest, execution, alive.lost);
    } catch (error) {
      // Отказ до создания выкладки — например, Docker недоступен — тоже
      // записывается: автор видит причину, а не молчание.
      if (!p && this.state.owns(token)) {
        const failed = this.state.begin(token, input, this.key());
        this.state.fail(token, failed.id, {
          error: execution.redact(error instanceof Error ? error.message : String(error)),
          failure: error instanceof PreviewError ? error.failure : 'unknown',
        });
      }
      throw error;
    } finally {
      alive.stop();
      this.state.release(token);
    }
  }
  private async build(
    initial: Preview,
    manifest: Record<string, { sha: string }>,
    execution: Execution,
    lost: AbortSignal,
  ): Promise<Preview> {
    const config = this.h.config.preview!;
    const { redact } = execution;
    let p = initial;
    const previous = this.h.store.read().previews?.find((x) => x.id === p.previous);
    let context: string | undefined;
    let switched = false;
    try {
      context = await this.materialize(manifest);
      const temp = await freePort();
      const base = { ...execution.env, DEVCONTOUR_RELEASE: p.release };
      const at = (port: number) => ({ ...base, DEVCONTOUR_PREVIEW_PORT: String(port) });
      const run: Execution = { env: base, redact };

      await this.assertCompose(p, context, manifest, at(temp), redact);
      this.guard(p.token, lost);
      await this.compose(p, context, ['build'], at(temp), redact, 'build');
      const images: Record<string, string> = {};
      const services = JSON.parse(
        await this.compose(p, context, ['config', '--format', 'json'], at(temp), redact, 'build'),
      ).services as Record<string, ComposeService>;
      for (const [name, service] of Object.entries(services)) {
        const image = service.build ? `${p.project}-${name}` : service.image!;
        if (!service.build) await this.docker(['pull', '-q', image], base, redact, 'build');
        images[name] = (
          await this.docker(
            ['image', 'inspect', '--format', '{{.Id}}', image],
            base,
            redact,
            'build',
          )
        ).trim();
      }
      p = this.state.built(p.token, p.id, images);

      // Пробный запуск: прежняя выкладка продолжает обслуживать URL.
      this.guard(p.token, lost);
      await this.compose(p, context, ['up', '-d'], at(temp), redact, 'health');
      await this.check(p, temp, run);

      // Переключение: прежняя останавливается, но не удаляется — к ней
      // возвращаются при отказе и по явному откату.
      this.guard(p.token, lost);
      switched = true;
      if (previous) await this.project(previous, 'stop', run);
      await this.compose(p, context, ['up', '-d'], at(config.port), redact, 'switch');
      p = this.state.deployed(p.token, p.id);
      await this.check(p, config.port, run);
      p = this.state.healthy(p.token, p.id);

      // Сценарий: его провал или невозможность запуска — «не подтверждено»,
      // а не повод снимать здоровую выкладку.
      let smoke: Preview['smoke'];
      if (config.smoke) {
        try {
          const result = await runCheck(this.h, {
            argv: config.smoke.command,
            cwd: context,
            env: { ...base, PREVIEW_URL: p.url },
            redact,
            timeoutMs: config.smoke.timeoutMs,
            signal: lost,
            write: [context],
            readable: [],
            controller: [this.root],
            settingsDir: join(this.root, 'artifacts', 'preview', p.id, 'smoke'),
          });
          smoke = {
            passed: result.code === 0 && !result.timedOut,
            summary: `Код выхода ${result.code}`,
            log: redact((result.stdout + '\n' + result.stderr).slice(-4000)),
          };
        } catch (error) {
          smoke = {
            passed: false,
            summary: 'Сценарий не запустился',
            log: redact(error instanceof Error ? error.message : String(error)),
          };
        }
      }
      const done = this.state.finish(p.token, p.id, smoke);
      await this.retire(run, done);
      return done;
    } catch (error) {
      const failure = error instanceof PreviewError ? error.failure : 'unknown';
      const message = redact(error instanceof Error ? error.message : String(error));
      let restored = false;
      let lostReason: string | undefined;
      // Компенсация — только своими ресурсами и только при действующем
      // владении: проект этой выкладки уникален, чужой выкладки она не
      // касается, а потерявшая владение попытка ничего не трогает.
      if (failure !== 'lease' && this.state.owns(p.token)) {
        await this.project(p, 'down', execution).catch(() => '');
        if (switched && previous) {
          try {
            await this.project(previous, 'start', execution);
            await this.check(previous, config.port, execution);
            restored = true;
          } catch (restore) {
            lostReason =
              'Прежняя выкладка не восстановилась после отказа новой: ' +
              redact(restore instanceof Error ? restore.message : String(restore));
          }
        }
      }
      this.state.fail(p.token, p.id, { error: message, failure, restored, lostReason });
      throw error instanceof PreviewError ? error : new PreviewError(failure, message);
    } finally {
      if (context) await rm(context, { recursive: true, force: true });
    }
  }
  /**
   * Снять старые выкладки. Остаётся только прежняя — для отката; остальные
   * удаляются вместе с их данными.
   */
  private async retire(execution: Execution, current: Preview) {
    for (const old of this.h.store.read().previews ?? [])
      if (
        old.id !== current.id &&
        old.id !== current.previous &&
        (old.status === 'retired' || old.status === 'failed')
      )
        await this.project(old, 'down', execution).catch(() => '');
  }
  /**
   * Явный откат: вернуть на URL выкладку, которая обслуживала его до текущей.
   * Она должна пройти ту же проверку здоровья, образов и версии. При любом
   * отказе текущую возвращают и проверяют; если и это не удалось, URL
   * помечается потерянным, а не выдаётся за работающий.
   */
  async rollback() {
    if (!this.h.config.preview) throw new DomainError('Preview не настроен');
    const config = this.h.config.preview;
    const { token, current, previous } = this.state.startRollback();
    const alive = this.keepAlive(token);
    const execution = this.execution();
    try {
      await this.assertDocker(execution);
      this.guard(token, alive.lost);
      await this.project(current, 'stop', execution);
      try {
        this.guard(token, alive.lost);
        await this.project(previous, 'start', execution);
        await this.check(previous, config.port, execution);
      } catch (error) {
        await this.project(previous, 'stop', execution).catch(() => '');
        let lostReason: string | undefined;
        try {
          await this.project(current, 'start', execution);
          await this.check(current, config.port, execution);
        } catch (back) {
          lostReason =
            'Откат не удался, и текущая выкладка не вернулась: ' +
            execution.redact(back instanceof Error ? back.message : String(back));
        }
        this.state.rollbackFailed(token, current.id, lostReason);
        throw new DomainError(
          (lostReason ?? 'Откат не удался, текущая выкладка возвращена') +
            ': ' +
            execution.redact(error instanceof Error ? error.message : String(error)),
        );
      }
      return this.state.restore(token, previous.id, current.id);
    } finally {
      alive.stop();
      this.state.release(token);
    }
  }
  async stop() {
    await Promise.allSettled([...this.pending]);
  }
}
