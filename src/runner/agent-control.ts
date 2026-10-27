import { technicalReview } from 'devcontour-harness';
import { reviewExecutionOf, toDomain } from '../harness/execution.ts';
import { runtimeAdapters } from '../harness/adapters.ts';
import { carriedTaskIds } from '../core/work-status.ts';
import { boardOwner } from '../core/sync-state.ts';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DevContour,
  contextDigest,
  contractDigest,
  dependencyDigest,
  digest,
  samePin,
  specDigest,
  scopeDigest,
} from '../core/service.ts';
import { blobBytes, pinArtifacts } from './contract-artifacts.ts';
import { assertUnderTest, unguardedDependencies, unguardedMessage } from './artifact-closure.ts';
import { type Approval, type ContractAttempt, DomainError, relativePath } from '../core/model.ts';
import { adapters, type AgentAdapter } from './adapters.ts';
import { repositories, repository } from '../core/repositories.ts';
import { git } from './process.ts';
import { assertRequirementProof } from './requirements.ts';
import {
  checkDeclaration,
  declarationProblems,
  isReference,
  obligationGates,
  type CheckDeclaration,
} from '../core/checks.ts';
import { spikeRecord, spikesOf } from './checks.ts';

// Контракт живёт в репозитории, и предложение должно на него ссылаться, а не
// нести копию: копию легко отправить на ревью устаревшей, и тогда принятый
// digest не относится ни к одному файлу в дереве. Inline-текст остаётся для
// предложений, у которых файла ещё нет.
/**
 * Пределы предложения контракта. Они те же, что у записи контракта в
 * синхронизации команды (`core/sync-model.ts`): принятая редакция переносится
 * между клонами одной записью, и предложение сверх них не стало бы
 * контрактом. Документированы в docs/cli.md и docs/check-contracts.md.
 */
export const proposalLimits = { artifacts: 50, purpose: 200, underTest: 50 } as const;
/**
 * Схема предложения. `bounded: false` — та же схема без пределов
 * proposalLimits (с запасом от бесконечного входа): ею contract-impact читает
 * предложение, чтобы назвать превышения в отчёте рядом с остальными
 * предпроверками, а не отказать до отчёта.
 */
const proposalSchema = (bounded: boolean) => {
  const limit = (name: keyof typeof proposalLimits) =>
    bounded ? proposalLimits[name] : proposalLimits[name] * 10;
  return z
    .object({
      repositoryId: z.string().optional(),
      title: z.string().trim().min(1).max(180),
      content: z.string().trim().min(1).max(60000).optional(),
      file: relativePath.optional(),
      /**
       * Нормативные файлы договора в том же компоненте: схема, приёмка, эталон.
       * Их содержимое входит в ревью и в digest контракта.
       */
      artifacts: z
        .array(
          z.object({
            path: relativePath,
            purpose: z
              .string()
              .trim()
              .min(1)
              .max(limit('purpose'), {
                error: `purpose артефакта длиннее ${limit('purpose')} знаков`,
              }),
          }),
        )
        .max(limit('artifacts'), { error: `artifacts: больше ${limit('artifacts')} элементов` })
        .optional(),
      /**
       * Реализация, которую закреплённая приёмка проверяет и импортирует
       * намеренно: файлы или каталоги, которые пишет исполнитель. Замыкание
       * зависимостей артефактов в них не заходит; прочие локальные импорты
       * артефактов должны быть закреплены или защищены (artifact-closure.ts).
       */
      underTest: z
        .array(relativePath)
        .max(limit('underTest'), { error: `underTest: больше ${limit('underTest')} элементов` })
        .transform((paths) => [...new Set(paths)].sort())
        .optional(),
      /**
       * Договор проверки: обязательства, независимый способ проверки, покрытие
       * и политика расширения корпуса (core/checks.ts). Структурные пропуски
       * отклоняются до вызова модели; смысл оценивает ревьюер.
       */
      checks: checkDeclaration.optional(),
    })
    .refine((p) => Boolean(p.content) !== Boolean(p.file), {
      message: 'Укажите либо file — путь к контракту в репозитории, либо content',
    });
};
export const contractProposal = proposalSchema(true);
/** Предложение без пределов proposalLimits — только для отчёта contract-impact. */
export const unboundedProposal = proposalSchema(false);

export type LimitIssue = {
  limit: keyof typeof proposalLimits;
  max: number;
  actual: number;
  over: number;
  index?: number;
  path?: string;
};
/**
 * Превышения proposalLimits — по сырому входу, до схемы: какой предел, какие
 * элементы и на сколько. Пусто — пределы соблюдены.
 */
