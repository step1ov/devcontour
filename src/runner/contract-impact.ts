import {
  DomainError,
  type Contract,
  type DevContourState,
  type Task,
  type TaskStatus,
} from '../core/model.ts';
import { contractDigest, samePin, type DevContour } from '../core/service.ts';
import { repository } from '../core/repositories.ts';
import {
  artifactGuard,
  checksWarnings,
  contractContent,
  defaultOwner,
  limitsMessage,
  proposalLimitIssues,
  proposalLimits,
  unboundedProposal,
} from './agent-control.ts';
import { unguardedMessage, type Dependency, type Exempted } from './artifact-closure.ts';
import { gitObjects, pinArtifacts } from './contract-artifacts.ts';
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
  // Отчёт читает предложение без пределов proposalLimits и называет
  // превышения в `limits` рядом с остальными предпроверками: оператор видит
  // их до отправки, вместе с замыканием и задачами. Изменение контракта по
  // такому предложению откажет до ревью.
  const limitIssues = proposalLimitIssues(input);
  // Предложение даже за запасом отчёта — тот же понятный отказ, что у
  // изменения контракта, а не массив схемы.
  const read = unboundedProposal.safeParse(input);
  if (!read.success && limitIssues.length) throw new DomainError(limitsMessage(limitIssues), 400);
  const parsed = unboundedProposal.parse(input);
  const limits = {
    max: proposalLimits,
    issues: limitIssues,
    ...(limitIssues.length ? { refusal: limitsMessage(limitIssues) } : {}),
  };
  const owner = repository(h.config, parsed.repositoryId ?? defaultOwner(h));
  // Отчёт строится по одному закреплённому commit: документ, digest,
  // revision и сверка базы берутся из HEAD, а не из рабочего дерева.
  const head = await git(owner.path, 'rev-parse', 'HEAD');
  if (parsed.file && (await git(owner.path, 'status', '--porcelain', '--', parsed.file)))
    throw new DomainError(
      'Документ контракта изменён после коммита — закоммитьте его: ' + parsed.file,
      400,
    );
  const content = await contractContent(h, parsed, head);
  const pinned = await pinArtifacts(
    owner,
    parsed.artifacts ?? [],
    head,
    h.config.contractArtifacts,
  );
  const digest = contractDigest(content, pinned.artifacts, 2, parsed.checks, parsed.underTest);
  // Незащищённые локальные зависимости артефактов: отчёт называет их, а
  // операция изменения контракта по ним отказывает до ревью.
  const closure: { unguarded: Dependency[]; exempted: Exempted[]; refusal?: string } =
    await artifactGuard(owner, pinned.artifacts, parsed.underTest).then(
      ({ unguarded, exempted }) => ({
        unguarded,
        exempted,
        ...(unguarded.length ? { refusal: unguardedMessage(unguarded) } : {}),
      }),
      (e: unknown) => ({
        unguarded: [],
        exempted: [],
        refusal: e instanceof Error ? e.message : String(e),
      }),
    );
  const s = h.store.read();
  // Редакции одного контракта — один источник в одном компоненте; у inline
  // предложения источника нет, и его редакции узнаются по названию.
  const same = (c: Contract) =>
    (c.repositoryId ?? undefined) === (parsed.repositoryId ?? undefined) &&
    (parsed.file ? c.source === parsed.file : !c.source && c.title === parsed.title);
  const revisions = s.contracts.filter(same);
  const current = revisions.at(-1);
  // Тот же файл, зарегистрированный под другим компонентом, — почти всегда
  // пропущенный repositoryId в предложении, а не новый договор. Молча назвать
  // его новым значило бы завести параллельный контракт без перепривязки задач.
  const elsewhere = parsed.file
    ? [
        ...new Set(
          s.contracts
            .filter((c) => c.source === parsed.file && !same(c))
            .map((c) => c.repositoryId ?? '(общий)'),
        ),
      ]
    : [];
  const status = !current
    ? 'new'
    : samePin(current, content, pinned.artifacts, parsed.checks, parsed.underTest)
      ? 'unchanged'
      : 'changed';

  const before = new Map((current?.artifacts ?? []).map((a) => [a.path, a]));
  const after = new Map(pinned.artifacts.map((a) => [a.path, a]));
  const artifacts = [...new Set([...before.keys(), ...after.keys()])].map((path) => {
    const old = before.get(path),
      next = after.get(path);
    return {
      path,
      change: !old ? 'added' : !next ? 'removed' : old.blob === next.blob ? 'same' : 'changed',
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
  // Сверка с базой — один пакетный запрос Git на документ и все артефакты,
  // а не rev-parse на каждый путь. Отсутствующее имя — пустой blob, как у
  // прежнего rev-parse с отказом.
  const specs = [
    ...(parsed.file ? [`${head}:${parsed.file}`] : []),
    ...(tip ? [parsed.file, ...pinned.artifacts.map((a) => a.path)] : [])
      .filter((path) => path !== undefined)
      .map((path) => `${tip}:${path}`),
  ];
  const objects = await gitObjects(owner.path, specs);
  const blobs = new Map(specs.map((spec, i) => [spec, objects[i]?.blob ?? '']));
  const at = (rev: string, path: string) => blobs.get(`${rev}:${path}`) ?? '';
  const inBase = (path: string, blob: string) => (tip ? at(tip, path) === blob : false);
  const base = {
    branch: owner.targetBranch,
    tip: tip ?? null,
    // Отставание — от того же commit, из которого взяты документ и
    // артефакты, а не от позднего HEAD.
    behind: tip ? Number(await git(owner.path, 'rev-list', '--count', `${tip}..${head}`)) : null,
    missing: [
      ...(parsed.file && !inBase(parsed.file, at(head, parsed.file)) ? [parsed.file] : []),
      ...pinned.artifacts.filter((a) => !inBase(a.path, a.blob)).map((a) => a.path),
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
    closure,
    limits,
    requiredReviews,
    // Структурные предупреждения до ревью: их видно без вызова модели.
    warnings: status === 'unchanged' ? [] : checksWarnings(parsed, current),
    // Отчёт ничего не меняет: применение — отдельный шаг после ревью.
    applied: false as const,
    ...(!current && elsewhere.length
      ? {
          warning: `Файл ${parsed.file} уже зарегистрирован как контракт компонента ${elsewhere.join(', ')}; укажите repositoryId, если меняется он`,
          registeredUnder: elsewhere,
        }
      : {}),
  };
}
