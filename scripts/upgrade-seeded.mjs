/**
 * Записи нового вида, которые сценарий обновления (`upgrade-scenario.ts`,
 * шаг `after`) пишет версией «после»: по одной на вид. Манифест P3 хранит их
 * id по видам, а P3 сверяет их по id с повторным чтением той же базы новым
 * процессом (шаг `reread`): запись, потерянная или подменённая при
 * повторном открытии, называется по id, а не только числом.
 */
export const SEEDED_KINDS = /** @type {const} */ (['quick', 'discussion', 'attention', 'input']);

/** Формат id каждого вида; отметка центра внимания — ключ источника. */
const FORMATS = {
  quick: /^PC-[0-9a-f-]{36}$/,
  discussion: /^DM-[0-9a-f-]{36}$/,
  attention: /^\S{1,500}$/,
  input: /^IR-[0-9a-f]{24}$/,
};

/**
 * Расхождения записей нового вида: для каждого вида — непустой список
 * уникальных id своего формата; с `reread` — те же id, что записал шаг
 * `after` (отсутствующие и лишние названы по id). Пустой список — сверка
 * прошла.
 *
 * @param {unknown} seeded id по видам из шага `after`
 * @param {unknown} [reread] id по видам из повторного чтения
 * @returns {string[]}
 */
export function seededProblems(seeded, reread) {
  const problems = [];
  const shape = (value, label) => {
    if (!value || typeof value !== 'object') {
      problems.push(`${label}: нет id записей нового вида`);
      return undefined;
    }
    return /** @type {Record<string, unknown>} */ (value);
  };
  const recorded = shape(seeded, 'after');
  if (!recorded) return problems;
  for (const kind of SEEDED_KINDS) {
    const ids = recorded[kind];
    if (!Array.isArray(ids) || ids.length === 0) {
      problems.push(`${kind}: нет записей`);
      continue;
    }
    for (const id of ids)
      if (typeof id !== 'string' || !FORMATS[kind].test(id))
        problems.push(`${kind}: id неверного вида ${JSON.stringify(id)}`);
    if (new Set(ids).size !== ids.length) problems.push(`${kind}: повтор id`);
  }
  const extra = Object.keys(recorded).filter((k) => !SEEDED_KINDS.includes(k));
  if (extra.length) problems.push('неизвестные виды: ' + extra.join(', '));
  if (reread === undefined) return problems;
  const again = shape(reread, 'reread');
  if (!again) return problems;
  for (const kind of SEEDED_KINDS) {
    const before = Array.isArray(recorded[kind]) ? recorded[kind] : [];
    const after = Array.isArray(again[kind]) ? again[kind] : [];
    const missing = before.filter((id) => !after.includes(id));
    const added = after.filter((id) => !before.includes(id));
    if (missing.length) problems.push(`${kind}: при повторном чтении нет ${missing.join(', ')}`);
    if (added.length) problems.push(`${kind}: при повторном чтении лишние ${added.join(', ')}`);
  }
  return problems;
}
