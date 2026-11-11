import { execFileSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import type { DevContour } from '../core/service.ts';
import type { DevContourState } from '../core/model.ts';
import { repository } from '../core/repositories.ts';
import { assertArtifactsInBase, componentArtifacts } from './contract-artifacts.ts';
import { git, hostGitArgs } from './process.ts';

/**
 * Изменённые между `from` и `to` пути, которые перемотка без ревью трогать не
 * вправе: документы и закреплённые артефакты контрактов, файлы закреплённых
 * context packs, защищённые и генерируемые пути компонента, его файл
 * конфигурации, каталоги и файлы контура. Гейт сверяет артефакт по
 * закреплённому blob только при регистрации контракта, поэтому ослабленный
 * человеком файл приёмки стал бы базой незамеченным; сверка закреплённых
 * редакций на `to` закрывает и правку, внесённую не этими коммитами.
 */
export async function sensitiveBasePaths(
  h: DevContour,
  /** Каталог данных контура: в embedded-режиме он внутри репозитория. */
  dataRoot: string,
  s: Readonly<DevContourState>,
  repositoryId: string,
  from: string,
  to: string,
) {
  return (await sensitiveBaseEntries(h, dataRoot, s, repositoryId, from, to)).map((e) => e.path);
}

/** Чувствительный путь переноса и признак «только документ контракта». */
export interface SensitiveBaseEntry {
  path: string;
  /**
   * Путь чувствителен лишь как документ (`source`) зарегистрированного
   * контракта: не артефакт, не файл context pack, не защищённый,
   * генерируемый или конфигурационный файл, не файл контура и не устаревшая
   * закреплённая редакция.
   */
  contractDocument: boolean;
}

/** То же, что `sensitiveBasePaths`, с причиной каждого пути. */
export async function sensitiveBaseEntries(
  h: DevContour,
  dataRoot: string,
  s: Readonly<DevContourState>,
  repositoryId: string,
  from: string,
  to: string,
): Promise<SensitiveBaseEntry[]> {
  const repo = repository(h.config, repositoryId);
  const changed = (await git(repo.path, 'diff', '--name-only', '--no-renames', from, to))
    .split('\n')
    .filter(Boolean);
  const own = (r?: string) => (r ?? 'main') === repositoryId;
  const exact = new Set<string>();
  // Документы контрактов — отдельно: снять их может доказательство ревью
  // (`reviewedContractDocument`), остальные пути — только человек.
  const documents = new Set<string>();
  const prefixes: string[] = ['.devcontour/', '.devcontour-local/'];
  for (const c of s.contracts) {
    if (c.source && own(c.repositoryId)) documents.add(c.source);
    for (const a of c.artifacts ?? []) if (a.repositoryId === repositoryId) exact.add(a.path);
  }
  for (const pack of h.config.contextPacks)
    if (pack.repositoryId === repositoryId)
      for (const f of [...pack.files, ...pack.references]) exact.add(f);
  for (const p of [...repo.protectedPaths, ...(repo.generatedPaths ?? [])])
    if (p.endsWith('/')) prefixes.push(p);
    else exact.add(p);
  if (repo.configFile) exact.add(repo.configFile);
  // Каталог данных контура внутри репозитория (embedded): его файлы — тоже.
  const data = relative(repo.path, dataRoot);
  if (data === '')
    for (const f of [
      'config.json',
      'workspace.json',
      'devcontour.workspace.json',
      'workspace-selection.json',
      'packs.lock.json',
    ])
      exact.add(f);
  if (data === '') prefixes.push('profiles/');
  else if (!data.startsWith('..') && !isAbsolute(data)) prefixes.push(data + '/');
  const other = (p: string) =>
    exact.has(p) ||
    // Каталог, закоммиченный ссылкой или gitlink, — путь без «/»: тоже он.
    prefixes.some((x) => p.startsWith(x) || p === x.slice(0, -1)) ||
    [...exact].some((x) => p.startsWith(x + '/'));
  const document = (p: string) =>
    documents.has(p) || [...documents].some((x) => p.startsWith(x + '/'));
  const hit = changed.filter((p) => other(p) || document(p));
  // Закреплённые редакции артефактов открытой работы на `to` — те же blob.
  const open = s.tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
  const pinned = s.contracts.filter((c) => open.some((t) => t.contracts.includes(c.id)));
  const stale = new Set(
    await assertArtifactsInBase(repo.path, to, componentArtifacts(pinned, repositoryId)),
  );
  return [...new Set([...hit, ...stale])].map((path) => ({
    path,
    contractDocument: documents.has(path) && !other(path) && !stale.has(path),
  }));
}

/** Доказательство: документ контракта на базе — blob, одобренный независимым ревью. */
export interface ReviewedContractDocument {
  repositoryId: string;
  path: string;
  /** Blob документа на перенесённой базе; он же — blob одобренного текста. */
  blob: string;
  contractId: string;
  /** Ревью, одобрившее этот текст (каталог решения `decisions/<id>`). */
  reviewId: string;
  authorRuntime?: string;
  reviewerRuntime: string;
}

/** Зарегистрированные редакции документа контракта компонента, от ранней к последней. */
export function contractRedactions(
  s: Readonly<DevContourState>,
  repositoryId: string,
  path: string,
) {
  const own = (r?: string) => (r ?? 'main') === repositoryId;
  return s.contracts
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.source === path && own(c.repositoryId))
    .sort((a, b) => a.c.approvedAt.localeCompare(b.c.approvedAt) || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * Документ контракта `path`, который перенос базы приносит ровно в той
 * редакции, что одобрило независимое ревью (`review-contract` или
 * contract-change в режиме агента). Доказательство — последняя
 * зарегистрированная редакция этого документа: одобрение агента с ревьюером
 * и сохранённым решением, а blob её текста (`git hash-object` точных байтов)
 * равен blob файла на `to`. Нет доказательства — `undefined`, и перенос
 * по-прежнему подтверждает человек: другая редакция (правка после ревью,
 * откат к прежней), удалённый документ, одобрение оператора или запись без
 * ревьюера, а также открытая задача, закреплённая за прежней редакцией того
 * же документа, — её договор этот перенос поменял бы без contract-change.
 */
export async function reviewedContractDocument(
  h: DevContour,
  s: Readonly<DevContourState>,
  repositoryId: string,
  path: string,
  to: string,
): Promise<ReviewedContractDocument | undefined> {
  const repo = repository(h.config, repositoryId);
  const records = contractRedactions(s, repositoryId, path);
  const latest = records.at(-1);
  const approval = latest?.approval;
  if (!latest || approval?.actor !== 'agent' || !approval.reviewerRuntime || !approval.artifact)
    return undefined;
  const open = s.tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
  if (records.some((c) => c.id !== latest.id && open.some((t) => t.contracts.includes(c.id))))
    return undefined;
  let blob: string;
  let approved: string;
  try {
    blob = await git(repo.path, 'rev-parse', '--verify', '--quiet', `${to}:${path}`);
    // Точные байты одобренного текста, без фильтров атрибутов и перевода строк.
    approved = execFileSync(
      'git',
      hostGitArgs(repo.path, ['hash-object', '--no-filters', '--stdin']),
      { cwd: repo.path, input: Buffer.from(latest.content, 'utf8'), encoding: 'utf8' },
    ).trim();
  } catch {
    return undefined;
  }
  if (!blob || blob !== approved) return undefined;
  return {
    repositoryId,
    path,
    blob,
    contractId: latest.id,
    reviewId: approval.artifact.split(/[\\/]/).at(-1) || approval.artifact,
    ...(approval.authorRuntime ? { authorRuntime: approval.authorRuntime } : {}),
    reviewerRuntime: approval.reviewerRuntime,
  };
}
