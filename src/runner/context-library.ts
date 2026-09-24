import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContextPack } from '../core/model.ts';

// Знание о стеке живёт в DevContour и приезжает в проект по объявлению, а не
// копируется в каждый репозиторий заранее. Профиль, объявивший пакет, тем самым
// говорит, какие инструкции нужны этой поверхности: подтвердили мобильное
// приложение — в продукт приезжают мобильные инструкции, и только они.
//
// Библиотека повторяет структуру продукта: файл лежит там же, где окажется.
const libraryRoot = fileURLToPath(new URL('../../packs/context/', import.meta.url));

const exists = (path: string) =>
  access(path, constants.F_OK).then(
    () => true,
    () => false,
  );

/**
 * Доставить файлы объявленных пакетов в репозиторий.
 *
 * Существующий файл не перезаписывается никогда: продукт мог его дополнить, а
 * пакет закреплён по digest — молчаливая замена сделала бы закрепление ложью,
 * а код, написанный по прежней инструкции, разошёлся бы с ней без следа.
 * Возвращаются только действительно скопированные пути.
 */
export async function deliverContextPacks(
  repository: string,
  packs: Pick<ContextPack, 'id' | 'files'>[],
): Promise<string[]> {
  const root = resolve(repository);
  const delivered: string[] = [];
  for (const file of [...new Set(packs.flatMap((pack) => pack.files))]) {
    const source = resolve(libraryRoot, file);
    if (!source.startsWith(resolve(libraryRoot) + sep) || !(await exists(source))) continue;
    const target = join(root, file);
    if (!target.startsWith(root + sep) || (await exists(target))) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(source, 'utf8'));
    delivered.push(file);
  }
  return delivered;
}

/**
 * Пакеты, чья копия в проекте отстала от библиотеки.
 *
 * Инструкция, по которой написан код, — часть договора. Обновлять её молча
 * нельзя: проект получил бы правила, которым его код уже не отвечает, и узнал
 * бы об этом на ревью. Обновление — решение: остаёмся на своей версии или
 * переходим и правим код. Здесь только факт расхождения, без действия.
 */
export async function outdatedContextPacks(
  repository: string,
  packs: Pick<ContextPack, 'id' | 'version' | 'files'>[],
): Promise<{ id: string; version: string; library: string; files: string[] }[]> {
  const root = resolve(repository);
  const outdated = [];
  for (const pack of packs) {
    const library = await libraryVersion(pack.id);
    if (!library || library === pack.version) continue;
    const differing: string[] = [];
    for (const file of pack.files) {
      const source = resolve(libraryRoot, file);
      const target = join(root, file);
      if (!source.startsWith(resolve(libraryRoot) + sep)) continue;
      if (!(await exists(source)) || !(await exists(target))) continue;
      if ((await readFile(source, 'utf8')) !== (await readFile(target, 'utf8')))
        differing.push(file);
    }
    if (differing.length) outdated.push({ ...pack, library, files: differing });
  }
  return outdated;
}

/** Версия пакета в библиотеке: её объявляет сама библиотека, а не проект. */
async function libraryVersion(id: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(join(libraryRoot, 'versions.json'), 'utf8'),
    ) as Record<string, string>;
    return manifest[id];
  } catch {
    return undefined;
  }
}

/**
 * Перейти на версию библиотеки для одного пакета.
 *
 * Решение принимает человек: остаться на своей версии — ничего не делать,
 * перейти — взять новый текст и привести код в соответствие. Закрепление при
 * этом снимается: digest относился к прежнему тексту, и context-lock обязан
 * пройти заново, иначе прогон будет ссылаться на то, чего уже нет.
 */
export async function adoptContextPack(
  repository: string,
  pack: Pick<ContextPack, 'id' | 'files'>,
): Promise<{ id: string; version?: string; files: string[] }> {
  const root = resolve(repository);
  const taken: string[] = [];
  for (const file of pack.files) {
    const source = resolve(libraryRoot, file);
    if (!source.startsWith(resolve(libraryRoot) + sep) || !(await exists(source))) continue;
    const target = join(root, file);
    if (!target.startsWith(root + sep)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(source, 'utf8'));
    taken.push(file);
  }
  if (!taken.length) throw new Error('В библиотеке нет файлов пакета ' + pack.id);
  return { id: pack.id, version: await libraryVersion(pack.id), files: taken };
}
