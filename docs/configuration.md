# Справочник конфигурации

Форматы заданы в `src/core/model.ts`, `integrations.ts`, `runner/config.ts` и `workspace-setup.ts`. JSON-блоки ниже — фрагменты, если не сказано иначе. Не заменяйте ими весь созданный config. Перед изменением политики приостановите очередь, дождитесь попыток и перезапустите сервер после правки.

## Уровни и файлы

| Файл                                        | Назначение                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `<workspace>/workspace.json`                | Входной реестр для первичного `workspace-init`; относительные пути разрешаются от него   |
| `<workspace>/.harness/local/config.json`    | Рабочая общая конфигурация, которую CLI/server загружают при старте                      |
| `<repo>/harness.component.json`             | Настройки конкретного компонента, подключаемые через `configFile`; следует хранить в Git |
| `<data>/packs.lock.json`                    | Версии и digests установленных stack profiles                                            |
| `<repo>/.agents/`, `AGENTS.md`, `CLAUDE.md` | Читаемые человеком и агентом правила; выбранные файлы закрепляются context packs         |

`workspace.json` — не автоматически синхронизируемый control plane. Повторный `workspace-init` сохраняет имеющуюся конфигурацию того же набора ID/путей. Правка исходного реестра сама по себе не меняет уже работающий сервер.

В component mode coordinator хранит ссылки `{id, path, dependsOn, configFile}`. При загрузке содержимое component config переопределяет локальные настройки, но `id`, `path`, `dependsOn` и `configFile` берутся из общей записи. Так глобальная топология остаётся согласованной, а команды/роли живут рядом с кодом.

`setup --workspace`/`workspace-init` выбирают component storage. Default самой схемы — central для совместимости старых конфигураций. Не переключайте действующее хранилище одним полем: для central → component используется `storage-migrate`.

## Общая политика

| Поле                 | Default схемы                                | Смысл                                                                 |
| -------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `version`            | Обязательно `1`                              | Версия поддерживаемого формата                                        |
| `name`, `repository` | Обязательны                                  | Имя и основной Git root; без repositories образует компонент `main`   |
| `workspaceRoot`      | Не задан                                     | Канонический путь общей координации                                   |
| `mode`               | `local`                                      | `demo` допускает детерминированные runtime                            |
| `approvalMode`       | `agent`                                      | Кто подтверждает этапы: агент или оператор                            |
| `completionMode`     | `local`                                      | Нужна ли подтверждённая remote Delivery для ChangeSet acceptance      |
| `storage`            | `central`                                    | Физическое размещение состояния; новые workspace выбирают `component` |
| `targetBranch`       | `harness/accepted`                           | Локальная интеграционная ветка; имя должно начинаться `harness/`      |
| `concurrency`        | `2`, диапазон 1–4                            | Число одновременно выданных попыток; mobile profile задаёт 1          |
| `leaseMs`            | `30000`, минимум 5000                        | Время владения, продлеваемое heartbeat                                |
| `runTimeoutMs`       | `900000`, минимум 1000                       | Общий deadline попытки/операции runner; включает ожидание ресурсов    |
| `maxAttempts`        | `3`, диапазон 1–10                           | Ограничение повторов Task и числа Verification конкретного ChangeSet  |
| `verificationMode`   | `all`                                        | Полный набор совместных gates либо явная оптимизация `affected`       |
| `resourceDatabase`   | `~/.harness/resources.sqlite` при исполнении | Общий pool хоста; переопределение требует абсолютный путь             |

Schema defaults и выбранный профиль — разные уровни. Например, `protectedPaths` в generated setup шире default схемы; чтение одного model.ts не показывает готовую политику продукта. `doctor` проверяет загруженную конфигурацию.

## Компоненты и роли

Компонент задаёт `id`, `name`, `kind: product|library`, `path`, `targetBranch`, `gates`, `protectedPaths`. Дополнительно: `roles`, `reviewer`, `generatedPaths`, `environment`, `prepare`, `preflight`, `lifecycle`, `dependencyBuild`, `dependencyArtifacts`, `forge`. Состав `dependsOn` принадлежит registry и описывает прямые входные компоненты.