export function proposalLimitIssues(input: unknown): LimitIssue[] {
  const p = (input ?? {}) as { artifacts?: unknown; underTest?: unknown };
  const issues: LimitIssue[] = [];
  const count = (limit: 'artifacts' | 'underTest', list: unknown) => {
    if (Array.isArray(list) && list.length > proposalLimits[limit])
      issues.push({
        limit,
        max: proposalLimits[limit],
        actual: list.length,
        over: list.length - proposalLimits[limit],
      });
  };
  count('artifacts', p.artifacts);
  if (Array.isArray(p.artifacts))
    p.artifacts.forEach((a: unknown, index) => {
      const { purpose, path } = (a ?? {}) as { purpose?: unknown; path?: unknown };
      const length = typeof purpose === 'string' ? purpose.trim().length : 0;
      if (length > proposalLimits.purpose)
        issues.push({
          limit: 'purpose',
          max: proposalLimits.purpose,
          actual: length,
          over: length - proposalLimits.purpose,
          index,
          ...(typeof path === 'string' ? { path } : {}),
        });
    });
  count('underTest', p.underTest);
  return issues;
}
/** Отказ по пределам: что превышено, на сколько и как это исправить. */
export function limitsMessage(issues: LimitIssue[]) {
  const lines = issues.map((i) =>
    i.limit === 'purpose'
      ? `artifacts[${i.index}].purpose${i.path ? ` (${i.path})` : ''}: ${i.actual} знаков при пределе ${i.max}, длиннее на ${i.over}`
      : `${i.limit}: ${i.actual} элементов при пределе ${i.max}, лишних ${i.over}`,
  );
  const remedies = [
    ...(issues.some((i) => i.limit === 'artifacts')
      ? [
          'файлы, которые закреплённые артефакты не импортируют и на которые не ссылаются checks (sets, crossChecks), — журналы, данные, отчёты — уберите из artifacts и защитите через protectedPaths компонента',
          'журналы сверки сведите в один сводный артефакт и назовите его в crossChecks',
        ]
      : []),
    ...(issues.some((i) => i.limit === 'purpose')
      ? ['сократите purpose до одной фразы о роли файла']
      : []),
    ...(issues.some((i) => i.limit === 'underTest')
      ? ['укажите в underTest каталоги реализации вместо отдельных файлов']
      : []),
  ];
  return (
    'Предложение контракта превышает пределы (docs/cli.md, «Пределы предложения»):\n' +
    lines.map((l) => '- ' + l).join('\n') +
    '\nКак исправить:\n' +
    remedies.map((r) => '- ' + r).join('\n')
  );
}
/** Строгий разбор предложения: превышение пределов — понятный отказ, а не массив zod. */
export function parseProposal(input: unknown) {
  const issues = proposalLimitIssues(input);
  if (issues.length) throw new DomainError(limitsMessage(issues), 400);
  return contractProposal.parse(input);
}
/**
 * Предупреждение до вызова модели: предложение без `checks` ревьюер оценит по
 * правилу `verifiability`, и контракт с вычислительными обещаниями будет
 * отклонён. Есть ли такие обещания, решает ревьюер по смыслу — по словам
 * контур их не определяет, поэтому это предупреждение, а не отказ. Оно
 * касается и изменения контракта, утверждённого до появления договора
 * проверки: прежняя редакция без `checks` не освобождает новую от правила.
 */
export function checksWarnings(
  proposal: { checks?: unknown },
  current?: { checks?: unknown } | null,
) {
  if (proposal.checks) return [];
  return [
    {
      code: 'checks-missing' as const,
      rule: VERIFIABILITY,
      message:
        'Предложение без checks: ревью оценит контракт по правилу verifiability, и контракт с вычислительными обещаниями (точность, оптимальность, полнота, производительность) без структурного checks будет отклонён. Объявите обязательства по docs/check-contracts.md; для контракта без таких обещаний (CRUD, сценарии) checks не нужен.' +
        (current
          ? current.checks
            ? ' Действующая редакция объявляет checks — предложение его снимает.'
            : ' Правило действует и для контракта, утверждённого до появления checks.'
          : ''),
    },
  ];
}
type Author = 'codex' | 'claude';
type Runtimes = Record<Author, AgentAdapter>;

// Попытки накапливаются: держим последние, чтобы состояние не росло без предела.
const MAX_CONTRACT_ATTEMPTS = 60;
function recordContractAttempt(h: DevContour, attempt: ContractAttempt) {
  h.store.change('contract.review', (s) => {
    s.contractAttempts = [...(s.contractAttempts ?? []), attempt].slice(-MAX_CONTRACT_ATTEMPTS);
  });
}
/**
 * Раунды предмета, которые прежняя версия провела сама (`contractAttempts`,
 * тот же предмет и заголовок, что и прежде), — история для harness: пока у
 * предмета нет раундов в движке, следующий раунд продолжает их нумерацию, а
 * находки последнего reviewer обязан разобрать. Одобрений и digest прежним
 * раундам не приписывается.
 */
function legacyHistory(h: DevContour, subject: string, title: string) {
  const attempts = (h.store.read().contractAttempts ?? []).filter(
    (a) => a.subject === subject && a.title === title,
  );
  const last = attempts.at(-1);
  if (!last) return undefined;
  return {
    rounds: attempts.length,
    findings: last.findings.map((f) => ({
      severity: f.severity === 'note' ? ('note' as const) : ('blocking' as const),
      message: f.message,
      ...(f.rule ? { rule: f.rule } : {}),
    })),
  };
}

