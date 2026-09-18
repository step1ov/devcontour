import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configSchema, type Config } from './core/model.ts';
import { Store } from './core/store.ts';
import { DevContour } from './core/service.ts';
import { Scheduler } from './runner/scheduler.ts';
import { git } from './runner/process.ts';
export async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export async function setupDemo(root: string) {
  root = resolve(root);
  const configPath = join(root, 'config.json');
  if (await exists(configPath)) return;
  const repo = join(root, 'repository');
  if (await exists(repo))
    throw new Error(
      'Demo repository уже существует без конфигурации. Выберите новый --data; существующие файлы не перезаписываются.',
    );
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, '.gitignore'), '.reports/\n');
  await writeFile(
    join(repo, 'README.md'),
    '# Учебный репозиторий DevContour\n\nДетерминированные артефакты для проверки оркестрации. Это не реализация каталога продуктов и не вывод AI.\n',
  );
  await writeFile(
    join(repo, 'verify.mjs'),
    `import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const ids=new Set((await readdir('deliverables')).map(x=>x.replace('.json','')));
for(const id of ids){const t=JSON.parse(await readFile('deliverables/'+id+'.json','utf8'));assert.equal(t.id,id);assert.ok(t.title.length>=3);assert.ok(t.acceptance.length>0);for(const dep of t.dependsOn)assert.ok(ids.has(dep),'Missing dependency '+dep);}
assert.ok(ids.has(process.env.DEVCONTOUR_TASK_ID),'No result for current task');
await mkdir('.reports',{recursive:true});await writeFile(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite name="demo" tests="2"><testcase name="dependency-artifacts"/><testcase name="current-task-result"/></testsuite>');
console.log('2 fixture assertions passed. No AI model was called.');\n`,
  );
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'add', '.');
  await git(
    repo,
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--no-gpg-sign',
    '-m',
    'Initialize reproducible DevContour fixture',
  );
  const config: Config = configSchema.parse({
    version: 1,
    name: 'Учебный проект',
    repository: repo,
    mode: 'demo',
    concurrency: 2,
    roles: {
      architect: { runtime: 'demo' },
      backend: { runtime: 'demo' },
      frontend: { runtime: 'demo' },
      qa: { runtime: 'demo' },
    },
    reviewer: { runtime: 'demo' },
    gates: [
      {
        id: 'fixture-tests',
        kind: 'test',
        command: ['node', 'verify.mjs'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
    protectedPaths: ['verify.mjs', '.gitignore'],
    packs: [
      { id: 'base-process', version: '0.1.0', capabilities: ['dag', 'revisions', 'evidence'] },
    ],
  });
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const scheduler = new Scheduler(h, root);
  await scheduler.init();
  const history = h.createBoard(
    'Стартовая инфраструктура',
    'Принятая доска для проверки истории и корректировок.',
  );
  const first = h.addTask(history.id, {
    title: 'Подготовить структуру проекта',
    description: 'Создать учебный артефакт структуры проекта для проверки полного цикла.',
    role: 'architect',
    acceptance: ['Артефакт структуры существует и проходит проверку.'],
  });
  h.addTask(history.id, {
    title: 'Проверить базовый сценарий',
    description: 'Подтвердить связь с артефактом структуры и сохранить результат учебной проверки.',
    role: 'qa',
    dependsOn: [first.id],
    acceptance: ['Зависимость присутствует в интегрированном результате.'],
  });
  h.approve(history.id);
  h.pause(false);
  await scheduler.drain();
  h.pause(true);
  if (store.read().tasks.some((t) => t.status !== 'done'))
    throw new Error('Demo setup failed: ' + JSON.stringify(store.read().tasks));
  h.accept(history.id, await git(repo, 'rev-parse', scheduler.target));
  const b = h.createBoard(
    'Каталог продуктов',
    'Первый вертикальный проход: контракт, параллельная разработка, интеграция. Все задачи учебные.',
  );
  const contract = h.contract(
    'Контракт каталога v1',
    'GET /products?q=string → { items: [{ id: string, title: string }], total: number }. Пустой запрос возвращает первую страницу. Состояния UI: loading, empty, error, success.',
  );
  const a = h.addTask(b.id, {
    title: 'Зафиксировать API и состояния',
    description:
      'Подготовить учебный результат утверждённого контракта API и состояний интерфейса.',
    role: 'architect',
    contracts: [contract.id],
    acceptance: ['Контракт API и четыре состояния интерфейса описаны.'],
  });
  const be = h.addTask(b.id, {
    title: 'Поиск по каталогу',
    description: 'Учебный backend-срез: подготовить артефакт поиска, связанный с утверждённым API.',
    role: 'backend',
    dependsOn: [a.id],
    contracts: [contract.id],
    acceptance: ['Поиск следует согласованному контракту.', 'Пустой запрос обрабатывается явно.'],
  });
  const fe = h.addTask(b.id, {
    title: 'Экран каталога',
    description: 'Учебный frontend-срез: подготовить артефакт интерфейса поиска и его состояний.',
    role: 'frontend',
    dependsOn: [a.id],
    contracts: [contract.id],
    acceptance: ['Есть состояния загрузки, ошибки, пустого и полного результата.'],
  });
  const qa = h.addTask(b.id, {
    title: 'Сценарии приёмки',
    description: 'Учебный QA-срез: подготовить набор сценариев для поиска и пограничных состояний.',
    role: 'qa',
    dependsOn: [a.id],
    acceptance: ['Сценарии покрывают положительный и отрицательный путь.'],
  });
  h.addTask(b.id, {
    title: 'Проверить сквозной результат',
    description: 'Проверить наличие всех трёх артефактов после объединения параллельной работы.',
    role: 'qa',
    dependsOn: [be.id, fe.id, qa.id],
    acceptance: ['Backend, frontend и QA-артефакты присутствуют вместе.'],
  });
  h.approve(b.id);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  await scheduler.stop();
  store.close();
}