В общей `roles` нужны все четыре ключа: architect/backend/frontend/qa. В компоненте разрешено частичное переопределение. Выбор binding роли: `repository.roles[role]`, иначе `config.roles[role]`. Выбор reviewer: reviewer выбранного role binding, иначе repository reviewer, иначе общий reviewer. Объект binding заменяется целиком; поля глобального binding не сливаются по одному.

```json
{
  "roles": {
    "frontend": {
      "runtime": "codex",
      "writePaths": ["src/ui/", "tests/ui/"],
      "reviewer": { "runtime": "claude" }
    }
  }
}
```

Это фрагмент **component config**. В global config остальные три роли тоже обязательны. `model` необязателен: если он отсутствует, выбор остаётся у CLI. `toolProfile` выбирает именованный профиль инструментов. Одинаковый runtime исполнителя и reviewer в local mode запрещён; разные model names не меняют это правило.

`writePaths` задачи и роли задают допустимые пути/префиксы; разрешённая область — их пересечение, если заданы оба. Это не glob: `src/ui/` подходит, `src/**/*.tsx` — нет. Protected paths, исходники context packs и generatedPaths исключаются дополнительно. Такой контроль проверяет принимаемый diff, не является OS sandbox.

## Gates

```json
{
  "gates": [
    { "id": "types", "kind": "check", "command": ["npm", "run", "typecheck"] },
    {
      "id": "tests",
      "kind": "test",
      "dependsOn": ["types"],
      "command": ["npm", "run", "test:harness"],
      "timeoutMs": 240000,
      "report": { "type": "junit", "path": ".reports/junit.xml" }
    }
  ]
}
```

| Поле          | Правило                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `id`          | Уникален внутри набора gates                                                            |
| `kind`        | `check` — команда проверки; `test` — тест с обязательным JUnit                          |
| `command`     | Непустой массив executable/argv; переменные и `&&` не раскрываются shell автоматически  |
| `dependsOn`   | IDs внутри этого набора; циклы и неизвестные IDs запрещены                              |
| `cwd`         | Относительный каталог внутри worktree; default — корень                                 |
| `timeoutMs`   | Default 120000; deadline этой команды                                                   |
| `report.path` | Путь относительно **корня worktree**, независимо от cwd; отчёт предварительно удаляется |
| `resources`   | IDs объявленных host resources                                                          |

В каждом локальном наборе нужен test gate. Workspace gate дополнительно имеет `repositoryId` и `artifacts`: файлы, хеши которых сохраняются как часть доказательства. Их пути также относительны корню компонента. Совместная конфигурация должна покрывать интеграционным test gate каждый продукт.

Граф задаёт порядок, а не параллельный запуск gates: текущий runner выполняет их последовательно в топологическом порядке. Без dependsOn сохраняется порядок массива. Все локальные gates повторяются для candidate и integration SHA.

`prepare` — команды подготовки до реализации/проверок, `preflight` — probes doctor, `dependencyBuild` — сборка закреплённых входных библиотек. Их step имеет `id`, `command`, `timeoutMs` (default 120000, максимум 3600000). Не маркируйте установку зависимостей как выполненный тест.

## Окружение и lifecycle

```json
{
  "environment": {
    "inherit": ["NODE_EXTRA_CA_CERTS"],
    "values": { "APP_ENV": "test" },
    "secrets": { "NPM_TOKEN": "PRIVATE_REGISTRY_READ_TOKEN" }
  },
  "lifecycle": {
    "setup": [{ "id": "start", "command": ["node", "scripts/test-env.mjs", "start"] }],
    "ready": [{ "id": "ready", "command": ["node", "scripts/test-env.mjs", "ready"] }],
    "teardown": [{ "id": "stop", "command": ["node", "scripts/test-env.mjs", "stop"] }]
  }
}
```

