# CLI и локальное API

## Первый запуск и размещение

[Готовые примеры с опциями и поручениями агенту](start-examples.md).

`start --workspace-mode embedded --workspace /absolute/product --port 0` открывает панель внутри одного репозитория. `start --workspace-mode separate --workspace /absolute/workspace --port 0` использует отдельную папку. Первый выбор обязателен; последующие команды читают сохранённый `devcontour.workspace.json`. Без режима/пути CLI объясняет, что уточнить у пользователя. [Границы режимов](workspace-modes.md). Смена размещения существующей памяти не выполняется флагом.

## Просмотр профиля до настройки workspace

```sh
devcontour profile-show --repository /absolute/product --profile ./profiles/service.json
```

Без выполнения команд возвращает resolved (проверки и источники состава), metadata (запись config.packs), pin (запись packs.lock.json). Для компонента с другим ID задайте --repository-id. Допускается встроенный ID вместо пути. Workspace не требуется: владелец файлов задан через --repository. Тот же профиль принимает setup/init --profile или поле profile в workspace-init registry. [Правила состава и обновления](mcp-and-profiles.md).

Из исходников команды вызываются через npm; [установленный пакет](distribution.md) предоставляет executable `devcontour`. Глобальная установка для работы не нужна:

```sh
npm run devcontour -- help
npm run devcontour -- COMMAND --workspace /absolute/product-workspace
```

`COMMAND` и условные IDs заменяются фактическими значениями. `--workspace` разрешается в `<workspace>/.devcontour-local`; альтернативный `--data` указывает папку с `config.json` напрямую. Их нельзя передавать вместе. Для старой конфигурации без workspaceRoot используйте `--data`.

CLI не задаёт интерактивный вопрос о workspace: это обязанность ведущего агента. Без выбранного контекста продуктовая команда завершается ошибкой. `demo` — отдельная явная команда с собственными данными.

## Подготовка

| Команда            | Параметры                                                                                           | Результат / эффект                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `setup`            | `--repository ABS --profile ID`, опционально `--brief docs/spec.md --approval-mode agent\|operator` | Копирует недостающие правила/документы и конфигурацию; возвращает `needs-agent-bootstrap`; существующие файлы сохраняются |
| `init`             | `--repository ABS`, опционально `--profile ID --approval-mode ...`                                  | Низкоуровневая конфигурация существующего Git-репозитория; не переносит полный набор правил                               |
| `workspace-init`   | `--file ABS/workspace.json`                                                                         | Создаёт общий config по registry; workspace определяется папкой файла; повтор сохраняет имеющееся состояние               |
| `doctor`           | опционально `--probe`                                                                               | Проверяет готовность; probe дополнительно запускает настроенный preflight и read-only forge-доступ                        |
| `context-lock`     | опционально `--ref HEAD`                                                                            | Закрепляет Git revision/digest пакетов инструкций, меняет config; требует паузу и отсутствие активных работ               |
| `context-show`     | `--task T12`                                                                                        | Показывает выбранный контекст задачи                                                                                      |
| `knowledge-import` | `--source ABS --files README.md,docs/api.md`, опционально `--ref HEAD`                              | Копирует выбранные committed документы как непроверенные знания с происхождением/digest                                   |
| `storage-migrate`  | выбранный workspace/data                                                                            | Мигрирует central storage в component; требует остановки работы и резервной копии                                         |

`--brief` у setup — Markdown внутри docs продукта. У `plan` это путь читаемого файла относительно cwd команды либо абсолютный путь. Не путайте эти правила разрешения путей.

Setup не вызывает модель, не устанавливает зависимости продукта и не запускает сервер. `workspace-init` не является автоматическим обновлением рабочего config. Подготовительные действия описаны в [пошаговом сценарии](manual-workflow.md).

## План и контракты

Карта продукта: `intent-render --file definition.json [--repository-id ID]` выводит Markdown без записи; `intent-snapshot [--repository-id ID] [--story ID]` читает committed-карту; `intent-report --release ID [--repository-id ID] [--require-complete]` возвращает JSON покрытия. Всем нужен явный --workspace/--data. Без repositoryId выбирается общий workspace. require-complete задаёт exit 1 при неполном покрытии. Точная структура и безопасная замена документа — [INTENT](intent.md).

