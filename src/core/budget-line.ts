// Строка бюджета словами оператора — одна для главной панели и для
// `GET /api/home` (`budget.text`, `scopes[].text`): сырой текст расчёта
// (`reason`) остаётся для «подробнее». Чистый модуль: его читает и браузер.

export type BudgetLineState = 'within' | 'exceeded' | 'undetermined';

export interface BudgetLineInput {
  state: BudgetLineState;
  scope: string;
  label?: string;
  limitUsd?: number;
  limitMs?: number;
  spentMs?: number;
  spentUsd: number;
  unknownCalls: number;
}

export const budgetNames: Record<BudgetLineState, string> = {
  within: 'в пределах',
  exceeded: 'исчерпан',
  undetermined: 'не определён',
};

const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  return mod10 === 1 && mod100 !== 11
    ? one
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? few
      : many;
};

export const budgetMoney = (v: number) => '~$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
// Предел — как задан: копейки не теряются и у больших сумм.
export const budgetLimit = (v: number) => '$' + (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2));
/** Доля предела: округление, но «100 %» — только у достигнутого предела. */
export const budgetPercent = (spent: number, limit: number) => {
  const p = Math.round((spent / limit) * 100);
  return spent < limit ? Math.min(p, 99) : p;
};
const minutes = (ms: number) => `${Math.round(ms / 60_000)} мин`;
const callsText = (n: number) => `${n} ${plural(n, 'вызова', 'вызовов', 'вызовов')}`;

/** Часть строки после состояния: сумма, предел, время и неизвестная стоимость. */
export function budgetTail(b: BudgetLineInput) {
  return (
    budgetMoney(b.spentUsd) +
    (b.limitUsd !== undefined
      ? ` из ${budgetLimit(b.limitUsd)} (${budgetPercent(b.spentUsd, b.limitUsd)} %)`
      : '') +
    (b.limitMs !== undefined ? `; время ${minutes(b.spentMs ?? 0)} из ${minutes(b.limitMs)}` : '') +
    (b.unknownCalls ? `; у ${callsText(b.unknownCalls)} стоимость неизвестна — сумма занижена` : '')
  );
}

/** Вся строка: «Бюджет workspace: не определён · ~$1014 из $3000 (34 %); …». */
export function budgetLine(b: BudgetLineInput) {
  return `Бюджет ${b.label ?? b.scope}: ${budgetNames[b.state]} · ${budgetTail(b)}`;
}
