// Вопросы владельцу: одна запись вопроса подготовки (`preparationQuestion`)
// до setup и после него. Раздел панели — где владелец читает и отвечает:
// продукт, архитектура, дизайн или разработка. Здесь — чистые правила над
// состоянием: раздел, варианты, удержание черновиков и сводка по разделам.
import type { DevContourState } from './model.ts';
import { DomainError } from './model.ts';
import type {
  PreparationQuestion,
  ProductChange,
  QuestionSection,
  QuestionStage,
} from './preparation-model.ts';
import { questionSections } from './preparation-model.ts';
import { digest } from './task-digest.ts';

/** Учётные данные в URL (`scheme://user:secret@host`) — маска до показа. */
export const maskUrlCredentials = (text: string) =>
  text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[REDACTED]@');

/**
 * Версия вопроса: всё, что ведущий может уточнить, пока вопрос открыт. Ответ
 * сверяет её (`expectedVersion`), чтобы вариант по индексу не лёг на другую
 * редакцию вариантов. У строк без полей разделов — прежняя формула карточки.
 */
export function questionVersion(q: PreparationQuestion) {
  return digest({
    text: q.text,
    why: q.why,
    options: q.options,
    ...(q.section || q.choices || q.recommended !== undefined || q.links || q.blocks
      ? {
          section: sectionOf(q),
          stage: q.stage,
          choices: q.choices ?? null,
          recommended: q.recommended ?? null,
          links: q.links ?? null,
          blocks: q.blocks ?? null,
        }
      : {}),
  }).slice(0, 32);
}

/** Раздел этапа: референсы, концепт и дизайн — раздел дизайна. */
export function sectionOfStage(stage: QuestionStage): QuestionSection {
  if (stage === 'references' || stage === 'concept') return 'design';
  return stage;
}

/** Вкладка раздела по умолчанию. */
export function stageOfSection(section: QuestionSection): QuestionStage {
  return section;
}

/** Раздел вопроса: записанный или по этапу (строки до разделов). */
export const sectionOf = (q: Pick<PreparationQuestion, 'stage' | 'section'>): QuestionSection =>
  q.section ?? sectionOfStage(q.stage);

/** Варианты вопроса: `choices`, у прежних строк — `options` без последствий. */
export function choicesOf(
  q: Pick<PreparationQuestion, 'choices' | 'options'>,
): { label: string; consequence?: string }[] {
  return q.choices ?? q.options.map((label) => ({ label }));
}

/** Этап и раздел из полей вопроса: раздел без этапа — его вкладка; оба — согласованы. */
export function placeQuestion(
  stage: QuestionStage | undefined,
  section: QuestionSection | undefined,
  fallback: QuestionStage,
): { stage: QuestionStage; section: QuestionSection } {
  const placed = stage ?? (section ? stageOfSection(section) : fallback);
  const derived = sectionOfStage(placed);
  if (section && section !== derived)
    throw new DomainError(
      `Раздел ${section} не соответствует этапу ${placed} (этап ${placed} — раздел ${derived})`,
      400,
    );
  return { stage: placed, section: derived };
}

/** Решение ведущего по вопросу действует (записано и не отозвано). */
export const resolvedQuestion = (c: ProductChange, questionId: string) =>
  (c.decisions ?? []).some((d) => d.questionId === questionId && !d.withdrawn);

/** Ответ владельца ждёт решения ведущего. */
export const answeredPending = (c: ProductChange, q: PreparationQuestion) =>
  q.status === 'answered' && !!q.answer && !resolvedQuestion(c, q.id);

/** Вопрос держит свои черновики: открыт или отвечен без действующего решения. */
export const questionHolding = (c: ProductChange, q: PreparationQuestion) =>
  !!q.blocks && (q.status === 'open' || answeredPending(c, q));

export interface QuestionHold {
  questionId: string;
  changeId: string;
  section: QuestionSection;
  status: 'open' | 'answered';
}

/**
 * Черновики, которые держат вопросы владельцу: id задачи → первый держащий
 * вопрос. Держится только черновик: выпущенная работа вопросом исполнителя.
 */
