import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { propertyReport } from '../core/property.ts';

const MAX_REPORT = 64 * 1024;

/**
 * Прочитать отчёт. Отсутствие или повреждение — не исключение: исход команды
 * остаётся главным, отчёт его только дополняет. Причина называется.
 *
 * Читается только обычный файл внутри worktree. Команда проверки могла
 * заменить отчёт или его каталог на symlink наружу, и чужой файл — например,
 * из каталога контура — попал бы в evidence. Каталог сверяется по realpath,
 * файл открывается без следования за ссылкой, и проверка идёт по уже
 * открытому дескриптору: подмена между проверкой и чтением не проходит.
 */
export async function readPropertyReport(
  path: string,
  root: string,
  redact?: (text: string) => string,
) {
  // Каталог отчёта мог исчезнуть вместе с отчётом: проверка вправе удалить
  // его. Это диагностический отказ, а не исключение — evidence записывается.
  let base: string, dir: string;
  try {
    base = await realpath(root);
    dir = await realpath(dirname(path));
  } catch {
    return { problem: 'отчёт свойств не записан' } as const;
  }
  if (dir !== base && !dir.startsWith(base + sep))
    return { problem: 'отчёт свойств вне worktree' } as const;
  let text: string;
  try {
    // O_NONBLOCK: FIFO на месте отчёта без писателя иначе держал бы open
    // бесконечно, и evidence не записывалось бы вовсе. Тип проверяется по
    // открытому дескриптору; обычный файл от флага не меняется.
    const handle = await open(
      join(dir, basename(path)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { problem: 'отчёт свойств — не обычный файл' } as const;
      if (stat.size > MAX_REPORT)
        return { problem: `отчёт свойств больше ${MAX_REPORT} байт` } as const;
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ELOOP'
      ? ({ problem: 'отчёт свойств — symlink' } as const)
      : ({ problem: 'отчёт свойств не записан' } as const);
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
