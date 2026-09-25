import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevContour } from '../core/service.ts';
import { DomainError } from '../core/model.ts';
import { Previews, servingPreview, type Preview } from '../core/preview.ts';
import { repository } from '../core/repositories.ts';
import { command } from './process.ts';
import { executionEnvironment } from './environment.ts';
import { runCheck } from './gates.ts';

/** Свободный порт на loopback для пробного запуска релиза. */
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

/**
 * Выкладка проверенного ChangeSet в локальный preview.
 *
 * Порядок выбран так, чтобы ни один отказ не выглядел готовностью и не лишал
 * автора работающей версии: новый релиз сначала поднимается на временном
 * порту и проходит health и сверку версии; только потом прежний релиз
 * останавливается, а новый занимает публичный порт и проверяется снова. Если
 * на публичном порту он не здоров, его снимают и возвращают прежний.
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
  private env(extra: NodeJS.ProcessEnv) {
    return executionEnvironment(
      [this.h.config.environment, this.h.config.preview?.environment],
      extra,
    );
  }
  private async docker(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 600000) {
    const result = await command(['docker', ...args], this.root, { env, timeoutMs });
    if (result.code !== 0 || result.timedOut)
      throw new Error(
        `docker ${args.slice(0, 4).join(' ')}: ${(result.stderr || result.stdout).trim().slice(-800)}`,
      );
    return result.stdout;
  }
  /**
   * Действие над уже созданным проектом по его имени — без compose-файла:
   * у прежнего релиза он мог быть другим, а контейнеры и так помечены.
   */
  private project(
    p: Pick<Preview, 'project'>,
    action: 'stop' | 'start' | 'down',
    env: NodeJS.ProcessEnv,
  ) {
    return this.docker(
      ['compose', '-p', p.project, action, ...(action === 'down' ? ['-v'] : [])],
      env,
    );
  }
  private compose(
    p: Pick<Preview, 'project'>,
    context: string,
    args: string[],
    env: NodeJS.ProcessEnv,
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
    );
  }
  /**
   * Корень сборки из manifest: каждый компонент на своём проверенном SHA в
   * `<repositoryId>/`. Берётся только закоммиченное содержимое — рабочие
   * файлы checkout в сборку не попадают.
   */
  private async materialize(manifest: Record<string, { sha: string }>) {
    const context = await realpath(await mkdtemp(join(tmpdir(), 'dc-preview-')));
    for (const [id, { sha }] of Object.entries(manifest)) {
      const dest = join(context, id);
      await mkdir(dest, { recursive: true });
      const archive = join(context, `.${id}.tar`);
      const repo = repository(this.h.config, id);
      const made = await command(['git', 'archive', '--format=tar', '-o', archive, sha], repo.path);
      if (made.code !== 0) throw new Error(`git archive ${id}@${sha}: ${made.stderr.trim()}`);
      const unpacked = await command(['tar', '-xf', archive, '-C', dest], context);
      if (unpacked.code !== 0) throw new Error(`tar ${id}: ${unpacked.stderr.trim()}`);
      await rm(archive, { force: true });
    }
    return context;
  }
  /** Ждать ответа 2xx; итог — последняя причина неудачи или undefined. */
  private async healthy(url: string, path: string, timeoutMs: number) {
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
   * URL обслуживает именно этот релиз: порт держит его compose-проект, а
   * если настроен путь версии — приложение само называет релиз. Старое
   * приложение по тому же URL за новое не сойдёт.
   */
  private async assertServes(p: Preview, url: string, port: number, env: NodeJS.ProcessEnv) {
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
      )
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (owners.length !== 1 || owners[0] !== p.project)
      throw new Error(
        `Порт ${port} обслуживает не релиз ${p.release}: ${owners.join(', ') || 'никто'}`,
      );
    const version = this.h.config.preview!.version;
    if (version) {
      const body = await (
        await fetch(url + version.path, { signal: AbortSignal.timeout(5000) })
      ).text();
      if (!body.includes(p.release))
        throw new Error(`${version.path} не называет релиз ${p.release}: ${body.slice(0, 200)}`);
    }
  }
  private async check(p: Preview, port: number, env: NodeJS.ProcessEnv) {
    const config = this.h.config.preview!;
    const url = `http://127.0.0.1:${port}`;
    const failure = await this.healthy(url, config.health.path, config.health.timeoutMs);
    if (failure) throw new Error('Health: ' + failure);
    await this.assertServes(p, url, port, env);
  }
  /**
   * Начать выкладку. Захват в домене — синхронно: отказ (нет настроек,
   * выкладка уже идёт, нет актуальной проверки) приходит вызывающему сразу,
   * а не теряется в фоне. Повтор того же manifest возвращает обслуживающий
   * релиз без сборки.
   */
  deploy(changeSetId: string): Promise<Preview> {
    if (!this.h.config.preview)
      throw new DomainError('Preview не настроен: добавьте раздел preview в config');
    const started = this.state.start(changeSetId, this.key());
    if ('reused' in started) return Promise.resolve(started);
    const work = this.deployRun(started);
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }
  private async deployRun(p: Preview & { manifest: Record<string, { sha: string }> }) {
    const config = this.h.config.preview!;
    const state = this.h.store.read();
    const previous = state.previews?.find((x) => x.release === p.previous && x.id !== p.id);
    const heartbeat = setInterval(
      () => {
        try {
          this.state.heartbeat(p.id, p.token);
        } catch {
          /* The attempt was fenced; the next domain write reports it. */
        }
      },
      Math.max(1000, this.h.config.leaseMs / 3),
    );
    let context: string | undefined;
    let switched = false;
    try {
      context = await this.materialize(p.manifest);
      const temp = await freePort();
      const base = this.env({ DEVCONTOUR_RELEASE: p.release }).env;
      const at = (port: number) => ({ ...base, DEVCONTOUR_PREVIEW_PORT: String(port) });

      await this.compose(p, context, ['build'], at(temp));
      const images: Record<string, string> = {};
      const services = JSON.parse(
        await this.compose(p, context, ['config', '--format', 'json'], at(temp)),
      ).services as Record<string, { image?: string; build?: unknown }>;
      for (const [name, service] of Object.entries(services)) {
        const image = service.image ?? `${p.project}-${name}`;
        images[name] = (
          await this.docker(['image', 'inspect', '--format', '{{.Id}}', image], base)
        ).trim();
      }
      this.state.built(p.id, p.token, images);

      // Пробный запуск: прежний релиз продолжает обслуживать URL.
      await this.compose(p, context, ['up', '-d'], at(temp));
      await this.check(p, temp, base);

      // Переключение: прежний останавливается, но не удаляется — к нему
      // возвращаются при отказе и по явному откату.
      if (previous) await this.project(previous, 'stop', base).catch(() => '');
      switched = true;
      await this.compose(p, context, ['up', '-d'], at(config.port));
      this.state.deployed(p.id, p.token);
      await this.check(p, config.port, base);
      this.state.healthy(p.id, p.token);

      let smoke: Preview['smoke'];
      if (config.smoke) {
        const dir = join(this.root, 'artifacts', 'preview', p.id);
        const result = await runCheck(this.h, {
          argv: config.smoke.command,
          cwd: context,
          env: { ...base, PREVIEW_URL: p.url },
          timeoutMs: config.smoke.timeoutMs,
          signal: new AbortController().signal,
          write: [context],
          readable: [],
          controller: [this.root],
          settingsDir: join(dir, 'smoke'),
        });
        smoke = {
          passed: result.code === 0 && !result.timedOut,
          summary: `Код выхода ${result.code}`,
          log: (result.stdout + '\n' + result.stderr).slice(-4000),
        };
      }
      const done = this.state.finish(p.id, p.token, smoke);
      await this.retire(base, p);
      return done;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let rolledBack = false;
      if (context) {
        await this.project(p, 'down', this.env({}).env).catch(() => '');
        if (switched && previous) {
          await this.project(previous, 'start', this.env({}).env).catch(() => '');
          rolledBack = !(await this.healthy(
            `http://127.0.0.1:${config.port}`,
            config.health.path,
            config.health.timeoutMs,
          ));
        }
      }
      this.state.fail(p.id, p.token, message, rolledBack);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      clearInterval(heartbeat);
      if (context) await rm(context, { recursive: true, force: true });
    }
  }
  /**
   * Снять старые релизы. Остаётся только прежний — для отката; остальные
   * удаляются вместе с их данными.
   */
  private async retire(env: NodeJS.ProcessEnv, current: Preview) {
    for (const old of this.h.store.read().previews ?? [])
      if (
        old.id !== current.id &&
        old.release !== current.previous &&
        old.release !== current.release &&
        (old.status === 'retired' || old.status === 'failed')
      )
        await this.project(old, 'down', env).catch(() => '');
  }
  /**
   * Явный откат: вернуть на URL релиз, который обслуживал его до текущего.
   * Он должен пройти ту же проверку здоровья и принадлежности порта.
   */
  async rollback() {
    const config = this.h.config.preview;
    if (!config) throw new DomainError('Preview не настроен');
    const s = this.h.store.read();
    const current = servingPreview(s);
    const previous = s.previews?.find((p) => p.release === current?.previous);
    if (!current || !previous) throw new DomainError('Нет предыдущего релиза для отката');
    const env = this.env({}).env;
    await this.project(current, 'stop', env);
    await this.project(previous, 'start', env);
    const failure = await this.healthy(
      `http://127.0.0.1:${config.port}`,
      config.health.path,
      config.health.timeoutMs,
    );
    if (failure) {
      await this.project(previous, 'stop', env).catch(() => '');
      await this.project(current, 'start', env).catch(() => '');
      throw new DomainError('Откат не удался, текущий релиз возвращён: ' + failure);
    }
    await this.assertServes(previous, `http://127.0.0.1:${config.port}`, config.port, env);
    return this.state.restore(previous.id, current.id);
  }
  async stop() {
    await Promise.allSettled([...this.pending]);
  }
}