/** Класс находки ревью контракта: обязательство невыполнимо или неизмеримо. */
export const FEASIBILITY = 'feasibility';
/** Класс находки: обязательство нечем независимо проверить. */
export const VERIFIABILITY = 'verifiability';
/**
 * Проверяемость обязательств. Ревью выполнимости оценивало формулировки, а
 * не то, можно ли проверить обещание на классе входов: контрпримеры ловились
 * по одному после серии попыток. Структуру договора проверки контур
 * сверяет сам; ревьюер оценивает смысл — полноту классификации, независимость
 * эталона от проверяемого кода и пределы вывода эксперимента.
 */
const verifiabilityReview = [
  `Assess verifiability. Every computational promise of the contract (accuracy, optimality, completeness, performance) must appear as an obligation of that kind in the structured "checks" declaration, with its input domain, answer rules, an independent verification method with its applicability, coverage families including boundary and adversarial inputs, and separate resource budgets for the implementation and the oracle. A contract with such promises and no checks declaration, an incomplete classification, or a method whose expected answers are derived from the implementation under test or its key algorithm (a shared input format is fine) is a blocking finding with rule "${VERIFIABILITY}". Name the provenance of expected answers you relied on. For obligations marked hard, read the spike: a timeout is inconclusive for that method and budget — it neither proves hardness or impossibility nor allows weakening the obligation; success on a sample does not prove a bound for every input. Ordinary CRUD needs only concrete scenarios with independently stated expected behaviour; do not demand an oracle there.`,
  `An obligation with verification "reference" is checked against pinned reference answer sets instead of a generator: an oracle computed the answers offline, they were cross-checked against another method and pinned as contract artifacts, and each of its gates must report that it replayed its declared share of inputs per family (the controller enforces the counts). This is a legitimate method; judge its substance, listed separately under "references": the oracle must be independent of the implementation and its stated limits (time limits, excluded unsolved inputs) must not bias the sets toward easy inputs without saying so; a cross-check on an unrelated family or a small sample is weak evidence, and a cross-check without "artifacts" (a pinned script or log that reproduces it) is an unverified claim of the author — weigh it as such and ask for the artifact where a promise rests on it; the sets prove the answer only on the inputs they contain. Read "gaps" — what the sets do not prove, such as generalization beyond the set or input classes outside it. A promise of the contract that rests only on a gap, with no other declared method (a generative property, an invariant or an analytic argument), or gaps that understate what the sets miss, is a blocking finding with rule "${VERIFIABILITY}".`,
];
/**
 * Проверка выполнимости обязательств контракта. Ревью одобрило обязательство,
 * невыполнимое в общем виде, и это выяснилось только после серии попыток
 * реализации. Трудность задачи сама по себе не невыполнимость: значат пределы
 * входа, точность, допустимость приближения, время и память. Поэтому ревьюер
 * проверяет, названы ли они, а не ищет в тексте слово «NP».
 */
/**
 * Файл, объявленный реализацией под тестом, исполнитель правит свободно:
 * если в нём логика приёмки (сравнение, эталон, допуск), договор ослаблялся
 * бы без ревью. Отличить это по синтаксису нельзя — решает ревьюер.
 */
const underTestReview = `The proposal declares underTest files: implementation the pinned acceptance imports on purpose and the implementer may change freely. "underTestImports" lists each such file the pinned files reach and its importer. Read each one: it must be implementation under test, not acceptance logic (comparison helpers, expected values, tolerances, fixtures or checks). If any listed file holds acceptance logic, return approved=false with a blocking finding naming the file and asking to pin it in artifacts or protect it instead.`;
const feasibilityReview = [
  `Assess every obligation of the contract for feasibility. For each, check that the contract states: the input domain and size limits; exactness or optimality (or the allowed approximation); the worst case; allowed refusals or failures; the resource model (time, memory, environment); and how the obligation is measured. An obligation that cannot be met in general under the stated limits, or cannot be measured as written, is a blocking finding with rule "${FEASIBILITY}" — name the obligation, the missing or contradictory bound and a concrete input that shows it. Hardness alone is not infeasibility: an exact answer for a hard problem is acceptable when the contract bounds the input, justifies the assumptions or allows a documented fallback. Do not block an obligation only for its wording.`,
];

/**
 * Независимая принимаемость задачи. Гейт первой задачи цепочки включал
 * сценарии следующих, и она не могла пройти; общий файл тестов сам по себе
 * при этом не виноват — виноват выбор сценариев.
 */
