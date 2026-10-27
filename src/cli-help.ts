// Справка CLI. Модуль без зависимостей от хранилища и движка: справку и
// версии вход CLI печатает, не загружая команды.
import { launchHint } from './runner/scope.ts';

export function printHelp() {
  console.log(
    'devcontour start --workspace /absolute/workspace [--workspace-mode embedded|separate] [--port 4317] — при первом запуске явно выберите размещение; панель до выбора стека и создания репозиториев',
  );
  console.log(
    'devcontour profile-show --profile <ID|./file.json> --repository /absolute/repo [--repository-id ID]',
  );
  console.log(
    'devcontour intent-render --file definition.json [--repository-id ID] --workspace ...\ndevcontour intent-snapshot [--repository-id ID] [--story ID] --workspace ...\ndevcontour intent-report --release ID [--repository-id ID] [--require-complete] [--require-accepted] --workspace ...\ndevcontour product-view [--release ID] [--require-accepted] --workspace ...',
  );
  console.log(
    'devcontour engineering-evals [--live --runtime codex|claude --model ID --reviewer-model ID]\ndevcontour eval-compare --baseline report.json --candidate report.json',
  );
  console.log(
    `DevContour · AI-native разработка\nЗапуск: ${launchHint()}\ndevcontour --version | version — версии DevContour и движка devcontour-harness\n\n` +
      'devcontour evals [--live --runtime codex|claude --model MODEL --repetitions 3 --max-calls 18]\ndevcontour metrics [--repository-id main] --workspace ...\ndevcontour requirements-snapshot --repository-id main --file docs/spec.md --workspace ...\ndevcontour requirements-report --repository-id main --workspace ...\ndevcontour requirements-correct --board ID --reason ... --workspace ...\ndevcontour capabilities\ndevcontour mcp --workspace /absolute/workspace\ndevcontour agent --file request.json --workspace /absolute/workspace\n' +
      'devcontour sync [--member alice] [--allow-branch-change] [--resolutions file.json] --workspace ...\ndevcontour sync-status --workspace ...\ndevcontour assign-task --task <id> --member alice --workspace ...\n' +
      'devcontour storage-migrate --workspace ...\ndevcontour backup --out FILE | restore --from FILE --to DIR --workspace ...\ndevcontour doctor [--probe] | doctor --scope data (только совместимость данных) --workspace ...\ndevcontour handoff | remote-check --changeset CHG-1 --workspace ...\ndevcontour preview --changeset CHG-1 | preview-rollback --workspace ... (локальный preview проверенного ChangeSet в Docker)\ndevcontour knowledge-import --source /donor --files README.md,docs/api.md [--ref HEAD] --workspace ...\ndevcontour environment-cleanup --receipt /absolute/receipt/environment.json --workspace ...\nДля нового проекта агент спрашивает абсолютный путь workspace. Все команды принимают --workspace /absolute/path вместо --data.\ndevcontour workspace-init --file /workspace/workspace.json [--data ...]\ndevcontour changeset-create --file changeset.json --data ...\ndevcontour workspace-verify | changeset-accept --changeset CHG-1 --data ...\ndevcontour journal --data ...\ndevcontour context-lock [--ref HEAD] | context-show --task T1 --workspace ...\ndevcontour context-adopt --pack <id> --workspace ... (перейти на версию пакета из библиотеки)\ndevcontour context-sources | context-import --source <id> [--paths a/,b/] (внести чужую библиотеку на закреплённом коммите)\ndevcontour base-update --workspace ... (переносит подготовку рабочей ветки в базу прогонов; очередь на паузе)\ndevcontour resources | resource-release --key <key> --token <token> --cleanup-confirmed --workspace ...\ndevcontour setup --repository /absolute/product --profile <id> --workspace /absolute/workspace [--brief docs/spec.md] [--approval-mode agent|operator]\ndevcontour demo [--port 4317] | serve --workspace /absolute/workspace [--port 4317] [--dev]\ndevcontour init --repository /absolute/repo --data .devcontour-local\ndevcontour run | export | import-plan --file plan.json [--board B1] | doctor --data ...\ndevcontour plan --brief brief.md --runtime codex --data .devcontour-local\ndevcontour review-contract --file contract.json --author-runtime codex|claude --data ...\ndevcontour review-plan [--tasks T1,T2] | accept --board B1 --author-runtime codex|claude --data ...\ndevcontour queue --start | --pause --data ...\ndevcontour reopen --task T1 --reason ... (вернуть в черновик задачу без принятого результата)\ndevcontour retry --task T1 [--reset --reason ...] | edit-task --task T1 --file task.json | edit-board --board B1 [--title ...] [--description ...] | task-feature --task T1 --feature F | cancel --task T1 --reason ... | correct --board B1 --roots T1,T2 --reason ... --data ...',
  );
}
