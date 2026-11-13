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
import { anchors, headings, idTokens, slug, textChecks } from '../core/contract-text.ts';

export { anchors, headings, idTokens, referencedAnchors, slug } from '../core/contract-text.ts';

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
 * Пропуски отображения в итоге ревью. Отображение — строки «старое → новое»
 * (`→` или `->`). Строка годна, если в её левой части не больше одного
 * заголовка прежнего текста, а у каждого ID прежнего текста слева своя цель
 * справа: тот же ID нового текста или отдельный заголовок либо якорь нового
 * текста. Каждый ID правил и каждый заголовок прежнего текста (целым словом
 * или якорем, без разметки) должен стоять в левой части годной строки.
 * Перечисление без стрелок, ссылка в никуда, одна строка на всё и совпадение
 * по части слова отображением не считаются.
 */
export function mappingGaps(previous: string, next: string, summary: string) {
  const newIds = new Set(idTokens(next));
  const newHeads = headings(next).map(headingText).filter(Boolean);
  const newAnchors = [...anchors(next)];
  const oldIds = idTokens(previous);
  const oldHeads = headings(previous).map(headingText).filter(Boolean);
  const mentions = (left: string, h: string) => whole(left, h) || whole(left, slug(h));
  const covered = { ids: new Set<string>(), heads: new Set<string>() };
  for (const raw of summary.split('\n')) {
    const m = /^(.*?)(?:→|->)(.*)$/u.exec(plain(raw));
    if (!m) continue;
    const [, left, right] = m;
    const heads = oldHeads.filter((h) => mentions(left, h));
    if (heads.length > 1) continue;
    const ids = idTokens(left).filter((id) => oldIds.includes(id));
    const sameIds = ids.filter((id) => newIds.has(id) && idTokens(right).includes(id));
    const places =
      newHeads.filter((h) => whole(right, h)).length +
      newAnchors.filter((a) => whole(right, a)).length;
    // Остальным ID нужна своя цель — заголовок или якорь, по одному на ID.
    const rest = ids.length - sameIds.length;
    if (!places && !sameIds.length) continue;
    if (rest > places) continue;
    for (const id of ids) covered.ids.add(id);
    for (const h of heads) covered.heads.add(h);
  }
  return [
    ...oldIds.filter((id) => !covered.ids.has(id)),
    ...oldHeads.filter((h) => !covered.heads.has(h)).map((h) => `«${h}»`),
  ];
}

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
  ids: string[];
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
  const checks = textChecks(current.content, content, file, siblings);
  if (checks.longer)
    throw new DomainError(
      `Консолидация сокращает документ: новый текст — ${content.length} знаков, действующий — ${current.content.length}. Дополнение правил — обычный contract-change`,
      400,
    );
  if (checks.lost.length)
    throw new DomainError(
      `Консолидация не может убрать идентификаторы правил: в новом тексте нет ${checks.lost.slice(0, 30).join(', ')}. Верните их на место переписанных правил`,
      400,
    );
  if (checks.broken.length)
    throw new DomainError(
      `Соседние контракты ссылаются на разделы, которых в новом тексте нет: ${checks.broken.slice(0, 20).join('; ')}. Сохраните эти заголовки или якоря`,
      400,
    );
  const ids = idTokens(current.content);
  return {
    current,
    content,
    pinned,
    ids,
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
    ...(incomplete ? { incompleteMapping: { round: last!.id, finding: incomplete.message } } : {}),
    title: parsed.title,
    ...(parsed.repositoryId ? { repositoryId: parsed.repositoryId } : {}),
    file: parsed.file!,
    previous: { id: plan.current.id, content: plan.current.content },
    content: plan.content,
    ids: plan.ids,
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
    const message = `${INCOMPLETE}: итог ревью не называет ${gaps.slice(0, 30).join(', ')}`;
    h.store.change('contract.review', (s) => {
      const a = s.contractAttempts?.find((x) => x.artifact === approval.artifact);
      if (!a) return;
      a.approved = false;
      a.findings = [...a.findings, { severity: 'blocking', message, rule: CONSOLIDATION }];
    });
    throw new DomainError(
      `Независимое ревью отклонено: ${message}. Артефакты: ${approval.artifact}`,
    );
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
