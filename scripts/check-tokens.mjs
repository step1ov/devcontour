import { readFile, readdir } from 'node:fs/promises';
const errors = [];
// Строки классов: className="…", className={`…`} (статичная часть и
// литералы внутри ${…}) и литералы в аргументах cn(…)/clsx(…) с любой
// вложенностью скобок. Литерал сравнения (`== 'error'`) и аргумент метода
// (`.includes('active')`) — не класс.
function balanced(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(' || text[i] === '{') depth++;
    else if (text[i] === ')' || text[i] === '}') if (--depth === 0) return text.slice(start + 1, i);
  }
  return '';
}
function* literals(code) {
  for (const m of code.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) {
    const before = code.slice(0, m.index);
    if (/[=!]==?\s*$/.test(before) || /\.\w+\(\s*$/.test(before)) continue;
    yield m[1] ?? m[2];
  }
}
function* classStrings(text) {
  for (const [, value] of text.matchAll(/className="([^"]*)"/g)) yield value;
  for (const m of text.matchAll(/className=\{`([^`]*)`\}/g)) {
    yield m[1].replace(/\$\{[^}]*\}/g, ' ');
    for (const [, expression] of m[1].matchAll(/\$\{([^}]*)\}/g)) yield* literals(expression);
  }
  for (const m of text.matchAll(/\b(?:cn|clsx)\(/g))
    yield* literals(balanced(text, m.index + m[0].length - 1));
}
const deadClasses = new Set([
  'primary',
  'alert',
  'error',
  'icon-button',
  'dot',
  'active',
  'nav-check',
]);
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (path === 'src/web/tokens.css') continue;
    const text = await readFile(path, 'utf8');
    if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i.test(text))
      errors.push(path + ': цветовые литералы допустимы только в tokens.css');
    // Классы удалённой таблицы стилей: CSS для них нет, и элемент молча
    // теряет вид (главная кнопка выглядела второстепенной, ошибка — текстом).
    if (path.endsWith('.tsx'))
      for (const value of classStrings(text)) {
        const dead = value.split(/\s+/).filter((word) => deadClasses.has(word));
        if (dead.length) errors.push(path + ': класс без стилей: ' + dead.join(', '));
      }
  }
}
await scan('src/web');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Semantic color tokens: OK');
