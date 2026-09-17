import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Harness, digest } from '../core/service.ts';
import { Deliveries } from '../core/delivery.ts';
import { repositories } from '../core/repositories.ts';
import type { Repository } from '../core/model.ts';
import type { ForgeConnection } from '../core/integrations.ts';
import { executionEnvironment, redactor } from './environment.ts';
import { command, git } from './process.ts';

const checkSchema = z.object({
  name: z.string(),
  sha: z.string(),
  status: z.string(),
  url: z.string().optional(),
});
export const observationSchema = z
  .object({
    sourceSha: z.string().optional(),
    mergedSha: z.string().optional(),
    state: z.enum(['absent', 'published', 'merged']),
    number: z.number().int().optional(),
    url: z.string().optional(),
    checks: z.array(checkSchema),
  })
  .superRefine((v, ctx) => {
    if (v.state !== 'absent' && !v.sourceSha)
      ctx.addIssue({ code: 'custom', message: 'Forge должен вернуть source SHA' });
  });
export type RemoteObservation = z.infer<typeof observationSchema>;
export interface ForgeAdapter {
  observe(repo: Repository, sourceBranch: string, signal: AbortSignal): Promise<RemoteObservation>;
}
// Built-in adapters have no write method. Token scopes may also be restricted server-side.
class ReadOnlyAPI {
  constructor(
    readonly config: ForgeConnection,
    readonly signal: AbortSignal,
  ) {}
  async get(path: string): Promise<any> {
    const secret = this.config.tokenEnv ? process.env[this.config.tokenEnv] : undefined;
    if (this.config.tokenEnv && !secret)
      throw new Error('Не задан read-only token: ' + this.config.tokenEnv);
    const response = await fetch(this.config.url!.replace(/\/$/, '') + path, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(30000)]),
      headers:
        this.config.provider === 'gitlab'
          ? secret
            ? { 'PRIVATE-TOKEN': secret }
            : {}
          : {
              Accept: 'application/vnd.github+json',
              ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
            },
    });
    if (!response.ok) throw new Error(`Forge GET ${path.split('?')[0]}: HTTP ${response.status}`);
    return response.json();
  }
}
export class GitLabAdapter implements ForgeAdapter {
  constructor(readonly config: ForgeConnection) {}
  async observe(repo: Repository, sourceBranch: string, signal: AbortSignal) {
    const api = new ReadOnlyAPI(this.config, signal),
      f = repo.forge!;
    const base = `/api/v4/projects/${encodeURIComponent(f.project)}`;
    const requests = await api.get(
      `${base}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(sourceBranch)}&target_branch=${encodeURIComponent(f.targetBranch)}&per_page=100`,
    );
    if (!Array.isArray(requests) || requests.length > 1)
      throw new Error('Ожидался один MR для ветки передачи');
    if (!requests.length) return observationSchema.parse({ state: 'absent', checks: [] });
    const mr = await api.get(`${base}/merge_requests/${requests[0].iid}`);
    if (mr.state === 'closed') throw new Error('MR закрыт без merge');
    const mergedSha =
      mr.state === 'merged' ? (mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha) : undefined;
    const checks = [];
    if (mergedSha) {
      const pipelines = await api.get(
        `${base}/pipelines?sha=${encodeURIComponent(mergedSha)}&ref=${encodeURIComponent(f.targetBranch)}&order_by=id&sort=desc&per_page=1`,
      );
      if (!Array.isArray(pipelines)) throw new Error('Некорректный список pipelines');
      if (pipelines.length) {
        const pipeline = await api.get(`${base}/pipelines/${pipelines[0].id}`);
        checks.push({
          name: 'pipeline',
          sha: pipeline.sha,
          status: pipeline.status,
          url: pipeline.web_url,
        });
        if (f.requiredChecks.length) {
          const jobs = await api.get(`${base}/pipelines/${pipeline.id}/jobs?per_page=100`);
          if (!Array.isArray(jobs) || jobs.length >= 100)
            throw new Error('Список jobs требует пагинации; используйте command adapter');
          checks.push(
            ...jobs.map((j: any) => ({
              name: j.name,
              sha: pipeline.sha,
              status: j.status,
              url: j.web_url,
            })),
          );
        }
      }
    }
    return observationSchema.parse({
      state: mr.state === 'merged' ? 'merged' : 'published',
      sourceSha: mr.sha,
      mergedSha,
      number: mr.iid,
      url: mr.web_url,
      checks,
    });
  }
}
export class GitHubAdapter implements ForgeAdapter {
  constructor(readonly config: ForgeConnection) {}
  async observe(repo: Repository, sourceBranch: string, signal: AbortSignal) {
    const api = new ReadOnlyAPI(this.config, signal),
      f = repo.forge!;
    const parts = f.project.split('/');
    if (parts.length !== 2) throw new Error('GitHub project: owner/repository');
    const base = `/repos/${parts.map(encodeURIComponent).join('/')}`;
    const requests = await api.get(
      `${base}/pulls?state=all&head=${encodeURIComponent(parts[0] + ':' + sourceBranch)}&base=${encodeURIComponent(f.targetBranch)}&per_page=100`,
    );
    if (!Array.isArray(requests) || requests.length > 1)
      throw new Error('Ожидался один PR для ветки передачи');
    if (!requests.length) return observationSchema.parse({ state: 'absent', checks: [] });
    const pr = await api.get(`${base}/pulls/${requests[0].number}`);
    if (pr.state === 'closed' && !pr.merged) throw new Error('PR закрыт без merge');
    const mergedSha = pr.merged ? pr.merge_commit_sha : undefined;
    const checks = [];
    if (mergedSha) {
      const runs = await api.get(
        `${base}/commits/${mergedSha}/check-runs?filter=latest&per_page=100`,
      );
      if (!Array.isArray(runs.check_runs) || runs.total_count > 100)
        throw new Error('Список checks требует пагинации; используйте command adapter');
      checks.push(
        ...runs.check_runs.map((c: any) => ({
          name: c.name,
          sha: c.head_sha,
          status: c.status === 'completed' ? c.conclusion : 'pending',
          url: c.html_url,
        })),
      );
      const statuses = await api.get(`${base}/commits/${mergedSha}/status?per_page=100`);
      if (!Array.isArray(statuses.statuses) || statuses.total_count > 100)
        throw new Error('Список statuses требует пагинации; используйте command adapter');
      checks.push(
        ...statuses.statuses.map((c: any) => ({
          name: c.context,
          sha: mergedSha,
          status: c.state,
          url: c.target_url ?? undefined,
        })),
      );
    }
    return observationSchema.parse({
      state: pr.merged ? 'merged' : 'published',
      sourceSha: pr.head.sha,
      mergedSha,
      number: pr.number,
      url: pr.html_url,
      checks,
    });
  }
}
export function forgeAdapter(config: ForgeConnection, h: Harness): ForgeAdapter {
  if (config.provider === 'gitlab') return new GitLabAdapter(config);
  if (config.provider === 'github') return new GitHubAdapter(config);
  return {
    async observe(repo, sourceBranch, signal) {
      const execution = executionEnvironment([h.config.environment, repo.environment], {
        HARNESS_FORGE_REQUEST: JSON.stringify({
          project: repo.forge!.project,
          sourceBranch,
          targetBranch: repo.forge!.targetBranch,
        }),
      });
      const result = await command(config.probe!.command, repo.path, {
        signal,
        timeoutMs: config.probe!.timeoutMs,
        ...execution,
      });
      if (result.code || result.timedOut)
        throw new Error('Read-only forge probe завершился с ошибкой');
      return observationSchema.parse(JSON.parse(result.stdout));
    },
  };
}

