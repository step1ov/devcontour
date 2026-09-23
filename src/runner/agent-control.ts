import { measuredExecute } from './usage.ts';
import { unobservedReview } from '../core/review.ts';
import { boardOwner } from '../core/sync-state.ts';
import { toolProfileFor, agentEnvironment } from './tools.ts';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DevContour, digest, specDigest } from '../core/service.ts';
import {
  type Approval,
  type ContractAttempt,
  type Task,
  DomainError,
  relativePath,
} from '../core/model.ts';
import { adapters, reviewResult, type AgentAdapter } from './adapters.ts';
import { repositories, repository, declaredRoles } from '../core/repositories.ts';
import { git } from './process.ts';

// Контракт живёт в репозитории, и предложение должно на него ссылаться, а не
// нести копию: копию легко отправить на ревью устаревшей, и тогда принятый
// digest не относится ни к одному файлу в дереве. Inline-текст остаётся для
// предложений, у которых файла ещё нет.
export const contractProposal = z
  .object({
    repositoryId: z.string().optional(),
    title: z.string().trim().min(1).max(180),
    content: z.string().trim().min(1).max(60000).optional(),
    file: relativePath.optional(),
  })
  .refine((p) => Boolean(p.content) !== Boolean(p.file), {
    message: 'Укажите либо file — путь к контракту в репозитории, либо content',
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
// Ревью каждой попытки читало предложение с нуля: прошлые находки ему не
// показывали. Поэтому автор не видел, что закрыто, а что вернулось, а рецензент
// мог заново поднять то, что уже поправлено, или противоречить прежнему совету.
// Передаём предыдущие находки и просим отметить их состояние.
function previousFindings(h: DevContour, subject: string, title: string) {
  const attempts = (h.store.read().contractAttempts ?? []).filter(
    (a) => a.subject === subject && a.title === title,
  );
  const last = attempts.at(-1);
  if (!last) return undefined;
  return {
    attempt: attempts.length,
    summary: last.summary,
    findings: last.findings.map((f) => f.message),
  };
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
  const previous = previousFindings(h, subject, (proposal as { title?: string }).title ?? subject);
  const prompt = [
    `Independently review this ${subject}. The author runtime is ${author}; you are ${reviewer}.`,
    'Read repo AGENTS.md and docs/spec.md (or the specification referenced in the proposal). Do not edit files, approve work yourself, or run implementation agents.',
    'Reject contradictions with requirements, unclear public interfaces, missing error/UI states, weak acceptance criteria, changes to scope or test policy that conceal failures. A proposal is not proof of implemented functionality.',
    'For a plan, check dependencies, the first complete user scenario, requirement references, required real tests, and agreed API/design contracts. For architecture, assess the chosen stack and bootstrap verification evidence.',
    'For plans, check writePaths, selected library contextPacks, device resources, consumer verification and separation of proposed discoveries from validated knowledge. Findings should include rule, consequence and evidence; do not invent violations to fill the report.',
    'Declared context packs: ' + JSON.stringify(h.config.contextPacks),
    'Return approved=false and concrete blocking findings when revision is needed. Routine technical choices within the specification do not need human approval.',
    ...(previous
      ? [
          'This proposal has been reviewed before. Previous findings follow. For each, state in your summary whether it is now resolved, still open, or superseded, before raising anything new. Do not re-raise a finding that the current proposal addresses, and do not contradict earlier guidance without saying why.',
          JSON.stringify(previous, null, 2),
        ]
      : []),
    'Workspace repositories: ' +
      JSON.stringify(
        repositories(h.config).map(({ id, name, kind, path }) => ({ id, name, kind, path })),
      ),
    JSON.stringify(proposal, null, 2),
  ].join('\n\n');
  await writeFile(join(artifact, 'proposal.json'), JSON.stringify(proposal, null, 2) + '\n');
  await writeFile(join(artifact, 'prompt.txt'), prompt);
  // Ревью читает архитектуру, но роль architect не обязана существовать:
  // конфигурация вправе объявить только свои. Берётся объявленная.
  const declared = declaredRoles(h.config, repositoryId ?? defaultOwner(h));
  const reviewRole = declared.includes('architect') ? 'architect' : declared[0];
  const toolProfile = toolProfileFor(h.config, reviewer, reviewRole, true);
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
  recordContractAttempt(h, {
    id: artifact.split('/').at(-1) ?? artifact,
    at: new Date().toISOString(),
    subject,
    title: (proposal as { title?: string }).title ?? subject,
    repositoryId,
    attempt: (previous?.attempt ?? 0) + 1,
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

// Компонент по умолчанию — «main», если он есть, иначе первый настроенный:
// workspace вправе называть репозитории product и library, и вызов без
// repositoryId там не должен падать на несуществующем имени.
const defaultOwner = (h: DevContour) =>
  repositories(h.config).some((r) => r.id === 'main') ? 'main' : repositories(h.config)[0].id;

// Контракт читается из дерева в момент ревью: ревьюер и реестр видят то же
// самое, что лежит в репозитории, а не то, что автор скопировал когда-то.
async function contractContent(
  h: DevContour,
  proposal: { content?: string; file?: string; repositoryId?: string },
) {
  if (!proposal.file) return proposal.content!;
  // Компонент может называться не main: в workspace из product и library
  // предложение без repositoryId иначе искало бы несуществующий репозиторий,
  // хотя inline-вариант там работал.
  const base = await realpath(repository(h.config, proposal.repositoryId ?? defaultOwner(h)).path);
  const file = resolve(base, proposal.file);
  let resolved: string;
  try {
    resolved = await realpath(file);
  } catch {
    throw new DomainError('Контракт не найден: ' + proposal.file, 400);
  }
  if (resolved !== file || !resolved.startsWith(base + sep))
    throw new DomainError('Контракт должен лежать внутри репозитория', 400);
  const content = await readFile(resolved, 'utf8');
  if (!content.trim()) throw new DomainError('Файл контракта пуст: ' + proposal.file, 400);
  return content;
}

export async function reviewContract(
  h: DevContour,
  root: string,
  input: unknown,
  author: Author,
  runtimes: Runtimes = adapters,
) {
  const parsed = contractProposal.parse(input);
  const proposal = { ...parsed, content: await contractContent(h, parsed) };
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
    contract: h.contract(
      proposal.title,
      proposal.content,
      approval,
      proposal.repositoryId,
      proposal.file,
    ),
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
  // Принятие относится к доказанному SHA, а не к текущей вершине ветки. Вершину
  // двигает и перенос базы: подготовка попадает туда без гейтов, и приёмка,
  // читавшая вершину, закрепляла бы непроверенный код как принятую работу.
  // Берётся самый поздний результат задач доски — он прошёл проверки на
  // интеграции, — и проверяется, что он действительно лежит в ветке.
  const heads: Record<string, string> = {};
  for (const task of tasks) {
    const repo = repository(h.config, task.repositoryId);
    const tip = await git(repo.path, 'rev-parse', `refs/heads/${repo.targetBranch}`);
    await git(repo.path, 'merge-base', '--is-ancestor', task.resultSha!, tip);
    const current = heads[repo.id];
    if (!current) heads[repo.id] = task.resultSha!;
    else if (current !== task.resultSha) {
      // Поздний — тот, для кого другой является предком. Равных нет: коммиты
      // интеграции выстроены в одну ветку.
      const currentIsOlder = await git(
        repo.path,
        'merge-base',
        '--is-ancestor',
        current,
        task.resultSha!,
      )
        .then(() => true)
        .catch(() => false);
      if (currentIsOlder) heads[repo.id] = task.resultSha!;
      else await git(repo.path, 'merge-base', '--is-ancestor', task.resultSha!, current);
    }
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
