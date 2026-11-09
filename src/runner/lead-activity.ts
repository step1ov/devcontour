// Отметка обращения ведущего агента: его операции агентского API (CLI
// `agent --file`, HTTP `/api/agent`, MCP) и пакет `session-handoff`. Многие
// из них только читают состояние и следов в журнале изменения не оставляют,
// поэтому присутствие ведущего по одним записям изменения пропадало, хотя
// он действовал минуты назад.
//
// Отметка — отдельный файл рядом с базой, а не запись состояния: чтение не
// меняет ревизию и не запускает проекции, а команды только для чтения базы
// (`session-handoff`) не становятся вторым writer. Запись — по возможности:
// сбой записи отметки не отменяет операцию.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LEAD_ACTIVITY_FILE = 'lead-activity.json';

type Located = { readonly file: string };

/** Каталог данных контура — каталог базы состояния; у базы в памяти отметки нет. */
const markFile = (store: Located) =>
  store.file === ':memory:' ? undefined : join(dirname(store.file), LEAD_ACTIVITY_FILE);

/** Отметить обращение ведущего: `via` — транспорт, `operation` — имя операции. */
export function markLeadActivity(
  store: Located,
  via: 'agent' | 'session-handoff',
  operation?: string,
  now: Date = new Date(),
) {
  const file = markFile(store);
  if (!file) return;
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({
        at: now.toISOString(),
        via,
        ...(operation ? { operation: operation.slice(0, 80) } : {}),
      }) + '\n',
    );
    renameSync(temporary, file);
  } catch {
    // Каталог только для чтения или занят: присутствие останется по журналу.
    // Недописанный временный файл не остаётся в каталоге данных.
    try {
      unlinkSync(temporary);
    } catch {
      // Временного файла нет.
    }
  }
}

/** Допустимое расхождение часов: отметка из будущего дальше него не учитывается. */
export const LEAD_MARK_SKEW_MS = 60_000;

/**
 * Время последнего обращения ведущего или `null`, если отметки нет, она
 * испорчена или датирована будущим дальше `LEAD_MARK_SKEW_MS` (правка руками,
 * файл с другой машины): такая отметка держала бы ведущего «на связи» вечно.
 */
export function leadActivityMark(store: Located, now: number = Date.now()): string | null {
  const file = markFile(store);
  if (!file) return null;
  try {
    const at = (JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }).at;
    if (typeof at !== 'string') return null;
    const t = Date.parse(at);
    return Number.isFinite(t) && t <= now + LEAD_MARK_SKEW_MS ? at : null;
  } catch {
    return null;
  }
}
