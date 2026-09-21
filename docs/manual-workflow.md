# Пошаговый сценарий через CLI

Новый продуктовый маршрут начинается с [раннего запуска панели и двух согласований](staged-workflow.md): продукт утверждает пользователь, затем он утверждает архитектуру и стек с C1/C2. Технические операции ниже выполняются после этих решений. `approvalMode` не отменяет их.

Это ручной маршрут ведущего агента: каждая стадия вызывается отдельной командой. В обычном AI-native процессе агент после подготовки регистрирует [сохраняемый workflow](lead-workflow.md), а сервер выполняет шаги review → очередь → приёмка. Не запускайте эти два маршрута одновременно для одной доски/ChangeSet. Оператору достаточно ТЗ и пути workspace. Для начала без моделей используйте [demo](quickstart.md), для нескольких репозиториев — [workspace guide](workspaces.md).

Все команды ниже запускаются из каталога DevContour. Замените `/absolute/product` и `/absolute/product-workspace` своими путями. IDs берите из JSON-ответов, а не из примеров.

## 0. Открыть панель и согласовать постановку

До setup запустите `npm run devcontour -- start --workspace /absolute/product-workspace --port 0`. Передайте пользователю URL. Через операции `preparation_*` ведущий агент сохраняет и отправляет на рассмотрение продуктовую постановку, а после её утверждения — архитектуру и стек с C1/C2. Пользователь подтверждает каждую версию отдельно в панели. Форматы и корректировки описаны в [продуктовом процессе](staged-workflow.md). Команды ниже выполняются только после двух согласований.

## 1. Подготовить продукт и среду

Положите непустое ТЗ в `/absolute/product/docs/spec.md`. Workspace должен быть отдельным каталогом вне продукта и установки инструмента. Сначала проверьте существующие правила, Git и незакоммиченные изменения: setup сохраняет файлы, но не решает смысловые противоречия между инструкциями.

```sh
npm run devcontour -- setup --repository /absolute/product --profile react-vite-admin --workspace /absolute/product-workspace
```

Ответ `needs-agent-bootstrap` означает продолжение работы. Изучите `created` и `preserved`. Агент создаёт или адаптирует приложение, реальные `typecheck/build/test:devcontour`, JUnit reporter, gitignore, инструкции ролей и тестовые сервисы. Существующий стек сохраняется, если требования не дают причины его менять.

Для нового продукта подготовьте Git и начальный commit осознанно, проверив diff и отсутствие секретов. Runner работает с коммитами; незакоммиченное ТЗ или тест не появится автоматически в новом worktree. Не запускайте после setup повторный init.

По умолчанию runtime ролей — Claude, reviewer — Codex. Оба CLI нужно установить и авторизовать в среде worker; доступы ведущего чата не наследуются. Если включаете MCP, задайте явный tool profile. Gates из профиля — стартовые команды, существование реальных scripts нужно проверить.

## 2. Закрепить правила и проверить готовность

```sh
npm run devcontour -- context-lock --workspace /absolute/product-workspace
npm run devcontour -- doctor --workspace /absolute/product-workspace
npm run devcontour -- doctor --probe --workspace /absolute/product-workspace
```

`context-lock` читает HEAD каждого источника и записывает revision/digest; правила должны быть закоммичены. После изменения locks сервер перезапускается. `doctor --probe` требует паузу/отсутствие активной работы и выполняет только настроенные preflight. Он не заменяет первый live-прогон моделей и продуктовые тесты.

Запустите реальные gates на исходном каркасе. Нельзя начинать продуктовую очередь с тестом, который просто печатает PASS. При приватных библиотеках настройте snapshots/prepare до этого этапа.

## 3. Уточнить технические контракты утверждённой архитектуры

Агент формирует архитектурное предложение, API/дизайн-контракты и обоснование выбора. Proposal JSON, например `/absolute/product-workspace/docs/proposals/catalog-contract.json`:

```json
{
  "title": "Каталог: контракт поиска v1",
  "content": "GET /products?q=string возвращает {items:[{id:string,title:string}],total:number}. Пустой q возвращает первую страницу. Некорректный q возвращает 400 с кодом INVALID_QUERY. Интерфейс имеет loading, empty, error и success; после ошибки доступен повтор."
}
```

Это пример интерфейсного фрагмента; реальный контракт дополните авторизацией, пагинацией, ограничениями, совместимостью и наблюдаемыми требованиями своего продукта.

```sh
npm run devcontour -- review-contract --file /absolute/product-workspace/docs/proposals/catalog-contract.json --author-runtime codex --workspace /absolute/product-workspace
```

Укажите фактический runtime автора. Другой runtime проверит предложение. При agent mode сохранится Contract с ID; при operator mode ответ будет `awaiting-operator`, после чего человек регистрирует согласованное содержимое в UI. Файл в Git сам по себе не является утверждённой записью Contract.

Если интерфейс ещё нужно исследовать, сначала создайте небольшой план только подготовительных работ. Не утверждайте весь frontend/backend заранее в надежде дописать договор позже.

## 4. Создать граф первого сценария

Агент готовит brief со ссылками на требования, согласованные контракты, границы изменения и проверки. Есть два альтернативных входа.

До импорта выделите в committed ТЗ `## REQ-id: Название` и получите `requirements-snapshot --repository-id main --file docs/spec.md --workspace /absolute/product-workspace`. Привяжите `requirements` задач к полным text/digest разделов, существующим test gates и наблюдаемым сценариям. Источник находится в Git самой задачи, даже для библиотеки. [Формат и обновление требований](requirements.md).

Модельный планировщик:

```sh
npm run devcontour -- plan --brief /absolute/product-workspace/docs/first-slice.md --runtime codex --workspace /absolute/product-workspace
```

Или готовый JSON по формату [example-plan.json](../packs/example-plan.json):

```sh
npm run devcontour -- import-plan --file /absolute/product-workspace/docs/plan.json --workspace /absolute/product-workspace
```

Не выполняйте оба для одного и того же плана: `plan` уже импортирует результат. Повтор создаёт новую доску. В одном плане 1–30 задач; предпочтителен небольшой завершённый пользовательский сценарий.

До утверждения агент проверяет repositoryId, dependsOn, роли, requirements/AC, реальные Contract IDs, contextPacks, writePaths и resources. Зависимость означает необходимость **завершённого результата** другой задачи. Frontend, работающий по контракту и fixtures, может не ждать backend; совместный сценарий обязан проверить их вместе.

Для изменения черновика:

```sh
npm run devcontour -- edit-task --task T12 --file /absolute/product-workspace/docs/task.json --workspace /absolute/product-workspace
npm run devcontour -- review-plan --board B4 --author-runtime codex --workspace /absolute/product-workspace
```

`task.json` содержит актуальный TaskInput целиком; не включайте служебные status/resultSha/attempt. Утверждённый план нельзя подменять ручным SQL. Независимое review проверяет постановку, после чего digest фиксирует именно эту версию.

## 5. Проверить подключение исполнения и запустить очередь

Панель уже работает через `start --workspace` с шага 0 и после setup подключает технический workflow на том же URL. Второй сервер не запускайте. Если процесс был остановлен для обслуживания, возобновите его командой `start --workspace /absolute/product-workspace --port 0`.

Агент проверяет `/api/state`: `config.workspaceRoot` и `dataRoot` должны соответствовать выбранному workspace. URL и способ продолжения процесса записываются в `<workspace>/docs/devcontour-progress.md`.

Во втором терминале:

```sh
npm run devcontour -- queue --start --workspace /absolute/product-workspace
```

Альтернатива без постоянного сервера — `run` с тем же workspace. Для обычной работы используйте один активный scheduler. `queue --start` само по себе worker не запускает.