const acceptabilityReview = [
  'Only the tasks listed in "approving" are approved by this review; the other tasks of the revision are shown as context, do not count them as missing and do not approve them. Assess independent acceptability of every task. A task must be acceptable without the result of a not-yet-accepted downstream task of the graph. Each task lists "properties": the check-contract obligations it must satisfy now, selected from a shared check file by property id; a shared test file is fine when the selection is exact, and a new function may legitimately have a red test on the current base. Reject, with rule "acceptability", a task whose properties, gates or requirement test ids need behaviour that a later task delivers, or that references properties no contract declares.',
];
/**
 * Предмет ревью в истории harness. План — доска; контракт до регистрации ID
 * не имеет — предмет определяют его заголовок и владелец, как и прежде.
 */
function reviewSubject(
  kind: 'plan' | 'contract',
  title: string,
  repositoryId?: string,
  subjectId?: string,
) {
  if (kind === 'plan' && subjectId) return subjectId;
  return (
    'contract-' +
    createHash('sha256')
      .update(JSON.stringify([title, repositoryId ?? null]))
      .digest('hex')
      .slice(0, 24)
  );
}

/**
 * Раунд технического ревью плана или контракта — `technicalReview` harness:
 * выбор reviewer по правилу вендора политики, вызов под бюджетом, история
 * находок с состоянием каждой прежней. Здесь — только продуктовая часть:
 * разделы запроса, рабочая копия и продуктовая запись согласования.
 */
async function review(
  h: DevContour,
  root: string,
  author: Author,
  subject: string,
  proposal: unknown,
  runtimes: Runtimes,
  repositoryId?: string,
  subjectId?: string,
  checkout?: { path: string; ref: string; sha: string },
): Promise<Approval> {
  if (h.config.mode !== 'local')
    throw new DomainError('AI-согласование доступно только для local mode');
  const kind = subject === 'task plan' ? 'plan' : 'contract';
  const title = (proposal as { title?: string }).title ?? subject;
  const artifact = join(root, 'decisions', randomUUID());
  await mkdir(artifact, { recursive: true });
  const instructions = [
    `Independently review this ${subject}. The author runtime is ${author}.`,
    'Read repo AGENTS.md and docs/spec.md (or the specification referenced in the proposal). Do not edit files, approve work yourself, or run implementation agents.',
    'Reject contradictions with requirements, unclear public interfaces, missing error/UI states, weak acceptance criteria, changes to scope or test policy that conceal failures. A proposal is not proof of implemented functionality.',
    'For a plan, check dependencies, the first complete user scenario, requirement references, required real tests, and agreed API/design contracts. For architecture, assess the chosen stack and bootstrap verification evidence.',
    'For plans, check writePaths, selected library contextPacks, device resources, consumer verification and separation of proposed discoveries from validated knowledge. Findings should include rule, consequence and evidence; do not invent violations to fill the report.',
    'Declared context packs: ' + JSON.stringify(h.config.contextPacks),
    ...(kind === 'contract' ? [...feasibilityReview, ...verifiabilityReview] : []),
    ...(kind === 'contract' &&
    (proposal as { underTestImports?: unknown[] }).underTestImports?.length
      ? [underTestReview]
      : []),
    ...(kind === 'plan' ? acceptabilityReview : []),
    'Return approved=false and concrete blocking findings when revision is needed. Routine technical choices within the specification do not need human approval.',
    ...(checkout
      ? [
          `Your working directory is a read-only checkout of the integration branch ${checkout.ref} at ${checkout.sha}. Tasks of this plan branch from it; the operator's own checkout may lag behind and is not the base.`,
        ]
      : []),
    'Workspace repositories: ' +
      JSON.stringify(
        repositories(h.config).map(({ id, name, kind, path }) => ({ id, name, kind, path })),
      ),
    JSON.stringify(proposal, null, 2),
  ];
  await writeFile(join(artifact, 'proposal.json'), JSON.stringify(proposal, null, 2) + '\n');
  const { engine } = reviewExecutionOf(h);
  const plan = kind === 'plan' ? (proposal as { tasks?: { id?: string }[] }) : undefined;
  const history = legacyHistory(h, subject, title);
  const record = await technicalReview(
    engine,
    engine.policy,
    runtimeAdapters(h, engine.policy, runtimes),
    {
      kind,
      subject: reviewSubject(kind, title, repositoryId, subjectId),
      digest: digest(proposal),
      author,
      instructions,
      ...(repositoryId ? { repositoryId } : {}),
      cwd: checkout?.path ?? h.config.repository,
      artifactDir: artifact,
      // База и журналы контура закрыты reviewer, даже когда лежат внутри
      // checkout (embedded): более конкретный путь побеждает.
      denied: [root],
      meta: {
        ...(repositoryId ? { repositoryId } : {}),
        ...(subjectId ? { subjectId } : {}),
        subjectKind: kind === 'plan' ? 'group' : 'other',
        stage: kind === 'plan' ? 'plan-review' : 'contract-review',
        ...(kind === 'plan' && subjectId
          ? {
              group: {
                id: subjectId,
                workIds: (plan?.tasks ?? []).flatMap((t) => (t.id ? [t.id] : [])),
              },
            }
          : {}),
      },
      ...(history ? { history } : {}),
      signal: AbortSignal.timeout(h.config.runTimeoutMs),
    },
  ).catch((error: unknown) => {
    throw toDomain(error);
  });
  const opened = record.findings.filter((f) => f.status === 'open' && f.openedIn === record.round);
  recordContractAttempt(h, {
    id: artifact.split('/').at(-1) ?? artifact,
    at: record.at,
    subject,
    title,
    repositoryId,
    attempt: record.round,
    approved: record.approved,
    summary: record.summary,
    findings: opened.map((f) => ({
      severity: f.severity,
      message: f.message,
      ...(f.rule ? { rule: f.rule } : {}),
    })),
    artifact,
    authorRuntime: author,
    reviewerRuntime: record.reviewerRuntime,
  });
  if (!record.approved) {
    // Невыполнимое обязательство чинится не правкой текста, а ограничениями
    // или изменением требования: автор должен увидеть это отдельно.
    const feasibility = record.findings.filter(
      (f) => f.status === 'open' && f.severity === 'blocking' && f.rule === FEASIBILITY,
    );
    throw new DomainError(
      `Независимое ревью отклонено: ${record.summary}.` +
        (feasibility.length
          ? ` Обязательства невыполнимы или неизмеримы в заявленном виде: ${feasibility.map((f) => f.message).join('; ')}. Добавьте ограничения области входов и ресурсов, допущения или измените требование.`
          : '') +
        ` Артефакты: ${artifact}`,
    );
  }
  return {
    actor: 'agent',
    authorRuntime: author,
    reviewerRuntime: record.reviewerRuntime as Author,
    artifact,
    digest: digest(proposal),
  };
}

