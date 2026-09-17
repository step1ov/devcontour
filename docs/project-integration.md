# Подключение существующих проектов и библиотек

DevContour остаётся единственным scheduler. Правила, роли, подробные задачи, попытки и журнал каждого компонента находятся в его репозитории. Workspace хранит координацию, общие контракты, межпроектные задачи, ссылки на локальные записи и результаты совместной проверки. Веб-интерфейс собирает представление из этих баз.

## Размещение данных

```text
chat-workspace/
  workspace.json
  docs/spec.md
  docs/decisions/                 # общие решения
  docs/journal/CHG-*.md           # межпроектный результат, версии и проверки
  .harness/local/
    config.json                  # общая политика и ссылки на component config
    state.sqlite                 # координация; без тел локальных задач
    workspace-checks/            # совместные проверки
    handoffs/                    # инструкции ручной публикации
chat-backend/
  harness.component.json         # gates, окружение, роли и модели компонента
  AGENTS.md
  .agents/roles/
  memory/
  .harness/local/
    state.sqlite                 # задачи, попытки, события, исторические снимки
    worktrees/
    artifacts/
    dependencies/                # закреплённые входные зависимости этой попытки
  .harness/journal/activity.md    # автоматически собранный местный журнал
chat-admin/                      # та же структура
```

`harness.component.json` и инструкции следует коммитить. `.harness/` исключается из Git. Дневник — проекция базы; библиотечный CHANGELOG и устойчивые решения обновляются отдельно в самой библиотеке. Старый оркестратор используется только как донор, его scheduler не запускается.

Новые `setup --workspace` и `workspace-init` используют `storage: "component"`. Локальные роли переопределяют общие: например, библиотека может использовать Claude для backend и Codex для ревью, другая библиотека — обратную пару. Профили доступа к общим инструментам описываются в `toolProfiles`; роли компонента выбирают их по `toolProfile`.

Локальная задача имеет `scope: "component"` (по умолчанию) и `repositoryId`. Для общей задачи укажите `scope: "workspace"`, `relatedRepositories` минимум из двух компонентов и `repositoryId` компонента, в котором выполняется интеграционная работа. Это не разрешает одному исполнителю менять несколько репозиториев. Изменения каждого компонента остаются отдельными зависимыми задачами.

Локальную доску можно явно создать с `repositoryId`; она не принимает чужие задачи. Для прежних досок область выводится по составу задач. Контракт с `repositoryId` локален; без него — общий. Контракт другого компонента нельзя использовать как межпроектный интерфейс: такой интерфейс оформляется общим контрактом.

## Почему граф остаётся целостным

