import { snapshotDependencies, assertDependencies, runEnvironment } from './dependencies.ts';
import { runSteps, withEnvironment } from './environment.ts';
import { toolProfileFor, agentEnvironment } from './tools.ts';
import { orderedGates, withinPaths, validateWorkflow } from '../core/workflow.ts';
import { taskContext } from './context.ts';
import { withResources } from './resources.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Harness, digest } from '../core/service.ts';
import { type Run, type Task, type Evidence } from '../core/model.ts';
import { adapters, implementationResult, reviewResult, type AgentAdapter } from './adapters.ts';
import { git } from './process.ts';
import { repositories, repository, roleBinding } from '../core/repositories.ts';
import { reserveRepositories } from './ownership.ts';
import { runGate } from './gates.ts';
export class Scheduler {
  readonly owner = randomUUID();
  private jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private contexts = new Map<string, string>();
  private mergeTails = new Map<string, Promise<void>>();
  constructor(
    readonly h: Harness,
    readonly root: string,
    readonly runtimes: typeof adapters = adapters,
  ) {}
  runRoot(repositoryId = 'main') {
    return this.h.config.storage === 'component'
      ? join(repository(this.h.config, repositoryId).path, '.harness', 'local')
      : this.root;
  }
  get active() {
    return this.jobs.size;
  }
  get target() {
    return `refs/heads/${this.h.config.targetBranch}`;
  }
  targetFor(repositoryId = 'main') {
    return `refs/heads/${repository(this.h.config, repositoryId).targetBranch}`;
  }
  async init() {
    validateWorkflow(this.h.config);
    await reserveRepositories(this.h.config, this.root);
    for (const repo of repositories(this.h.config)) {
      const target = this.targetFor(repo.id);
      try {
        await git(repo.path, 'rev-parse', '--verify', target);
      } catch {
        await git(repo.path, 'branch', repo.targetBranch, 'HEAD');
      }
      await this.assertTargetDetached(repo.id);
    }
  }
  private async assertTargetDetached(repositoryId = 'main') {
    const repo = repository(this.h.config, repositoryId);
    const list = await git(repo.path, 'worktree', 'list', '--porcelain');
    if (list.split('\n').includes(`branch ${this.targetFor(repo.id)}`))
      throw new Error(
        `Ветка интеграции ${repo.id} открыта в worktree. Переключите этот worktree на другую ветку.`,
      );
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () =>
        void this.tick().catch((e) =>
          this.h.store.change('scheduler.error', (s) => {
            s.paused = true;
            return { error: String(e) };
          }),
        ),
      750,
    );
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.h.pause(true);
    for (const j of this.jobs.values()) j.controller.abort();
    await Promise.all([...this.jobs.values()].map((j) => j.promise));
    this.h.store.change('scheduler.released', (s) => {
      if (s.leader?.owner === this.owner) s.leader = undefined;
      return { owner: this.owner };
    });
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.h.leader(this.owner)) {
        for (const j of this.jobs.values()) j.controller.abort();
        return;
      }
      await this.recover();
      for (const [id, job] of this.jobs) {
        const r = this.h.store.read().runs.find((r) => r.id === id);
        if (r?.status !== 'active') job.controller.abort();
      }
      while (this.jobs.size < this.h.config.concurrency) {
        const run = this.h.claim(this.owner);
        if (!run) break;
        const controller = new AbortController();
        const promise = this.execute(run, controller).finally(() => this.jobs.delete(run.id));
        this.jobs.set(run.id, { promise, controller });
      }
    } finally {
      this.ticking = false;
    }
  }
  async drain() {
    while (true) {
      await this.tick();
      if (!this.jobs.size) break;
      await Promise.all([...this.jobs.values()].map((j) => j.promise));
    }
  }
  private async recover() {
    for (const r of this.h.store
      .read()
      .runs.filter((r) => r.status === 'active' && r.leaseUntil <= Date.now())) {
      if (r.integrationSha && r.policyDigest === this.h.policyDigest(r.repositoryId ?? 'main')) {
        try {
          await git(
            repository(this.h.config, r.repositoryId ?? 'main').path,
            'merge-base',
            '--is-ancestor',
            r.integrationSha,
            this.targetFor(r.repositoryId ?? 'main'),
          );
          const adopted = this.h.adopt(r.id, this.owner);
          this.h.finish(r.id, adopted.token, r.integrationSha);
          continue;
        } catch {
          this.h.store.change('recovery.rejected', (s) => {
            const failed = s.runs.find((x) => x.id === r.id);
            if (failed?.status === 'active') failed.leaseUntil = 0;
            return { runId: r.id };
          });
        }
      }
    }
    if (this.h.store.read().runs.some((r) => r.status === 'active' && r.leaseUntil <= Date.now()))
      this.h.expire();
  }
  private prompt(task: Task, run: Run, review = false, sha?: string) {
    const s = this.h.store.read();
    return [
      review
        ? 'You independently review the exact candidate. Do not edit files. Reject missing acceptance criteria, weakened tests, policy changes, and unsafe changes. Report concrete findings.'
        : 'Implement the approved task in this isolated worktree. Do not commit, push, merge, change harness policy, or start other agents. DevContour owns testing and integration. Return completed=false if you cannot finish.',
      `Role: ${task.role}. Task: ${task.id}. Approved specification: ${task.approvedDigest}.`,
      JSON.stringify(
        {
          repositoryId: task.repositoryId,
          title: task.title,
          description: task.description,
          acceptance: task.acceptance,
          dependsOn: task.dependsOn,
        },
        null,
        2,
      ),
      'Approved contracts: ' +
        JSON.stringify(s.contracts.filter((c) => task.contracts.includes(c.id))),
      'Previous attempts: ' +
        JSON.stringify(
          s.runs
            .filter((r) => r.taskId === task.id && r.id !== run.id)
            .map((r) => ({
              attempt: r.attempt,
              error: r.error,
              evidence: r.evidence.map((e) => ({
                gate: e.gate,
                passed: e.passed,
                summary: e.summary,
              })),
            })),
        ),
      `Base commit: ${run.baseSha}. ${sha ? `Review commit: ${sha}.` : ''}`,
      'Review against the pinned conventions. Report verified causal regressions, including unchanged consumers. Findings need path/line, rule, consequence and evidence; use null only when not applicable. Do not demand unrelated legacy cleanup.',
      'Report unrelated bugs or debt in discoveries with a reproducible observation; these become unapproved tasks, not accepted knowledge. Never weaken a test to hide an application bug.',
      'Write scope: ' +
        JSON.stringify({
          role: roleBinding(this.h.config, task.role, task.repositoryId).writePaths,
          task: task.writePaths,
        }),
      'Pinned dependencies (do not modify these worktrees or artifacts): ' +
        JSON.stringify(run.dependencies ?? []),
      'Reserved resources (only these may be used): ' + JSON.stringify(run.resources ?? []),
      this.contexts.get(run.id) ?? '',
      'Use repo AGENTS.md and scoped memory. Never mark a task done yourself. No secrets in output. Explain actions and evidence, not private reasoning.',
    ].join('\n\n');
  }
  private async review(
    adapter: AgentAdapter,
    run: Run,
    task: Task,
    cwd: string,
    sha: string,
    phase: Evidence['phase'],
    signal: AbortSignal,
  ) {
    const dir = join(this.runRoot(task.repositoryId), 'artifacts', run.id, phase, 'review');
    await mkdir(dir, { recursive: true });
    const diff = await git(cwd, 'diff', '--no-ext-diff', '--no-textconv', run.baseSha!, sha);
    if (diff.length > 1000000)
      throw new Error('Diff превышает лимит независимого ревью; разбейте задачу');
    const toolProfile = toolProfileFor(
      this.h.config,
      run.reviewer,
      task.role,
      true,
      task.repositoryId,
    );
    const baseExecution = runEnvironment(this.h.config, run, phase, cwd);
    const agent = agentEnvironment(this.h.config, toolProfile, baseExecution.env);
    const execution = {
      env: agent.env,
      redact: (text: string) => baseExecution.redact(agent.redact(text)),
    };
    const result = await adapter.execute({
      toolProfile,
      execution,
      cwd,
      artifactDir: dir,
      prompt: this.prompt(task, run, true, sha) + '\n\nExact diff to review:\n' + diff,
      review: true,
      task,
      model: run.reviewerModel,
      signal,
      timeoutMs: this.h.config.runTimeoutMs,
      resourcesJson: JSON.stringify(run.resources ?? []),
    });
    await assertDependencies(run.dependencies ?? []);
    const parsed = reviewResult.parse(result.data);
    this.h.discoveries(run.id, run.token, sha, parsed.discoveries);
    const clean =
      !(await git(cwd, 'status', '--porcelain', '--untracked-files=no')) &&
      (await git(cwd, 'rev-parse', 'HEAD')) === sha;
    const passed =
      clean && parsed.approved && !parsed.findings.some((f) => f.severity === 'blocking');
    const log = join(dir, 'review.json');
    await writeFile(log, JSON.stringify(parsed, null, 2));
    this.h.evidence(run.id, run.token, {
      kind: 'review',
      phase,
      sha,
      gate: 'independent-review',
      passed,
      command: result.command,
      exitCode: passed ? 0 : 1,
      log,
      digest: digest(parsed),
      summary: parsed.summary,
    });
    if (!passed) throw new Error('Независимое ревью отклонило результат: ' + parsed.summary);
  }
  private async execute(run: Run, controller: AbortController) {
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), this.h.config.runTimeoutMs);
    const heartbeat = setInterval(
      () => {
        try {
          this.h.heartbeat(run.id, run.token);
        } catch {
          controller.abort();
        }
      },
      Math.max(1000, this.h.config.leaseMs / 3),
    );
    const task = this.h.store.read().tasks.find((t) => t.id === run.taskId)!;
    const repo = repository(this.h.config, task.repositoryId);
    try {
      await withResources(
        this.h.config,
        [...(task.resources ?? []), ...repo.gates.flatMap((g) => g.resources ?? [])],
        `${this.root}:${run.id}`,
        signal,
        async (signal, resources) => {
          run.resources = resources;
          const context = await taskContext(this.h.config, task);
          run.context = context.snapshots;
          this.contexts.set(run.id, context.text);
          this.h.withRun(run.id, run.token, 'run.context', (stored) => {
            stored.context = context.snapshots;
            stored.resources = resources;
            return { runId: run.id, context: context.snapshots, resources };
          });
          run.dependencies = await snapshotDependencies(
            this.h.config,
            this.runRoot(task.repositoryId),
            run,
            task,
            this.h.store.read().tasks,
            signal,
          );
          this.h.withRun(run.id, run.token, 'run.dependencies', (stored) => {
            stored.dependencies = run.dependencies;
            return { runId: run.id, dependencies: run.dependencies };
          });
          const base = await git(repo.path, 'rev-parse', this.targetFor(repo.id));
          const cwd = join(this.runRoot(task.repositoryId), 'worktrees', run.id);
          await mkdir(join(this.runRoot(task.repositoryId), 'worktrees'), { recursive: true });
          await git(repo.path, 'worktree', 'add', '-b', `harness/run-${run.id}`, cwd, base);
          run.baseSha = base;
          run.worktree = cwd;
          this.h.phase(run.id, run.token, 'running', { baseSha: base, worktree: cwd });
          const execution = runEnvironment(this.h.config, run, 'candidate', cwd);
          await withEnvironment(
            repo.lifecycle,
            cwd,
            join(this.runRoot(task.repositoryId), 'artifacts', run.id, 'candidate', 'environment'),
            execution,
            signal,
            async () => {
              await runSteps(
                repo.prepare ?? [],
                cwd,
                join(this.runRoot(task.repositoryId), 'artifacts', run.id, 'candidate', 'prepare'),
                execution,
                signal,
              );
              const dir = join(
                this.runRoot(task.repositoryId),
                'artifacts',
                run.id,
                'implementation',
              );
              await mkdir(dir, { recursive: true });
              await writeFile(join(dir, 'task.json'), JSON.stringify(task, null, 2));
              await writeFile(
                join(dir, 'context.json'),
                JSON.stringify({ packs: context.snapshots, text: context.text }, null, 2),
              );
              const writer = this.runtimes[run.runtime];
              const toolProfile = toolProfileFor(
                this.h.config,
                run.runtime,
                task.role,
                false,
                task.repositoryId,
              );
              const agent = agentEnvironment(this.h.config, toolProfile, execution.env);
              const result = await writer.execute({
                toolProfile,
                execution: {
                  env: agent.env,
                  redact: (text) => execution.redact(agent.redact(text)),
                },
                cwd,
                artifactDir: dir,
                prompt: this.prompt(task, run),
                review: false,
                task,
                model: run.model,
                signal,
                timeoutMs: this.h.config.runTimeoutMs,
                resourcesJson: JSON.stringify(resources),
              });
              await writeFile(join(dir, 'result.json'), JSON.stringify(result.data, null, 2));
              const implementation = implementationResult.parse(result.data);
              if (!implementation.completed)
                throw new Error('Исполнитель сообщил о незавершённой работе');
              this.h.heartbeat(run.id, run.token);
              if (signal.aborted) throw new Error('Попытка отменена');
              if ((await git(cwd, 'rev-parse', 'HEAD')) !== base)
                throw new Error('Агент изменил HEAD; интеграцией владеет harness');
              await git(cwd, 'add', '-A');
              const changed = (
                await git(cwd, 'diff', '--cached', '--no-renames', '--name-only', '-z')
              )
                .split('\0')
                .filter(Boolean);
              const forbidden = changed.filter((p) =>
                withinPaths(p, [
                  ...repo.protectedPaths,
                  repo.configFile ?? 'harness.component.json',
                  '.harness/',
                  ...(repo.generatedPaths ?? []),
                  ...this.h.config.contextPacks
                    .filter((pack) => pack.repositoryId === repo.id)
                    .flatMap((pack) => pack.files),
                ]),
              );
              if (forbidden.length)
                throw new Error(`Изменены защищённые файлы: ${forbidden.join(', ')}`);
              const outside = changed.filter((p) =>
                [
                  roleBinding(this.h.config, task.role, task.repositoryId).writePaths,
                  task.writePaths,
                ].some((scope) => scope && !withinPaths(p, scope)),
              );
              if (outside.length)
                throw new Error('Изменены файлы вне области задачи/роли: ' + outside.join(', '));
              await git(
                cwd,
                '-c',
                'core.hooksPath=/dev/null',
                'commit',
                '--no-gpg-sign',
                '--allow-empty',
                '-m',
                `${task.id}: ${task.title}`,
              );
              const sha = await git(cwd, 'rev-parse', 'HEAD');
              this.h.discoveries(run.id, run.token, sha, implementation.discoveries);
              run.candidateSha = sha;
              this.h.phase(run.id, run.token, 'verifying', { candidateSha: sha });
              for (const gate of orderedGates(repo.gates))
                await runGate(
                  this.h,
                  run,
                  cwd,
                  sha,
                  'candidate',
                  gate,
                  join(this.runRoot(task.repositoryId), 'artifacts', run.id, 'candidate'),
                  signal,
                );
              this.h.phase(run.id, run.token, 'reviewing');
              await this.review(
                this.runtimes[run.reviewer],
                run,
                task,
                cwd,
                sha,
                'candidate',
                signal,
              );
            },
          );
          await assertDependencies(run.dependencies ?? []);
          // Serialize integration. Branch CAS still protects against other processes.
          const previous = this.mergeTails.get(repo.id) ?? Promise.resolve();
          let unlock!: () => void;
          this.mergeTails.set(
            repo.id,
            new Promise<void>((r) => {
              unlock = r;
            }),
          );
          await previous;
          try {
            await this.integrate(run, task, signal);
          } finally {
            unlock();
          }
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.h.fail(run.id, run.token, message);
      } catch {
        /* A cancelled or fenced run cannot publish a late failure. */
      }
    } finally {
      this.contexts.delete(run.id);
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }
  private async integrate(run: Run, task: Task, signal: AbortSignal) {
    this.h.heartbeat(run.id, run.token);
    if (signal.aborted) throw new Error('Попытка отменена');
    const repo = repository(this.h.config, task.repositoryId);
    const target = this.targetFor(repo.id);
    await this.assertTargetDetached(repo.id);
    const base = await git(repo.path, 'rev-parse', target);
    const cwd = join(this.runRoot(task.repositoryId), 'worktrees', `${run.id}-integration`);
    await git(repo.path, 'worktree', 'add', '--detach', cwd, base);
    await git(
      cwd,
      '-c',
      'core.hooksPath=/dev/null',
      'merge',
      '--no-ff',
      '--no-edit',
      '--no-gpg-sign',
      run.candidateSha!,
    );
    const sha = await git(cwd, 'rev-parse', 'HEAD');
    run.integrationSha = sha;
    this.h.phase(run.id, run.token, 'integrating', { integrationSha: sha });
    const execution = runEnvironment(this.h.config, run, 'integration', cwd);
    await withEnvironment(
      repo.lifecycle,
      cwd,
      join(this.runRoot(task.repositoryId), 'artifacts', run.id, 'integration', 'environment'),
      execution,
      signal,
      async () => {
        await runSteps(
          repo.prepare ?? [],
          cwd,
          join(this.runRoot(task.repositoryId), 'artifacts', run.id, 'integration', 'prepare'),
          execution,
          signal,
        );
        for (const gate of orderedGates(repo.gates))
          await runGate(
            this.h,
            run,
            cwd,
            sha,
            'integration',
            gate,
            join(this.runRoot(task.repositoryId), 'artifacts', run.id, 'integration'),
            signal,
          );
        await this.review(this.runtimes[run.reviewer], run, task, cwd, sha, 'integration', signal);
      },
    );
    await assertDependencies(run.dependencies ?? []);
    if (
      (await git(cwd, 'rev-parse', 'HEAD')) !== sha ||
      (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
    )
      throw new Error('Очистка окружения изменила проверенный код');
    if (signal.aborted) throw new Error('Попытка отменена');
    await this.assertTargetDetached(repo.id);
    // Fencing validation, compare-and-swap publication and task acceptance share the DB write lock.
    // If the process dies after update-ref, recovery verifies persisted evidence before acceptance.
    this.h.finish(run.id, run.token, sha, () => {
      execFileSync('git', ['update-ref', target, sha, base], {
        cwd: repo.path,
        stdio: 'pipe',
      });
    });
  }
}
