import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, roles } from '../core/model.ts';
import { loadConfig, scopedConfig } from './config.ts';
import { profile } from './packs.ts';
import { git } from './process.ts';

const templateRoot = fileURLToPath(new URL('../../templates/project/', import.meta.url));
const harnessRoot = fileURLToPath(new URL('../../', import.meta.url));
export function defaultContextPacks(repositoryId = 'main') {
  const prefix = repositoryId === 'main' ? '' : repositoryId + '-';
  return [
    {
      id: prefix + 'workflow',
      version: '1.0.0',
      repositoryId,
      roles: [...roles],
      files: ['.agents/context/workflow.md', '.agents/context/review.md'],
    },
    ...roles.map((role) => ({
      id: prefix + role,
      version: '1.0.0',
      repositoryId,
      roles: [role],
      files: [
        `.agents/roles/${role}.md`,
        `.agents/context/${role === 'frontend' ? 'design' : role === 'qa' ? 'testing' : 'contracts'}.md`,
      ],
    })),
    {
      id: prefix + 'library-contracts',
      version: '1.0.0',
      repositoryId,
      roles: [],
      files: ['.agents/context/contracts.md'],
    },
    {
      id: prefix + 'mobile-maestro',
      version: '1.0.0',
      repositoryId,
      roles: [],
      files: ['.agents/context/mobile-maestro.md'],
    },
  ];
}
type Profile = Awaited<ReturnType<typeof profile>>;
export type ApprovalMode = 'agent' | 'operator';

export function projectConfig(
  repository: string,
  selected: Profile,
  approvalMode: ApprovalMode = 'agent',
) {
  return configSchema.parse({
    version: 1,
    name: basename(repository),
    repository,
    mode: 'local',
    approvalMode,
    roles: Object.fromEntries(roles.map((role) => [role, { runtime: 'claude' }])),
    reviewer: { runtime: 'codex' },
    concurrency: selected.concurrency ?? 2,
    gates: selected.gates,
    protectedPaths: [
      'AGENTS.md',
      'CLAUDE.md',
      '.agents/',
      '.github/',
      '.githooks/',
      'harness.config.json',
      'harness.component.json',
      '.harness/',
      '.devcontour/',
      'package.json',
      'package-lock.json',
    ],
    packs: [{ id: selected.id, version: selected.version, capabilities: selected.capabilities }],
  });
}

export const profileLock = (selected: Profile) => ({
  version: 1,
  packs: [{ id: selected.id, version: selected.version, digest: selected.digest }],
});