| Команда           | Параметры                                                          | Результат / эффект                                                                                    |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `plan`            | `--brief FILE --runtime codex\|claude`, опционально `--model NAME` | Вызывает модель, сохраняет и импортирует новый черновой план                                          |
| `import-plan`     | `--file FILE`                                                      | Импортирует готовый JSON, создаёт новую доску и draft-задачи                                          |
| `edit-task`       | `--task ID --file FILE`                                            | Меняет допустимый черновик с проверкой digest; передавайте полный TaskInput без служебных полей       |
| `base-update`     | —                                                                  | Переносит подготовку рабочей ветки в базу прогонов: перемотка либо слияние. Требует паузы очереди |
| `review-contract` | `--file FILE --author-runtime codex\|claude`                       | Независимое review предложения; при agent mode регистрирует контракт, при operator ждёт подтверждения |
| `review-plan`     | `--board ID --author-runtime codex\|claude`                        | Проверяет текущий план и утверждает черновики по политике                                             |

Предложение контракта ссылается на файл в репозитории: `{"title": "...", "file": "docs/contracts/load-engine.md"}`. Содержимое читается из дерева в момент ревью, поэтому рецензент и реестр видят одну и ту же редакцию, а принятый digest относится к файлу, а не к чьей-то копии. Путь сохраняется в `Contract.source`. Inline-поле `content` остаётся для предложений, у которых файла ещё нет; указывать оба сразу нельзя.

`--author-runtime` обозначает фактического автора предложения, не произвольный выбор reviewer. Review выбирает другой runtime. Команды review вызывают модель и расходуют её лимиты. Точное совпадение уже утверждённого контракта может вернуть `already-approved`.

Файл contract proposal содержит `title`, `content`, опционально `repositoryId`. Отсутствие repositoryId означает общий контракт. Plan содержит `title`, `description`, `tasks` (1–30), у каждой задачи — локальный `key`, роль, description, acceptance, contracts, dependsOn и при необходимости repositoryId/scope/context/writePaths/resources. `dependsOn` принимает ключ из этого плана либо существующий Task ID. Пример: [example-plan.json](../packs/example-plan.json).

Возвращённые B/T/C/CHG IDs нужно читать из результата; значения `B1`, `T12`, `CHG-12` в документации условны. Повторный import не является idempotent-обновлением существующей доски.

## Выполнение и приёмка

| Команда            | Параметры                                       | Результат / эффект                                                                                 |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `serve`            | опционально `--port 4317 --dev`                 | Долго работающий локальный HTTP server и scheduler                                                 |
| `run`              | выбранный контекст                              | Включает очередь, исполняет доступную работу до исчерпания текущей выдачи, останавливает scheduler |
| `queue`            | ровно один из `--start`, `--pause`              | Меняет режим выдачи; отдельный scheduler этой командой не запускается                              |
| `retry`            | `--task ID`                                     | Возвращает failed/cancelled задачу в допустимое состояние, сохраняя историю; действует maxAttempts |
| `accept`           | `--board ID --author-runtime codex\|claude`     | Принимает завершённую ревизию по политике; проверяет присутствие result SHA                        |
| `correct`          | `--board ID --roots T1,T2 --reason TEXT`        | Новая ревизия принятой доски и заменяющие draft-задачи                                             |
| `changeset-create` | `--file FILE`                                   | Новый общий результат из boardIds, опционально supersedes                                          |
| `workspace-verify` | `--changeset ID`                                | Выполняет совместные gates на manifest компонентов                                                 |
| `changeset-accept` | `--changeset ID --author-runtime codex\|claude` | Принимает успешную Verification, при remote mode требует Delivery                                  |

`run` не утверждает черновики и не выполняет весь продукт автоматически. Его успешный exit сам по себе не доказывает, что не осталось draft/blocked задач или непринятых досок. Проверяйте итоговое состояние и порученный объём.

