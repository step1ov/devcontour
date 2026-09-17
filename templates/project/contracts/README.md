# Контракты

Для API: схема, коды ошибок, auth, pagination, idempotency, совместимость.
Для событий: schema/version, ordering, retries, delivery semantics, дедупликация.
Для UI: состояния, validation, navigation, semantic tokens и версия макета.

Утверждение в DevContour фиксирует текст и digest. Новая семантика — новый contract ID и новая ревизия задач. Frontend может работать по согласованному mock, но итоговая приёмка требует интеграции с настоящим backend.
