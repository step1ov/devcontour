// Запись `devcontour report --out` и `session-handoff --out` — запись
// `harness report --out` (`writeReportFile` пакета) и запрет каталогов данных
// DevContour, которых пакет не знает.
import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { REPORT_FILE_MODE, writeReportFile as harnessWriteReportFile } from 'devcontour-harness';

export { REPORT_FILE_MODE };

/**
 * Записать отчёт без записи «сквозь» ссылки — функцией пакета: временный
 * файл того же каталога (`wx`) и rename поверх цели; права прежнего файла
 * сохраняются, новый получает `0600`; отказ (`PATH_CONFLICT`), если цель —
 * symlink, не обычный файл или файл с несколькими жёсткими ссылками.
 *
 * Здесь — только то, чего пакет не знает: каталог данных контура (`dataDir`)
 * и каталоги данных компонентов (`componentDirs`, `.devcontour-local` их
 * репозиториев) — тоже запрещённые места; каталог цели и каталог данных
 * должны существовать.
 */
export function writeReportFile(
  out: string,
  dataDir: string,
  text: string,
  componentDirs: readonly string[] = [],
) {
  let dir: string;
  try {
    dir = realpathSync(dirname(resolve(out)));
  } catch (error) {
    throw new Error(`--out: каталог недоступен: ${(error as Error).message}`, { cause: error });
  }
  let data: string;
  try {
    data = realpathSync(resolve(dataDir));
  } catch (error) {
    throw new Error(`--out: каталог данных контура недоступен: ${(error as Error).message}`, {
      cause: error,
    });
  }
  // Каталог данных компонента может ещё не существовать: тогда в нём нет и
  // каталога цели (он обязан существовать), сравнивать не с чем.
  const protectedDirs = [
    data,
    ...componentDirs.flatMap((d) => {
      try {
        return [realpathSync(resolve(d))];
      } catch {
        return [];
      }
    }),
  ];
  if (protectedDirs.some((p) => dir === p || dir.startsWith(p + sep)))
    throw new Error(`--out: внутри каталога данных контура: ${out}`);
  harnessWriteReportFile(out, data, text);
}
