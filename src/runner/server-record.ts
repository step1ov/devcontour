// Запись о работающем сервере workspace и его штатная остановка (`stop`).
//
// `start`/`serve` после начала прослушивания пишут `<data>/server.json`:
// pid, адрес и случайный идентификатор экземпляра. `stop` останавливает
// процесс только тогда, когда сервер по записанному адресу сам подтверждает
// тот же pid и тот же экземпляр (`GET /api/server`). Pid, переиспользованный
// чужим процессом, или чужой сервер на том же порту этого подтверждения не
// дают — такой процесс не трогается. Сервер называет и свой каталог данных:
// запись, скопированная вместе с workspace (`cp -r`), указывает на сервер
// исходного workspace, и его копия не останавливает.
//
// Сервер версии до появления записи её не пишет. Без записи `stop` читает
// роль controller из базы (только чтение, как doctor): живая роль — процесс
// без записи держит workspace, и `stop` отказывает, не посылая сигнала.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { controllerRow, effectiveLeader, readOnlyLocation } from '../core/store.ts';
import { processAlive } from './resources.ts';

export interface ServerRecord {
  pid: number;
  url: string;
  instance: string;
  startedAt: string;
}

export const serverRecordPath = (root: string) => join(root, 'server.json');

/** Идентификатор экземпляра сервера: его отдаёт `GET /api/server`. */
export const serverInstance = () => randomUUID();