Базовые PATH/HOME/TMPDIR/CI дополняются явно перечисленными переменными. `secrets` хранит отображение целевого имени в имя переменной процесса; значений секретов в JSON нет. Отсутствие заявленного inherit/secret — ошибка. HARNESS_* зарезервированы. Tool profile может дополнить среду вызова runtime; настройки агента в открытом диалоге не копируются в worker автоматически.

Lifecycle требует хотя бы один teardown step; setup/ready могут быть пустыми. Команды start должны завершаться после запуска управляемого сервиса, а не оставаться бесконечным foreground-процессом. Teardown должен быть повторяемым и безопасным после частичного setup. Для общей проверки используется `workspaceLifecycle`.

Подробные примеры MCP, приватных зависимостей и Postgres — в [интеграции](project-integration.md). Установка сервиса, миграции, seed и проверка готовности реализуются проектными скриптами, а не автоматически из имени поля.

## Переменные runner

| Переменная                  | Где используется                                                |
| --------------------------- | --------------------------------------------------------------- |
| `HARNESS_RUN_ID`            | Идентификатор попытки/совместной проверки для изоляции ресурсов |
| `HARNESS_REPOSITORY_ID`     | ID компонента task run                                          |
| `HARNESS_TASK_ID`           | В task run; в workspace-проверке отдельной Task нет             |
| `HARNESS_PHASE`             | Фаза окружения/проверки                                         |
| `HARNESS_REPORT_PATH`       | Абсолютный путь отчёта текущего test gate                       |
| `HARNESS_COMPONENTS_JSON`   | JSON-map компонентов в закреплённые рабочие каталоги            |
| `HARNESS_DEPENDENCIES_JSON` | Snapshots входных библиотек Task: версии и артефакты            |
| `HARNESS_CHANGESET_ID`      | Общая проверка ChangeSet                                        |
| `HARNESS_MANIFEST_PATH`     | Manifest совместной комбинации                                  |
| `HARNESS_RESOURCES_JSON`    | Выделенные ресурсы, их адреса/идентификаторы                    |

Не предполагается, что каждая переменная присутствует у любой команды. Скрипт должен явно требовать нужный контекст и завершаться понятной ошибкой при его отсутствии. Парсите JSON, не извлекайте пути поиском подстрок.

## Context, profiles и forge

`contextPacks`: `id`, `version`, `repositoryId`, `roles`, `files`, затем закреплённые `revision` и `digest`. Пустые roles означают только явное включение через Task.contextPacks. `context-lock` читает коммиты, не незакоммиченные файлы. [Подробности](engineering-context.md).

`toolProfiles` описывает runtime, environment, MCP servers и capability settings. Claude: `claudeTools`/`claudeAllowedTools`; Codex: `codexShell`/`codexNetwork`. MCP transport — stdio с command/args/env либо http с url/bearerTokenEnv; `tools` — явный allowlist. Имена инструментов сверяются с конкретным сервером. Встроенный reviewer остаётся read-only; права серверов MCP тоже должны быть ограничены.

`forgeConnections` — общие подключения `gitlab | github | command`. `repository.forge` — connection, project, remote, удалённая targetBranch и requiredChecks. Не путайте её с локальной `repository.targetBranch: harness/accepted`. Настройка `completionMode: remote` требует полного рабочего пути проверки Delivery; одного URL GitLab недостаточно.

## Безопасное изменение политики

Зафиксируйте причину, выполните паузу/остановку и сохраните прежнюю конфигурацию. Адаптируйте локальные файлы правил и Git-коммит, затем context-lock при необходимости. После проверки config/doctor перезапустите сервер. Попытки и Verification связаны с policy digest: старый PASS нельзя переиспользовать для изменённого договора только потому, что код остался прежним.

При обновлении профиля сравниваются manifest, версия и lock. В MVP нет автоматических миграций stack profiles и разрешения конфликтов capabilities. Изменения существующей принятой истории через новую конфигурацию не выполняются.
