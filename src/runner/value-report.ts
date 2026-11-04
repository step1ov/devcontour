// `devcontour report`: отчёт об эффекте из базы, открытой только для чтения.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../core/model.ts';
import { repositories } from '../core/repositories.ts';
import { DevContour } from '../core/service.ts';
import { Store, journalFiles } from '../core/store.ts';
import {
  devcontourValueReport,
  type DevContourValueReport,
  type ReportRequest,
} from '../application/value-report.ts';

const fingerprint = (file: string) => {
  try {
    const s = statSync(file);
    return JSON.stringify([s.ino, s.size, s.mtimeMs, s.ctimeMs]);
  } catch {
    return 'missing';
  }
};

/**
 * Чтение без записи в базу: соединение только для чтения, как у `doctor` —
 * без PRAGMA режима журнала, DDL, начальных строк, проекций и журнала.
 * Работающий `serve` остаётся единственным writer. База WAL без файлов
 * журнала читается неизменяемой и ничего рядом не создаёт; если за время
 * чтения появились файлы журнала или изменился файл базы, чтение
 * повторяется (уже обычным соединением с журналом).
 */
export function readOnlyRead<T>(
  config: Config,
  root: string,
  read: (h: DevContour) => T,
  /** Наблюдение за попытками чтения (тесты: writer начинает работу во время чтения). */
  afterRead?: (attempt: number) => void,
): T {
  const file = join(root, 'state.sqlite');
  if (!existsSync(file)) throw new Error('База состояния не найдена: ' + file);
  const components = config.storage === 'component' ? repositories(config) : undefined;
  const journal = journalFiles(file);
  for (let attempt = 1; ; attempt++) {
    const quiet = !journal.some((f) => existsSync(f));
    const before = fingerprint(file);
    const store = new Store(file, components, false, undefined, true);
    let value: T;
    try {
      value = read(new DevContour(store, config));
    } finally {
      store.close();
    }
    afterRead?.(attempt);
    if (!quiet || (!journal.some((f) => existsSync(f)) && fingerprint(file) === before))
      return value;
    if (attempt === 3)
      throw new Error('Базу непрерывно меняет другой процесс: состояние не прочитано согласованно');
  }
}

/** Отчёт об эффекте из базы, открытой только для чтения (`readOnlyRead`). */
export function readOnlyValueReport(
  config: Config,
  root: string,
  request: ReportRequest,
  label: string,
  /** Наблюдение за попытками чтения (тесты: writer начинает работу во время чтения). */
  afterRead?: (attempt: number) => void,
): DevContourValueReport {
  return readOnlyRead(
    config,
    root,
    (h) => devcontourValueReport(h, request, { label, stateDir: root }),
    afterRead,
  );
}