`accept`/`changeset-accept` не создают ещё один LLM-review готового отчёта. Они применяют доменные условия к уже полученным доказательствам. При `approvalMode: operator` агентский вызов возвращает `awaiting-operator`; оператор подтверждает в UI. Статус такого ответа нужно обработать, а не читать любой exit 0 как приёмку.

## Требования, продолжение этапов и измерения

| Команда                 | Параметры                                                  | Результат                                                 |
| ----------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `requirements-snapshot` | `--repository-id main --file docs/spec.md`                 | Разделы REQ из committed HEAD с digest                    |
| `requirements-report`   | `--repository-id main`                                     | Связи требований и актуальность проверенного покрытия     |
| `requirements-correct`  | `--board ID --reason TEXT`                                 | Draft-ревизия для изменившихся связанных требований       |
| `metrics`               | опционально `--repository-id main`                         | Время стадий, ожидание и все попытки выбранного владельца |
| `evals`                 | опционально `--repetitions N --max-calls N --timeout-ms N` | Изолированный eval протокола без workspace и моделей      |

Первые четыре команды требуют `--workspace` или `--data`. Live-eval отдельно включается флагами `--live --runtime codex|claude --model MODEL`; его ограничения и интерпретация — в [evals](agent-evals.md).

`workflow_start`, `workflow_status`, `workflow_retry`, `signal_ingest` и `signal_status` вызываются через MCP, HTTP `/api/agent` или CLI `agent --file request.json --workspace ...`. Файл содержит `{ "operation": "workflow_status", "input": { "repositoryId": "main" } }`. Форматы входа берутся из `capabilities`; процедура описана в [workflow](lead-workflow.md) и [сигналах](external-signals.md). Регистрация workflow не запускает отдельный daemon: его продвигает работающий `serve`.

## Публикация и обслуживание

| Команда               | Параметры                                     | Результат / эффект                                                                      |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `handoff`             | `--changeset ID`                              | Сохраняет JSON/Markdown с точными версиями и инструкциями человеку; push не выполняется |
| `remote-check`        | `--changeset ID`                              | Одно наблюдение merge/CI с проверкой SHA/tree; может вернуть ожидание                   |
| `journal`             | выбранный контекст                            | Перестраивает автоматические Markdown-дневники из БД                                    |
| `export`              | выбранный контекст                            | Выводит собранные state/events JSON; обратного restore/import нет                       |
| `resources`           | выбранный контекст                            | Показывает общий pool и владельцев                                                      |
| `resource-release`    | `--key KEY --token TOKEN --cleanup-confirmed` | Снимает подтверждённо заброшенную аренду; живой PID/другой token блокируют действие     |
| `environment-cleanup` | `--receipt ABS/environment.json`              | Выполняет восстановительную очистку сохранённого окружения                              |

Команды восстановления требуют понимания фактического состояния. [Процедуры](operations.md) объясняют порядок. Публикация пакетов/deployment командами DevContour не реализованы.

## Вывод и ошибки

Большинство управляющих команд выводят JSON в stdout; ошибки — сообщение и ненулевой exit code. npm добавляет собственный banner, поэтому при машинном разборе используйте `npm run --silent devcontour -- ...` и отдельно учитывайте stderr. SQLite может печатать experimental warning в stderr.

`doctor` возвращает scope и результаты, отличая not-checked от успешной проверки. `run` возвращает статусы задач и ненулевой exit при failed, но не заменяет acceptance. `serve` печатает URL и режим, затем работает до сигнала. Отдельной стабилизированной версии машинного CLI-протокола пока нет; интеграции должны проверять структурированный ответ и зафиксированную версию инструмента.

## HTTP API

Предпочтительный интерфейс ведущего агента — CLI. HTTP нужен UI и локальным интеграциям. Сервер слушает loopback; публикация в интернет не поддерживается без отдельного слоя аутентификации. Для mutating-запросов обязательны `Content-Type: application/json` и `X-DevContour-Request: 1`, Host/Origin проходят проверку.

