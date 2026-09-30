import { readFile } from 'node:fs/promises';
import { propertyReport } from '../core/property.ts';

const MAX_REPORT = 64 * 1024;

/**
 * Прочитать отчёт. Отсутствие или повреждение — не исключение: исход команды
 * остаётся главным, отчёт его только дополняет. Причина называется.
 */
export async function readPropertyReport(path: string, redact?: (text: string) => string) {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { problem: 'отчёт свойств не записан' } as const;
  }
  if (text.length > MAX_REPORT)
    return { problem: `отчёт свойств больше ${MAX_REPORT} байт` } as const;
  if (redact) text = redact(text);
  try {
    const parsed = propertyReport.safeParse(JSON.parse(text));
    if (!parsed.success) return { problem: 'отчёт свойств не по схеме' } as const;
    return { report: parsed.data } as const;
  } catch {
    return { problem: 'отчёт свойств — не JSON' } as const;
  }
}