Веб-консоль показывает граф, список, ревизии, контракты, попытки и evidence. В agent mode она служит наблюдению: оператор не обязан нажимать каждое согласование. При failed ведущий агент разбирает причину, исправляет среду/постановку допустимым способом и выполняет явный retry в пределах лимита.

## 6. Принять локальную доску

```sh
npm run devcontour -- accept --board B4 --author-runtime codex --workspace /absolute/product-workspace
```

Требуются `done` всех задач и наличие их result SHA в принятой ветке. В operator mode подтверждение делает человек в UI. Сам факт `accept` не запускает дополнительный модельный аудит продукта: ведущий агент до этого сверяет результат с требованиями и артефактами.

Перед ручной приёмкой прочитайте `requirements-report --repository-id main --workspace /absolute/product-workspace`. Старые evidence не подтверждают изменившийся HEAD ТЗ. При наличии связей используйте свежий отчёт, даже если Task исторически остаётся done.

Основной checkout не переключается. Для просмотра приложения можно создать отдельный detached checkout:

```sh
git -C /absolute/product worktree add --detach /absolute/product-review devcontour/accepted
```

Он фиксирует текущую версию. Новое движение принятой ветки не обновляет этот checkout автоматически. Не держите саму `devcontour/accepted` текущей веткой рабочего каталога.

## 7. Принять общий результат и передать публикацию

Для продукта с библиотеками, общего этапа или remote completion создайте ChangeSet из нужных досок и настройте настоящие workspaceGates. Самостоятельная локальная доска не требует ChangeSet, если общий/удалённый результат не используется.

```json
{
  "title": "Поиск в каталоге: первый сценарий",
  "description": "Проверка продукта на согласованной комбинации версий компонентов",
  "boardIds": ["B4"]
}
```

```sh
npm run devcontour -- changeset-create --file /absolute/product-workspace/docs/changeset.json --workspace /absolute/product-workspace
npm run devcontour -- workspace-verify --changeset CHG-12 --workspace /absolute/product-workspace
```

В local completion после успешной Verification агент принимает ChangeSet. В remote completion сначала:

```sh
npm run devcontour -- handoff --changeset CHG-12 --workspace /absolute/product-workspace
# Человек выполняет публикацию и процесс PR/MR/merge.
npm run devcontour -- remote-check --changeset CHG-12 --workspace /absolute/product-workspace
```

После подтверждения требуемого уровня:

```sh
npm run devcontour -- changeset-accept --changeset CHG-12 --author-runtime codex --workspace /absolute/product-workspace
```

Remote-check может вернуть ожидание — это не приёмка. Команды handoff не исполняются автоматически. Процесс подробно описан в [интеграции](project-integration.md).

## 8. Продолжить или исправить принятый результат

Новый самостоятельный этап — новая доска. Изменение принятого результата — новая ревизия:

```sh
npm run devcontour -- correct --board B4 --roots T12 --reason 'Изменился контракт обработки пустого поиска' --workspace /absolute/product-workspace
```

Агент проверяет вычисленное влияние, редактирует новые черновики, связывает новые контракты и снова выполняет review/очередь/приёмку. Незавершённая затронутая цепочка блокирует корректировку. Для принятого общего результата создаётся следующий ChangeSet с `supersedes`.

Если изменились уже связанные committed REQ-разделы, вместо ручного выбора roots используйте `requirements-correct --board B4 --reason 'Изменились требования поиска' --workspace /absolute/product-workspace`. Команда обновляет связи и создаёт draft-замены; AC, сценарии и тесты пересматривает агент. Новые несвязанные и удалённые требования требуют явного планирования.

Дальше агент возвращается к таблице требований и следующему сценарию, пока не выполнен весь порученный объём. Итог содержит реализованные требования, версии, доказательства и оставшиеся блокеры. [Восстановление и диагностика](operations.md) описывают продолжение после остановки сессии.
