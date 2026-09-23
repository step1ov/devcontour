import { measuredExecute } from './usage.ts';
import { unobservedReview } from '../core/review.ts';
import { boardOwner } from '../core/sync-state.ts';
import { toolProfileFor, agentEnvironment } from './tools.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DevContour, digest, specDigest } from '../core/service.ts';
import { type Approval, type ContractAttempt, type Task, DomainError } from '../core/model.ts';
import { adapters, reviewResult, type AgentAdapter } from './adapters.ts';
import { repositories, repository } from '../core/repositories.ts';
import { git } from './process.ts';

export const contractProposal = z.object({
  repositoryId: z.string().optional(),
  title: z.string().trim().min(1).max(180),
  content: z.string().trim().min(1).max(60000),
});
type Author = 'codex' | 'claude';
type Runtimes = Record<Author, AgentAdapter>;

// Попытки накапливаются: держим последние, чтобы состояние не росло без предела.
const MAX_CONTRACT_ATTEMPTS = 60;
function recordContractAttempt(h: DevContour, attempt: ContractAttempt) {
  h.store.change('contract.review', (s) => {
    s.contractAttempts = [...(s.contractAttempts ?? []), attempt].slice(-MAX_CONTRACT_ATTEMPTS);
  });
}

async function review(
  h: DevContour,
  root: string,
  author: Author,
  subject: string,
  proposal: unknown,
  runtimes: Runtimes,
  repositoryId?: string,
  subjectId?: string,
): Promise<Approval> {
  if (h.config.mode !== 'local')
    throw new DomainError('AI-согласование доступно только для local mode');
  const reviewer = author === 'codex' ? 'claude' : 'codex';
  if (runtimes[reviewer].name !== reviewer)
    throw new DomainError('Неверный runtime независимого reviewer');
  const artifact = join(root, 'decisions', randomUUID());
  await mkdir(artifact, { recursive: true });
  const prompt = [
    `Independently review this ${subject}. The author runtime is ${author}; you are ${reviewer}.`,
    'Read repo AGENTS.md and docs/spec.md (or the specification referenced in the proposal). Do not edit files, approve work yourself, or run implementation agents.',
    'Reject contradictions with requirements, unclear public interfaces, missing error/UI states, weak acceptance criteria, changes to scope or test policy that conceal failures. A proposal is not proof of implemented functionality.',
    'For a plan, check dependencies, the first complete user scenario, requirement references, required real tests, and agreed API/design contracts. For architecture, assess the chosen stack and bootstrap verification evidence.',
    'For plans, check writePaths, selected library contextPacks, device resources, consumer verification and separation of proposed discoveries from validated knowledge. Findings should include rule, consequence and evidence; do not invent violations to fill the report.',
    'Declared context packs: ' + JSON.stringify(h.config.contextPacks),
    'Return approved=false and concrete blocking findings when revision is needed. Routine technical choices within the specification do not need human approval.',
    'Workspace repositories: ' +
      JSON.stringify(
        repositories(h.config).map(({ id, name, kind, path }) => ({ id, name, kind, path })),
      ),
    JSON.stringify(proposal, null, 2),
  ].join('\n\n');
  await writeFile(join(artifact, 'proposal.json'), JSON.stringify(proposal, null, 2) + '\n');
  await writeFile(join(artifact, 'prompt.txt'), prompt);
  const toolProfile = toolProfileFor(h.config, reviewer, 'architect', true);
  const result = await measuredExecute(
    h,
    runtimes[reviewer],
    {
      toolProfile,
      execution: agentEnvironment(h.config, toolProfile),
      cwd: h.config.repository,
      artifactDir: artifact,
      prompt,
      review: true,
      task: {} as Task,
      model: h.config.reviewer.runtime === reviewer ? h.config.reviewer.model : undefined,
      signal: AbortSignal.timeout(h.config.runTimeoutMs),
      timeoutMs: h.config.runTimeoutMs,
    },
    { repositoryId, subjectId, stage: subject === 'task plan' ? 'plan-review' : 'contract-review' },
  );
  const parsed = reviewResult.parse(result.data);
  await writeFile(
    join(artifact, 'review.json'),
    JSON.stringify({ ...parsed, inspection: result.inspection ?? unobservedReview() }, null, 2) +
      '\n',
  );
  await writeFile(join(artifact, 'runtime.log'), result.log);
  const rejected = !parsed.approved || parsed.findings.some((f) => f.severity === 'blocking');
  if (subject !== 'task plan')
    recordContractAttempt(h, {
      id: artifact.split('/').at(-1) ?? artifact,
      at: new Date().toISOString(),
      title: (proposal as { title?: string }).title ?? subject,
      repositoryId,
      approved: !rejected,
      summary: parsed.summary,
      findings: parsed.findings.map((f) => ({ severity: f.severity, message: f.message })),
      artifact,
      authorRuntime: author,
      reviewerRuntime: reviewer,
    });
  if (rejected)
    throw new DomainError(`Независимое ревью отклонено: ${parsed.summary}. Артефакты: ${artifact}`);
  return {
    actor: 'agent',
    authorRuntime: author,
    reviewerRuntime: reviewer,
    artifact,
    digest: digest(proposal),
  };
}

