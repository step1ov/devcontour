import { developmentBinding, assertTaskPreparation } from './preparation.ts';
import { validateTaskContext, validateWorkflow } from './workflow.ts';
import { entityId } from './ids.ts';
import { createHash, randomUUID } from 'node:crypto';
import { repository, repositories, roleBinding, reviewerBinding } from './repositories.ts';
import { Store } from './store.ts';
import { planResult } from './plan.ts';
import { assertDag, descendants, readyTasks, latestTaskId, impactGraph } from './graph.ts';
import {
  DomainError,
  requireValue,
  taskInput,
  discoveryInput,
  type Task,
  type DevContourState,
  type Config,
  type Evidence,
  type Run,
  type Approval,
} from './model.ts';
export const digest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const specDigest = (t: Task) =>
  digest({
    ...(t.preparation ? { preparation: t.preparation } : {}),
    ...(t.repositoryId && t.repositoryId !== 'main' ? { repositoryId: t.repositoryId } : {}),
    ...(t.requirements?.length ? { requirements: t.requirements } : {}),
    title: t.title,
    description: t.description,
    role: t.role,
    dependsOn: t.dependsOn,
    acceptance: t.acceptance,
    ...(t.scope === 'workspace'
      ? { scope: t.scope, relatedRepositories: t.relatedRepositories }
      : {}),
    contracts: t.contracts,
    contractDigests: t.contractDigests,
    ...(t.contextPacks?.length ? { contextPacks: t.contextPacks } : {}),
    ...(t.writePaths?.length ? { writePaths: t.writePaths } : {}),
    ...(t.resources?.length ? { resources: t.resources } : {}),
    ...(t.finding ? { finding: t.finding } : {}),
  });
const now = () => new Date().toISOString();
const task = (s: DevContourState, id: string) =>
  requireValue(
    s.tasks.find((t) => t.id === id),
    `Задача ${id} не найдена`,
  );
const board = (s: DevContourState, id: string) =>
  requireValue(
    s.boards.find((b) => b.id === id),
    `Доска ${id} не найдена`,
  );
