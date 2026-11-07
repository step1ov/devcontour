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
// Намеренное изменение: операции вопросов исполнителя input_list, input_show,
// input_answer, input_context, input_review, input_target, input_apply,
// input_cancel и input_supersede после contract_change_revise, вместе с
// операциями обсуждения (input_list,
// input_show, input_target — только чтение); прочие операции байтово прежние.
// Намеренное изменение: discussion_post принимает kind answer с input (ответ
// на вопрос исполнителя сообщением обсуждения), input_context — messageIds
// для manifest снимка; прочие операции байтово прежние.
// Намеренное изменение: фильтр input_list знает состояние review-rejected
// (ревью отклонило ответ), описание называет его; прочие операции байтово прежние.
// Намеренное изменение: описания input_answer и input_supersede называют
// путь изменения требований (новая постановка задачи, замена той же задачей
// и перенос ответа) и отказ SPEC_UNCHANGED; прочие операции байтово прежние.
// Намеренное изменение: описание input_supersede называет замену
// неблокирующего follow-up новой задачей той же доски (например, заменой из
// board_correct); прочие операции байтово прежние.
// Намеренное изменение: операция только чтения attention_list (центр
// внимания: упорядоченный список актуальных действий ведущего и оператора)
// после input_supersede; прочие операции байтово прежние.
export const CATALOG_DIGEST = '1fc9b3ba053fe7d4edeaa017538b18ffcbba5c3ffa5966ecf3218cf672e31fd0';
export const SNAPSHOT_VERSION = '0.4.0-alpha.7';
