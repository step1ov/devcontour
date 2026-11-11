import { DomainError } from './model.ts';

/** Кратчайший префикс, который ищется по началу id (`B-94b`). */
export const ID_PREFIX_MIN = 4;
/** Сколько кандидатов называет отказ неоднозначного префикса. */
const CANDIDATES_SHOWN = 10;

/**
 * Id по полному значению или по однозначному префиксу — короткой форме, которую
 * показывают журнал и панель (`B-94be8215`). Полное совпадение важнее
 * префикса. Нет совпадений — `undefined`: отказ «не найдено» остаётся у
 * вызывающего. Несколько — отказ 409 с кандидатами (не больше десяти и их
 * число), чтобы ведущий выбрал полный id, а не угадывал.
 */
export function resolveIdPrefix(
  ids: Iterable<string>,
  ref: string,
  what: string,
): string | undefined {
  const all = [...ids];
  if (all.includes(ref)) return ref;
  if (ref.length < ID_PREFIX_MIN) return undefined;
  const found = all.filter((id) => id.startsWith(ref));
  if (found.length <= 1) return found[0];
  const shown = found.slice(0, CANDIDATES_SHOWN).join(', ');
  const rest = found.length > CANDIDATES_SHOWN ? ` и ещё ${found.length - CANDIDATES_SHOWN}` : '';
  throw new DomainError(
    `${what}: префикс ${ref} неоднозначен — подходят ${found.length}: ${shown}${rest}. Укажите полный id или более длинный префикс.`,
    409,
  );
}
