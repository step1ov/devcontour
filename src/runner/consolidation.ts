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
  reviewConsolidationRound,
} from './agent-control.ts';
import { pinArtifacts } from './contract-artifacts.ts';

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

/** ID-токены требований и правил: REQ-12, API-3, AC-31. */
export const ID_TOKEN = /\b[A-Z]{2,}-\d+/g;
/** Предел выдержек соседей и вопросов в запросе ревьюера. */
const EXCERPTS = 40;
const INPUTS = 20;

export function idTokens(text: string) {
  return [...new Set(text.match(ID_TOKEN) ?? [])].sort();
}

/** Якорь заголовка в форме GitHub: нижний регистр, без пунктуации, пробелы — дефисы. */
export function slug(heading: string) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Якоря документа: заголовки Markdown (повтор получает суффикс `-1`, `-2`,
 * как у GitHub) и явные `id`/`name` HTML и `{#id}`. Заголовки внутри блоков
 * кода не считаются.
 */
export function anchors(text: string) {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      const explicit = /\{#([^}\s]+)\}\s*$/.exec(heading)?.[1];
      if (explicit) out.add(explicit.toLowerCase());
      const base = slug(heading.replace(/\{#[^}]*\}\s*$/, ''));
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      out.add(n ? `${base}-${n}` : base);
    }
    for (const m of line.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi))
      out.add(m[1].toLowerCase());
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Якоря документа `file`, на которые ссылается текст соседа: `catalog.md#rules`. */
export function referencedAnchors(text: string, file: string) {
  const name = escape(basename(file));
  const found = new Set<string>();
  for (const m of text.matchAll(
    new RegExp(`(?:^|[^\\w./-])(?:[\\w./-]*/)?${name}#([^\\s)\\]>"'\`]+)`, 'g'),
  )) {
    let anchor = m[1];
    try {
      anchor = decodeURIComponent(anchor);
    } catch {
      /* Оставить как есть. */
    }
    found.add(anchor.toLowerCase());
  }
  return [...found];
}

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
  if (content.length >= current.content.length)
    throw new DomainError(
      `Консолидация сокращает документ: новый текст — ${content.length} знаков, действующий — ${current.content.length}. Дополнение правил — обычный contract-change`,
      400,
    );
  const ids = idTokens(current.content);
  const kept = new Set(idTokens(content));
  const lost = ids.filter((id) => !kept.has(id));
  if (lost.length)
    throw new DomainError(
      `Консолидация не может убрать идентификаторы правил: в новом тексте нет ${lost.slice(0, 30).join(', ')}. Верните их на место переписанных правил`,
      400,
    );
  // Соседние зарегистрированные контракты: действующие редакции других
  // документов. Ссылка на якорь этого документа должна остаться рабочей.
  const siblings = s.contracts.filter(
    (c) => c.source !== file && !newerRedaction(s.contracts, c.id) && typeof c.content === 'string',
  );
  const before = anchors(current.content);
  const after = anchors(content);
  const broken = siblings.flatMap((c) =>
    referencedAnchors(c.content, file)
      .filter((a) => before.has(a) && !after.has(a))
      .map((a) => `${c.source ?? c.title}: #${a}`),
  );
  if (broken.length)
    throw new DomainError(
      `Соседние контракты ссылаются на разделы, которых в новом тексте нет: ${broken.slice(0, 20).join('; ')}. Сохраните эти заголовки или якоря`,
      400,
    );
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
  const approval = await reviewConsolidationRound(h, root, author, runtimes, {
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
  // Решение относится к просмотренному снимку и к той же действующей
  // редакции: новая редакция документа за время ревью — повод начать заново.
  const after = await consolidationPlan(h, parsed, revision);
  if (
    after.current.id !== plan.current.id ||
    contractDigest(after.content, after.pinned.artifacts, 2, parsed.checks, parsed.underTest) !==
      expected
  )
    throw new DomainError(
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