export class DeliveryRunner {
  readonly state: Deliveries;
  private controllers = new Set<AbortController>();
  constructor(
    readonly h: Harness,
    readonly root: string,
  ) {
    this.state = new Deliveries(h);
  }
  private pending = new Set<Promise<unknown>>();
  private track<T>(action: () => Promise<T>) {
    const work = action();
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }
  prepare(id: string) {
    return this.track(() => this.prepareRun(id));
  }
  check(id: string) {
    return this.track(() => this.checkRun(id));
  }
  private async prepareRun(id: string) {
    const d = this.state.start(id, digest(this.root).slice(0, 12));
    if (d.status === 'delivered') return d;
    try {
      const dir = join(this.root, 'handoffs', d.id);
      await mkdir(dir, { recursive: true });
      const components = repositories(this.h.config).map((repo) => ({
        repositoryId: repo.id,
        repository: repo.path,
        sha: d.components[repo.id].sha,
        sourceBranch: d.components[repo.id].sourceBranch,
        targetBranch: repo.forge!.targetBranch,
        remote: repo.forge!.remote,
        command: [
          'git',
          '-C',
          repo.path,
          'push',
          repo.forge!.remote,
          `${d.components[repo.id].sha}:refs/heads/${d.components[repo.id].sourceBranch}`,
        ],
      }));
      await writeFile(
        join(dir, 'handoff.json'),
        JSON.stringify(
          { deliveryId: d.id, verificationId: d.verificationId, components, publication: 'human' },
          null,
          2,
        ),
      );
      const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      await writeFile(
        join(dir, 'README.md'),
        [
          '# Ручная публикация',
          '',
          'DevContour не выполняет push, создание PR/MR, merge или публикацию пакетов. Выполните команды, создайте PR/MR в указанную ветку и завершите ваш процесс ревью. Затем агент запускает remote-check.',
          '',
          ...components.flatMap((c) => [
            `## ${c.repositoryId}`,
            '',
            '```sh',
            c.command.map(quote).join(' '),
            '```',
            '',
            `Целевая ветка: ${c.targetBranch}. Проверенный SHA: ${c.sha}.`,
            '',
          ]),
        ].join('\n'),
      );
      this.state.wait(id, d.token, true);
      return { status: 'awaiting-human-push', directory: dir, components };
    } catch (e) {
      this.state.fail(id, d.token, String(e));
      throw e;
    }
  }
  private async checkRun(id: string) {
    const d = this.state.start(id, digest(this.root).slice(0, 12));
    if (d.status === 'delivered') return d;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.h.config.runTimeoutMs);
    const beat = setInterval(
      () => {
        try {
          this.state.heartbeat(id, d.token);
        } catch {
          controller.abort();
        }
      },
      Math.max(1000, this.h.config.leaseMs / 3),
    );
    const secrets = Object.values(this.h.config.forgeConnections).flatMap((c) =>
      c.tokenEnv && process.env[c.tokenEnv] ? [process.env[c.tokenEnv]!] : [],
    );
    try {
      let waiting = false;
      for (const repo of repositories(this.h.config)) {
        controller.signal.throwIfAborted();
        this.state.heartbeat(id, d.token);
        const connection = this.h.config.forgeConnections[repo.forge!.connection];
        const c = structuredClone(d.components[repo.id]);
        const observation = await forgeAdapter(connection, this.h).observe(
          repo,
          c.sourceBranch,
          controller.signal,
        );
        if (observation.sourceSha && observation.sourceSha !== c.sha)
          throw new Error(`${repo.id}: опубликован другой SHA; нужна новая локальная проверка`);
        c.mr = observation.number;
        c.url = observation.url;
        c.checks = observation.checks;
        if (observation.state !== 'merged') {
          waiting = true;
          c.state = observation.state === 'absent' ? 'pending' : 'published';
        } else {
          if (!observation.mergedSha || !/^[a-f0-9]{40,64}$/.test(observation.mergedSha))
            throw new Error('Forge не вернул итоговый merge SHA');
          const ref = `refs/harness/remote-check/${d.id}/${repo.id}`;
          // Fetch reads the remote and only updates a private local ref; it never pushes.
          const fetched = await command(
            [
              'git',
              'fetch',
              '--no-tags',
              repo.forge!.remote,
              `+refs/heads/${repo.forge!.targetBranch}:${ref}`,
            ],
            repo.path,
            {
              signal: controller.signal,
              timeoutMs: 30000,
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
              redact: redactor(secrets),
            },
          );
          if (fetched.code || fetched.timedOut || controller.signal.aborted)
            throw new Error('Не удалось получить целевую ветку: ' + fetched.stderr);
          await git(repo.path, 'merge-base', '--is-ancestor', observation.mergedSha, ref);
          c.remoteTree = await git(repo.path, 'rev-parse', `${observation.mergedSha}^{tree}`);
          if (c.remoteTree !== c.tree)
            throw new Error(
              `${repo.id}: merge изменил проверенное дерево; требуется проверка нового результата`,
            );
          c.mergedSha = observation.mergedSha;
          c.state = 'merged';
          for (const name of repo.forge!.requiredChecks)
            if (!c.checks!.some((check) => check.name === name)) waiting = true;
          if (
            !c.checks!.length ||
            c.checks!.some((check) => check.sha !== c.mergedSha || check.status !== 'success')
          )
            waiting = true;
        }
        this.state.component(id, d.token, repo.id, c);
      }
      return waiting ? this.state.wait(id, d.token) : this.state.finish(id, d.token);
    } catch (e) {
      const message = redactor(secrets)(e instanceof Error ? e.message : String(e));
      this.state.fail(id, d.token, message);
      throw new Error(message);
    } finally {
      clearInterval(beat);
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  async stop() {
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