| Метод и путь                                               | Назначение                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/state`                                           | Собранное состояние, blockers/ready, events, dataRoot, часть config и journalError |
| `GET /api/boards/:id/impact?roots=T1,T2`                   | Влияние корректировки                                                              |
| `GET /api/evidence/:id`                                    | Сохранённое доказательство и ограниченный по размеру текст лога                    |
| `GET /api/changesets/:id/journal`                          | Текст общего дневника                                                              |
| `GET /api/changesets/:id/evidence?verification=ID&gate=ID` | Лог общей проверки                                                                 |
| `POST /api/boards`                                         | Создать доску: title, description, опциональный repositoryId                       |
| `POST /api/boards/:id/tasks`                               | Добавить TaskInput                                                                 |
| `PATCH /api/tasks/:id`                                     | Изменить черновик: поля постановки и expectedDigest                                |
| `POST /api/contracts`                                      | Ручное утверждение title/content и опционального repositoryId                      |
| `POST /api/boards/:id/approve`                             | Ручное утверждение плана; опциональный taskIds                                     |
| `POST /api/boards/:id/accept`                              | Ручная приёмка ревизии                                                             |
| `POST /api/boards/:id/correct`                             | Корректировка: roots и reason                                                      |
| `POST /api/tasks/:id/retry`, `/cancel`                     | Повтор или отмена                                                                  |
| `POST /api/scheduler`                                      | `{ "start": true }` либо false                                                     |
| `POST /api/changesets`                                     | Создание общего результата                                                         |
| `POST /api/changesets/:id/verify`                          | Запустить асинхронную Verification; started не означает PASS                       |
| `POST /api/changesets/:id/accept`                          | Ручная приёмка ChangeSet                                                           |
| `POST /api/changesets/:id/handoff`, `/remote-check`        | Подготовка/наблюдение публикации                                                   |

Операторские endpoints записывают ручное действие. Автоматический ведущий агент использует команды независимого review, а не выдаёт себя за оператора через HTTP для обхода процесса. В local single-user MVP это договор workflow; полноценной авторизации по ролям ещё нет.

Неизвестный маршрут возвращает 404, ошибка JSON/schema — 400, нарушение локальной границы — 403, доменный конфликт обычно — 409. Тело содержит `error`. Точные тела и ограничения находятся в `src/server/http.ts`. Нет endpoint для прямой загрузки PASS или установки `done`.

## Командный Git sync

| Команда                                         | Поведение                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `sync-status`                                   | Сравнивает baseline, SQLite и `.devcontour/`; показывает изменения/конфликты без импорта задач и записи Git-файлов |
| `sync --member alice`                           | Первый обмен и локальная идентичность участника; далее `--member` можно опускать                                   |
| `sync`                                          | При остановленных workers объединяет и проверяет записи, обновляет файлы и локальную SQLite                        |
| `sync --resolutions /absolute/resolutions.json` | Выбирает `local`/`git` для указанных конфликтующих записей; доменные проверки остаются обязательными               |
| `sync --allow-branch-change`                    | Разрешает проверенную смену имени ветки без удаления истории и обхода конфликтов                                   |
| `assign-task --task <ID> --member alice`        | Меняет ответственного при отсутствии активной попытки; командная очередь берёт только свои задачи                  |

Все команды принимают `--workspace /absolute/workspace` или прежний `--data`. Sync требует `workspaceRoot` и отдельные Git-репозитории; он не делает commit/pull/push. Операционный `export` остаётся диагностикой, его JSON не является переносимым sync-форматом. Новые IDs содержат UUID; используйте возвращённые IDs, не вычисляйте следующий номер. Подробные сценарии, примеры файлов решений и границы доверия — [team-sync.md](team-sync.md).

## Эксперименты без продуктового workspace

`engineering-evals` использует собственные временные Git-репозитории. По умолчанию это fixture без модели; live требует `--live --runtime codex|claude --model ID --reviewer-model ID`. `eval-compare --baseline ABS.json --candidate ABS.json` сравнивает совместимые отчёты без вызова модели. Полные параметры и ограничения — [эксперименты](experiments.md).

Для memory_retain/recall, usage_report, decision_report и strategy_replay используйте общий `agent --file request.json --workspace ...`; точные схемы показывает capabilities.
