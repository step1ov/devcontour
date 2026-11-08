import { readFile, mkdir, writeFile, stat, readdir } from 'node:fs/promises';

const path = new URL('../skills/devcontour/references/agent-api.json', import.meta.url);

// Схемы берутся из собранного lib, а не из исходников. Если сборка отстала,
// проверка сверяет справочник со старым API и молча соглашается — ровно тот
// отказ, который она и должна ловить. Поэтому сначала проверяется свежесть
// самой сборки.
async function newest(dir) {
  let latest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    latest = Math.max(
      latest,
      entry.isDirectory() ? await newest(child) : (await stat(child)).mtimeMs,
    );
  }
  return latest;
}
// Генерация (build:assets) читает исходники через tsx и не требует lib:
// в свежей рабочей копии `npm run build:assets` работает без build:lib.
// Проверка (check:skill) по-прежнему сверяет справочник с собранным lib.
const check = process.argv.includes('--check');
const { capabilities } = await import(
  check ? '../lib/application/agent.js' : '../src/application/agent.ts'
);
const expected = JSON.stringify(capabilities(), null, 2) + '\n';
if (check) {
  const source = new URL('../src/', import.meta.url);
  const built = new URL('../lib/', import.meta.url);
  if ((await newest(source)) > (await newest(built)))
    throw new Error(
      'Сборка lib старше исходников: справочник сверялся бы с прежним API. Выполните npm run build:lib',
    );
  if ((await readFile(path, 'utf8')) !== expected)
    throw new Error('Skill API reference is stale; run npm run build');
  console.log('Skill API reference matches the installed command schemas');
} else {
  await mkdir(new URL('.', path), { recursive: true });
  await writeFile(path, expected);
}