function activeRevision(s: DevContourState, id: string) {
  const b = board(s, id);
  const r = b.revisions.at(-1)!;
  if (r.status !== 'active') throw new DomainError('Доска принята. Создайте корректировку.');
  return r;
}
export class DevContour {
  constructor(
    readonly store: Store,
    readonly config: Config,
  ) {
    validateWorkflow(config);
  }
  policyDigest(repositoryId = 'main') {
    const repo = repository(this.config, repositoryId);
    return digest({
      ...(this.config.repositories.length
        ? { repositoryId, path: repo.path, targetBranch: repo.targetBranch }
        : {}),
      gates: repo.gates,
      execution: {
        environment: this.config.environment,
        toolProfiles: this.config.toolProfiles,
        lifecycle: repo.lifecycle,
        prepare: repo.prepare,
        repositoryEnvironment: repo.environment,
      },
      dependencies: repositories(this.config).map(
        ({
          id,
          path,
          targetBranch,
          dependsOn,
          dependencyBuild,
          dependencyArtifacts,
          environment,
        }) => ({
          id,
          path,
          targetBranch,
          dependsOn,
          dependencyBuild,
          dependencyArtifacts,
          environment,
        }),
      ),
      memoryPolicy: this.config.memoryPolicy,
      protectedPaths: repo.protectedPaths,
      roles: { ...this.config.roles, ...repo.roles },
      repositoryReviewer: repo.reviewer,
      reviewer: this.config.reviewer,
      mode: this.config.mode,
      ...(this.config.contextPacks.length ? { contextPacks: this.config.contextPacks } : {}),
      ...(this.config.resources.length
        ? { resources: this.config.resources, resourceDatabase: this.config.resourceDatabase }
        : {}),
      ...(repo.generatedPaths?.length ? { generatedPaths: repo.generatedPaths } : {}),
    });
  }
  importPlan(input: unknown) {
    const plan = planResult.parse(input);
    return this.store.change('plan.imported', (s) => {
      const ids = new Map<string, string>();
      for (const t of plan.tasks) {
        if (ids.has(t.key)) throw new DomainError('Ключи задач должны быть уникальны', 400);
        ids.set(t.key, entityId(s, 'T'));
      }
      const tasks = plan.tasks.map((item) => {
        const parsed = taskInput.parse({
          ...item,
          dependsOn: item.dependsOn.map((key) =>
            requireValue(
              ids.get(key) ?? s.tasks.find((t) => t.id === key)?.id,
              `Неизвестная зависимость плана ${key}`,
            ),
          ),
        });
        repository(this.config, parsed.repositoryId);
        validateTaskContext(this.config, parsed);
        return {
          ...parsed,
          preparation: developmentBinding(s),
          assignee: parsed.assignee ?? s.team?.member,
          id: ids.get(item.key)!,
          status: 'draft' as const,
          attempt: 0,
          createdAt: now(),
          contractDigests: {},
        };
      });
      s.tasks.push(...tasks);
      assertDag(s.tasks);
      const b = {
        id: entityId(s, 'B'),
        title: plan.title,
        description: plan.description,
        revisions: [
          {
            number: 1,
            status: 'active' as const,
            reason: 'Утверждение предложенного плана',
            taskIds: tasks.map((t) => t.id),
            createdAt: now(),
          },
        ],
      };
      s.boards.push(b);
      return { boardId: b.id, tasks: tasks.length };
    });
  }
  createBoard(title: string, description = '', repositoryId?: string) {
    if (repositoryId) repository(this.config, repositoryId);
    if (title.trim().length < 3 || title.length > 180)
      throw new DomainError('Название: от 3 до 180 символов', 400);
    return this.store.change('board.created', (s) => {
      const b = {
        id: entityId(s, 'B'),
        repositoryId,
        title: title.trim(),
        description,
        revisions: [
          {
            number: 1,
            status: 'active' as const,
            reason: 'Первый цикл',
            taskIds: [],
            createdAt: now(),
          },
        ],
      };
      s.boards.push(b);
      return b;
    });
  }
  addTask(boardId: string, input: unknown) {
    const parsed = taskInput.parse(input);
    repository(this.config, parsed.repositoryId);
    validateTaskContext(this.config, parsed);
    return this.store.change('task.created', (s) => {
      const r = activeRevision(s, boardId);
      const owner = board(s, boardId).repositoryId;
      if (owner && (parsed.repositoryId !== owner || parsed.scope === 'workspace'))
        throw new DomainError('Локальная доска принимает только задачи своего компонента');
      const t: Task = {
        ...parsed,
        preparation: developmentBinding(s),
        assignee: parsed.assignee ?? s.team?.member,
        id: entityId(s, 'T'),
        status: 'draft',
        attempt: 0,
        createdAt: now(),
        contractDigests: {},
      };
      s.tasks.push(t);
      assertDag(s.tasks);
      r.taskIds.push(t.id);
      return t;
    });
  }
  editTask(id: string, input: unknown, expectedDigest: string) {
    const parsed = taskInput.parse(input);
    repository(this.config, parsed.repositoryId);
    validateTaskContext(this.config, parsed);
    return this.store.change('task.edited', (s) => {
      const t = task(s, id);
      if (t.status !== 'draft')
        throw new DomainError(
          'Изменять можно только черновик. Для принятой задачи создайте корректировку.',
        );
      if (specDigest(t) !== expectedDigest)
        throw new DomainError('Задача изменилась. Обновите страницу.');
      const ownerBoard = s.boards.find((b) => b.revisions.some((r) => r.taskIds.includes(t.id)));
      if (
        ownerBoard?.repositoryId &&
        (parsed.repositoryId !== ownerBoard.repositoryId || parsed.scope === 'workspace')
      )
        throw new DomainError('Локальная доска принимает только задачи своего компонента');
      Object.assign(t, parsed, { preparation: developmentBinding(s) });
      assertDag(s.tasks);
      return t;
    });
  }
  contract(
    title: string,
    content: string,
    approval: Approval = { actor: 'operator' },
    repositoryId?: string,
    source?: string,
  ) {
    if (repositoryId) repository(this.config, repositoryId);
    if (!title.trim() || !content.trim() || content.length > 60000)
      throw new DomainError('Укажите название и содержимое контракта (до 60 000 символов)', 400);
    return this.store.change('contract.approved', (s) => {
      const c = {
        id: entityId(s, 'C'),
        repositoryId,
        title,
        content,
        source,
        digest: digest(content),
        approvedAt: now(),
        approval,
      };
      s.contracts.push(c);
      return c;
    });
  }
  approve(
    boardId: string,
    taskIds?: string[],
    approval: Approval = { actor: 'operator' },
    expected?: { revision: number; taskIds: string[]; tasks: Record<string, string> },
  ) {
    return this.store.change('board.approved', (s) => {
      developmentBinding(s);
      const r = activeRevision(s, boardId);
      if (!r.taskIds.length) throw new DomainError('Добавьте задачи перед утверждением');
      const selected = taskIds ?? r.taskIds;
      if (!selected.length || selected.some((id) => !r.taskIds.includes(id)))
        throw new DomainError('Выберите задачи этой ревизии', 400);
      if (
        expected &&
        (expected.revision !== r.number ||
          digest(expected.taskIds) !== digest(r.taskIds) ||
          selected.some((id) => {
            const current = task(s, id);
            return current.status !== 'draft' || expected.tasks[id] !== specDigest(current);
          }))
      )
        throw new DomainError('План изменился во время ревью; требуется повторная проверка');
      for (const id of selected) {
        const t = task(s, id);
        if (t.status !== 'draft') continue;
        assertTaskPreparation(s, t);
        validateTaskContext(this.config, t);
        if (['backend', 'frontend'].includes(t.role) && !t.contracts.length)
          throw new DomainError(`${t.id}: для ${t.role} сначала привяжите утверждённый контракт`);
        t.contractDigests = Object.fromEntries(
          t.contracts.map((id) => {
            const c = requireValue(
              s.contracts.find((c) => c.id === id),
              `Контракт ${id} не утверждён`,
            );
            if (c.repositoryId && c.repositoryId !== t.repositoryId)
              throw new DomainError('Для межпроектного интерфейса нужен общий контракт');
            return [id, c.digest];
          }),
        );
        t.approvedAt = now();
        t.approvedDigest = specDigest(t);
        t.approval = approval;
        t.status = 'ready';
      }
      return { boardId, revision: r.number, approval };
    });
  }
  impact(boardId: string, roots: string[]) {
    const s = this.store.read();
    const b = board(s, boardId);
    const r = b.revisions.at(-1)!;
    if (r.status !== 'accepted')
      throw new DomainError('Корректировка создаётся после приёмки текущей ревизии');
    if (!roots.length || roots.some((id) => !r.taskIds.includes(id)))
      throw new DomainError('Выберите принятые задачи этой доски', 400);
    const ids = descendants(impactGraph(s.tasks), [
      ...new Set(roots.map((id) => latestTaskId(s.tasks, id))),
    ]);
    return {
      taskIds: ids,
      boards: s.boards
        .filter((b) => b.revisions.at(-1)!.taskIds.some((id) => ids.includes(id)))
        .map((b) => ({ id: b.id, title: b.title })),
    };
  }
  correct(
    boardId: string,
    roots: string[],
    reason: string,
    refresh?: { expected: string; requirements: Record<string, Task['requirements']> },
  ) {
    if (reason.trim().length < 10 || reason.length > 5000)
      throw new DomainError('Опишите корректировку: от 10 до 5000 символов', 400);
    // Recompute the entire impact inside the write transaction; preview is never authoritative.
    return this.store.change('board.corrected', (s) => {
      const b = board(s, boardId);
      if (refresh && digest(b) !== refresh.expected)
        throw new DomainError('Доска изменилась во время чтения требований');
      const previous = b.revisions.at(-1)!;
      if (previous.status !== 'accepted') throw new DomainError('Сначала примите текущую ревизию');
      if (!roots.length || roots.some((id) => !previous.taskIds.includes(id)))
        throw new DomainError('Выберите задачи текущей принятой ревизии', 400);
      const impacted = descendants(impactGraph(s.tasks), [
        ...new Set(roots.map((id) => latestTaskId(s.tasks, id))),
      ]);
      if (impacted.some((id) => task(s, id).status !== 'done'))
        throw new DomainError(
          'В затронутой цепочке есть незавершённые задачи. Сначала завершите их.',
        );
      const currentIds = new Map(s.tasks.map((t) => [t.id, latestTaskId(s.tasks, t.id)]));
      const currentRoots = roots.map((id) => currentIds.get(id)!);
      const map = new Map(impacted.map((id) => [id, entityId(s, 'T')]));
      for (const id of impacted) {
        const original = task(s, id);
        const requirements = refresh?.requirements[id] ?? original.requirements;
        validateTaskContext(this.config, { ...original, requirements });
        s.tasks.push({
          ...original,
          preparation: developmentBinding(s),
          requirements,
          sharedCompletion: undefined,
          id: map.get(id)!,
          description:
            original.description +
            `\n\nКорректировка: ${reason}\n${currentRoots.includes(id) ? 'Измените результат согласно корректировке.' : 'Повторно проверьте и при необходимости адаптируйте результат к новым зависимостям.'}`,
          dependsOn: original.dependsOn.map(
            (d) => map.get(currentIds.get(d)!) ?? currentIds.get(d)!,
          ),
          supersedes: id,
          status: 'draft',
          createdAt: now(),
          attempt: 0,
          approvedAt: undefined,
          approvedDigest: undefined,
          approval: undefined,
          activeRunId: undefined,
          resultSha: undefined,
          failure: undefined,
          contractDigests: {},
        });
      }
      const revision = {
        number: previous.number + 1,
        status: 'active' as const,
        reason,
        taskIds: [
          ...new Set([
            ...previous.taskIds.map((id) => map.get(currentIds.get(id)!) ?? id),
            ...map.values(),
          ]),
        ],
        createdAt: now(),
      };
      b.revisions.push(revision);
      assertDag(s.tasks);
      return { boardId, revision: revision.number, replacements: Object.fromEntries(map) };
    });
  }
  accept(
    boardId: string,
    headSha: string,
    approval: Approval = { actor: 'operator' },
    expectedDigest?: string,
    repositories?: Record<string, string>,
  ) {
    return this.store.change('board.accepted', (s) => {
      const r = activeRevision(s, boardId);
      if (expectedDigest && digest(r) !== expectedDigest)
        throw new DomainError('Ревизия изменилась во время приёмки');
      if (!r.taskIds.length || r.taskIds.some((id) => task(s, id).status !== 'done'))
        throw new DomainError('Приёмка доступна, когда все задачи прошли интеграцию и проверки');
      const tasks = r.taskIds.map((id) => structuredClone(task(s, id)));
      tasks.forEach((t) => assertTaskPreparation(s, t));
      r.status = 'accepted';
      r.acceptedAt = now();
      r.acceptance = approval;
      r.snapshot = {
        tasks,
        sha: headSha,
        ...(repositories ? { repositories } : {}),
        digest: digest({ tasks, sha: headSha, ...(repositories ? { repositories } : {}) }),
      };
      return { boardId, revision: r.number, snapshot: r.snapshot.digest, approval };
    });
  }
  pause(value: boolean, reason: 'operator' | 'shutdown' = 'operator') {
    return this.store.change(value ? 'scheduler.paused' : 'scheduler.started', (s) => {
      if (!value) developmentBinding(s);
      if (s.paused && value && reason === 'shutdown')
        return { paused: true, reason: s.pauseReason };
      s.paused = value;
      s.pauseReason = value ? reason : undefined;
      return { paused: value, reason: s.pauseReason };
    });
  }
  assign(id: string, member: string) {
    const assignee = taskInput.shape.assignee.unwrap().parse(member);
    return this.store.change('task.assigned', (s) => {
      const t = task(s, id);
      if (t.activeRunId) throw new DomainError('Дождитесь завершения активной попытки');
      t.assignee = assignee;
      return { taskId: id, assignee };
    });
  }
  claim(owner: string): Run | undefined {
    return this.store.change('run.claimed', (s) => {
      if (
        s.paused ||
        s.changeSets.some((c) =>
          c.deliveries?.some((d) => d.status === 'active' && d.leaseUntil > Date.now()),
        ) ||
        s.changeSets.some((c) =>
          c.verifications.some((v) => v.status === 'active' && v.leaseUntil > Date.now()),
        )
      )
        return;
      if (s.runs.filter((r) => r.status === 'active').length >= this.config.concurrency) return;
      const eligible = readyTasks(s).filter(
        (t) => t.attempt < this.config.maxAttempts && (!s.team || t.assignee === s.team.member),
      );
      const t = eligible[0];
      if (!t) return;
      assertTaskPreparation(s, t);
      validateTaskContext(this.config, t);
      if (t.approvedDigest !== specDigest(t))
        throw new DomainError('Спецификация изменилась после утверждения');
      const dependencyDates = t.dependsOn.map((id) => {
        const dependency = s.tasks.find((x) => x.id === id)!;
        return (
          s.runs.findLast((r) => r.taskId === id && r.status === 'succeeded')?.finishedAt ??
          dependency.sharedCompletion?.receipt.finishedAt
        );
      });
      const readyAt =
        t.approvedAt && dependencyDates.every(Boolean)
          ? [t.approvedAt, ...(dependencyDates as string[])].sort().at(-1)
          : undefined;
      const candidates = eligible.map((t) => ({
        taskId: t.id,
        repositoryId: t.repositoryId,
        attempt: t.attempt,
      }));
      const run: Run = {
        dispatch: {
          policy: 'fifo-ready-v1',
          at: now(),
          eligible: candidates,
          activeCount: s.runs.filter((r) => r.status === 'active').length,
          concurrency: this.config.concurrency,
          inputDigest: digest(candidates),
        },
        wait: { approvedAt: t.approvedAt, readyAt },
        requiredGates: [
          // Задача доказывает себя своей областью, если она объявлена; иначе —
          // всем профилем, как раньше.
          ...(t.gates ?? repository(this.config, t.repositoryId).gates.map((g) => g.id)),
          ...(t.requirements?.length ? ['requirement-source'] : []),
        ],
        id: randomUUID(),
        taskId: t.id,
        repositoryId: t.repositoryId,
        attempt: ++t.attempt,
        token: randomUUID(),
        owner,
        runtime: roleBinding(this.config, t.role, t.repositoryId).runtime,
        reviewer: reviewerBinding(this.config, t.role, t.repositoryId).runtime,
        model: roleBinding(this.config, t.role, t.repositoryId).model,
        reviewerModel: reviewerBinding(this.config, t.role, t.repositoryId).model,
        policyDigest: this.policyDigest(t.repositoryId),
        status: 'active',
        phase: 'running',
        startedAt: now(),
        leaseUntil: Date.now() + this.config.leaseMs,
        evidence: [],
      };
      t.status = 'running';
      t.activeRunId = run.id;
      t.failure = undefined;
      s.runs.push(run);
      return run;
    });
  }
  withRun<T>(
    id: string,
    token: string,
    type: string,
    fn: (run: Run, t: Task, s: DevContourState) => T,
  ): T {
    return this.store.change(type, (s) => {
      const r = requireValue(
        s.runs.find((r) => r.id === id),
        'Попытка не найдена',
      );
      const t = task(s, r.taskId);
      assertTaskPreparation(s, t);
      if (r.policyDigest !== this.policyDigest(t.repositoryId))
        throw new DomainError('Политика проверок изменилась; нужна новая попытка');
      if (
        r.status !== 'active' ||
        r.token !== token ||
        r.leaseUntil <= Date.now() ||
        t.activeRunId !== r.id
      )
        throw new DomainError('Устаревшая попытка: владение утрачено');
      return fn(r, t, s);
    });
  }
  heartbeat(id: string, token: string) {
    this.withRun(id, token, 'heartbeat', (r) => {
      r.leaseUntil = Date.now() + this.config.leaseMs;
    });
  }
  phase(
    id: string,
    token: string,
    phase: 'running' | 'verifying' | 'reviewing' | 'integrating',
    data: Partial<Pick<Run, 'baseSha' | 'candidateSha' | 'integrationSha' | 'worktree'>> = {},
  ) {
    this.withRun(id, token, 'run.phase', (r, t) => {
      if (!['running', 'verifying', 'reviewing', 'integrating'].includes(phase))
        throw new DomainError('Недопустимая фаза');
      r.phase = phase;
      t.status = phase;
      Object.assign(r, data);
      return { runId: id, taskId: t.id, phase, ...data };
    });
  }
  evidence(id: string, token: string, evidence: Omit<Evidence, 'id' | 'runId' | 'createdAt'>) {
    return this.withRun(id, token, 'evidence.recorded', (r) => {
      const e = { ...evidence, id: randomUUID(), runId: id, createdAt: now() };
      r.evidence.push(e);
      return e;
    });
  }
  finish(id: string, token: string, sha: string, publish?: () => void) {
    return this.withRun(id, token, 'task.done', (r, t) => {
      if (r.phase !== 'integrating' || !r.candidateSha || r.integrationSha !== sha)
        throw new DomainError('Нет интеграционного коммита');
      const last = (kind: Evidence['kind'], phase: Evidence['phase'], sha: string, gate: string) =>
        r.evidence.findLast(
          (e) => e.kind === kind && e.phase === phase && e.sha === sha && e.gate === gate,
        )?.passed === true;
      for (const gate of [
        ...repository(this.config, t.repositoryId).gates,
        ...(t.requirements?.length ? [{ id: 'requirement-source' }] : []),
      ])
        for (const phase of ['candidate', 'integration'] as const)
          if (!last('test', phase, phase === 'candidate' ? r.candidateSha : sha, gate.id))
            throw new DomainError(`Нет PASS: ${phase}/${gate.id}`);
      for (const phase of ['candidate', 'integration'] as const)
        if (
          !last('review', phase, phase === 'candidate' ? r.candidateSha : sha, 'independent-review')
        )
          throw new DomainError(`Нет независимого ревью: ${phase}`);
      publish?.();
      r.status = 'succeeded';
      r.finishedAt = now();
      t.status = 'done';
      t.resultSha = sha;
      t.activeRunId = undefined;
      return { taskId: t.id, runId: id, sha };
    });
  }
  fail(id: string, token: string, error: string) {
    return this.withRun(id, token, 'run.failed', (r, t) => {
      r.status = 'failed';
      r.error = error;
      r.finishedAt = now();
      t.status = 'failed';
      t.failure = error;
      t.activeRunId = undefined;
      return { taskId: t.id, runId: id, error };
    });
  }
  discoveries(id: string, token: string, sha: string, input: unknown) {
    const findings = discoveryInput.array().max(20).parse(input);
    if (!findings.length) return [];
    return this.withRun(id, token, 'findings.recorded', (run, source, s) => {
      const created: string[] = [];
      for (const finding of findings) {
        const fingerprint = digest({
          repositoryId: source.repositoryId,
          path: finding.path,
          observation: finding.observation,
        });
        if (
          s.tasks.some(
            (t) =>
              t.finding?.fingerprint === fingerprint &&
              t.status !== 'done' &&
              t.status !== 'cancelled',
          )
        )
          continue;
        let inbox = s.boards.find(
          (b) => b.title === 'Находки агентов' && b.revisions.at(-1)?.status === 'active',
        );
        if (!inbox) {
          inbox = {
            id: entityId(s, 'B'),
            title: 'Находки агентов',
            description:
              'Непроверенные дефекты и техдолг. Ведущий агент проверяет воспроизведение и приоритет до утверждения.',
            revisions: [
              {
                number: 1,
                status: 'active',
                reason: 'Сбор находок',
                taskIds: [],
                createdAt: now(),
              },
            ],
          };
          s.boards.push(inbox);
        }
        const t: Task = {
          ...taskInput.parse({
            repositoryId: source.repositoryId,
            role: source.role,
            title: finding.title,
            description: `${finding.observation}\nПоследствие: ${finding.consequence}\nВоспроизведение: ${finding.reproduction}\nИсточник: ${finding.path}:${finding.line} @ ${sha}. Находка не подтверждена.`,
            acceptance: [
              'Воспроизвести находку и сохранить доказательство до изменения кода.',
              'После исправления выполнить регрессионный сценарий и обязательные проверки.',
            ],
            finding: {
              ...finding,
              fingerprint,
              sourceTaskId: source.id,
              sourceRunId: run.id,
              sourceSha: sha,
              verification: 'proposed',
            },
          }),
          id: entityId(s, 'T'),
          assignee: s.team?.member,
          status: 'draft',
          attempt: 0,
          createdAt: now(),
          contractDigests: {},
        };
        s.tasks.push(t);
        inbox.revisions.at(-1)!.taskIds.push(t.id);
        created.push(t.id);
      }
      return created;
    });
  }
  cancel(id: string) {
    return this.store.change('task.cancelled', (s) => {
      const t = task(s, id);
      if (t.status === 'done')
        throw new DomainError('Принятый результат нельзя отменить; создайте корректировку');
      const r = s.runs.find((r) => r.id === t.activeRunId);
      if (r) {
        r.status = 'cancelled';
        r.finishedAt = now();
      }
      t.status = 'cancelled';
      t.activeRunId = undefined;
      return { taskId: id };
    });
  }
  retry(id: string) {
    return this.store.change('task.retry', (s) => {
      const t = task(s, id);
      if (!['failed', 'cancelled'].includes(t.status))
        throw new DomainError('Повтор доступен после сбоя или отмены');
      if (t.attempt >= this.config.maxAttempts) throw new DomainError('Исчерпан лимит попыток');
      t.status = t.approvedDigest ? 'ready' : 'draft';
      t.failure = undefined;
      return { taskId: id };
    });
  }
  expire(at = Date.now()) {
    return this.store.change('runs.expired', (s) => {
      const ids: string[] = [];
      for (const r of s.runs)
        if (r.status === 'active' && r.leaseUntil <= at) {
          r.status = 'expired';
          r.finishedAt = now();
          r.error = 'Истёк срок владения. Проверьте worktree и повторите явно.';
          const t = task(s, r.taskId);
          if (t.activeRunId === r.id) {
            t.status = 'failed';
            t.failure = r.error;
            t.activeRunId = undefined;
          }
          ids.push(r.id);
        }
      return ids;
    });
  }
  adopt(id: string, owner: string) {
    return this.store.change('run.recovered', (s) => {
      const r = requireValue(
        s.runs.find((r) => r.id === id),
        'Попытка не найдена',
      );
      if (r.status !== 'active' || r.leaseUntil > Date.now())
        throw new DomainError('Попытка ещё принадлежит worker');
      r.token = randomUUID();
      r.owner = owner;
      r.leaseUntil = Date.now() + this.config.leaseMs;
      return r;
    });
  }
  leader(owner: string) {
    return this.store.change('heartbeat', (s) => {
      if (s.leader && s.leader.owner !== owner && s.leader.leaseUntil > Date.now()) return false;
      s.leader = { owner, leaseUntil: Date.now() + this.config.leaseMs };
      return true;
    });
  }
}
