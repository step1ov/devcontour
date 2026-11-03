// Запись `devcontour report --out` — те же правила, что у `harness report --out`.
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Права нового файла отчёта: только владелец (в отчёте — данные проекта). */
export const REPORT_FILE_MODE = 0o600;

const lstatOf = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Записать отчёт без записи «сквозь» ссылки: текст пишется во временный
 * файл того же каталога (новый, `wx`) и переименовывается поверх цели —
 * rename заменяет запись каталога и не следует ни за symlink, ни за жёсткой
 * ссылкой. Права прежнего файла сохраняются, новый получает `0600`.
 * Временный файл (имя с UUID) удаляется при неполной записи или отказе rename.
 *
 * Отказ: цель — symlink, не обычный файл, файл с несколькими жёсткими
 * ссылками или путь внутри каталога данных контура; каталог цели должен
 * существовать.
 */
export function writeReportFile(out: string, dataDir: string, text: string) {
  const target = resolve(out);
  let dir: string;
  try {
    dir = realpathSync(dirname(target));
  } catch (error) {
    throw new Error(`--out: каталог недоступен: ${(error as Error).message}`, { cause: error });
  }
  let data: string | undefined;
  try {
    data = realpathSync(resolve(dataDir));
  } catch {
    data = undefined;
  }
  if (data && (dir === data || dir.startsWith(data + sep)))
    throw new Error(`--out: внутри каталога данных контура: ${out}`);
  const existing = lstatOf(target);
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error(`--out: символическая ссылка: ${out}`);
    if (!existing.isFile()) throw new Error(`--out: не обычный файл: ${out}`);
    if (existing.nlink > 1) throw new Error(`--out: у файла несколько жёстких ссылок: ${out}`);
  }
  const mode = existing ? existing.mode & 0o7777 : REPORT_FILE_MODE;
  const temp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    created = true;
    try {
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, mode);
    renameSync(temp, join(dir, basename(target)));
    created = false;
  } finally {
    // Только созданный здесь временный файл: имя с UUID, путь собран выше.
    if (created) rmSync(temp, { force: true });
  }
}