Один локальный controller соединяет базы через SQLite ATTACH. Транзакция меняет записи и события в нужных базах; в координаторе остаются IDs и ссылки. Исторические снимки локальных задач также хранятся в компоненте. Для атомарности нескольких файлов используются rollback journal (`DELETE`) и `synchronous=FULL`, а не WAL. SQLite описывает это условие в [ATTACH DATABASE](https://www.sqlite.org/lang_attach.html).

Текущая реализация поддерживает до 10 компонентов на одном хосте. Это не федерация автономных контроллеров. База компонента закрепляется за одним coordinator; прямой запуск обычного Store против её файла отклоняется. Отдельные агенты библиотеки работают под общим scheduler, в собственных worktree библиотеки. Самовольный перенос базы или смена ID блокируется.

Для существующего workspace с прежней общей БД:

```sh
npm run devcontour -- queue --pause --workspace /absolute/workspace
# Остановить сервер и дождаться завершения/отмены активных попыток.
npm run devcontour -- storage-migrate --workspace /absolute/workspace
```

Миграция переносит записи, события и исторические snapshots одной SQLite-транзакцией, очищает страницы прежней БД и сохраняет IDs. Конфигурация получает ссылки на файлы в компонентах. Исторические worktree/логи прежней версии сохраняют свои прежние пути; новые попытки создаются внутри компонентов. Отдельная самостоятельная база библиотеки с уже существующими задачами не присоединяется автоматически: нужна сверка владельца и IDs.

## Проверка готовности

```sh
npm run devcontour -- doctor --workspace /absolute/workspace
npm run devcontour -- doctor --probe --workspace /absolute/workspace
```

Первый режим проверяет конфигурацию, графы, CLI, Git, переменные, закреплённый контекст и незавершённую очистку. `--probe` дополнительно выполняет настроенные `preflight` компонента в отдельном worktree и read-only запрос к forge. Очередь должна быть остановлена. Пример части `harness.component.json`:

```json
{
  "preflight": [
    { "id": "private-dependencies", "command": ["npm", "ci"], "timeoutMs": 240000 },
    { "id": "mcp-access", "command": ["node", "scripts/probe-readonly-tools.mjs"] }
  ]
}
```

Скрипты реализует ведущий агент по реальному проекту. `ready` означает отсутствие обнаруженных блокеров только в указанном `scope`; `not-checked` остаётся видимым. Doctor не вызывает модели, не доказывает их авторизацию, не заменяет тесты продукта и не утверждает, что MCP-соединение проверено одним лишь наличием исполняемого файла.

## Окружение и доступ к инструментам

Настройки `environment` доступны на уровне workspace, компонента и tool profile. Базовое окружение команд содержит PATH, HOME, TMPDIR и CI. Переменные добавляются явно:

```json
{
  "environment": {
    "inherit": ["NODE_EXTRA_CA_CERTS"],
    "values": { "APP_ENV": "test" },
    "secrets": { "NPM_TOKEN": "CORPORATE_NPM_READ_TOKEN" }
  }
}
```

`inherit` и `secrets` обязательны, если перечислены: отсутствие значения блокирует запуск. В конфигурации хранятся имена источников, значения берутся из окружения процесса. Известные секреты и унаследованные значения маскируются в выводах runner. Маскирование не заменяет правило не печатать секреты. Авторизация CLI через штатные файлы в HOME сохраняется; env-авторизацию нужно перечислить явно. HARNESS_* зарезервированы runner.

Пример Claude-профиля для чтения GitLab через уже настроенный HTTP MCP:

```json
{
  "toolProfiles": {
    "claude": {
      "runtime": "claude",
      "claudeTools": ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
      "claudeAllowedTools": ["Bash(npm run test:*)"],
      "mcp": {
        "corporate_gitlab": {
          "transport": "http",
          "url": "https://mcp.example.internal/mcp",
          "bearerTokenEnv": "GITLAB_MCP_READ_TOKEN",
          "tools": ["get_project", "get_merge_request"]
        }
      }
    }
  }
}
```

URL и имена MCP tools — примеры, их нужно сверить с вашим сервером. `stdio` использует `command`, `args`, `env` (имена переменных), `tools`. В Claude передаются явный MCP config и разрешённые инструменты; reviewer сохраняет только Read/Glob/Grep из встроенных инструментов. В Codex — `enabled_tools`, `codexShell`, `codexNetwork` и `--ignore-user-config` для явно выбранного профиля. Поэтому нестандартную конфигурацию провайдера нужно проверить отдельно; managed/project policies CLI продолжают действовать. Никаких bypass-permissions DevContour не включает.

Профили по умолчанию ищутся по ключам `claude`, `codex`, `claude-review`, `codex-review`. Роль/её reviewer могут выбрать другой ключ через `toolProfile`. Доступы MCP исполнителя не появляются автоматически из текущего чата ведущего агента.

Флаги сверены с локальными CLI и документацией: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude CLI](https://code.claude.com/docs/en/cli-reference). Реальные provider-вызовы проверяются отдельным пилотом.

## Неопубликованные зависимости

`dependsOn` компонента задаёт его входные библиотеки. Task `dependsOn` задаёт порядок работ: если потребителю нужна новая версия библиотеки, его задача зависит от задачи этой библиотеки.

В начале попытки runner создаёт detached snapshots транзитивных зависимостей, фиксирует SHA/tree и запускает их `dependencyBuild` в порядке графа. `dependencyArtifacts` фиксируют хеши файлов результата. Исходники и артефакты перепроверяются; их изменение блокирует приёмку. Новые upstream-коммиты не меняют уже выданный snapshot: актуальная совместная комбинация проверяется отдельным ChangeSet.

```json
{
  "dependencyBuild": [{ "id": "pack", "command": ["node", "scripts/pack-for-harness.mjs"] }],
  "dependencyArtifacts": [".reports/library.tgz"]
}
```

Потребитель получает HARNESS_COMPONENTS_JSON (пути компонентов) и HARNESS_DEPENDENCIES_JSON (SHA/tree/хеши артефактов). Его `prepare` запускается до реализации/проверок кандидата и отдельно перед проверками интеграционного коммита:

```json
{
  "prepare": [
    { "id": "install-pinned-libraries", "command": ["node", "scripts/prepare-harness.mjs"] }
  ]
}
```

Скрипт устанавливает зафиксированные зависимости в воспроизводимое окружение. Не оставляйте после него gate `npm ci`, который снова заменит библиотеку старой Registry-версией. Не меняйте tracked lockfile во время проверки: обновление зависимостей оформляется изменением исходников. Точные команды зависят от npm/pnpm/Go и структуры проекта; DevContour не навязывает один package manager.

## PostgreSQL и другие тестовые сервисы

В компоненте задаётся `lifecycle`, для совместных проверок — `workspaceLifecycle`:

```json
{
  "lifecycle": {
    "setup": [{ "id": "start", "command": ["node", "scripts/test-env.mjs", "start"] }],
    "ready": [{ "id": "ready", "command": ["node", "scripts/test-env.mjs", "ready"] }],
    "teardown": [{ "id": "stop", "command": ["node", "scripts/test-env.mjs", "stop"] }]
  }
}
```

Скрипт создаёт изолированную БД/контейнер по HARNESS_RUN_ID и HARNESS_PHASE, применяет миграции, seed и проверяет готовность. Он должен завершаться, оставляя управляемый сервис (например, detached container), и иметь повторяемую очистку. Для workspace доступны HARNESS_COMPONENTS_JSON и HARNESS_MANIFEST_PATH; cwd — первый компонент реестра.

Teardown запускается после успеха, ошибки setup/ready, ошибки проверки и отмены. У него собственный deadline. Ошибка очистки блокирует приёмку и сохраняет ресурсные аренды; повторно выдавать такой ресурс нельзя. После аварии сохраняется environment.json с владельцем и параметрами.

Восстановление: остановить оставшийся процесс владельца и очередь, проверить окружение, выполнить `environment-cleanup --receipt /absolute/environment.json --workspace ...`, затем освободить оставшиеся host leases штатной `resource-release --cleanup-confirmed`. Изменение политики cleanup требует отдельной сверки. Жёсткое выключение хоста не может выполнить finally; это покрывается сохранённым receipt и явным восстановлением.

## GitLab, GitHub и ручная публикация

Forge отвечает за чтение удалённых фактов. Доступны GitLab, GitHub (включая enterprise API URL) и расширение `command`. Встроенные адаптеры выполняют только GET. GitLab MCP может оставаться read-only; push, PR/MR, merge и выпуск пакетов выполняет человек своим процессом.

Пример общей конфигурации:

```json
{
  "completionMode": "remote",
  "forgeConnections": {
    "corporate": {
      "provider": "gitlab",
      "url": "https://gitlab.example.internal",
      "tokenEnv": "GITLAB_READ_TOKEN"
    },
    "github": {
      "provider": "github",
      "url": "https://api.github.com",
      "tokenEnv": "GITHUB_READ_TOKEN"
    }
  }
}
```

Пример в `harness.component.json`:

```json
{
  "forge": {
    "connection": "corporate",
    "project": "group/chat-library",
    "remote": "origin",
    "targetBranch": "main",
    "requiredChecks": ["pipeline"]
  }
}
```

Для GitHub `project` имеет вид `owner/repository`; `requiredChecks` — имена checks/status contexts. Требуется хотя бы один успешный check на итоговом merge SHA; отсутствие/ожидание/failure/skipped не считаются успехом. Для GitLab читается pipeline целевой ветки на итоговом SHA; при необходимости — его jobs. Список сверх 100 записей блокируется явно; для такой инсталляции нужен адаптер с пагинацией.

```sh
npm run devcontour -- workspace-verify --changeset CHG-12 --workspace /absolute/workspace
npm run devcontour -- handoff --changeset CHG-12 --workspace /absolute/workspace
# Человек выполняет подготовленные команды и свой процесс PR/MR/merge.
npm run devcontour -- remote-check --changeset CHG-12 --workspace /absolute/workspace
npm run devcontour -- changeset-accept --changeset CHG-12 --author-runtime codex --workspace /absolute/workspace
```

Handoff сохраняет JSON/Markdown с точными SHA, ветками и командами push в `<workspace>/.harness/local/handoffs/`. Команды не исполняются. Повтор использует тот же идентификатор. Remote-check — один ограниченный запрос состояния; это не фоновая подписка.

Проверяется source SHA, факт merge, наличие merge-коммита в целевой ветке через read-only fetch, совпадение дерева с локально проверенным результатом и CI на итоговом SHA. Merge/squash могут изменить SHA при сохранении дерева; если дерево изменилось, требуется новая проверка результата. Приёмка фиксирует историческую комбинацию, не обещает атомарный merge нескольких репозиториев. Пакеты автоматически не публикуются; версия потребителя должна проходить отдельную проверку установки из реестра, если это критерий выпуска.

В этой версии remote-режим требует подтверждения PR/MR и CI для каждого компонента manifest. Повторное использование удалённой приёмки неизменённых библиотек ещё не автоматизировано; для такого процесса нужен проектный read-only command adapter, подтверждающий уже интегрированный SHA, либо локальная приёмка и отдельная проверка выпуска.

`completionMode: "local"` сохраняет прежний локальный цикл. `remote` не позволяет принять ChangeSet, пока факты публикации не подтверждены. Локальный статус задачи в UI подписан «Проверена локально». Согласования этапов по умолчанию выполняет агент; ручная публикация — отдельная явно выбранная ответственность человека.

Для другого forge/MCP задайте connection `{ "provider": "command", "probe": { "id": "read-remote", "command": ["node", "scripts/forge-readonly.mjs"] } }`. Скрипт получает HARNESS_FORGE_REQUEST, обращается к разрешённым read-only инструментам и возвращает JSON по `observationSchema` из `src/runner/forge.ts`. Он является доверенным адаптером, как проектный test runner: его исходники и разрешения должны быть проверены. Непроверенный текст от модели не подменяет такой адаптер.

## Донор знаний

```sh
npm run devcontour -- knowledge-import --source /absolute/old-orchestrator --files README.md,docs/api.md --workspace /absolute/workspace
```

Импорт читает выбранные закоммиченные Markdown/text-файлы, фиксирует source SHA и digest, сохраняет их в docs/donors со статусом unreviewed. Команды донора не исполняются. Ведущий агент сверяет сведения с текущим кодом, переносит библиотечные правила в саму библиотеку, общие решения — в workspace, коммитит утверждённые инструкции и выполняет context-lock. Уже изменённый импортированный документ не перезаписывается.
