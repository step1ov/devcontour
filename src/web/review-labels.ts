// Подписи важности находки ревью — одна карта для всей панели. Значение
// (`blocking`, `note`) — поле протокола harness, в данных не переводится;
// неизвестное показывается как есть.
const findingSeverityLabels: Record<string, string> = { blocking: 'блокер', note: 'замечание' };

export const findingSeverityLabel = (severity: string) =>
  findingSeverityLabels[severity] ?? severity;
