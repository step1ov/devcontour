import { readFile, readdir } from 'node:fs/promises';
const errors = [];
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
      for (const [, value] of text.matchAll(/className="([^"]*)"/g)) {
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
