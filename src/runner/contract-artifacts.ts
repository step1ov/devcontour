import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { DomainError, type Contract, type ContractArtifact } from '../core/model.ts';
import { digest } from '../core/service.ts';
import { git } from './process.ts';

/**
 * Пределы закрепления. Закрепление и текст для ревьюера — разные вещи: прежде
 * суммарные 400000 байт текста запрещали закрепить сам эталонный набор, и
 * его выводили из договора, защищая только protectedPaths. Теперь полный
 * объект закрепляется по точным байтам в своём пределе, а ревьюер получает
 * манифест, статистику и ограниченную выборку.
 */
export interface ArtifactLimits {
  /** Предел одного файла. */
  maxFileBytes: number;
  /** Предел суммы артефактов одного договора. */
  maxTotalBytes: number;
  /** Сколько текста артефактов выдаётся ревьюеру. */
  reviewTextBytes: number;
}
export const defaultArtifactLimits: ArtifactLimits = {
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  reviewTextBytes: 400000,
};
/** Сколько байт начала большого файла показывается ревьюеру. */
const SAMPLE_BYTES = 16 * 1024;

/** То, что ревьюер видит об артефакте: полный текст или выборку с манифестом. */
export type ArtifactView =
  | { path: string; purpose: string; content: string }
  | {
      path: string;
      purpose: string;
      blob: string;
      digest: string;
      bytes: number;
      lines: number;
      binary: boolean;
      /** Начало файла — выборка, а не полное содержимое. */
      sample?: string;
      note: string;
    };

/**
 * Закрепить нормативные артефакты контракта: схему, файлы приёмки, эталон.
 *
 * Реестр закреплял только документ контракта. Правка схемы, на которую он
 * ссылался, отвечала «уже утверждено» и не проходила ревью, а задачи
 * выполнялись уже по другому договору. Артефакт закрепляется закоммиченной
 * ревизией: путь, blob и digest содержимого на HEAD компонента. Незакоммиченная
 * правка, symlink, выход из репозитория и неотслеживаемый файл — отказ с
 * причиной: закреплять то, чего нет в истории, значит закреплять ничто.
 *
 * Digest считается потоком по точным байтам blob, без чтения большого файла
 * в память целиком и без синхронного обхода, который держал бы heartbeat.
 */
