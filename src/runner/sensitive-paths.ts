import { execFileSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import {
  contractRedactionsOf,
  latestRedaction,
  supersededBy,
  type DevContour,
} from '../core/service.ts';
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
  const { other, document, documents } = baseRules(h, dataRoot, s, repositoryId);
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

/**
 * Правила чувствительных путей переноса базы для компонента: документы
 * контрактов (`document`) отдельно от прочего (`other`: артефакты контрактов,
 * файлы context packs, защищённые и генерируемые пути, файл конфигурации,
 * каталоги и данные контура). `restricted` — то же прочее без артефактов и
 * файлов context packs: эти пути не снимает никакое доказательство ревью.
 */
function baseRules(
  h: DevContour,
  dataRoot: string,
  s: Readonly<DevContourState>,
  repositoryId: string,
) {
  const repo = repository(h.config, repositoryId);
  const own = (r?: string) => (r ?? 'main') === repositoryId;
  const exact = new Set<string>();
  const artifacts = new Set<string>();
  const packFiles = new Set<string>();
  // Документы контрактов — отдельно: снять их может доказательство ревью
  // (`reviewedContractDocument`), остальные пути — только человек.
  const documents = new Set<string>();
  const prefixes: string[] = ['.devcontour/', '.devcontour-local/'];
  for (const c of s.contracts) {
    if (c.source && own(c.repositoryId)) documents.add(c.source);
    for (const a of c.artifacts ?? []) if (a.repositoryId === repositoryId) artifacts.add(a.path);
  }
  for (const pack of h.config.contextPacks)
    if (pack.repositoryId === repositoryId)
      for (const f of [...pack.files, ...pack.references]) packFiles.add(f);
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
  const under = (set: Set<string>, p: string) =>
    set.has(p) || [...set].some((x) => p.startsWith(x + '/'));
  const restricted = (p: string) =>
    under(exact, p) ||
    // Каталог, закоммиченный ссылкой или gitlink, — путь без «/»: тоже он.
    prefixes.some((x) => p.startsWith(x) || p === x.slice(0, -1));
  const other = (p: string) => restricted(p) || under(artifacts, p) || under(packFiles, p);
  const document = (p: string) => under(documents, p);
  const artifact = (p: string) => under(artifacts, p);
  const pack = (p: string) => under(packFiles, p);
  return { other, document, documents, restricted, artifact, pack };
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
  // Открытая задача прежней редакции держит перенос, если эта редакция
  // заменена по смыслу. Задача редакции, которую последняя лишь
  // консолидирует, сохраняет свой договор: перенос текста его не меняет.
  if (
    records.some(
      (c) =>
        c.id !== latest.id &&
        supersededBy(s.contracts, c.id) &&
        open.some((t) => t.contracts.includes(c.id)),
    )
  )
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

/** Путь соседнего контракта, который перенос базы операции несёт как одобренный. */
export interface SiblingContractLift {
  path: string;
  /** Зарегистрированная редакция соседнего контракта, одобрившая этот blob. */
  contractId: string;
  kind: 'document' | 'artifact';
  blob: string;
  mode: string;
}

/** Соседний контракт и commit, который видело его ревью. */
export interface SiblingContract {
  contractId: string;
  head: string;
}

/** Запись дерева `to` по пути: blob и режим обычного файла или `undefined`. */
async function regularFile(repoPath: string, to: string, path: string) {
  const entry = await treeEntry(repoPath, to, path);
  if (!entry || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755'))
    return undefined;
  return { mode: entry.mode, blob: entry.blob };
}

/** Другие контракты открытой работы закрепляют `path` в другой редакции. */
function pinnedElsewhere(
  s: Readonly<DevContourState>,
  repositoryId: string,
  contractId: string,
  path: string,
  blob: string,
) {
  const open = s.tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
  return s.contracts.some(
    (x) =>
      x.id !== contractId &&
      open.some((t) => t.contracts.includes(x.id)) &&
      (x.artifacts ?? []).some(
        (a) => a.repositoryId === repositoryId && a.path === path && a.blob !== blob,
      ),
  );
}

/**
 * Снятие соседнего пути всё ещё действительно по состоянию — без Git, для
 * проверки внутри транзакции сдвига ref: за время переноса могли
 * зарегистрировать новую редакцию документа, вернуть в работу задачу прежней
 * или закрепить тот же артефакт в другой редакции. Живость соседней операции
 * сверяет вызывающий.
 */
export function siblingLiftHolds(
  config: Config,
  s: Readonly<DevContourState>,
  repositoryId: string,
  lift: SiblingContractLift,
) {
  const c = s.contracts.find((x) => x.id === lift.contractId);
  if (!c?.source || reviewedRedaction(config, s, repositoryId, c.source)?.id !== c.id) return false;
  if (lift.kind === 'document') return c.source === lift.path;
  const pin = (c.artifacts ?? []).find(
    (a) => a.repositoryId === repositoryId && a.path === lift.path,
  );
  return pin?.blob === lift.blob && !pinnedElsewhere(s, repositoryId, c.id, lift.path, lift.blob);
}

/**
 * Пути из `paths`, которые операция contract-change вправе перенести в базу
 * вместе со своим контрактом, потому что это одобренные редакции соседних
 * контрактов того же этапа. Соседи — зарегистрированные редакции живых
 * операций, прошедших ревью, с commit, который видело их ревью. Редакция
 * годится, только если она — последняя для своего документа и её одобрение
 * годно для снятия (`reviewedRedaction`). Тогда снимается:
 *
 * - документ — blob на `to` равен blob одобренного текста
 *   (`reviewedContractDocument`, правило переноса D42 без изменений);
 * - закреплённый артефакт — blob на `to` равен закреплённому, он не файл
 *   context pack и не документ контракта, и другой контракт открытой работы не
 *   закрепляет его в другой редакции.
 *
 * Оба — обычные файлы с тем же режимом, что на commit ревью соседа: смена
 * бита исполнения при прежнем blob ревью не проходила. Защищённые,
 * генерируемые и конфигурационные пути, каталоги и данные контура не
 * снимаются никогда. Документ в context pack снимается: его перезакрепит шаг
 * `context` соседней операции.
 */
export async function siblingContractLifts(
  h: DevContour,
  dataRoot: string,
  s: Readonly<DevContourState>,
  repositoryId: string,
  paths: string[],
  to: string,
  contracts: SiblingContract[],
): Promise<Map<string, SiblingContractLift>> {
  const lifted = new Map<string, SiblingContractLift>();
  const wanted = new Set(paths);
  if (!wanted.size || !contracts.length) return lifted;
  const repo = repository(h.config, repositoryId);
  const rules = baseRules(h, dataRoot, s, repositoryId);
  // Тот же файл и режим, что видело ревью соседа.
  const sameFile = async (path: string, head: string) => {
    const now = await regularFile(repo.path, to, path);
    const seen = await regularFile(repo.path, head, path);
    return now && seen && now.mode === seen.mode ? now : undefined;
  };
  for (const { contractId: id, head } of contracts) {
    const c = s.contracts.find((x) => x.id === id);
    if (!c?.source || (c.repositoryId ?? 'main') !== repositoryId) continue;
    if (reviewedRedaction(h.config, s, repositoryId, c.source)?.id !== c.id) continue;
    if (
      wanted.has(c.source) &&
      !lifted.has(c.source) &&
      !rules.restricted(c.source) &&
      !rules.artifact(c.source)
    ) {
      const proof = await reviewedContractDocument(h, s, repositoryId, c.source, to);
      const file = proof?.contractId === c.id ? await sameFile(c.source, head) : undefined;
      if (proof && file && file.blob === proof.blob)
        lifted.set(c.source, {
          path: c.source,
          contractId: c.id,
          kind: 'document',
          blob: proof.blob,
          mode: file.mode,
        });
    }
    for (const a of c.artifacts ?? []) {
      if (a.repositoryId !== repositoryId || !wanted.has(a.path) || lifted.has(a.path)) continue;
      if (rules.restricted(a.path) || rules.pack(a.path) || rules.document(a.path)) continue;
      if (pinnedElsewhere(s, repositoryId, c.id, a.path, a.blob)) continue;
      const file = await sameFile(a.path, head);
      if (file && file.blob === a.blob)
        lifted.set(a.path, {
          path: a.path,
          contractId: c.id,
          kind: 'artifact',
          blob: file.blob,
          mode: file.mode,
        });
    }
  }
  return lifted;
}

/** Запись дерева `at` по пути: `null` — пути нет, `undefined` — Git не ответил. */
async function treeEntry(repoPath: string, at: string, path: string) {
  let entry: string;
  try {
    entry = await git(repoPath, 'ls-tree', '-z', at, '--', path);
  } catch {
    return undefined;
  }
  const records = entry.split('\0').filter(Boolean);
  if (!records.length) return null;
  const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(records[0]);
  if (records.length !== 1 || !match || match[4] !== path) return undefined;
  return { mode: match[1], type: match[2], blob: match[3] };
}

/** Снятия путей контрактов, зарегистрированных без операции, и что перезакрепить. */
export interface RegisteredContractLifts {
  lifted: Map<string, SiblingContractLift>;
  /** Контракты снятых документов, которые закрепляет context pack. */
  packed: string[];
}

/**
 * Пути из `paths`, которые операция contract-change вправе перенести в базу,
 * потому что это одобренные редакции контрактов, зарегистрированных без
 * операции (`review-contract`): новый документ этапа или поправка, у которой
 * нет открытых задач на прежней редакции. Правила те же, что у соседей
 * (`siblingContractLifts`): редакция — последняя для своего документа и
 * годится для снятия (`reviewedRedaction`); документ — обычный файл с blob
 * одобренного текста (`reviewedContractDocument`), закреплённый артефакт —
 * обычный файл с закреплённым blob, не документ и не файл context pack, и
 * другой контракт открытой работы не закрепляет его иначе. Режим: у
 * артефакта — тот же, что на commit закрепления; у документа — тот же, что
 * на базе, а нового документа — любой обычный (правило F28 проверки базы).
 *
 * Не снимаются: пути живых операций (`held`, их несут они сами или ждут),
 * редакции, которые зарегистрировала незавершённая операция (`excluded`:
 * отменённая, заменённая, устаревшая — ведущий её остановил), защищённые,
 * генерируемые и конфигурационные пути и данные контура. Документ из context
 * pack снимается только при `packs` — тогда его перезакрепляет шаг `context`
 * этой операции (`packed`).
 */
export async function registeredContractLifts(
  h: DevContour,
  dataRoot: string,
  s: Readonly<DevContourState>,
  repositoryId: string,
  paths: string[],
  to: string,
  base: string,
  options: {
    held: Set<string>;
    excluded: Set<string>;
    packs: boolean;
    /**
     * Редакции, которые зарегистрировала завершённая операция contract-change:
     * она уже записала корректировки принятых задач всех редакций до неё.
     */
    corrected?: Set<string>;
  },
): Promise<RegisteredContractLifts> {
  const lifted = new Map<string, SiblingContractLift>();
  const packed: string[] = [];
  const wanted = paths.filter((p) => !options.held.has(p));
  if (!wanted.length) return { lifted, packed };
  const repo = repository(h.config, repositoryId);
  const rules = baseRules(h, dataRoot, s, repositoryId);
  const own = (r?: string) => (r ?? 'main') === repositoryId;
  // Последняя годная редакция документа, зарегистрированная не незавершённой
  // операцией. Поправка, заменившая по смыслу редакцию с принятыми задачами,
  // требует операции: корректировки принятых задач (`corrections`) создаёт
  // только contract-change.
  const current = (source: string) => {
    const c = reviewedRedaction(h.config, s, repositoryId, source);
    if (!c || options.excluded.has(c.id)) return undefined;
    const done = s.tasks.filter((t) => t.status === 'done');
    // Считаются только редакции начиная с последней, которую провела
    // завершённая операция: принятые задачи прежних она уже назвала в своих
    // корректировках. Её собственная редакция считается: задачи, принятые
    // по ней, следующая поправка без операции заменила бы без корректировки.
    const records = contractRedactionsOf(s.contracts, source, repositoryId);
    const since = Math.max(
      records.findLastIndex((r) => options.corrected?.has(r.id)),
      0,
    );
    const corrected = records
      .slice(since)
      .some(
        (r) =>
          r.id !== c.id &&
          supersededBy(s.contracts, r.id) &&
          done.some((t) => t.contracts.includes(r.id)),
      );
    return corrected ? undefined : c;
  };
  // Действующие договоры компонента: последние редакции документов и
  // контракты без документа.
  const latest = s.contracts.filter(
    (x) =>
      own(x.repositoryId) &&
      (!x.source || latestRedaction(s.contracts, x.source, repositoryId)?.id === x.id),
  );
  for (const path of wanted) {
    if (rules.restricted(path)) continue;
    if (rules.documents.has(path)) {
      const c = current(path);
      if (!c || rules.artifact(path) || (!options.packs && rules.pack(path))) continue;
      const proof = await reviewedContractDocument(h, s, repositoryId, path, to);
      const now = await treeEntry(repo.path, to, path);
      const was = await treeEntry(repo.path, base, path);
      if (!proof || proof.contractId !== c.id || !now || now.blob !== proof.blob) continue;
      if (was === undefined || (was && was.mode !== now.mode)) continue;
      lifted.set(path, {
        path,
        contractId: c.id,
        kind: 'document',
        blob: now.blob,
        mode: now.mode,
      });
      if (rules.pack(path)) packed.push(c.id);
      continue;
    }
    if (rules.pack(path) || rules.document(path)) continue;
    for (const c of s.contracts) {
      const pin = (c.artifacts ?? []).find(
        (a) => a.repositoryId === repositoryId && a.path === path,
      );
      if (!pin || !own(c.repositoryId) || !c.source || current(c.source)?.id !== c.id) continue;
      if (pinnedElsewhere(s, repositoryId, c.id, path, pin.blob)) continue;
      // Два действующих договора закрепляют путь по-разному: какой из них
      // верен, решает не порядок реестра, а ведущий.
      if (
        latest.some(
          (x) =>
            x.id !== c.id &&
            (x.artifacts ?? []).some(
              (a) => a.repositoryId === repositoryId && a.path === path && a.blob !== pin.blob,
            ),
        )
      )
        break;
      const now = await regularFile(repo.path, to, path);
      const seen = await regularFile(repo.path, pin.revision, path);
      if (!now || !seen || now.mode !== seen.mode || now.blob !== pin.blob) continue;
      lifted.set(path, {
        path,
        contractId: c.id,
        kind: 'artifact',
        blob: now.blob,
        mode: now.mode,
      });
      break;
    }
  }
  return { lifted, packed: [...new Set(packed)] };
}
