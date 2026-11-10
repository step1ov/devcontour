// prepublishOnly: предварительная версия (с суффиксом `-…`) публикуется только
// с явной меткой, не `latest`. Без `--tag` npm 11 ставит метку `latest`, и
// `publishConfig.tag` этого не меняет: `npm install devcontour` получил бы
// alpha. Публикация — шаг человека; скрипт только отказывает до неё.
import { readFileSync } from 'node:fs';

const version =
  process.env.npm_package_version ??
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const tag = process.env.npm_config_tag;
if (version.includes('-') && (!tag || tag === 'latest')) {
  console.error(
    `publish-guard: ${version} — предварительная версия; публикуйте с меткой: npm publish --tag alpha`,
  );
  process.exit(1);
}