export async function pinArtifacts(
  repo: { id: string; path: string },
  declared: { path: string; purpose: string }[],
  /**
   * Commit, из которого закрепляются артефакты. Отчёт или операция, читающие
   * документ из определённого commit, передают его сюда: иначе документ и
   * артефакты могли бы оказаться из разных снимков.
   */
  at?: string,
  limits: ArtifactLimits = defaultArtifactLimits,
) {
  if (!declared.length) return { artifacts: [], contents: [] as ArtifactView[] };
  const seen = new Set<string>();
  const base = await realpath(repo.path);
  const revision = at ?? (await git(repo.path, 'rev-parse', 'HEAD'));
  // Git опрашивается пакетно: прежде на каждый артефакт уходило пять вызовов
  // (ls-files, status, rev-parse, cat-file -s, cat-file blob), и отчёт по
  // полусотне файлов под нагрузкой не укладывался в таймаут. Проверки файловой
  // системы идут по порядку объявления до первого отказа; Git спрашивается
  // только о прошедших их путях, и отказ Git по раннему пути по-прежнему
  // опережает отказ файловой системы по позднему.
  const checked: { path: string; purpose: string }[] = [];
  let refusal: DomainError | undefined;
  for (const item of declared) {
    refusal = await fileRefusal(base, item.path, seen);
    if (refusal) break;
    checked.push(item);
  }
  const paths = checked.map((c) => c.path);
  const prefix = paths.length ? await git(repo.path, 'rev-parse', '--show-prefix') : '';
  const listed = new Set(
    paths.length
      ? (await gitRaw(repo.path, ['ls-files', '-z', '--full-name', '--', ...paths]))
          .split('\0')
          .filter(Boolean)
      : [],
  );
  // Полное имя в Git — префикс каталога компонента и путь от его корня.
  // Путь, которого нет в пакетном списке, переспрашивается отдельно: так
  // отказ «не в Git» и найденное имя совпадают с прежней проверкой.
  const tracked = checked.map(({ path }) => {
    const name = prefix + relative(base, resolve(base, path)).split(sep).join('/');
    return listed.has(name) ? name : undefined;
  });
  const anyDirty = paths.length
    ? Boolean(await git(repo.path, 'status', '--porcelain', '--', ...paths))
    : false;
  const names = [...new Set(tracked.filter((n) => n !== undefined))];
  const found = await gitObjects(
    repo.path,
    names.map((n) => `${revision}:${n}`),
  );
  const objects = new Map(names.map((n, k) => [n, found[k]]));
  const artifacts: ContractArtifact[] = [];
  const sizes: number[] = [];
  let total = 0;
  for (const [i, { path, purpose }] of checked.entries()) {
    const name = tracked[i] ?? (await git(repo.path, 'ls-files', '--full-name', '--', path));
    if (!name) throw new DomainError('Артефакт не в Git: ' + path, 400);
    // Пакетный status пуст — чисты все; иначе виновник ищется по порядку.
    if (anyDirty && (await git(repo.path, 'status', '--porcelain', '--', path)))
      throw new DomainError(
        'Артефакт изменён после коммита — закоммитьте его до ревью контракта: ' + path,
        400,
      );
    const object = tracked[i]
      ? objects.get(name)
      : (await gitObjects(repo.path, [`${revision}:${name}`]))[0];
    if (!object) throw new Error(`git rev-parse: путь ${name} не найден в ${revision}`);
    const { blob, size } = object;
    if (size > limits.maxFileBytes)
      throw new DomainError(
        `Артефакт ${path} — ${size} байт, больше предела файла ${limits.maxFileBytes} (contractArtifacts.maxFileBytes)`,
        400,
      );
    total += size;
    if (total > limits.maxTotalBytes)
      throw new DomainError(
        `Артефакты договора вместе больше предела ${limits.maxTotalBytes} байт (contractArtifacts.maxTotalBytes)`,
        400,
      );
    artifacts.push({ repositoryId: repo.id, path: name, purpose, revision, blob, digest: '' });
    sizes.push(size);
  }
  if (refusal) throw refusal;
  // Digest — по точным байтам blob: вывод git() обрезан, и правка
  // начальных или конечных пробелов не меняла бы digest. Все blob идут одним
  // потоком `git cat-file --batch` по порядку объявления, поэтому остаток
  // текста ревьюера известен к началу каждого blob, как при чтении по одному.
  const contents: ArtifactView[] = [];
  let review = limits.reviewTextBytes;
  await streamBlobs(
    repo.path,
    artifacts.map((a) => a.blob),
    (i) => (sizes[i] <= review ? sizes[i] : SAMPLE_BYTES),
    (i, read) => {
      const a = artifacts[i],
        size = sizes[i];
      if (read.bytes !== size)
        throw new DomainError('Blob артефакта прочитан не полностью: ' + a.path);
      a.digest = read.digest;
      if (size <= review && !read.binary) {
        contents.push({ path: a.path, purpose: a.purpose, content: read.head.toString('utf8') });
        review -= size;
        return;
      }
      // Выборка не называется полным содержимым: любой байт вне неё меняет
      // digest, и закрепление относится к полному файлу.
      const sample = read.binary
        ? undefined
        : cutAtLine(read.head.subarray(0, Math.max(0, Math.min(SAMPLE_BYTES, review))));
      if (sample) review -= Buffer.byteLength(sample);
      contents.push({
        path: a.path,
        purpose: a.purpose,
        blob: a.blob,
        digest: read.digest,
        bytes: size,
        lines: read.lines,
        binary: read.binary,
        ...(sample ? { sample } : {}),
        note: `Выборка, не полное содержимое: закреплён полный файл (${size} байт, sha256 ${read.digest}). Прочитать его целиком: git cat-file blob ${a.blob}.`,
      });
    },
  );
  return { artifacts, contents };
}

/** Отказ файловой системы для объявленного пути или undefined. */
async function fileRefusal(base: string, path: string, seen: Set<string>) {
  if (seen.has(path)) return new DomainError('Артефакт указан дважды: ' + path, 400);
  seen.add(path);
  const file = resolve(base, path);
  if (!file.startsWith(base + sep))
    return new DomainError('Артефакт вне репозитория: ' + path, 400);
  const stat = await lstat(file).catch(() => undefined);
  if (!stat) return new DomainError('Артефакт не найден: ' + path, 400);
  // Symlink подменил бы содержимое чужим файлом при том же пути в дереве.
  if (stat.isSymbolicLink()) return new DomainError('Артефакт — symlink: ' + path, 400);
  if (!stat.isFile()) return new DomainError('Артефакт не файл: ' + path, 400);
  if ((await realpath(file)) !== file)
    return new DomainError('Путь артефакта проходит через symlink: ' + path, 400);
  return undefined;
}