async function inspect(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function checkDestination(path: string) {
  let cursor = resolve(path);
  while (true) {
    const stat = await inspect(cursor);
    if (stat?.isSymbolicLink()) throw new Error(`Setup не пишет через symlink: ${cursor}`);
    if (stat && cursor !== resolve(path) && !stat.isDirectory())
      throw new Error(`Родитель не является каталогом: ${cursor}`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function templateFiles(dir = templateRoot, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await templateFiles(join(dir, entry.name), name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Неподдерживаемый файл шаблона: ${name}`);
  }
  return result;
}

export async function setupProject(options: {
  repository: string;
  profile: string;
  brief?: string;
  data?: string;
  workspace?: string;
  approvalMode?: ApprovalMode;
}) {
  const repository = await realpath(resolve(options.repository));
  if (repository === (await realpath(harnessRoot)))
    throw new Error('Укажите отдельный каталог продукта, а не исходники DevContour');
  const docs = await realpath(join(repository, 'docs'));
  if (docs !== join(repository, 'docs')) throw new Error('docs должен быть внутри продукта');
  const brief = await realpath(resolve(repository, options.brief ?? 'docs/spec.md'));
  const briefRelative = relative(docs, brief);
  if (
    isAbsolute(briefRelative) ||
    briefRelative.startsWith('..' + sep) ||
    briefRelative === '..' ||
    !brief.endsWith('.md')
  )
    throw new Error('ТЗ должно быть Markdown-файлом внутри docs продукта');
  if (!(await readFile(brief, 'utf8')).trim()) throw new Error('ТЗ пустое');
  let gitRoot: string | undefined;
  try {
    gitRoot = await git(repository, 'rev-parse', '--show-toplevel');
  } catch {
    /* A new product may contain only docs/spec.md; the agent initializes Git later. */
  }
  if (gitRoot && (await realpath(gitRoot)) !== repository)
    throw new Error('Продукт находится внутри другого Git-репозитория; выберите его корень');

  const selected = await profile(options.profile);
  if (options.workspace && options.data) throw new Error('Используйте workspace или data, не оба');
  let workspaceRoot: string | undefined;
  if (options.workspace) {
    if (!isAbsolute(options.workspace)) throw new Error('workspace требует абсолютный путь');
    await checkDestination(options.workspace);
    workspaceRoot = (await inspect(options.workspace))
      ? await realpath(options.workspace)
      : resolve(options.workspace);
    const toolRoot = await realpath(harnessRoot);
    if (
      [repository, toolRoot].some(
        (root) => workspaceRoot === root || workspaceRoot!.startsWith(root + sep),
      )
    )
      throw new Error('Workspace должен находиться вне репозитория продукта и каталога DevContour');
  }
  const data = workspaceRoot
    ? join(workspaceRoot, '.harness', 'local')
    : options.data
      ? resolve(options.data)
      : join(repository, '.harness', 'local');
  const files = new Map<string, string>();
  for (const name of await templateFiles())
    files.set(join(repository, name), await readFile(join(templateRoot, name), 'utf8'));
  files.set(
    join(repository, '.gitignore'),
    '.harness/\n.reports/\nnode_modules/\ndist/\n.env*\n!.env.example\n',
  );
  if (workspaceRoot)
    files.set(join(workspaceRoot, '.gitignore'), '.harness/\n.env*\n!.env.example\n');
  const guides = new Map([
    ['START.md', 'harness-start.md'],
    ['docs/workspaces.md', 'harness-workspaces.md'],
    ['docs/engineering-context.md', 'harness-engineering.md'],
    ['docs/project-integration.md', 'harness-integration.md'],
    ...[
      'team-sync',
      'requirements',
      'lead-workflow',
      'project-memory',
      'metrics',
      'experiments',
      'agent-evals',
    ].map((name) => ['docs/' + name + '.md', 'harness-' + name + '.md'] as [string, string]),
  ]);
  for (const [source, destination] of guides) {
    const text = await readFile(join(harnessRoot, source), 'utf8');
    const rewritten = text.replace(
      /\[([^\]]+)\]\(([^)]+\.md(?:#[^)]*)?)\)/g,
      (match, label, target: string) => {
        if (/^(https?:|#)/.test(target)) return match;
        const [file, anchor] = target.split('#');
        const sourceRelative = relative(harnessRoot, resolve(harnessRoot, dirname(source), file));
        const installed = guides.get(sourceRelative);
        return installed
          ? '[' + label + '](' + installed + (anchor ? '#' + anchor : '') + ')'
          : label +
              ' (справочник DevContour: ' +
              sourceRelative +
              (anchor ? '#' + anchor : '') +
              ')';
      },
    );
    files.set(join(repository, 'docs', destination), rewritten);
  }
  files.set(join(data, 'packs.lock.json'), JSON.stringify(profileLock(selected), null, 2) + '\n');
  const profilePath = join(data, 'profiles', selected.id + '.json');
  const profileContent = await readFile(
    new URL(`../../packs/profiles/${selected.id}.json`, import.meta.url),
    'utf8',
  );
  files.set(profilePath, profileContent);
  // Publish config last so an interrupted copy can resume without an incomplete policy.
  files.set(
    join(data, 'config.json'),
    JSON.stringify(
      {
        ...projectConfig(repository, selected, options.approvalMode),
        contextPacks: defaultContextPacks(),
        ...(workspaceRoot ? { workspaceRoot, storage: 'component' } : {}),
      },
      null,
      2,
    ) + '\n',
  );

  // Complete preflight before writes; existing files are preserved, including user policy.
  for (const path of files.keys()) {
    await checkDestination(path);
    const stat = await inspect(path);
    if (stat && !stat.isFile()) throw new Error(`Ожидался обычный файл: ${path}`);
  }
  let approvalMode = options.approvalMode ?? 'agent';
  if (await inspect(join(data, 'config.json'))) {
    const existing = loadConfig(join(data, 'config.json'));
    if (
      (workspaceRoot && existing.workspaceRoot !== workspaceRoot) ||
      existing.repository !== repository ||
      existing.mode !== 'local' ||
      !existing.packs.some((p) => p.id === selected.id)
    )
      throw new Error('Существующая конфигурация относится к другому продукту или профилю');
    if (options.approvalMode && existing.approvalMode !== options.approvalMode)
      throw new Error('Setup не меняет установленный режим согласования; измените его явно');
    approvalMode = existing.approvalMode;
  } else if (await inspect(join(data, 'packs.lock.json'))) {
    const existing = JSON.parse(await readFile(join(data, 'packs.lock.json'), 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(profileLock(selected)))
      throw new Error('Существующий packs.lock.json не соответствует выбранному профилю');
  }
  if ((await inspect(profilePath)) && (await readFile(profilePath, 'utf8')) !== profileContent)
    throw new Error('Сохранённый профиль изменён; требуется явная сверка версии');

  const created: string[] = [],
    preserved: string[] = [];
  for (const [path, content] of files) {
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { flag: 'wx' });
      created.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      preserved.push(path);
    }
  }
  if (workspaceRoot) {
    const configPath = join(data, 'config.json');
    const config = loadConfig(configPath);
    if (config.storage === 'component')
      await writeFile(configPath, JSON.stringify(scopedConfig(config), null, 2) + '\n');
  }
  return {
    status: 'needs-agent-bootstrap',
    repository,
    brief,
    workspace: workspaceRoot,
    data,
    profile: selected.id,
    approvalMode,
    created,
    preserved,
    next: [
      'Ведущий агент продолжает по START.md: каркас, настройки, реальные gates и исходный Git-коммит.',
      'Сохранённые пользовательские AGENTS.md и .gitignore нужно согласовать с новыми правилами без потери данных.',
      'После bootstrap-коммита выполните context-lock: инструкции закрепляются по Git SHA и digest.',
      'Контракты и план проходят независимое ревью; при approvalMode=agent подтверждение оператора не требуется.',
      'После запуска ведущий агент разбирает сбои, ведёт следующие этапы и принимает только проверенные доски.',
    ],
  };
}
