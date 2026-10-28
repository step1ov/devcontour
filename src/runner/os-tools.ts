// Те же правила, что у движка (`src/environment/os-tools.ts` devcontour-harness
// 0.1.0-alpha.20): пакет не экспортирует их из публичной точки входа.

/**
 * Окружение утилиты, чей вывод разбирается: даты, числа и сообщения — в
 * локали C при любой локали пользователя. В ru_RU `ps -o lstart=` печатает
 * «среда, 28 октября 2026 г. 16:42:10», и `Date.parse` его не читает. Только
 * LC_CTYPE остаётся пользовательским: в локали C `lsof` экранирует байты
 * не-ASCII путей (`\xd0\xbb…`), и каталог с кириллицей не узнаётся. Поэтому не
 * `LC_ALL=C`: LC_ALL перекрыл бы LC_CTYPE, и его значение переносится в LC_CTYPE.
 */
export function osToolEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { LC_ALL, ...rest } = env;
  const ctype = LC_ALL || env.LC_CTYPE || env.LANG;
  return {
    ...rest,
    LC_TIME: 'C',
    LC_NUMERIC: 'C',
    LC_MESSAGES: 'C',
    ...(ctype ? { LC_CTYPE: ctype } : {}),
  };
}

/**
 * Имя файла из вывода `lsof`: в локали без UTF-8 он экранирует байты вне
 * ASCII как `\xNN`, обратную косую — как `\\`, управляющие — как `\t`, `\n` и
 * т. п. Здесь экранирование снимается, и путь сравним с настоящим.
 */
export function lsofName(name: string): string {
  if (!name.includes('\\')) return name;
  const simple: Record<string, number> = { b: 8, t: 9, n: 10, f: 12, r: 13, '\\': 92 };
  const bytes = name.split(/(\\x[0-9a-fA-F]{2}|\\[btnfr\\])/).flatMap((part, i) => {
    if (i % 2 === 0) return [...Buffer.from(part, 'utf8')];
    return [part[1] === 'x' ? parseInt(part.slice(2), 16) : simple[part[1]]];
  });
  return Buffer.from(bytes).toString('utf8');
}