/** Структурные пропуски договора проверки — отказ до вызова модели. */
export function assertDeclaration(
  h: DevContour,
  repositoryId: string,
  declaration: CheckDeclaration,
  artifacts: { path: string }[],
) {
  const problems = declarationProblems(declaration, {
    config: h.config,
    repositoryId,
    artifacts: artifacts.map((a) => a.path),
    spike: (id) => spikeRecord(h, repositoryId, id),
  });
  if (problems.length)
    throw new DomainError('Договор проверки неполон: ' + problems.join('; '), 400);
}
/** Эталонные обязательства договора в форме для ревьюера. */
function references(declaration: CheckDeclaration | undefined) {
  return (declaration?.obligations ?? [])
    .filter((o) => isReference(o) && o.reference)
    .map((o) => ({
      property: o.property,
      promise: o.promise,
      gates: obligationGates(declaration!, o),
      oracle: o.reference!.oracle,
      crossChecks: o.reference!.crossChecks,
      sets: o.reference!.sets.map((s) => ({
        gate: s.gate,
        artifacts: s.artifacts,
        minCases: s.minCases,
      })),
      gaps: o.reference!.gaps,
    }));
}
function referencedSpikes(h: DevContour, repositoryId: string, declaration: CheckDeclaration) {
  const ids = new Set(declaration.obligations.flatMap((o) => o.feasibility?.spike ?? []));
  return spikesOf(h, repositoryId).filter((s) => ids.has(s.id));
}

// Компонент по умолчанию — «main», если он есть, иначе первый настроенный:
// workspace вправе называть репозитории product и library, и вызов без
// repositoryId там не должен падать на несуществующем имени.
export const defaultOwner = (h: DevContour) =>
  repositories(h.config).some((r) => r.id === 'main') ? 'main' : repositories(h.config)[0].id;

