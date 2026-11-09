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
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  try {
    const temporary = `${file}.${process.pid}.tmp`;
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
  }
}

/** Время последнего обращения ведущего или `null`, если отметки нет или она испорчена. */
export function leadActivityMark(store: Located): string | null {
  const file = markFile(store);
  if (!file) return null;
  try {
    const at = (JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown }).at;
    return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}
