// Снимок каталога агентских операций DevContour — единый для тестов, которые
// проверяют, что каталог байтово прежний. Каталог называет версию продукта;
// снимок снят на 0.4.0-alpha.7, поэтому digest считается с этой версией.
// Намеренное изменение: contract_change_revise получил необязательный
// `proposal` (исправленное предложение того же контракта), а его `checks`
// с движком 0.1.0-alpha.16 — поля обязательства `gates`, `verification`,
// `reference` и `crossChecks[].artifacts`; область gates задачи (`gates`,
// `consumers[].gates`) — до предела gates профиля (100 вместо 20); прочие
// операции байтово прежние. Digest перевзят с движком 0.1.0-alpha.19.
export const CATALOG_DIGEST = 'ac0e8747b898624ff186efa43593f7b16cb4ea6e2a2fa3be8f5d1062bf3b8993';
export const SNAPSHOT_VERSION = '0.4.0-alpha.7';