// Контракт читается из дерева в момент ревью: ревьюер и реестр видят то же
// самое, что лежит в репозитории, а не то, что автор скопировал когда-то.
export async function contractContent(
  h: DevContour,
  proposal: { content?: string; file?: string; repositoryId?: string },
  /**
   * Читать документ из этого commit, а не из рабочего дерева. Чистый status
   * не доказывает совпадения с HEAD: файл с assume-unchanged показывает
   * «не изменён» при другом тексте. Отчёт или операция, которые ссылаются на
   * commit, читают именно его.
   */
  revision?: string,
) {
  if (!proposal.file) return proposal.content!;
  if (revision) {
    const repo = repository(h.config, proposal.repositoryId ?? defaultOwner(h));
    const entry = await git(repo.path, 'ls-tree', revision, '--', proposal.file).catch(() => '');
    if (!entry) throw new DomainError('Документ контракта не закоммичен: ' + proposal.file, 400);
    if (entry.startsWith('120000'))
      throw new DomainError('Контракт должен лежать внутри репозитория', 400);
    const content = blobBytes(repo.path, entry.split(/\s+/)[2]).toString('utf8');
    if (!content.trim()) throw new DomainError('Файл контракта пуст: ' + proposal.file, 400);
    return content;
  }
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

/**
 * Незакреплённые и незащищённые локальные зависимости закреплённых
 * артефактов на их ревизии. Через них исполнитель ослабил бы приёмку, не
 * тронув ни одного закреплённого файла.
 */
export async function artifactGuard(
  owner: { path: string; protectedPaths: string[]; generatedPaths?: string[] },
  artifacts: { path: string; revision: string }[],
  underTest: string[] = [],
) {
  if (!artifacts.length) {
    if (underTest.length)
      throw new DomainError(
        'underTest без artifacts: реализацию под тестом объявляют для закреплённой приёмки',
        400,
      );
    return { unguarded: [], exempted: [] };
  }
  const paths = artifacts.map((a) => a.path);
  assertUnderTest(paths, underTest);
  return unguardedDependencies(owner, artifacts[0].revision, paths, underTest);
}

export async function reviewContract(
  h: DevContour,
  root: string,
  input: unknown,
  author: Author,
  runtimes: Runtimes = adapters,
  /**
   * Проверка владельца перед регистрацией — в той же транзакции. Ответ ревью,
   * пришедший после потери владения операцией, не создаёт редакцию.
   */
  beforeCommit: () => void = () => {},
  /** Ревьюировать документ из этого commit (см. contractContent). */
  revision?: string,
) {
  const parsed = parseProposal(input);
  const content = await contractContent(h, parsed, revision);
  const owner = repository(h.config, parsed.repositoryId ?? defaultOwner(h));
  const pinned = await pinArtifacts(
    owner,
    parsed.artifacts ?? [],
    revision,
    h.config.contractArtifacts,
  );
  // Структура договора проверки — до вызова модели: пропущенная область,
  // способ проверки без закреплённого эталона или эксперимент, на который
  // никто не ссылается, стоили бы вызова и были бы отклонены всё равно.
  if (parsed.checks) assertDeclaration(h, owner.id, parsed.checks, pinned.artifacts);
  // Отказ обхода (symlink, выход из репозитория, предел) тоже сохраняется:
  // для утверждённого договора он предупреждение, для нового — отказ.
  const closure = await artifactGuard(owner, pinned.artifacts, parsed.underTest).then(
    (c) => c,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  const guard =
    closure instanceof Error
      ? closure
      : closure.unguarded.length
        ? new DomainError(unguardedMessage(closure.unguarded), 400)
        : undefined;
  const exempted = closure instanceof Error ? [] : closure.exempted;

  const contractId = contractDigest(content, pinned.artifacts, 2, parsed.checks, parsed.underTest);
  // Повтор совпадает с утверждённым контрактом, только если совпали и
  // артефакты: изменённая схема при прежнем тексте — новый договор.
  const existing = h.store.read().contracts.find(
    (c) =>
      c.title === parsed.title &&
      c.repositoryId === parsed.repositoryId &&
      // По тексту и blob, а не по digest: запись прежней формулы с тем же
      // содержимым — тот же договор, а не повод для нового ревью.
      samePin(c, content, pinned.artifacts, parsed.checks, parsed.underTest),
  );
  // Контракт без manifest по-прежнему работает, но закреплён только текст.
  const warning = pinned.artifacts.length
    ? undefined
    : 'Контракт без artifacts: закреплён только документ; схемы и файлы приёмки, на которые он ссылается, могут измениться без ревью';
  // Утверждённый договор не отзывается задним числом: повтор называет
  // незащищённые зависимости предупреждением. Новый — отказ до ревью.
  if (existing)
    return {
      status: 'already-approved',
      contract: existing,
      ...(warning || guard
        ? {
            warning: [warning, guard?.message].filter(Boolean).join('. '),
          }
        : {}),
    };
  if (guard) throw guard;
  // Ревьюер читает неизменный снимок: закреплённое содержимое артефактов, а
  // не рабочие файлы, которые могут измениться во время ревью.
  const proposal = {
    ...parsed,
    content,
    ...(pinned.contents.length ? { artifacts: pinned.contents } : {}),
    // Файлы underTest, до которых дошла приёмка, и кто их импортирует:
    // ревьюер подтверждает, что это реализация, а не логика приёмки.
    ...(exempted.length ? { underTestImports: exempted } : {}),
    // Эксперименты выполнимости, на которые ссылаются обязательства: их
    // результат и пределы вывода ревьюер читает сам, а не со слов автора.
    ...(parsed.checks ? { spikes: referencedSpikes(h, owner.id, parsed.checks) } : {}),
    // Эталонные обязательства отдельно: эталон, сверка, наборы и пределы
    // (`gaps`) — ревьюер видит, чего наборы не доказывают, рядом с договором.
    ...(references(parsed.checks).length ? { references: references(parsed.checks) } : {}),
  };
  const approval = await review(
    h,
    root,
    author,
    'contract / architecture decision',
    proposal,
    runtimes,
    proposal.repositoryId,
  );
  // Решение относится к просмотренному снимку. Если за время ревью изменился
  // HEAD с другим содержимым артефактов или сам документ, одобрение к
  // текущему дереву не относится.
  const after = await pinArtifacts(
    owner,
    parsed.artifacts ?? [],
    revision,
    h.config.contractArtifacts,
  );
  if (
    contractDigest(
      await contractContent(h, parsed, revision),
      after.artifacts,
      2,
      parsed.checks,
      parsed.underTest,
    ) !== contractId
  )
    throw new DomainError(
      'Контракт или его артефакты изменились во время ревью; отправьте его на ревью заново',
      409,
    );
  if (h.config.approvalMode === 'operator')
    return { status: 'awaiting-operator', proposal, approval, ...(warning ? { warning } : {}) };
  return {
    status: 'approved',
    contract: h.store.atomic(() => {
      beforeCommit();
      return h.contract(
        proposal.title,
        proposal.content,
        approval,
        proposal.repositoryId,
        proposal.file,
        pinned.artifacts,
        parsed.checks,
        parsed.underTest,
      );
    }),
    ...(warning ? { warning } : {}),
  };
}

/**
 * Рабочая копия ветки интеграции для ревью плана. Задачи ответвляются от
 * неё, а не от checkout человека: на пилоте ревьюер читал main, где ядро ещё
 * не было реализовано, и требовал зависимость, давно принятую в интеграции.
 * Нет ветки (контур ещё не создал её) — ревью идёт в основном checkout.
 */
async function withIntegrationCheckout<T>(
  h: DevContour,
  root: string,
  repositoryId: string | undefined,
  action: (checkout?: { path: string; ref: string; sha: string }) => Promise<T>,
) {
  const repo = repository(h.config, repositoryId ?? defaultOwner(h));
  let sha: string;
  try {
    sha = await git(repo.path, 'rev-parse', '--verify', `refs/heads/${repo.targetBranch}^{commit}`);
  } catch {
    return action();
  }
  const path = join(root, 'review-checkouts', randomUUID());
  await mkdir(join(root, 'review-checkouts'), { recursive: true });
  await git(repo.path, 'worktree', 'add', '--detach', path, sha);
  try {
    return await action({ path, ref: repo.targetBranch, sha });
  } finally {
    await git(repo.path, 'worktree', 'remove', '--force', path).catch(() => undefined);
  }
}

export async function reviewPlan(
  h: DevContour,
  root: string,
  boardId: string,
  author: Author,
  runtimes: Runtimes = adapters,
  beforeCommit: () => void = () => {},
  /**
   * Какие черновики выпустить. На доске находок разобранные находки соседствуют
   * с неразобранными, а ревью выпускало все черновики сразу: выпустить одну
   * было нельзя, пока не разобраны остальные. Невыбранные черновики в
   * предложение не входят и остаются черновиками.
   */
  selected?: string[],
  /**
   * Показать ревьюеру невыбранные черновики ревизии как контекст. Смена
   * контракта включает: её план иначе казался ревьюеру неполным. Доска
   * находок — нет: неразобранные находки в предложение не входят.
   */
  context = false,
) {
  const state = h.store.read();
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) throw new DomainError('Доска не найдена');
  const revision = board.revisions.at(-1)!;
  if (revision.status !== 'active') throw new DomainError('Доска уже принята');
  const all = state.tasks.filter((t) => revision.taskIds.includes(t.id));
  if (!all.length) throw new DomainError('Добавьте задачи перед ревью плана');
  const foreign = (selected ?? []).filter(
    (id) => !all.some((t) => t.id === id && t.status === 'draft'),
  );
  if (foreign.length) throw new DomainError('Не черновики этой доски: ' + foreign.join(', '));
  // С контекстом ревьюер видит всю ревизию — и невыбранные черновики, — но
  // утверждаются только выбранные. «Видно ревьюеру» и «можно выпустить» не
  // смешиваются: соседний черновик не утверждается побочно.
  const tasks =
    selected && !context ? all.filter((t) => t.status !== 'draft' || selected.includes(t.id)) : all;
  const drafts = selected
    ? all.filter((t) => t.status === 'draft' && selected.includes(t.id))
    : all.filter((t) => t.status === 'draft');
  if (!drafts.length) return { status: 'already-approved', boardId };
  // Предусловия утверждения — до ревью: отказ после одобрения тратил вызов
  // модели впустую.
  drafts.forEach((t) => h.approvable(state, t));
  const contractIds = new Set(tasks.flatMap((t) => t.contracts));
  // Зависимости вне предложения ревьюер проверить не может: база контура
  // ему закрыта. Это задачи других досок и невыбранные черновики своей —
  // ревью планов при смене контракта выбирает только перепривязанные, и
  // предшественник из той же доски пропадал из виду. Статус и принятый SHA
  // входят в предложение, а у ещё не выполненной — и её постановка: иначе
  // ревью требовало «карточку внешней зависимости».
  const shown = new Set(tasks.map((t) => t.id));
  const externalDependencies = [
    ...new Set(tasks.flatMap((t) => t.dependsOn).filter((id) => !shown.has(id))),
  ].map((id) => {
    const t = state.tasks.find((x) => x.id === id);
    return {
      id,
      title: t?.title,
      status: t?.status,
      resultSha: t?.resultSha,
      ...(t && t.status !== 'done' && t.status !== 'cancelled'
        ? { description: t.description, acceptance: t.acceptance, gates: t.gates }
        : {}),
    };
  });
  // Следующий этап и корректировка несут задачи принятой ревизии. Их
  // результат уже принят, и ревьюер получает их кратко: полный текст прежних
  // постановок раздувал бы предложение с каждым этапом и выдавал принятое за
  // предмет нового ревью. Цель ревизии — её причина.
  const carried = carriedTaskIds(board, state.tasks);
  const proposal = {
    // Прошлые находки ревью ищутся по названию. Без номера ревизии этап или
    // корректировка получали находки к плану первой ревизии как «открытые».
    title: revision.number > 1 ? `${board.title} — ревизия ${revision.number}` : board.title,
    description: board.description,
    revision: revision.number,
    ...(revision.number > 1 ? { goal: revision.reason } : {}),
    tasks: tasks.filter((t) => !carried.has(t.id)),
    // Что утверждает это ревью; остальные задачи — контекст, их состав и
    // постановки закреплены, и их изменение во время ревью делает его устаревшим.
    approving: drafts.map((t) => t.id),
    ...(carried.size
      ? {
          acceptedEarlier: tasks
            .filter((t) => carried.has(t.id))
            .map((t) => ({ id: t.id, title: t.title, status: t.status, resultSha: t.resultSha })),
        }
      : {}),
    ...(externalDependencies.length ? { externalDependencies } : {}),
    contracts: state.contracts.filter((c) => contractIds.has(c.id)),
    // Какие задачи обязаны подтвердить каждое свойство договора проверки:
    // по нему ревьюер видит, не требует ли задача результата следующей.
    ...(tasks.some((t) => t.properties?.length)
      ? {
          propertyScope: Object.fromEntries(
            [...new Set(tasks.flatMap((t) => t.properties ?? []))].map((p) => [
              p,
              tasks.filter((t) => t.properties?.includes(p)).map((t) => t.id),
            ]),
          ),
        }
      : {}),
  };
  // Утверждается только то, что ревьюер прочёл целиком: черновик, ушедший
  // в краткую сводку принятого, означал бы утверждение без ревью.
  const hidden = drafts.filter((t) => !proposal.tasks.includes(t));
  if (hidden.length)
    throw new DomainError('Черновики вне предложения ревью: ' + hidden.map((t) => t.id).join(', '));
  // Цель ревизии входит в предложение и потому — в то, что утверждается:
  // смена цели во время ревью (например, через sync) отменяет утверждение.
  const expected = {
    revision: revision.number,
    reason: revision.reason,
    taskIds: revision.taskIds,
    dependencies: Object.fromEntries(
      externalDependencies.map((d) => [
        d.id,
        dependencyDigest(state.tasks.find((t) => t.id === d.id)!),
      ]),
    ),
    // Показанный контекст закрепляется по смыслу: постановка, гейты и
    // принятый результат. Ход чужой попытки (running → verifying) — не
    // смысловое изменение и ревью не обесценивает.
    context: Object.fromEntries(
      proposal.tasks.filter((t) => !drafts.includes(t)).map((t) => [t.id, contextDigest(t)]),
    ),
    tasks: Object.fromEntries(drafts.map((t) => [t.id, specDigest(t)])),
    // Область проверок не входит в digest постановки: закрепляется отдельно.
    scopes: Object.fromEntries(drafts.map((t) => [t.id, scopeDigest(t)])),
    // Политика исполнения, включая закреплённый контекст, при котором
    // ревьюер читал план: её смена во время ревью делает одобрение устаревшим.
    policies: Object.fromEntries(
      // Потребители задач — тоже: их gates входят в договор задачи.
      [
        ...new Set(
          drafts.flatMap((t) => [
            t.repositoryId,
            ...(t.consumers ?? []).map((c) => c.repositoryId),
          ]),
        ),
      ].map((id) => [id, h.policyDigest(id)]),
    ),
  };
  const owner = boardOwner(board, state);
  const approval = await withIntegrationCheckout(h, root, owner, (checkout) =>
    review(h, root, author, 'task plan', proposal, runtimes, owner, boardId, checkout),
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
  // Отменённые задачи в объём приёмки не входят (см. DevContour.accept).
  const tasks = revision.taskIds
    .map((id) => state.tasks.find((t) => t.id === id)!)
    .filter((t) => t.status !== 'cancelled');
  if (!tasks.length || tasks.some((t) => t.status !== 'done' || !t.resultSha))
    throw new DomainError('Приёмка требует done, проверки и интеграцию всех задач');
  // Критерий, назвавший свой тест, предъявляет его здесь: приёмка относится к
  // принятому SHA, а зелёная проверка сама по себе не говорит, что заявленное
  // поведение проверял кто-нибудь.
  // Перенесённые из принятой ревизии задачи предъявили доказательства при её
  // приёмке; заново их не требуют (см. carriedTaskIds).
  const carried = carriedTaskIds(board, state.tasks);
  for (const task of tasks) if (!carried.has(task.id)) assertRequirementProof(h, task, state);
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