export function questionHolds(s: Readonly<DevContourState>): Map<string, QuestionHold> {
  const out = new Map<string, QuestionHold>();
  const drafts = new Set(s.tasks.filter((t) => t.status === 'draft').map((t) => t.id));
  for (const c of s.preparation?.changes ?? [])
    for (const q of c.questions ?? []) {
      if (!questionHolding(c, q)) continue;
      for (const id of q.blocks!.taskIds)
        if (drafts.has(id) && !out.has(id))
          out.set(id, {
            questionId: q.id,
            changeId: c.id,
            section: sectionOf(q),
            status: q.status as 'open' | 'answered',
          });
    }
  return out;
}

/** Отказ 409 `QUESTION_PENDING`: черновики держит вопрос владельцу. */
export function assertNotHeld(s: Readonly<DevContourState>, taskIds: readonly string[]) {
  const holds = questionHolds(s);
  const held = taskIds.filter((id) => holds.has(id));
  if (!held.length) return;
  const first = holds.get(held[0])!;
  throw new DomainError(
    `Черновики ждут решения владельца по вопросу ${first.questionId} (${first.section}): ${held.join(', ')}. ` +
      (first.status === 'open'
        ? 'Владелец ещё не ответил в панели; до ответа их не выпускают. Ревью плана — без них (plan_review с tasks), или перенесите их на другую доску (task_move).'
        : 'Ответ получен: исправьте черновики по ответу и закройте вопрос preparation_resolve {"questionId": …, "statement": …, "rationale": …, "refs": {…}}.'),
    409,
    { code: 'QUESTION_PENDING', questionId: first.questionId, taskIds: held },
  );
}

/** Предел записей одного раздела сводки. */
export const SUMMARY_ITEMS = 5;

export interface QuestionSummaryItem {
  id: string;
  changeId: string;
  kind: 'question';
  status: 'open' | 'answered';
  title: string;
  since: string;
  href: string;
  recommended?: string;
  blocks: string[];
  links?: PreparationQuestion['links'];
}

export interface QuestionSummarySection {
  open: number;
  answeredPendingLead: number;
  blockedTasks: number;
  items: QuestionSummaryItem[];
  /** Записей больше предела. */
  more: boolean;
}

const clip = (text: string, n: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/**
 * Сводка вопросов владельцу по разделам: открытые, отвеченные без решения
 * ведущего, удержанные черновики и до пяти записей (открытые раньше, старые
 * первыми). Только чтение состояния.
 */
export function questionSummary(
  s: Readonly<DevContourState>,
  href: (changeId: string, stage: QuestionStage, anchor: string) => string,
  redact: (text: string) => string = maskUrlCredentials,
  /** Записей на раздел (главная панели показывает три). */
  limit = SUMMARY_ITEMS,
): Record<QuestionSection, QuestionSummarySection> {
  const holds = questionHolds(s);
  const sections = Object.fromEntries(
    questionSections.map((x) => [
      x,
      {
        open: 0,
        answeredPendingLead: 0,
        blockedTasks: 0,
        items: [] as QuestionSummaryItem[],
        more: false,
      },
    ]),
  ) as Record<QuestionSection, QuestionSummarySection>;
  const rows: (QuestionSummaryItem & { section: QuestionSection })[] = [];
  for (const c of s.preparation?.changes ?? [])
    for (const q of c.questions ?? []) {
      const open = q.status === 'open';
      if (!open && !answeredPending(c, q)) continue;
      const section = sectionOf(q);
      if (open) sections[section].open++;
      else sections[section].answeredPendingLead++;
      const choices = choicesOf(q);
      const blocks = (q.blocks?.taskIds ?? []).filter((id) => holds.get(id)?.questionId === q.id);
      rows.push({
        section,
        id: q.id,
        changeId: c.id,
        kind: 'question',
        status: open ? 'open' : 'answered',
        title: clip(redact(q.text), 160),
        since: open ? q.createdAt : q.answer!.at,
        href: href(c.id, q.stage, `questions-${q.stage}`),
        ...(q.recommended !== undefined && choices[q.recommended]
          ? { recommended: clip(redact(choices[q.recommended].label), 300) }
          : {}),
        blocks,
        ...(q.links ? { links: q.links } : {}),
      });
    }
  for (const hold of holds.values()) sections[hold.section].blockedTasks++;
  rows.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) || a.since.localeCompare(b.since),
  );
  for (const { section, ...row } of rows)
    if (sections[section].items.length < limit) sections[section].items.push(row);
    else sections[section].more = true;
  return sections;
}