export function writeServerRecord(root: string, record: ServerRecord) {
  const path = serverRecordPath(root);
  const temp = `${path}.${process.pid}`;
  writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

export function readServerRecord(root: string): ServerRecord | undefined {
  let text: string;
  try {
    text = readFileSync(serverRecordPath(root), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as Partial<ServerRecord>;
    if (
      Number.isInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.url === 'string' &&
      typeof value.instance === 'string'
    )
      return value as ServerRecord;
  } catch {
    /* Нечитаемая запись — как отсутствующая, но файл не удаляется. */
  }
  return undefined;
}

/** Удалить запись, только если она — этого экземпляра: запись нового сервера не трогается. */
export function clearServerRecord(root: string, instance: string) {
  if (readServerRecord(root)?.instance === instance)
    rmSync(serverRecordPath(root), { force: true });
}

export type StopResult =
  | { status: 'stopped'; pid: number; url: string }
  | { status: 'not-running'; detail: string }
  | {
      status: 'running-unrecorded';
      owner: string;
      leaseUntil: string;
      detail: string;
      /** Как оператору самому найти и остановить такой процесс: DevContour сигнала не посылает. */
      manualStop: string[];
    };

/**
 * Канонический каталог данных: его называет `GET /api/server`. Нативный
 * realpath: на файловой системе без различия регистра (macOS) JS-вариант
 * сохраняет регистр букв переданного пути, и путь в другом регистре читался
 * бы как запись, скопированная вместе с workspace.
 */
export const dataIdentity = (root: string) => (existsSync(root) ? realpathSync.native(root) : root);

/**
 * Живая роль controller базы `root`, прочитанная без записи. Базы или
 * состояния нет — роли нет.
 */
export function liveController(root: string, now = Date.now()) {
  const file = join(root, 'state.sqlite');
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(readOnlyLocation(file), { readOnly: true });
  try {
    const table = db
      .prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='state'")
      .get();
    const row = table
      ? (db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string } | undefined)
      : undefined;
    const document = row
      ? (JSON.parse(row.data) as { leader?: { owner: string; leaseUntil: number } }).leader
      : undefined;
    const leader = effectiveLeader(document, controllerRow(db));
    return leader && leader.leaseUntil > now ? leader : undefined;
  } finally {
    db.close();
  }
}

/**
 * Шаги ручной остановки процесса без записи. Роль controller хранит только
 * случайный идентификатор владельца — ни pid, ни хоста в ней нет, поэтому
 * шаги объясняют, как найти процесс по командной строке и порту. Сигнал
 * посылает оператор после проверки командной строки, не DevContour.
 */
export function manualStopSteps(root: string): string[] {
  // `--workspace W` и `--data W/.devcontour-local` оба содержат путь W.
  const workspace = basename(root) === '.devcontour-local' ? dirname(root) : root;
  const quoted = `'${workspace.replaceAll("'", "'\\''")}'`;
  return [
    `Найдите pid: ps -ax -o pid,command | grep -F -- ${quoted} | grep -v grep — нужен процесс \`devcontour serve\` или \`devcontour start\` с --workspace ${workspace} (или --data в его .devcontour-local), либо очередь \`run\` этого workspace`,
    "Поиск по пути не найдёт сервер, запущенный с относительным путём (--workspace .), через символическую ссылку (/tmp и /private/tmp) или с --data вне этого workspace: тогда ищите все серверы — ps -ax -o pid,command | grep -E 'devcontour.* (serve|start|run)' | grep -v grep — и сверяйте их пути через realpath, либо по порту панели (по умолчанию 4317): lsof -nP -iTCP:<порт> -sTCP:LISTEN, затем ps -o pid,command -p <pid>",
    'Убедитесь по командной строке, что это сервер именно этого workspace, и остановите его сами: kill -TERM <pid> — это штатная остановка, как Ctrl+C: сервер дожидается идущих операций и снимает роль controller',
    'Запущенный в терминале сервер остановите Ctrl+C в этом терминале; запущенный в фоне (nohup, &, менеджер процессов) терминала не имеет — только kill -TERM <pid> или средствами его менеджера',
    'Проверьте: devcontour stop --workspace ... должен ответить not-running',
  ];
}

/** Без подтверждённой записи: живая роль controller — сервер без записи работает. */
function withoutRecord(root: string, detail: string): StopResult {
  let leader: ReturnType<typeof liveController>;
  try {
    leader = liveController(root);
  } catch (error) {
    throw new Error(
      `${detail}; роль controller в базе не прочитана (${error instanceof Error ? error.message : String(error)}). Убедитесь сами, что сервер этого workspace не запущен`,
    );
  }
  if (!leader) return { status: 'not-running', detail };
  const until = new Date(leader.leaseUntil).toISOString();
  return {
    status: 'running-unrecorded',
    owner: leader.owner,
    leaseUntil: until,
    detail: `${detail}, но роль controller базы держит живой процесс (владелец ${leader.owner}, срок до ${until}; pid и хост роль не хранит). Вероятно, это сервер, запущенный версией без записи server.json (до обновления), или очередь \`run\`. DevContour не посылает сигнал процессу, который не подтвердил себя записью: остановите его сами по шагам manualStop (найти pid, проверить командную строку, kill -TERM <pid>; в терминале — Ctrl+C) и повторите stop. Если такого процесса нет, роль истечёт в ${until}`,
    manualStop: manualStopSteps(root),
  };
}

/**
 * Остановить сервер workspace по записи `server.json`: SIGTERM — штатная
 * остановка сервера (та же, что Ctrl+C), затем ожидание выхода процесса.
 * Процесс, который не подтвердил себя сервером этой записи, не
 * останавливается: отказ называет pid и путь записи.
 */
export async function stopServer(
  root: string,
  options: { timeoutMs?: number; confirmMs?: number } = {},
): Promise<StopResult> {
  const timeoutMs = options.timeoutMs ?? 60000;
  const path = serverRecordPath(root);
  const record = readServerRecord(root);
  if (!record) return withoutRecord(root, `Записи о запущенном сервере нет (${path})`);
  if (!processAlive(record.pid)) {
    // Процесс записи завершился без штатной остановки: запись устарела.
    clearServerRecord(root, record.instance);
    return withoutRecord(
      root,
      `Сервер pid ${record.pid} уже не работает; устаревшая запись ${path} удалена`,
    );
  }
  const identity = await confirm(record, dataIdentity(root), options.confirmMs ?? 3000);
  if (identity !== 'ours')
    throw new Error(
      `Процесс pid ${record.pid} не подтвердил, что он — сервер этого workspace (${record.url}: ${identity}). DevContour не останавливает чужой процесс. Проверьте процесс сами; если сервер этого workspace не запущен, удалите устаревшую запись ${path}`,
    );
  process.kill(record.pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (processAlive(record.pid)) {
    if (Date.now() > deadline)
      throw new Error(
        `Сервер pid ${record.pid} получил сигнал остановки, но не завершился за ${timeoutMs} мс: он дожидается идущих операций. Повторите stop позже`,
      );
    await new Promise((r) => setTimeout(r, 100));
  }
  // Штатная остановка удаляет запись сама; запись упавшего на остановке — тоже.
  clearServerRecord(root, record.instance);
  return { status: 'stopped', pid: record.pid, url: record.url };
}

async function confirm(record: ServerRecord, dataRoot: string, timeoutMs: number) {
  let url: URL;
  try {
    url = new URL('/api/server', record.url);
  } catch {
    return 'адрес записи некорректен';
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    return 'адрес записи не локальный';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return `ответ ${response.status}`;
    const body = (await response.json()) as {
      pid?: unknown;
      instance?: unknown;
      dataRoot?: unknown;
    };
    if (body.pid !== record.pid || body.instance !== record.instance)
      return 'по адресу отвечает другой сервер';
    // Запись скопирована вместе с workspace: сервер записи ведёт другие данные.
    return body.dataRoot === dataRoot
      ? 'ours'
      : `по адресу отвечает сервер другого каталога данных (${typeof body.dataRoot === 'string' ? body.dataRoot : 'не назван'}); запись, вероятно, скопирована вместе с workspace`;
  } catch (error) {
    return `сервер не отвечает (${error instanceof Error ? error.message : String(error)})`;
  }
}
