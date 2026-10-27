// Снимок каталога агентских операций DevContour — единый для тестов, которые
// проверяют, что каталог байтово прежний. Каталог называет версию продукта;
// снимок снят на 0.4.0-alpha.7, поэтому digest считается с этой версией.
// Намеренное изменение: contract_change_revise получил необязательный
// `proposal` (исправленное предложение того же контракта), а его `checks`
// с движком 0.1.0-alpha.16 — поля обязательства `gates`, `verification`,
// `reference` и `crossChecks[].artifacts`; прочие операции байтово прежние.
export const CATALOG_DIGEST = '1f5f438af316eacef2616f5139f58d1456415105fca1f36bcaa5fbd49f3f5e28';
export const SNAPSHOT_VERSION = '0.4.0-alpha.7';
