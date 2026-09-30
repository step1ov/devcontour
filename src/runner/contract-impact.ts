import {
  DomainError,
  type Contract,
  type DevContourState,
  type Task,
  type TaskStatus,
} from '../core/model.ts';
import { contractDigest, type DevContour } from '../core/service.ts';
import { repository } from '../core/repositories.ts';
import { contractContent, contractProposal, defaultOwner } from './agent-control.ts';
import { pinArtifacts } from './contract-artifacts.ts';
import { git } from './process.ts';

/**
 * Что изменит новая редакция контракта — до ревью и до любых изменений.
 *
 * Изменение контракта требовало длинной ручной последовательности: ревью,
 * перепривязка задач, повторное ревью плана, перенос базы. Ошибка в порядке
 * останавливала очередь или запускала задачу на старой редакции. Этот отчёт
 * только читает: он называет изменения документа и артефактов, затронутые
 * задачи по состояниям и их транзитивных потребителей, состояние базы и
 * нужные ревью. Ничего не перепривязывается и не активируется.
 */
type Action = 'rebind-after-review' | 'wait-or-cancel-run' | 'correction' | 'none';
const action = (status: TaskStatus): Action =>
  status === 'done'
    ? // Принятая история не переписывается: изменение — корректировка.
      'correction'
    : status === 'cancelled'
      ? 'none'
      : ['running', 'verifying', 'reviewing', 'integrating'].includes(status)
        ? 'wait-or-cancel-run'
        : 'rebind-after-review';

const boardOf = (s: DevContourState, t: Task) =>
  s.boards.find((b) => b.revisions.some((r) => r.taskIds.includes(t.id)))?.id;

export async function contractImpact(h: DevContour, input: unknown) {
  const parsed = contractProposal.parse(input);
  const owner = repository(h.config, parsed.repositoryId ?? defaultOwner(h));
  // Отчёт строится по закоммиченной редакции: сверка базы идёт по HEAD.
  if (parsed.file && (await git(owner.path, 'status', '--porcelain', '--', parsed.file)))
    throw new DomainError(
      'Документ контракта изменён после коммита — закоммитьте его: ' + parsed.file,
      400,
    );
  const content = await contractContent(h, parsed);
  const pinned = await pinArtifacts(owner, parsed.artifacts ?? []);
  const digest = contractDigest(content, pinned.artifacts);
  const s = h.store.read();
  // Редакции одного контракта — один источник в одном компоненте; у inline
  // предложения источника нет, и его редакции узнаются по названию.
  const same = (c: Contract) =>
    (c.repositoryId ?? undefined) === (parsed.repositoryId ?? undefined) &&
    (parsed.file ? c.source === parsed.file : !c.source && c.title === parsed.title);
  const revisions = s.contracts.filter(same);
  const current = revisions.at(-1);
  const status = !current ? 'new' : current.digest === digest ? 'unchanged' : 'changed';

  const before = new Map((current?.artifacts ?? []).map((a) => [a.path, a]));
  const after = new Map(pinned.artifacts.map((a) => [a.path, a]));
  const artifacts = [...new Set([...before.keys(), ...after.keys()])].map((path) => {
    const old = before.get(path),
      next = after.get(path);
    return {
      path,
      change: !old ? 'added' : !next ? 'removed' : old.digest === next.digest ? 'same' : 'changed',
      ...(old ? { pinnedBlob: old.blob } : {}),
      ...(next ? { proposedBlob: next.blob } : {}),
    };
  });

  const ids = new Set(revisions.map((c) => c.id));
  const direct = s.tasks.filter((t) => t.contracts.some((id) => ids.has(id)));
  // Потребители — по зависимостям, транзитивно: задача, ждущая затронутую,
  // получит результат, построенный по другому договору.
  const affected = new Set(direct.map((t) => t.id));
  const transitive: Task[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const t of s.tasks)
      if (!affected.has(t.id) && t.dependsOn.some((d) => affected.has(d))) {
        affected.add(t.id);
        transitive.push(t);
        grew = true;
      }
  }
  const describe = (t: Task) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    boardId: boardOf(s, t),
    boundTo: t.contracts.filter((id) => ids.has(id)),
    action: status === 'unchanged' ? ('none' as const) : action(t.status),
  });

  // База прогонов должна получить новую редакцию документа и артефактов,
  // иначе задачи после перепривязки блокируются на сверке закреплений.
  const target = `refs/heads/${owner.targetBranch}`;
  const tip = await git(owner.path, 'rev-parse', '--verify', target).catch(() => undefined);
  const inBase = async (path: string, blob: string) =>
    tip ? (await git(owner.path, 'rev-parse', `${tip}:${path}`).catch(() => '')) === blob : false;
  const head = await git(owner.path, 'rev-parse', 'HEAD');
  const base = {
    branch: owner.targetBranch,
    tip: tip ?? null,
    behind: tip ? Number(await git(owner.path, 'rev-list', '--count', `${tip}..HEAD`)) : null,
    missing: [
      ...(parsed.file &&
      !(await inBase(
        parsed.file,
        await git(owner.path, 'rev-parse', `${head}:${parsed.file}`).catch(() => ''),
      ))
        ? [parsed.file]
        : []),
      ...(
        await Promise.all(
          pinned.artifacts.map(async (a) => ((await inBase(a.path, a.blob)) ? '' : a.path)),
        )
      ).filter(Boolean),
    ],
  };

  const open = [...direct, ...transitive].filter((t) =>
    ['draft', 'ready', 'failed'].includes(t.status),
  );
  const requiredReviews =
    status === 'unchanged'
      ? []
      : [
          {
            kind: 'contract' as const,
            reason: status === 'new' ? 'новый контракт' : 'изменена редакция',
          },
          ...[...new Set(open.map((t) => boardOf(s, t)).filter(Boolean))].map((boardId) => ({
            kind: 'plan' as const,
            boardId: boardId!,
            reason: 'задачи доски привязаны к прежней редакции',
          })),
        ];
  return {
    status,
    title: parsed.title,
    repositoryId: owner.id,
    current: current ? { id: current.id, digest: current.digest } : null,
    proposed: { digest, revision: head },
    changes: {
      document: current ? current.content !== content : true,
      artifacts,
    },
    tasks: { direct: direct.map(describe), transitive: transitive.map(describe) },
    base,
    requiredReviews,
    // Отчёт ничего не меняет: применение — отдельный шаг после ревью.
    applied: false as const,
  };
}
