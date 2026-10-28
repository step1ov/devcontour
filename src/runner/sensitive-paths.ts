import { isAbsolute, relative } from 'node:path';
import type { DevContour } from '../core/service.ts';
import type { DevContourState } from '../core/model.ts';
import { repository } from '../core/repositories.ts';
import { assertArtifactsInBase, componentArtifacts } from './contract-artifacts.ts';
import { git } from './process.ts';

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
  const repo = repository(h.config, repositoryId);
  const changed = (await git(repo.path, 'diff', '--name-only', '--no-renames', from, to))
    .split('\n')
    .filter(Boolean);
  const own = (r?: string) => (r ?? 'main') === repositoryId;
  const exact = new Set<string>();
  const prefixes: string[] = ['.devcontour/', '.devcontour-local/'];
  for (const c of s.contracts) {
    if (c.source && own(c.repositoryId)) exact.add(c.source);
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
  const hit = changed.filter(
    (p) =>
      exact.has(p) ||
      // Каталог, закоммиченный ссылкой или gitlink, — путь без «/»: тоже он.
      prefixes.some((x) => p.startsWith(x) || p === x.slice(0, -1)) ||
      [...exact].some((x) => p.startsWith(x + '/')),
  );
  // Закреплённые редакции артефактов открытой работы на `to` — те же blob.
  const open = s.tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
  const pinned = s.contracts.filter((c) => open.some((t) => t.contracts.includes(c.id)));
  const stale = await assertArtifactsInBase(
    repo.path,
    to,
    componentArtifacts(pinned, repositoryId),
  );
  return [...new Set([...hit, ...stale])];
}
