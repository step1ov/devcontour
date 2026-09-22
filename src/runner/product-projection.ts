import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  lstatSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DevContourState } from '../core/model.ts';
import type { ProductChange } from '../core/preparation-model.ts';

const line = (text: string) => text.replace(/[\r\n|]/g, ' ');
const names = {
  draft: 'черновик агента',
  'in-review': 'ожидает решения пользователя',
  approved: 'утверждено',
  'changes-requested': 'возвращено на доработку',
};
const header = (change: ProductChange, part: string) => [
  `# ${change.key} · ${line(change.title)} — ${part}`,
  '',
  '> Автоматическая проекция состояния. Правьте в панели: ручные изменения будут заменены.',
  '',
];

// The brief is what the operator approves and every later task is bound to.
// Keeping it only in SQLite made it unreadable without a running server.
export function renderProduct(change: ProductChange) {
  const product = change.product.at(-1);
  const rows = header(change, 'постановка');
  if (!product) {
    rows.push('Постановка ещё не сохранена.', '');
    return rows.join('\n');
  }
  const content = product.content;
  rows.push(
    `Версия ${product.number} · ${names[product.status]} · ${product.createdAt}`,
    '',
    `Причина версии: ${line(product.reason)}`,
    ...(product.decision
      ? [
          '',
          `Решение пользователя ${product.decision.at}: ${line(product.decision.comment) || 'без замечаний'}`,
        ]
      : []),
    '',
    '## Проблема',
    '',
    content.problem,
    '',
    '## Ожидаемый результат',
    '',
    content.outcome,
    '',
    '## Каналы',
    '',
    ...content.channels.map((c) => `- **${line(c.title)}** (\`${c.id}\`) — ${line(c.purpose)}`),
    '',
    '## Релизы',
    '',
    '| Версия | Релиз | Граница объёма |',
    '| --- | --- | --- |',
    ...content.releases.map(
      (r) => `| ${r.version} | ${line(r.title)} (\`${r.id}\`) | ${line(r.goal)} |`,
    ),
    '',
  );
  if (content.personas.length)
    rows.push(
      '## Персоны',
      '',
      ...content.personas.flatMap((persona) => [
        `### ${line(persona.name)} — ${line(persona.role)} (\`${persona.id}\`)`,
        '',
        'Цели:',
        ...persona.goals.map((g) => `- ${line(g)}`),
        '',
        'Боли:',
        ...persona.pains.map((g) => `- ${line(g)}`),
        '',
      ]),
    );
  rows.push('## Фичи', '');
  for (const feature of content.features) {
    rows.push(
      `### ${line(feature.title)} (\`${feature.id}\`)`,
      '',
      feature.outcome,
      '',
      `Каналы: ${feature.channels
        .map((id) => content.channels.find((c) => c.id === id)?.title ?? id)
        .join(', ')}`,
      '',
      'Сценарии:',
      ...feature.scenarios.map((s) => {
        const persona = content.personas.find((x) => x.id === s.personaId);
        return `- ${persona ? '**' + line(persona.name) + '** — ' : ''}${line(s.text)}`;
      }),
      '',
      'Критерии приёмки:',
      ...feature.acceptance.map((a) => {
        const release = content.releases.find((r) => r.id === a.releaseId);
        return `- \`${release?.version ?? a.releaseId}\` ${line(a.text)}`;
      }),
      '',
    );
  }
  rows.push(
    '## За пределами изменения',
    '',
    ...content.exclusions.map((x) => `- ${line(x)}`),
    '',
    '## Материалы',
    '',
    ...content.references.map((x) => `- ${line(x)}`),
    '',
  );
  return rows.join('\n');
}
export function renderArchitecture(change: ProductChange) {
  const architecture = change.architecture.at(-1);
  const rows = header(change, 'архитектура и стек');
  if (!architecture) {
    rows.push('Архитектура прорабатывается после утверждения продуктовой постановки.', '');
    return rows.join('\n');
  }
  const content = architecture.content;
  rows.push(
    `Версия ${architecture.number} · ${names[architecture.status]} · ${architecture.createdAt}`,
    '',
    `Причина версии: ${line(architecture.reason)}`,
    ...(architecture.decision
      ? [
          '',
          `Решение пользователя ${architecture.decision.at}: ${line(architecture.decision.comment) || 'без замечаний'}`,
        ]
      : []),
    '',
    '## Решение',
    '',
    content.summary,
    '',
    '## Стек',
    '',
    '| Область | Выбор | Почему | Альтернативы |',
    '| --- | --- | --- | --- |',
    ...content.stack.map(
      (s) =>
        `| ${line(s.area)} | ${line(s.choice)} | ${line(s.rationale)} | ${line(s.alternatives)} |`,
    ),
    '',
    '## Решения и границы',
    '',
    ...content.decisions.map((d) => `- ${line(d)}`),
    '',
    '## Риски',
    '',
    ...content.risks.map((d) => `- ${line(d)}`),
    '',
    '## Стратегия тестирования',
    '',
    content.testStrategy,
    '',
  );
  const levels: [string, { nodes: unknown; relationships: unknown } | undefined][] = [
    ['C1 · контекст системы', content.c1],
    ['C2 · приложения, сервисы и хранилища', content.c2],
    ...(content.c3 ?? []).map(
      (c3) =>
        [
          'C3 · компоненты контейнера ' +
            (content.c2?.nodes.find((n) => n.id === c3.containerId)?.name ?? c3.containerId),
          c3,
        ] as [string, typeof c3],
    ),
  ];
  for (const [title, value] of levels) {
    const diagram = value as typeof content.c1;
    if (!diagram) continue;
    rows.push(
      `## ${title}`,
      '',
      ...diagram.nodes.map(
        (n) =>
          `- **${line(n.name)}** (\`${n.id}\`, ${n.kind}${n.technology ? ', ' + line(n.technology) : ''}) — ${line(n.description)}`,
      ),
      '',
      ...diagram.relationships.map(
        (r) =>
          `- ${diagram.nodes.find((n) => n.id === r.from)?.name} → ${diagram.nodes.find((n) => n.id === r.to)?.name}: ${line(r.description)}${r.technology ? ' (' + line(r.technology) + ')' : ''}`,
      ),
      '',
    );
  }
  return rows.join('\n');
}
export function renderDesign(change: ProductChange) {
  const design = change.design.at(-1);
  const rows = header(change, 'направление дизайна');
  if (!design) {
    rows.push('Направление дизайна прорабатывается после утверждения архитектуры.', '');
    return rows.join('\n');
  }
  const content = design.content;
  rows.push(
    `Версия ${design.number} · ${names[design.status]} · ${design.createdAt}`,
    '',
    `Причина версии: ${line(design.reason)}`,
    ...(design.decision
      ? [
          '',
          `Решение пользователя ${design.decision.at}: ${line(design.decision.comment) || 'без замечаний'}`,
        ]
      : []),
    '',
  );
  if (!content.applicable) {
    rows.push('## Дизайн не требуется', '', content.reason, '');
    return rows.join('\n');
  }
  rows.push(
    '## Концепция',
    '',
    content.concept,
    '',
    '## Референсы',
    '',
    ...(content.references.length
      ? content.references.map(
          (r) =>
            `- [${r.status === 'accepted' ? 'принят' : r.status === 'rejected' ? 'отклонён' : 'кандидат'}] ${r.url} — ${line(r.takeaway)}`,
        )
      : ['Референсы не собраны.']),
    '',
    '## Общее для всех каналов',
    '',
    ...content.shared.map((x) => `- ${line(x)}`),
    '',
    '## Различия по каналам',
    '',
  );
  for (const item of content.channels)
    rows.push(
      `### ${line(change.product.at(-1)?.content.channels.find((x) => x.id === item.channelId)?.title ?? item.channelId)}`,
      '',
      ...item.notes.map((n) => `- ${line(n)}`),
      '',
    );
  rows.push(
    '## Семантические токены',
    '',
    '| Группа | Имя | Значение | Назначение |',
    '| --- | --- | --- | --- |',
    ...content.tokens.map(
      (x) => `| ${line(x.group)} | ${line(x.name)} | ${line(x.value)} | ${line(x.purpose)} |`,
    ),
    '',
    '## Guidelines',
    '',
    ...content.guidelines.map((x) => `- ${line(x)}`),
    '',
  );
  if (content.prototypes.length)
    rows.push(
      '## Макеты',
      '',
      ...content.prototypes.map((x) => `- [${line(x.title)}](${x.url})`),
      '',
    );
  return rows.join('\n');
}
export function renderChangeJournal(change: ProductChange) {
  const rows = header(change, 'вопросы и решения');
  const questions = change.questions ?? [];
  const decisions = change.decisions ?? [];
  rows.push(
    '## Вопросы пользователю',
    '',
    ...(questions.length
      ? questions.flatMap((q) => [
          `### ${line(q.text)}`,
          '',
          `Статус: ${q.status === 'answered' ? 'отвечено' : q.status === 'open' ? 'ждёт ответа' : 'снят'} · задан ${q.createdAt}`,
          ...(q.why ? ['', `На что влияет: ${line(q.why)}`] : []),
          ...(q.options.length ? ['', `Варианты: ${q.options.map(line).join(' · ')}`] : []),
          ...(q.answer ? ['', `**Ответ ${q.answer.at}:** ${line(q.answer.text)}`] : []),
          '',
        ])
      : ['Открытых вопросов не было.', '']),
    '## Принятые решения',
    '',
    ...(decisions.length
      ? decisions.flatMap((d) => [
          `### ${line(d.statement)}`,
          '',
          line(d.rationale),
          ...(d.questionId
            ? [
                '',
                `По вопросу: ${line(questions.find((q) => q.id === d.questionId)?.text ?? d.questionId)}`,
              ]
            : []),
          '',
        ])
      : ['Решения ещё не зафиксированы.', '']),
    '## История версий',
    '',
    ...(['product', 'architecture', 'design'] as const).flatMap((stage) =>
      change[stage].map(
        (r) =>
          `- ${stage === 'product' ? 'Продукт' : stage === 'architecture' ? 'Архитектура' : 'Дизайн'} v${r.number} · ${names[r.status]} · ${r.createdAt} · ${line(r.reason)}`,
      ),
    ),
    '',
  );
  return rows.join('\n');
}
// The index is the thing a folder listing cannot give: which change is open,
// which is awaiting a decision and which is already approved.
export function renderIndex(changes: ProductChange[]) {
  return [
    '# Изменения продукта',
    '',
    '> Автоматическая проекция состояния. Правьте в панели: ручные изменения будут заменены.',
    '',
    'Каждая папка — одно изменение. `brief.md` пишет человек, остальное проецируется.',
    '',
    '| Ключ | Изменение | Продукт | Архитектура | Создано |',
    '| --- | --- | --- | --- | --- |',
    ...changes.map((c) => {
      const product = c.product.at(-1),
        architecture = c.architecture.at(-1);
      return `| [\`${c.key}\`](./${c.key}/) | ${line(c.title)} | ${product ? 'v' + product.number + ' · ' + names[product.status] : '—'} | ${architecture ? 'v' + architecture.number + ' · ' + names[architecture.status] : '—'} | ${c.createdAt.slice(0, 10)} |`;
    }),
    '',
  ].join('\n');
}
function directory(root: string, ...parts: string[]) {
  let dir = realpathSync(root);
  for (const name of ['docs', 'changes', ...parts]) {
    dir = join(dir, name);
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir))
      throw new Error('Проекция постановки не пишет через symlink');
  }
  return dir;
}
// Skip an identical rewrite: a heartbeat or a progress note must not touch the
// product repository at all, not even its timestamps.
function atomicWrite(destination: string, content: string) {
  if (existsSync(destination) && readFileSync(destination, 'utf8') === content) return;
  const temporary = destination + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, content, { flag: 'wx' });
  renameSync(temporary, destination);
}
// Agent progress notes are runtime telemetry and are left out: they would
// rewrite the files on every heartbeat and dirty the product repository.
export function writeProduct(state: DevContourState, root: string) {
  const changes = state.preparation?.changes ?? [];
  if (!changes.length) return;
  atomicWrite(join(directory(root), 'README.md'), renderIndex(changes));
  for (const change of changes) {
    const dir = directory(root, change.key);
    atomicWrite(join(dir, 'product.md'), renderProduct(change));
    atomicWrite(join(dir, 'architecture.md'), renderArchitecture(change));
    atomicWrite(join(dir, 'design.md'), renderDesign(change));
    atomicWrite(join(dir, 'journal.md'), renderChangeJournal(change));
    const { activity: _activity, ...durable } = change;
    atomicWrite(join(dir, 'change.json'), JSON.stringify(durable, null, 2) + '\n');
    // brief.md is the incoming request in the operator's own words. The
    // projection creates it once and never overwrites it.
    const brief = join(dir, 'brief.md');
    if (!existsSync(brief))
      atomicWrite(
        brief,
        [
          `# ${change.key} · ${line(change.title)} — поручение`,
          '',
          'Исходное поручение своими словами. Этот файл проекция не перезаписывает:',
          'опишите здесь, что и зачем нужно, и на какие разделы ТЗ это опирается.',
          '',
        ].join('\n'),
      );
  }
}
