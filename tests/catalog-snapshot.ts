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
export const CATALOG_DIGEST = 'fb6574e41a61b0a271f4132b56a31344376e42d1c9b2fae5d36482eb2fb7ea04';
export const SNAPSHOT_VERSION = '0.4.0-alpha.7';