const cutAtLine = (bytes: Buffer) => {
  const end = bytes.lastIndexOf(0x0a);
  return (end > 0 ? bytes.subarray(0, end + 1) : bytes).toString('utf8');
};

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

/** Необрезанный stdout Git; ввод — в stdin. */
function gitRaw(repoPath: string, args: string[], input?: string) {
  return new Promise<string>((ok, fail) => {
    const child = spawn('git', args, {
      cwd: repoPath,
      env: gitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (error += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0
        ? ok(Buffer.concat(out).toString('utf8'))
        : fail(new Error(`git ${args[0]}: ${error.trim()}`)),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/**
 * Объекты по именам вида `rev:path` одним `git cat-file --batch-check`:
 * blob и размер или undefined, если имени нет — как отказ `rev-parse`.
 * Имя с переводом строки протокол не передаст: оно спрашивается отдельно.
 */
export async function gitObjects(repoPath: string, names: string[]) {
  const found: ({ blob: string; type: string; size: number } | undefined)[] = [];
  const batch = names.filter((n) => !n.includes('\n'));
  const lines = batch.length
    ? (await gitRaw(repoPath, ['cat-file', '--batch-check'], batch.join('\n') + '\n')).split('\n')
    : [];
  let k = 0;
  for (const name of names) {
    if (name.includes('\n')) {
      const blob = await git(repoPath, 'rev-parse', '--verify', '--quiet', name).catch(() => '');
      if (!blob) {
        found.push(undefined);
        continue;
      }
      const [type, size] = await Promise.all([
        git(repoPath, 'cat-file', '-t', blob),
        git(repoPath, 'cat-file', '-s', blob),
      ]);
      found.push({ blob, type, size: Number(size) });
      continue;
    }
    const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(lines[k++] ?? '');
    found.push(m ? { blob: m[1], type: m[2], size: Number(m[3]) } : undefined);
  }
  return found;
}

interface BlobRead {
  digest: string;
  bytes: number;
  lines: number;
  head: Buffer;
  binary: boolean;
}
/**
 * Счётчик байтов одного blob: digest, число байт и строк, первые `keep` байт
 * и признак двоичного содержимого по первым max(keep, 8192) байтам.
 */
function blobReader(keep: number) {
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  const window = Math.max(keep, 8192);
  let kept = 0,
    bytes = 0,
    lines = 0,
    binary = false;
  return {
    feed(chunk: Buffer) {
      hash.update(chunk);
      bytes += chunk.length;
      for (const byte of chunk) if (byte === 0x0a) lines++;
      if (kept < window) {
        const part = chunk.subarray(0, window - kept);
        if (part.includes(0)) binary = true;
        if (kept < keep) head.push(part.subarray(0, keep - kept));
        kept += part.length;
      }
    },
    done: (): BlobRead => ({
      digest: hash.digest('hex'),
      bytes,
      lines,
      head: Buffer.concat(head),
      binary,
    }),
  };
}

/**
 * Поток байтов blob: digest, число байт и строк, первые `keep` байт и
 * признак двоичного содержимого. Файл целиком в память не читается.
 */
export function streamBlob(repoPath: string, blob: string, keep: number) {
  return new Promise<BlobRead>((ok, fail) => {
    const child = spawn('git', ['cat-file', 'blob', blob], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const reader = blobReader(keep);
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => reader.feed(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? ok(reader.done()) : fail(new Error(`git cat-file ${blob}: ${error.trim()}`)),
    );
  });
}

/**
 * Несколько blob одним `git cat-file --batch`, по порядку. `keep(i)`
 * спрашивается в начале i-го blob — после того как `done` получил все
 * предыдущие, — и `done(i, read)` получает итог, как у streamBlob. Память —
 * только заголовок и первые `keep` байт текущего blob.
 */
export function streamBlobs(
  repoPath: string,
  blobs: string[],
  keep: (i: number) => number,
  done: (i: number, read: BlobRead) => void,
) {
  if (!blobs.length) return Promise.resolve();
  return new Promise<void>((ok, fail) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: repoPath,
      env: gitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let i = 0,
      header: Buffer[] = [],
      state: 'header' | 'body' | 'end' = 'header',
      remaining = 0,
      reader: ReturnType<typeof blobReader> | undefined,
      failed: Error | undefined,
      error = '';
    const stop = (e: unknown) => {
      failed ??= e instanceof Error ? e : new Error(String(e));
      child.stdout.destroy();
      child.kill();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        let at = 0;
        while (at < chunk.length && failed === undefined) {
          if (state === 'header') {
            const nl = chunk.indexOf(0x0a, at);
            if (nl < 0) {
              header.push(chunk.subarray(at));
              break;
            }
            header.push(chunk.subarray(at, nl));
            at = nl + 1;
            const line = Buffer.concat(header).toString('utf8');
            header = [];
            const m = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(line);
            if (!m || m[1] !== blobs[i]) throw new Error(`git cat-file ${blobs[i]}: ${line}`);
            reader = blobReader(keep(i));
            remaining = Number(m[2]);
            state = remaining ? 'body' : 'end';
          } else if (state === 'body') {
            const part = chunk.subarray(at, at + remaining);
            reader!.feed(part);
            remaining -= part.length;
            at += part.length;
            if (!remaining) state = 'end';
          } else {
            // Завершающий перевод строки после содержимого.
            if (chunk[at] !== 0x0a) throw new Error(`git cat-file ${blobs[i]}: нарушен поток`);
            at++;
            done(i, reader!.done());
            reader = undefined;
            state = 'header';
            if (++i === blobs.length) child.stdin.end();
          }
        }
      } catch (e) {
        stop(e);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.stdin.on('error', () => {});
    child.on('error', fail);
    child.on('close', (code) => {
      if (failed !== undefined) return fail(failed);
      if (i < blobs.length)
        return fail(
          new Error(`git cat-file --batch: прочитано ${i} из ${blobs.length}. ${error.trim()}`),
        );
      return code === 0 ? ok() : fail(new Error(`git cat-file --batch: ${error.trim()}`));
    });
    child.stdin.write(blobs.join('\n') + '\n');
  });
}

/** Точные байты Git blob, без обрезки и перекодирования. */
export function blobBytes(repoPath: string, blob: string) {
  return execFileSync('git', ['cat-file', 'blob', blob], {
    cwd: repoPath,
    maxBuffer: 520 * 1024 * 1024,
  });
}
export const bytesDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Закрепление из переносимой записи сверяется с Git: blob лежит по своему
 * пути в своей ревизии, и его байты дают записанный digest. Иначе запись с
 * подменённым blob при прежнем digest проходила бы импорт, и проверка базы
 * принимала бы другую схему.
 */
export function verifyArtifacts(repoPath: (repositoryId: string) => string, contracts: Contract[]) {
  for (const c of contracts)
    for (const a of c.artifacts ?? []) {
      const path = repoPath(a.repositoryId);
      let blob: string, bytes: Buffer;
      try {
        blob = execFileSync('git', ['rev-parse', `${a.revision}:${a.path}`], { cwd: path })
          .toString()
          .trim();
        bytes = blobBytes(path, a.blob);
      } catch {
        throw new Error(`Артефакт ${a.path} контракта ${c.id} не найден в Git на ${a.revision}`);
      }
      // Запись первой формулы хранит digest обрезанного текста — как его
      // давал прежний вывод git; новая — digest точных байтов.
      const expected =
        c.pinVersion === 2 ? bytesDigest(bytes) : digest(bytes.toString('utf8').trim());
      if (blob !== a.blob || expected !== a.digest)
        throw new Error(
          `Артефакт ${a.path} контракта ${c.id} не совпадает с Git: закрепление подменено`,
        );
    }
}

/** Артефакты контрактов задачи, которые лежат в данном компоненте. */
export function componentArtifacts(contracts: Contract[], repositoryId: string) {
  return contracts.flatMap((c) =>
    (c.artifacts ?? []).filter((a) => a.repositoryId === repositoryId),
  );
}

/**
 * База прогона содержит именно закреплённые редакции артефактов. Иначе гейт
 * читал бы файл рабочего дерева — ту редакцию, которую ревью не видело, или
 * ещё не перенесённую в базу.
 */
export async function assertArtifactsInBase(
  repoPath: string,
  base: string,
  artifacts: ContractArtifact[],
) {
  const found = await gitObjects(
    repoPath,
    artifacts.map((a) => `${base}:${a.path}`),
  );
  return artifacts.filter((a, i) => found[i]?.blob !== a.blob).map((a) => a.path);
}
