import { basename } from 'node:path';
import { DomainError, type Contract } from '../core/model.ts';
import {
  contractDigest,
  latestRedaction,
  newerRedaction,
  sameObligations,
  type DevContour,
} from '../core/service.ts';
import { repository } from '../core/repositories.ts';
import { executionOf } from '../harness/execution.ts';
import { adapters, type AgentAdapter } from './adapters.ts';
import {
  contractContent,
  defaultOwner,
  parseProposal,
  CONSOLIDATION,
  CONSOLIDATION_SUBJECT,
  reviewConsolidationRound,
} from './agent-control.ts';
import { pinArtifacts } from './contract-artifacts.ts';
import {
  definitions,
  headingLabel,
  headings,
  ruleTokens,
  sections,
  slug,
  textChecks,
} from '../core/contract-text.ts';

export {
  anchors,
  definitions,
  headings,
  idTokens,
  referencedAnchors,
  ruleTokens,
  sections,
  slug,
} from '../core/contract-text.ts';

/**
 * Консолидация контракта (F20): переписать документ, накопивший поправки
 * этапов, в чистое описание текущего поведения без изменения смысла.
 *
 * Сначала — детерминированные предпроверки без модели: есть действующая
 * редакция документа; закреплённые артефакты, checks и underTest побайтно
 * те же; новый текст короче; каждый ID-токен прежнего текста остался;
 * заголовки и якоря, на которые ссылаются соседние зарегистрированные
 * контракты, остались. Затем — отдельное ревью равносильности
 * (`consolidationReview`): полное отображение старого текста в новый и отказ
 * за выпавшее, ослабленное, расширенное или воскрешённое правило.
 * Зарегистрированная редакция несёт `consolidates`, и задачи прежней
 * редакции сохраняют привязку (`supersededBy`).
 */

/** Ревью равносильности, отменённое контуром: ответ отнёсся к устаревшему входу. */
export class StaleConsolidation extends DomainError {}

/** Начало находки контура о неполном отображении — по нему узнаётся прошлый раунд. */
const INCOMPLETE = 'Неполное отображение старого текста в новый';

/** Текст заголовка без явного якоря `{#id}`. */
/**
 * Текст без разметки Markdown для сравнения заголовков: ссылки `[x](y)` →
 * `x`, без `` ` ``, `*`, `_`, пробелы схлопнуты. Ревьюер пишет заголовок
 * `` `GET /items` `` как «GET /items» — это тот же заголовок.
 */
