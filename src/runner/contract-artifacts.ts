import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
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
  const artifacts: ContractArtifact[] = [];
  const contents: ArtifactView[] = [];
  let total = 0;
  let review = limits.reviewTextBytes;
  for (const { path, purpose } of declared) {
    if (seen.has(path)) throw new DomainError('Артефакт указан дважды: ' + path, 400);
    seen.add(path);
    const file = resolve(base, path);
    if (!file.startsWith(base + sep))
      throw new DomainError('Артефакт вне репозитория: ' + path, 400);
    const stat = await lstat(file).catch(() => undefined);
    if (!stat) throw new DomainError('Артефакт не найден: ' + path, 400);
    // Symlink подменил бы содержимое чужим файлом при том же пути в дереве.
    if (stat.isSymbolicLink()) throw new DomainError('Артефакт — symlink: ' + path, 400);
    if (!stat.isFile()) throw new DomainError('Артефакт не файл: ' + path, 400);
    if ((await realpath(file)) !== file)
      throw new DomainError('Путь артефакта проходит через symlink: ' + path, 400);
    const tracked = await git(repo.path, 'ls-files', '--full-name', '--', path);
    if (!tracked) throw new DomainError('Артефакт не в Git: ' + path, 400);
    if (await git(repo.path, 'status', '--porcelain', '--', path))
      throw new DomainError(
        'Артефакт изменён после коммита — закоммитьте его до ревью контракта: ' + path,
        400,
      );
    const blob = await git(repo.path, 'rev-parse', `${revision}:${tracked}`);
    const size = Number(await git(repo.path, 'cat-file', '-s', blob));
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
    // Digest — по точным байтам blob: вывод git() обрезан, и правка
    // начальных или конечных пробелов не меняла бы digest.
    const read = await streamBlob(repo.path, blob, size <= review ? size : SAMPLE_BYTES);
    if (read.bytes !== size) throw new DomainError('Blob артефакта прочитан не полностью: ' + path);
    artifacts.push({
      repositoryId: repo.id,
      path: tracked,
      purpose,
      revision,
      blob,
      digest: read.digest,
    });
    if (size <= review && !read.binary) {
      contents.push({ path: tracked, purpose, content: read.head.toString('utf8') });
      review -= size;
    } else {
      // Выборка не называется полным содержимым: любой байт вне неё меняет
      // digest, и закрепление относится к полному файлу.
      const sample = read.binary
        ? undefined
        : cutAtLine(read.head.subarray(0, Math.max(0, Math.min(SAMPLE_BYTES, review))));
      if (sample) review -= Buffer.byteLength(sample);
      contents.push({
        path: tracked,
        purpose,
        blob,
        digest: read.digest,
        bytes: size,
        lines: read.lines,
        binary: read.binary,
        ...(sample ? { sample } : {}),
        note: `Выборка, не полное содержимое: закреплён полный файл (${size} байт, sha256 ${read.digest}). Прочитать его целиком: git cat-file blob ${blob}.`,
      });
    }
  }
  return { artifacts, contents };
}

const cutAtLine = (bytes: Buffer) => {
  const end = bytes.lastIndexOf(0x0a);
  return (end > 0 ? bytes.subarray(0, end + 1) : bytes).toString('utf8');
};

/**
 * Поток байтов blob: digest, число байт и строк, первые `keep` байт и
 * признак двоичного содержимого. Файл целиком в память не читается.
 */
export function streamBlob(repoPath: string, blob: string, keep: number) {
  return new Promise<{
    digest: string;
    bytes: number;
    lines: number;
    head: Buffer;
    binary: boolean;
  }>((ok, fail) => {
    const child = spawn('git', ['cat-file', 'blob', blob], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let kept = 0,
      bytes = 0,
      lines = 0,
      binary = false,
      error = '';
    child.stdout.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
      for (const byte of chunk) if (byte === 0x0a) lines++;
      if (kept < Math.max(keep, 8192)) {
        const part = chunk.subarray(0, Math.max(keep, 8192) - kept);
        if (part.includes(0)) binary = true;
        if (kept < keep) head.push(part.subarray(0, keep - kept));
        kept += part.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0
        ? ok({ digest: hash.digest('hex'), bytes, lines, head: Buffer.concat(head), binary })
        : fail(new Error(`git cat-file ${blob}: ${error.trim()}`)),
    );
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
  const stale: string[] = [];
  for (const a of artifacts) {
    const blob = await git(repoPath, 'rev-parse', `${base}:${a.path}`).catch(() => '');
    if (blob !== a.blob) stale.push(a.path);
  }
  return stale;
}
