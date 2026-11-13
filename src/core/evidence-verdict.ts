// Исход записи evidence для показа: PASS, провал или «не применим (пути)».
//
// Условный gate (`when.paths`), которого не задел настоящий diff фазы, пишет
// запись `not-applicable` с `passed: false`. Это не провал и не PASS: показ по
// одному `passed` выдал бы её за упавшую проверку, а счёт по `kind` — за
// пройденную. Модуль без зависимостей Node: его читают и сервер, и панель.

export type EvidenceVerdict = 'passed' | 'failed' | 'not-applicable';

export const NOT_APPLICABLE_LABEL = 'не применим (пути)';

export const evidenceVerdict = (e: { kind?: string; passed: boolean }): EvidenceVerdict =>
  e.kind === 'not-applicable' ? 'not-applicable' : e.passed ? 'passed' : 'failed';

/** Сведения о неприменимости, которые несёт запись (`GateApplicability` harness). */
export interface NotApplicableSummary {
  patterns: string[];
  count: number;
  files: string[];
}

/** Короткая форма для панели: шаблоны, число изменённых путей и первые пути. */
export function notApplicableSummary(
  value: NotApplicableSummary | undefined,
  files = 5,
): NotApplicableSummary | undefined {
  if (!value) return undefined;
  return {
    patterns: value.patterns.slice(0, 16),
    count: value.count,
    files: value.files.slice(0, files),
  };
}

/** Строка о неприменимости: что ожидал gate и что изменил diff. */
export function notApplicableLine(value: NotApplicableSummary | undefined) {
  if (!value) return NOT_APPLICABLE_LABEL;
  const files = value.files.length
    ? `: ${value.files.join(', ')}${value.count > value.files.length ? ', …' : ''}`
    : '';
  return `${NOT_APPLICABLE_LABEL}: шаблоны ${value.patterns.join(', ')}; изменено путей ${value.count}${files}`;
}

/** Метка исхода в текстовых отчётах. */
export const verdictWord = (e: { kind?: string; passed: boolean }) =>
  ({ passed: 'PASS', failed: 'FAIL', 'not-applicable': 'НЕ ПРИМЕНИМ (пути)' })[evidenceVerdict(e)];