const plain = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
/** Текст заголовка без явного якоря `{#id}` и без разметки. */
const headingText = (h: string) => plain(h.replace(/\{#[^}]*\}\s*$/, ''));
const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `phrase` в `text` целым словом или фразой, без учёта регистра. */
const whole = (text: string, phrase: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(phrase)}(?![\\p{L}\\p{N}_-])`, 'iu').test(text);

/**
 * Как ревьюер называет заголовок: целиком, якорем, меткой (`ORD-04`), а
 * нумерованный раздел ещё и без номера в кавычках («Область действия»),
 * номером с первым словом («10. Ограничения») или знаком параграфа (`§2.1`).
 */
function headingName(heading: string) {
  const text = headingText(heading);
  const number = /^(\d+(?:\.\d+)*)(\.?)\s+(\S+)/u.exec(text);
  const bare = number ? text.slice(number[0].length - number[3].length) : '';
  return {
    text,
    label: headingLabel(heading),
    number: number?.[1],
    forms: [text, slug(text), ...(number ? [`«${bare}»`, `"${bare}"`, number[0]] : [])],
  };
}
/** Называет ли `side` заголовок `h` (метка — отдельно: она ведёт себя как ID). */
const names = (side: string, h: ReturnType<typeof headingName>) =>
  h.forms.some((f) => whole(side, f)) ||
  (!!h.number && new RegExp(`§\\s?${escape(h.number)}(?!\\.?\\d)`, 'u').test(side));

/**
 * Пропуски отображения в итоге ревью. Отображение — строки «старое → новое»
 * (`→` или `->`; несколько пар в строке — через `;`). Строка годна, если в её
 * левой части не больше одного заголовка прежнего текста и не все правила
 * документа сразу (при двух правилах и больше), а правая называет хотя бы
 * одну цель в новом тексте: ID, заголовок (целиком или меткой вроде
 * `ORD-04`) или якорь. Заголовок прежнего текста слева годной строки
 * отображён. ID правила слева отображён, если цель его определяет: в
 * собственном тексте раздела цели (раздел ID-цели — тот, где этот ID
 * определён) ID стоит в месте определения, а не упоминанием. Так несколько ID
 * делят одну строку. Слияние пишется явно — `merged into REQ-1` или
 * `слито в REQ-1`: REQ-1 определён в новом тексте, и его раздел держит
 * слитый ID. Правило, которое в новом тексте больше нигде не определено и
 * не слито, — пропуск с пометкой «в новом тексте не определено».
 *
 * Отображения требуют ID, которые прежний текст определяет сам
 * (`definitions`), и заголовки с собственным текстом (k-е вхождение
 * заголовка только с подразделами, если в новом тексте есть k-е вхождение,
 * отображать не нужно). Ссылки на ID, определённые в другом месте (ADR,
 * сценарии тестов, правила соседних документов), строки не требуют, пока
 * стоят в новом тексте дословно; пропавшая ссылка — пропуск. Перечисление
 * без стрелок, ссылка в никуда, одна строка на несколько заголовков или на
 * все правила и совпадение по части слова отображением не считаются.
 */
export function mappingGaps(previous: string, next: string, summary: string) {
  const newIds = new Set(ruleTokens(next));
  const defined = definitions(previous);
  const oldIds = ruleTokens(previous);
  const rules = oldIds.filter((id) => defined.has(id));
  // Заголовок без собственного текста (только подразделы), оставшийся в новом
  // тексте, ничего не несёт: отображать в нём нечего. Считается по месту:
  // k-е вхождение заголовка пусто, и в новом тексте есть k-е вхождение.
  const kept = new Map<string, number>();
  for (const h of headings(next).map(headingText)) kept.set(h, (kept.get(h) ?? 0) + 1);
  const seen = new Map<string, number>();
  const oldHeads = sections(previous)
    .slice(1)
    .map((p) => {
      const name = headingName(p.heading!);
      const k = (seen.get(name.text) ?? 0) + 1;
      seen.set(name.text, k);
      const empty = !p.text.split('\n').slice(1).join('').trim();
      return { ...name, exempt: empty && (kept.get(name.text) ?? 0) >= k };
    })
    .filter((h) => h.text && !h.exempt);
  const parts = sections(next).map((s) => ({
    ...s,
    ids: new Set(ruleTokens(s.text)),
    defines: definitions(s.text),
    name: s.heading === undefined ? undefined : headingName(s.heading),
  }));
  const newDefined = definitions(next);
  // Раздел ID-цели: где ID определён сильнее всего; не определён — где упомянут.
  const strongest = (id: string) => {
    const own = parts.map((p) => p.defines.get(id) ?? 0);
    const best = Math.max(...own);
    return best && newDefined.has(id)
      ? parts.filter((_, i) => own[i] === best)
      : parts.filter((p) => p.ids.has(id));
  };
  const covered = { ids: new Set<string>(), heads: new Set<string>() };
  const pairs = summary.split('\n').flatMap((raw) => {
    const line = plain(raw);
    const arrows = line.match(/→|->/gu)?.length ?? 0;
    return arrows > 1 ? line.split(';') : [line];
  });
  for (const pair of pairs) {
    const m = /^(.*?)(?:→|->)(.*)$/u.exec(pair);
    if (!m) continue;
    const [, left, right] = m;
    const heads = oldHeads.filter((h) => names(left, h));
    if (heads.length > 1) continue;
    // Одна строка на все правила документа — не отображение.
    const named = new Set(ruleTokens(left));
    if (rules.length > 1 && rules.every((id) => named.has(id))) continue;
    const targets = [
      ...new Set([
        ...ruleTokens(right)
          .filter((id) => newIds.has(id))
          .flatMap(strongest),
        ...parts.filter(
          (p) =>
            (p.name && (names(right, p.name) || (p.name.label && whole(right, p.name.label)))) ||
            p.anchors.some((a) => whole(right, a)),
        ),
      ]),
    ];
    if (!targets.length) continue;
    // Слияние называется явно: «merged into REQ-1» или «слито в REQ-1», и
    // REQ-1 определён в новом тексте; его раздел держит слитый ID.
    const into = /(?:merged into|слито в)\s+([^\s,;()]+)/iu.exec(right)?.[1];
    const merged = ruleTokens(into ?? '')
      .filter((id) => newDefined.has(id))
      .flatMap(strongest);
    // ID отображён, если цель его определяет (не просто упоминает) или он
    // слит в определённый ID.
    const holds = (id: string) =>
      targets.some((t) => t.defines.has(id)) || merged.some((t) => t.ids.has(id));
    for (const h of heads) covered.heads.add(h.text);
    // Раздел, названный меткой (`ORD-04`), — как его ID.
    for (const h of oldHeads)
      if (h.label && whole(left, h.label)) {
        const id = ruleTokens(h.label)[0];
        if (id ? holds(id) : targets.some((t) => whole(t.text, h.label!)))
          covered.heads.add(h.text);
      }
    for (const id of named) if (holds(id)) covered.ids.add(id);
  }
  return [
    ...new Set([
      ...rules
        .filter((id) => !covered.ids.has(id))
        .map((id) => (newDefined.has(id) ? id : `${id} (в новом тексте не определено)`)),
      ...oldIds.filter((id) => !defined.has(id) && !newIds.has(id)),
      ...oldHeads.filter((h) => !covered.heads.has(h.text)).map((h) => `«${h.text}»`),
    ]),
  ];
}

/** «пропуск», «пропуска», «пропусков» по числу. */
const plural = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? 'пропуск'
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)
      ? 'пропуска'
      : 'пропусков';

/** Предел выдержек соседей и вопросов в запросе ревьюера. */
const EXCERPTS = 40;
const INPUTS = 20;

/** Строки соседа, упоминающие документ, с соседними строками — для ревьюера. */
function excerpts(text: string, file: string) {
  const name = basename(file);
  const lines = text.split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (line.includes(name))
      out.push(
        lines
          .slice(Math.max(0, i - 1), i + 2)
          .join('\n')
          .slice(0, 1000),
      );
  });
  return out.slice(0, EXCERPTS);
}

export interface ConsolidationPlan {
  current: Contract;
  content: string;
  pinned: Awaited<ReturnType<typeof pinArtifacts>>;
  /** ID правил, которые документ определяет сам: им нужна строка отображения. */
  ids: string[];
  /** ID, на которые документ только ссылается: остаются дословно. */
  references: string[];
  siblings: { id: string; title: string; source?: string; excerpts: string[] }[];
  inputs: { id: string; taskId: string; lifecycle: string; question: string }[];
}

/** Предложение консолидации — строгий разбор и документ из файла. */
export type ConsolidationProposal = ReturnType<typeof parseProposal>;

/**
 * Предпроверки консолидации по документу на `revision` — отказ до удержаний и
 * до вызова модели. Повторяются перед регистрацией: за время ревью могла
 * появиться новая редакция документа.
 */
export async function consolidationPlan(
  h: DevContour,
  proposal: ConsolidationProposal,
  revision?: string,
): Promise<ConsolidationPlan> {
  if (!proposal.file)
    throw new DomainError(
      'Консолидация переписывает документ контракта из файла: укажите file, а не content',
      400,
    );
  const file = proposal.file;
  const s = h.store.read();
  const current = latestRedaction(s.contracts, file, proposal.repositoryId);
  if (!current)
    throw new DomainError(
      `Консолидировать нечего: у ${file} нет зарегистрированной редакции. Новый контракт проводится обычным contract-change`,
      400,
    );
  if (current.title !== proposal.title)
    throw new DomainError(
      `Консолидация сохраняет название контракта: «${current.title}», а не «${proposal.title}»`,
      400,
    );
  const owner = repository(h.config, proposal.repositoryId ?? defaultOwner(h));
  const content = await contractContent(h, proposal, revision);
  const pinned = await pinArtifacts(
    owner,
    proposal.artifacts ?? [],
    revision,
    h.config.contractArtifacts,
  );
  if (!sameObligations(current, pinned.artifacts, proposal.checks, proposal.underTest)) {
    const differs = (a: unknown, b: unknown) =>
      JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
    const changed = [
      differs(current.checks, proposal.checks) ? 'checks' : '',
      differs(
        current.underTest?.length ? current.underTest : null,
        proposal.underTest?.length ? proposal.underTest : null,
      )
        ? 'underTest'
        : '',
      sameObligations({ ...current, checks: undefined, underTest: undefined }, pinned.artifacts)
        ? ''
        : 'artifacts',
    ].filter(Boolean);
    throw new DomainError(
      `Консолидация меняет только текст документа, а предложение меняет ${changed.join(', ')} действующей редакции ${current.id}: такое изменение проводится обычным contract-change`,
      400,
    );
  }
  if (content === current.content)
    throw new DomainError('Текст совпадает с действующей редакцией: консолидировать нечего', 400);
  // Соседние зарегистрированные контракты: действующие редакции других
  // документов. Ссылка на якорь этого документа должна остаться рабочей.
  const siblings = s.contracts.filter(
    (c) => c.source !== file && !newerRedaction(s.contracts, c.id) && typeof c.content === 'string',
  );
  const checks = textChecks(current.content, content, file, siblings, ruleTokens);
  if (checks.longer)
    throw new DomainError(
      `Консолидация сокращает документ: новый текст — ${content.length} знаков, действующий — ${current.content.length}. Дополнение правил — обычный contract-change`,
      400,
    );
  if (checks.lost.length)
    throw new DomainError(
      `Консолидация не может убрать идентификаторы правил: в новом тексте нет ${checks.lost.join(', ')}. Верните их на место переписанных правил`,
      400,
    );
  if (checks.broken.length)
    throw new DomainError(
      `Соседние контракты ссылаются на разделы, которых в новом тексте нет: ${checks.broken.join('; ')}. Сохраните эти заголовки или якоря`,
      400,
    );
  const defined = definitions(current.content);
  const all = ruleTokens(current.content);
  const ids = all.filter((id) => defined.has(id));
  return {
    current,
    content,
    pinned,
    ids,
    references: all.filter((id) => !defined.has(id)),
    siblings: siblings
      .map((c) => ({
        id: c.id,
        title: c.title,
        ...(c.source ? { source: c.source } : {}),
        excerpts: excerpts(c.content, file),
      }))
      .filter((c) => c.excerpts.length),
    inputs: openInputs(h, file),
  };
}

/** Открытые вопросы исполнителей, упоминающие документ: новый текст не решает их иначе. */
function openInputs(h: DevContour, file: string) {
  let requests: ReturnType<ReturnType<typeof executionOf>['engine']['inputRequests']>;
  try {
    requests = executionOf(h).engine.inputRequests();
  } catch {
    return [];
  }
  const name = basename(file);
  return requests
    .filter((r) => ['pending', 'answered'].includes(r.lifecycle))
    .filter((r) => JSON.stringify(r).includes(name))
    .slice(0, INPUTS)
    .map((r) => ({
      id: r.id,
      taskId: r.workId,
      lifecycle: r.lifecycle,
      question: JSON.stringify(r.question).slice(0, 2000),
    }));
}

/**
 * Ревью равносильности и регистрация консолидации. `beforeCommit` — проверка
 * владения операцией в транзакции регистрации. Отказ ревью — `DomainError`
 * с каталогом решения, ничего не зарегистрировано.
 */
export async function reviewConsolidation(
  h: DevContour,
  root: string,
  input: unknown,
  author: 'codex' | 'claude',
  runtimes: Record<'codex' | 'claude', AgentAdapter> = adapters,
  beforeCommit: () => void = () => {},
  revision?: string,
) {
  if (h.config.approvalMode === 'operator')
    throw new DomainError(
      'В режиме operator изменение контракта проводит оператор: ревью ждёт его подтверждения',
      409,
    );
  const parsed = parseProposal(input);
  const plan = await consolidationPlan(h, parsed, revision);
  const expected = contractDigest(
    plan.content,
    plan.pinned.artifacts,
    2,
    parsed.checks,
    parsed.underTest,
  );
  // Прошлый раунд этого контракта отклонён контуром за неполное отображение:
  // его пропуски входят в предложение. Тогда digest предложения другой, и
  // harness проводит новый раунд, а не возвращает прежнее одобрение.
  const last = (h.store.read().contractAttempts ?? [])
    .filter((a) => a.subject === CONSOLIDATION_SUBJECT && a.title === parsed.title)
    .at(-1);
  const incomplete = last?.findings.find(
    (f) => f.rule === CONSOLIDATION && f.message.startsWith(INCOMPLETE),
  );
  const approval = await reviewConsolidationRound(h, root, author, runtimes, {
    ...(incomplete
      ? {
          incompleteMapping: {
            round: last!.id,
            finding: incomplete.message,
            ...(last!.gaps ? { gaps: last!.gaps } : {}),
          },
        }
      : {}),
    title: parsed.title,
    ...(parsed.repositoryId ? { repositoryId: parsed.repositoryId } : {}),
    file: parsed.file!,
    previous: { id: plan.current.id, content: plan.current.content },
    content: plan.content,
    ids: plan.ids,
    references: plan.references,
    ...(plan.pinned.contents.length ? { artifacts: plan.pinned.contents } : {}),
    ...(parsed.checks ? { checks: parsed.checks } : {}),
    ...(parsed.underTest?.length ? { underTest: parsed.underTest } : {}),
    siblings: plan.siblings,
    inputs: plan.inputs,
  });
  // Отображение проверяется по итогу ревью: каждый ID и заголовок прежнего
  // текста назван. Иначе раунд считается отклонённым — с находкой в истории.
  const attempt = (h.store.read().contractAttempts ?? []).find(
    (a) => a.artifact === approval.artifact,
  );
  const gaps = mappingGaps(plan.current.content, plan.content, attempt?.summary ?? '');
  if (gaps.length) {
    // Одобрение смысла с неполным отображением — не отказ по смыслу: раунд
    // записывается исходом `incomplete-mapping` с полным списком пропусков,
    // и следующий раунд получает его целиком.
    const message = `${INCOMPLETE}: ревью одобрило смысл, но итог не называет ${gaps.length} ${plural(gaps.length)}: ${gaps.join(', ')}`;
    h.store.change('contract.review', (s) => {
      const a = s.contractAttempts?.find((x) => x.artifact === approval.artifact);
      if (!a) return;
      a.approved = false;
      a.outcome = 'incomplete-mapping';
      a.gaps = gaps;
      a.findings = [...a.findings, { severity: 'blocking', message, rule: CONSOLIDATION }];
    });
    throw new DomainError(`${message}. Артефакты: ${approval.artifact}`);
  }
  // Решение относится к просмотренному снимку и к той же действующей
  // редакции: новая редакция документа за время ревью — повод начать заново.
  if (
    latestRedaction(h.store.read().contracts, parsed.file!, parsed.repositoryId)?.id !==
    plan.current.id
  )
    throw new StaleConsolidation(
      `Действующая редакция ${parsed.file} сменилась во время ревью консолидации; проведите её заново`,
      409,
    );
  const after = await consolidationPlan(h, parsed, revision);
  if (
    after.current.id !== plan.current.id ||
    contractDigest(after.content, after.pinned.artifacts, 2, parsed.checks, parsed.underTest) !==
      expected
  )
    throw new StaleConsolidation(
      'Контракт, его артефакты или действующая редакция изменились во время ревью; проведите консолидацию заново',
      409,
    );
  const review = approval.artifact!.split(/[\\/]/).at(-1)!;
  return h.store.atomic(() => {
    beforeCommit();
    return h.contract(
      parsed.title,
      plan.content,
      approval,
      parsed.repositoryId,
      parsed.file,
      plan.pinned.artifacts,
      parsed.checks,
      parsed.underTest,
      { from: plan.current.id, review },
    );
  });
}
