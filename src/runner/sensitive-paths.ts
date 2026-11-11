import { execFileSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { contractRedactionsOf, latestRedaction, type DevContour } from '../core/service.ts';
import type { Approval, Config, DevContourState } from '../core/model.ts';
import { independentReviewer } from '../harness/policy.ts';
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
  // `-z`: пути как есть. Без него git экранирует не-ASCII пути
  // (core.quotePath), и путь кириллицей не совпадал ни с одним правилом.
  const changed = (await git(repo.path, 'diff', '--name-only', '-z', '--no-renames', from, to))
    .split('\0')
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
  authorRuntime: string;
  reviewerRuntime: string;
}

/**
 * Одобрение контракта годится в доказательство для снятия переноса базы:
 * агент, названы runtime автора и ревьюера, есть сохранённое решение ревью.
 * Ревьюер независим по текущему правилу ревью контрактов (`review.contract`,
 * `independentReviewer`): другой runtime, либо тот же, если правило само его
 * выбирает (`same-vendor-allowed`). Возврат к `different-vendor` прекращает
 * такие снятия. Импорт задач при Git sync сверяет то же по `review.plan`.
 */
export function liftableContractApproval(config: Config, a: Approval | undefined) {
  if (a?.actor !== 'agent' || !a.authorRuntime || !a.reviewerRuntime || !a.artifact) return false;
  return independentReviewer(config, 'contract', a.authorRuntime, a.reviewerRuntime);
}

/**
 * Причина, по которой последняя редакция документа не годится в
 * доказательство, — по одному состоянию, без Git. Её же сверяет транзакция
 * решения: за время gates могли зарегистрировать новую редакцию или вернуть
 * в работу задачу, закреплённую за прежней.
 */
export function reviewedRedaction(
  config: Config,
  s: Readonly<DevContourState>,
  repositoryId: string,
  path: string,
) {
  const records = contractRedactionsOf(s.contracts, path, repositoryId);
  const latest = latestRedaction(s.contracts, path, repositoryId);
  if (!latest || !liftableContractApproval(config, latest.approval)) return undefined;
  const open = s.tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
  if (records.some((c) => c.id !== latest.id && open.some((t) => t.contracts.includes(c.id))))
    return undefined;
  return latest;
}

/**
 * Документ контракта `path`, который перенос базы приносит ровно в той
 * редакции, что одобрило независимое ревью (`review-contract` или
 * contract-change в режиме агента). Доказательство — последняя
 * зарегистрированная редакция этого документа (`latestRedaction`, тот же
 * порядок, что у `supersededBy`) с одобрением, годным для снятия
 * (`liftableContractApproval`); на `to` по
 * этому пути лежит обычный файл (100644 или 100755), и его blob равен blob
 * текста редакции (`git hash-object` точных байтов). Нет доказательства —
 * `undefined`, и перенос по-прежнему подтверждает человек: другая редакция
 * (правка после ревью, откат к прежней), удалённый документ, ссылка или
 * подмодуль, одобрение оператора или запись без runtime либо решения ревью,
 * а также открытая задача, закреплённая за прежней редакцией того же
 * документа, — её договор этот перенос поменял бы без contract-change.
 */
export async function reviewedContractDocument(
  h: DevContour,
  s: Readonly<DevContourState>,
  repositoryId: string,
  path: string,
  to: string,
): Promise<ReviewedContractDocument | undefined> {
  const repo = repository(h.config, repositoryId);
  const latest = reviewedRedaction(h.config, s, repositoryId, path);
  const approval = latest?.approval;
  if (!latest || !approval?.artifact || !approval.authorRuntime || !approval.reviewerRuntime)
    return undefined;
  let entry: string;
  let approved: string;
  try {
    // Запись дерева на `to`, а не рабочий файл: режим и blob из одного места.
    entry = await git(repo.path, 'ls-tree', '-z', to, '--', path);
    // Точные байты одобренного текста, без фильтров атрибутов и перевода строк.
    approved = execFileSync(
      'git',
      hostGitArgs(repo.path, ['hash-object', '--no-filters', '--stdin']),
      { cwd: repo.path, input: Buffer.from(latest.content, 'utf8'), encoding: 'utf8' },
    ).trim();
  } catch {
    return undefined;
  }
  const records = entry.split('\0').filter(Boolean);
  const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(records[0] ?? '');
  if (records.length !== 1 || !match || match[4] !== path) return undefined;
  const [, mode, type, blob] = match;
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return undefined;
  if (blob !== approved) return undefined;
  return {
    repositoryId,
    path,
    blob,
    contractId: latest.id,
    reviewId: approval.artifact.split(/[\\/]/).at(-1) || approval.artifact,
    authorRuntime: approval.authorRuntime,
    reviewerRuntime: approval.reviewerRuntime,
  };
}