export async function reviewContract(
  h: DevContour,
  root: string,
  input: unknown,
  author: Author,
  runtimes: Runtimes = adapters,
) {
  const proposal = contractProposal.parse(input);
  const existing = h.store
    .read()
    .contracts.find(
      (c) =>
        c.title === proposal.title &&
        c.content === proposal.content &&
        c.repositoryId === proposal.repositoryId,
    );
  if (existing) return { status: 'already-approved', contract: existing };
  const approval = await review(
    h,
    root,
    author,
    'contract / architecture decision',
    proposal,
    runtimes,
    proposal.repositoryId,
  );
  if (h.config.approvalMode === 'operator')
    return { status: 'awaiting-operator', proposal, approval };
  return {
    status: 'approved',
    contract: h.contract(proposal.title, proposal.content, approval, proposal.repositoryId),
  };
}

export async function reviewPlan(
  h: DevContour,
  root: string,
  boardId: string,
  author: Author,
  runtimes: Runtimes = adapters,
  beforeCommit: () => void = () => {},
) {
  const state = h.store.read();
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) throw new DomainError('Доска не найдена');
  const revision = board.revisions.at(-1)!;
  if (revision.status !== 'active') throw new DomainError('Доска уже принята');
  const tasks = state.tasks.filter((t) => revision.taskIds.includes(t.id));
  if (!tasks.length) throw new DomainError('Добавьте задачи перед ревью плана');
  const drafts = tasks.filter((t) => t.status === 'draft');
  if (!drafts.length) return { status: 'already-approved', boardId };
  const contractIds = new Set(tasks.flatMap((t) => t.contracts));
  const proposal = {
    title: board.title,
    description: board.description,
    revision: revision.number,
    tasks,
    contracts: state.contracts.filter((c) => contractIds.has(c.id)),
  };
  const expected = {
    revision: revision.number,
    taskIds: revision.taskIds,
    tasks: Object.fromEntries(drafts.map((t) => [t.id, specDigest(t)])),
  };
  const approval = await review(
    h,
    root,
    author,
    'task plan',
    proposal,
    runtimes,
    boardOwner(board, state),
    boardId,
  );
  beforeCommit();
  if (h.config.approvalMode === 'operator')
    return { status: 'awaiting-operator', boardId, approval };
  return {
    status: 'approved',
    ...h.store.atomic(() => {
      beforeCommit();
      return h.approve(
        boardId,
        drafts.map((t) => t.id),
        approval,
        expected,
      );
    }),
  };
}

export async function acceptBoard(
  h: DevContour,
  boardId: string,
  author: Author,
  manual = false,
  beforeCommit: () => void = () => {},
) {
  const state = h.store.read();
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) throw new DomainError('Доска не найдена');
  const revision = board.revisions.at(-1)!;
  if (revision.status === 'accepted') return { status: 'already-accepted', boardId };
  const tasks = revision.taskIds.map((id) => state.tasks.find((t) => t.id === id)!);
  if (!tasks.length || tasks.some((t) => t.status !== 'done' || !t.resultSha))
    throw new DomainError('Приёмка требует done, проверки и интеграцию всех задач');
  const heads: Record<string, string> = {};
  for (const task of tasks) {
    const repo = repository(h.config, task.repositoryId);
    heads[repo.id] ??= await git(repo.path, 'rev-parse', `refs/heads/${repo.targetBranch}`);
    await git(repo.path, 'merge-base', '--is-ancestor', task.resultSha!, heads[repo.id]);
  }
  beforeCommit();
  const head = Object.values(heads)[0];
  if (h.config.approvalMode === 'operator' && !manual)
    return { status: 'awaiting-operator', boardId, head };
  return {
    status: 'accepted',
    ...h.store.atomic(() => {
      beforeCommit();
      return h.accept(
        boardId,
        head,
        manual ? { actor: 'operator' } : { actor: 'agent', authorRuntime: author },
        digest(revision),
        heads,
      );
    }),
  };
}
