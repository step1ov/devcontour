import { executionEnvironment, withEnvironment } from './environment.ts';
import { orderedGates } from '../core/workflow.ts';
import { withResources } from './resources.ts';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DevContour, digest } from '../core/service.ts';
import { Workspace } from '../core/workspace.ts';
import { IntentService } from './intent.ts';
import { repositories } from '../core/repositories.ts';
import type { Verification, WorkspaceEvidence } from '../core/model.ts';
import { reserveRepositories } from './ownership.ts';
import { command, git } from './process.ts';
import { junitSummary, prepareReportPath, runCheck } from './gates.ts';
import { composeRedactors, redactDeep } from './redaction.ts';

export class WorkspaceRunner {
  readonly workspace: Workspace;
  private jobs = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  constructor(
    readonly h: DevContour,
    readonly root: string,
  ) {
    this.workspace = new Workspace(h, new IntentService(h));
  }
  verify(id: string) {
    const run = this.workspace.start(id);
    const controller = new AbortController();
    const promise = this.execute(id, run, controller).finally(() => this.jobs.delete(run.id));
    this.jobs.set(run.id, { controller, promise });
    return promise;
  }
  async stop() {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
  }
  private async execute(id: string, run: Verification, controller: AbortController) {
    const w = this.workspace,
      signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), this.h.config.runTimeoutMs);
    const heartbeat = setInterval(
      () => {
        try {
          w.heartbeat(id, run.token);
        } catch {
          controller.abort();
        }
      },
      Math.max(1000, this.h.config.leaseMs / 3),
    );
    const dir = join(this.root, 'workspace-checks', run.id);
    try {
      return await withResources(
        this.h.config,
        this.h.config.workspaceGates.flatMap((g) => g.resources ?? []),
        `${this.root}:${run.id}`,
        signal,
        async (signal, resources) => {
          await reserveRepositories(this.h.config, this.root);
          await mkdir(join(dir, 'components'), { recursive: true });
          const manifest: NonNullable<Verification['manifest']> = {};
          const paths: Record<string, string> = {};
          for (const repo of repositories(this.h.config)) {
            const sha = await git(repo.path, 'rev-parse', `refs/heads/${repo.targetBranch}`);
            for (const task of run.tasks.filter((t) => t.repositoryId === repo.id))
              await git(repo.path, 'merge-base', '--is-ancestor', task.resultSha!, sha);
            const cwd = join(dir, 'components', repo.id);
            await git(repo.path, 'worktree', 'add', '--detach', cwd, sha);
            manifest[repo.id] = { sha, tree: await git(cwd, 'rev-parse', 'HEAD^{tree}') };
            paths[repo.id] = await realpath(cwd);
          }
          w.heartbeat(id, run.token);
          w.manifest(id, run.token, manifest);
          const impact = this.h.store
            .read()
            .changeSets.find((c) => c.id === id)!
            .verifications.at(-1)!.impact!;
          await writeFile(join(dir, 'impact.json'), JSON.stringify(impact, null, 2));
          const manifestPath = join(dir, 'manifest.json');
          const manifestContent = JSON.stringify(
            {
              changeSetId: id,
              verificationId: run.id,
              digest: digest(manifest),
              components: Object.fromEntries(
                Object.entries(manifest).map(([id, m]) => [id, { ...m, path: paths[id] }]),
              ),
            },
            null,
            2,
          );
          await writeFile(manifestPath, manifestContent);
          const captured: { path: string; digest: string }[] = [];
          const clean = async () => {
            if ((await readFile(manifestPath, 'utf8')) !== manifestContent)
              throw new Error('Проверка изменила manifest');
            for (const artifact of captured)
              if (
                createHash('sha256')
                  .update(await readFile(artifact.path))
                  .digest('hex') !== artifact.digest
              )
                throw new Error('Изменён уже проверенный artifact: ' + artifact.path);
            for (const [id, cwd] of Object.entries(paths)) {
              if (
                (await git(cwd, 'rev-parse', 'HEAD')) !== manifest[id].sha ||
                (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
              )
                throw new Error(`Проверка изменила исходники компонента ${id}`);
            }
          };
          const commonEnv = {
            DEVCONTOUR_RUN_ID: run.id,
            DEVCONTOUR_CHANGESET_ID: id,
            DEVCONTOUR_RESOURCES_JSON: JSON.stringify(resources),
            DEVCONTOUR_MANIFEST_PATH: manifestPath,
            DEVCONTOUR_COMPONENTS_JSON: JSON.stringify(paths),
          };
          const firstPath = paths[repositories(this.h.config)[0].id];
          await withEnvironment(
            this.h.config.workspaceLifecycle,
            firstPath,
            join(dir, 'environment'),
            executionEnvironment([this.h.config.environment], commonEnv),
            signal,
            async () => {
              for (const gate of orderedGates(this.h.config.workspaceGates).filter((g) =>
                impact.gateIds.includes(g.id),
              )) {
                if (signal.aborted) throw new Error('Проверка workspace отменена');
                const cwd = paths[gate.repositoryId];
                if (!cwd) throw new Error('Неизвестный repositoryId интеграционной проверки');
                const logPath = join(dir, gate.id + '.log');
                let log = '',
                  passed = false,
                  exitCode = -1,
                  summary = '';
                const artifacts: WorkspaceEvidence['artifacts'] = [];
                // Окружение и маска gate — одни на исполнение и на сохранение.
                // Окружение строится внутри try: незаданный секрет — отказ gate
                // с evidence, а не исключение до записи доказательства.
                let redact = (text: string) => text;
                try {
                  const environment = executionEnvironment(
                    [
                      this.h.config.environment,
                      repositories(this.h.config).find((r) => r.id === gate.repositoryId)
                        ?.environment,
                    ],
                    { ...commonEnv },
                  );
                  redact = environment.redact;
                  const reportPath = gate.report
                    ? await prepareReportPath(cwd, gate.report.path, 'Report выходит из компонента')
                    : undefined;
                  const gateCwd = gate.cwd ? await realpath(resolve(cwd, gate.cwd)) : cwd;
                  if (gateCwd !== cwd && !gateCwd.startsWith(cwd + sep))
                    throw new Error('Gate cwd выходит из компонента');
                  // Совместная проверка — в той же песочнице, что и проверки
                  // задач: пишет только в свой компонент и scratch, читает
                  // закреплённые снимки компонентов и manifest, а база и
                  // рабочие каталоги контура ей закрыты.
                  const result = await runCheck(this.h, {
                    argv: gate.command,
                    cwd: gateCwd,
                    signal,
                    timeoutMs: gate.timeoutMs,
                    write: [cwd],
                    readable: [
                      ...Object.values(paths),
                      manifestPath,
                      ...repositories(this.h.config).map((r) => join(r.path, '.git')),
                    ],
                    controller: [this.root, ...repositories(this.h.config).map((r) => r.path)],
                    settingsDir: join(dir, gate.id),
                    env: { ...environment.env, DEVCONTOUR_REPORT_PATH: reportPath },
                    redact,
                  });
                  exitCode = result.code;
                  log = result.stdout + '\n' + result.stderr;
                  if (result.code || result.timedOut || signal.aborted)
                    throw new Error(
                      `Gate ${gate.id}: exit=${result.code}; timeout=${result.timedOut}`,
                    );
                  if (reportPath) {
                    if (!(await realpath(reportPath)).startsWith(cwd + sep))
                      throw new Error('Report выходит из компонента');
                    const xml = await readFile(reportPath, 'utf8'),
                      counts = junitSummary(xml);
                    await writeFile(join(dir, gate.id + '.xml'), redact(xml));
                    summary = `${counts.tests} tests, ${counts.failures} failures, ${counts.skipped} skipped`;
                    if (counts.failures || counts.skipped) throw new Error(summary);
                  } else summary = 'Команда завершилась успешно';
                  for (const path of gate.artifacts) {
                    const resolved = await realpath(resolve(cwd, path));
                    if (!resolved.startsWith(cwd + sep))
                      throw new Error('Artifact выходит из компонента');
                    const hash = createHash('sha256')
                      .update(await readFile(resolved))
                      .digest('hex');
                    artifacts.push({ path: `${gate.repositoryId}/${path}`, digest: hash });
                    captured.push({ path: resolved, digest: hash });
                  }
                  await clean();
                  passed = true;
                } catch (error) {
                  // Текст ошибки называет пути, выбранные проверкой: уборка
                  // её временного каталога, чтение её отчёта.
                  summary = redact(error instanceof Error ? error.message : String(error));
                  log += '\n' + summary;
                }
                log = redact(log);
                await writeFile(logPath, log);
                const evidence = redactDeep(
                  {
                    gate: gate.id,
                    command: gate.command,
                    passed,
                    exitCode,
                    log: logPath,
                    digest: digest(log),
                    summary,
                    artifacts,
                  },
                  redact,
                );
                w.evidence(id, run.token, evidence);
                if (!passed) throw new Error(evidence.summary);
              }
            },
          );
          await clean();
          w.heartbeat(id, run.token);
          return w.finish(id, run.token);
        },
      );
    } catch (error) {
      // Ошибка проверки сохраняется в Verification и журнал: маска — по
      // окружениям всех компонентов, чьи секреты могли в неё попасть.
      // Незаданный секрет сам бывает причиной ошибки: маска строится по тем
      // окружениям, что удалось собрать, и не подменяет исходную ошибку.
      const masks = [
        [this.h.config.environment],
        ...repositories(this.h.config).map((r) => [this.h.config.environment, r.environment]),
      ].flatMap((profiles) => {
        try {
          return [executionEnvironment(profiles).redact];
        } catch {
          return [];
        }
      });
      const redact = composeRedactors(...masks);
      const message = redact(error instanceof Error ? error.message : String(error));
      w.fail(id, run.token, message);
      throw error instanceof Error ? Object.assign(error, { message }) : new Error(message);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
  }
}
