import { DomainError } from './model.ts';

/**
 * Сколько знаков после метки типа (`B-`) должно быть в префиксе: короткая
 * форма журнала и панели — `B-xxxxxxxx`. Префикс короче мог бы молча
 * разрешиться опечаткой или устаревшим коротким id в другую запись.
 */
export const ID_PREFIX_MIN = 8;
/** Сколько кандидатов называет отказ неоднозначного префикса. */
const CANDIDATES_SHOWN = 10;

/**
 * Id по полному значению или по однозначному префиксу — короткой форме,
 * которую показывают журнал и панель (`B-xxxxxxxx`). Полное совпадение важнее
 * префикса. Префикс короче `ID_PREFIX_MIN` знаков после метки — отказ 404 с
 * этим объяснением. Нет совпадений — `undefined`: отказ «не найдено» остаётся
 * у вызывающего. Несколько — отказ 409 с кандидатами (не больше десяти и их
 * число), чтобы ведущий выбрал полный id, а не угадывал.
 */
export function resolveIdPrefix(
  ids: Iterable<string>,
  ref: string,
  what: string,
): string | undefined {
  const all = [...ids];
  if (all.includes(ref)) return ref;
  const dash = ref.indexOf('-');
  const tag = dash < 0 ? '' : ref.slice(0, dash + 1);
  if (ref.length - tag.length < ID_PREFIX_MIN)
    throw new DomainError(
      `${what} не найдена: ${ref} — не полный id, а префикс нужен не короче ${ID_PREFIX_MIN} знаков после ${tag ? `«${tag}»` : 'начала'} (вид ${tag}${'x'.repeat(ID_PREFIX_MIN)}).`,
      404,
    );
  const found = all.filter((id) => id.startsWith(ref));
  if (found.length <= 1) return found[0];
  const shown = found.slice(0, CANDIDATES_SHOWN).join(', ');
  const rest = found.length > CANDIDATES_SHOWN ? ` и ещё ${found.length - CANDIDATES_SHOWN}` : '';
  throw new DomainError(
    `${what}: префикс ${ref} неоднозначен — подходят ${found.length}: ${shown}${rest}. Укажите полный id или более длинный префикс.`,
    409,
  );
}
