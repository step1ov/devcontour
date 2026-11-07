// Снимок каталога агентских операций DevContour — единый для тестов, которые
// проверяют, что каталог байтово прежний. Каталог называет версию продукта;
// снимок снят на 0.4.0-alpha.7, поэтому digest считается с этой версией.
// Намеренное изменение: contract_change_revise получил необязательный
// `proposal` (исправленное предложение того же контракта), а его `checks`
// с движком 0.1.0-alpha.16 — поля обязательства `gates`, `verification`,
// `reference` и `crossChecks[].artifacts`; область gates задачи (`gates`,
// `consumers[].gates`) — до предела gates профиля (100 вместо 20); прочие
// операции байтово прежние. Digest перевзят с движком 0.1.0-alpha.19.
// Намеренное изменение: новая пишущая операция task_story (привязка
// выполненной задачи к истории INTENT без изменения постановки) после
// task_assign; прочие операции байтово прежние.
// Намеренное изменение: maxItems у relatedRepositories в task_create и
// task_edit, а в задаче plan_import ещё у dependsOn, acceptance и contracts;
// схема плана runtime и прочие операции байтово прежние.
// Намеренное изменение: новая операция только чтения value_report (отчёт об
// эффекте) после workflow_metrics; прочие операции байтово прежние.
// Намеренное изменение: новая операция только чтения session_handoff (пакет передачи
// контекста новой сессии ведущего агента) после value_report; прочие
// операции байтово прежние.
// Намеренное изменение: описание workflow_status называет поля liveness и
// operations (попытки и проверки без движения); прочие операции байтово прежние.
// Намеренное изменение: пишущие операции быстрого изменения preparation_quick,
// preparation_setup и preparation_expand после preparation_activate; прочие
// операции байтово прежние.
// Намеренное изменение: операции обсуждения задачи discussion_read,
// discussion_post, discussion_resolve и discussion_inbox после memory_recall;
// прочие операции байтово прежние.
// Намеренное изменение: описания discussion_read, discussion_post,
// discussion_resolve и discussion_inbox называют чтение назад, выдержки
// текста, цикл needs-answer и версию треда в очереди; курсор
// discussion_inbox — до 2000 символов; прочие операции байтово прежние.
export const CATALOG_DIGEST = '71ec177499a2b700381fde1248a09f9f9803128edd78005385c6b3b331bf5172';
export const SNAPSHOT_VERSION = '0.4.0-alpha.7';
