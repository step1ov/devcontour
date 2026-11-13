// Test tiers of scripts/test.mjs. Every tier is a subset of `npm test`, which
// still runs every tests/*.test.ts file and every test in it.
//
// Scheduling hints, not a test allowlist: files start longest first, so that a
// long file never starts last and holds the tail of the run. Seconds per file,
// summed test durations of a full `npm run check` (four files at a time, under
// its own load). Only files of 30 s and more are listed; any other file counts
// as 0 and starts after them, in name order. `npm test` prints the slowest
// files at the end and names those of 30 s and more that are missing here.
// tests/test-selection.test.ts checks that every entry names an existing file.
export const fileSeconds = {
  runner: 540,
  'contract-change-staleness': 493,
  preview: 443,
  'runner-sandbox': 429,
  'contract-revise': 410,
  product: 393,
  'contract-change-reconfigure': 385,
  'git-sync': 384,
  'product-scenarios': 379,
  'product-scope': 375,
  'product-proof': 371,
  // Оценка по отдельному прогону (~125 с) с запасом на нагрузку полной проверки.
  'contract-change-registered': 370,
  engineering: 368,
  'runner-base': 349,
  'input-carry-order': 346,
  'contract-change': 342,
  intent: 341,
  'check-sync': 329,
  // Оценка по отдельному прогону (~110 с) с запасом на нагрузку полной проверки.
  'contract-change-siblings': 328,
  'quick-route-e2e': 325,
  'check-sync-storage': 325,
  'git-sync-artifacts': 320,
  'receipt-identity': 271,
  'check-corpus': 267,
  'property-recovery': 241,
  'input-flow': 227,
  'input-gaps': 227,
  'board-coverage': 226,
  'runner-refusals': 223,
  'contract-change-base': 222,
  'input-races': 209,
  enterprise: 207,
  'lead-joint-flight': 198,
  // Оценка по отдельному прогону (~45 с) с запасом на нагрузку полной проверки.
  'scenario-proof': 190,
  'respecify-attempts': 171,
  'property-gate': 168,
  workspace: 165,
  'input-workflow': 148,
  'input-ops': 145,
  'input-host': 140,
  'discussion-input': 131,
  'input-panel': 123,
  'panel-projections': 119,
  'lead-workflow': 119,
  'input-release': 115,
  'input-supersede': 115,
  'attention-input': 109,
  'input-progress': 108,
  usage: 105,
  'property-coverage': 105,
  requirements: 105,
  assumptions: 104,
  'quick-result': 103,
  'copy-precheck': 102,
  'handoff-rank': 102,
  'integration-review-scope': 101,
  proof: 100,
  'stall-sweep': 99,
  'idle-controller': 92,
  'start-context-commit': 90,
  'quick-route': 88,
  'lead-requirements-lease': 88,
  'workspace-mode': 87,
  'contract-closure': 83,
  'proposal-limits': 83,
  'check-contract': 81,
  'joint-budget-reset': 80,
  profiles: 78,
  'engineering-evals': 76,
  'agent-control': 74,
  'checkout-root': 73,
  'harness-legacy': 71,
  'autonomous-loop': 69,
  'demo-approval-mode': 67,
  'lead-joint-lifetime': 67,
  'check-runner': 66,
  'check-api': 61,
  'contract-artifacts': 57,
  'shutdown-abort': 50,
  'harness-roles': 49,
  reproductions: 48,
  'approval-policy': 39,
  'worktree-cleanup': 35,
  'large-artifacts': 34,
};

// The slow tier that `--fast` leaves out: whole files (`true`) or top-level
// tests by name prefix. Updated from measured full-suite durations: cases
// above 30 s under concurrent load, plus their generated case family where
// names share one source template. These are local feedback tiers only; the
// full release check still runs every case. tests/test-selection.test.ts
// checks that each prefix identifies an existing test file. A renamed test
// returns to the fast tier, increasing time rather than losing coverage.
export const slowTests = {
  'approval-policy': [
    'Политика после утверждения плана: смена gate и правила вендора ревью держат',
  ],
  'autonomous-loop': true,
  // Два запуска учебного сервера CLI (~20 с).
  'demo-approval-mode': ['demo --approval-mode writes agent or operator'],
  'quick-result': true,
  'quick-route-e2e': true,
  // Обе проверки исполняют доски и gates на принятом SHA.
  'scenario-proof': true,
  'board-coverage': [
    'Приёмка доски выполняет непокрытые gates один раз на итоговом SHA и принимает',
    'Провал непокрытого gate на итоговом SHA доски — отказ приёмки с названным gate;',
    'Повтор приёмки после частичного провала сохраняет прошедшие gates проверки',
    'Задача, работу которой сделала зависимость, — done без коммита и проходит',
    'Профиль в порядке массива: проверка доски исполняет непокрытый gate после более',
  ],
  'check-api': [
    'AC35: metrics keep their denominators over gate, review and',
    'AC33: Agent API, CLI, HTTP and MCP share version checks,',
  ],
  'check-contract': ['AC06: two tasks of one chain share a check file through'],
  'check-corpus': [
    'AC13, AC19: a confirmed defect stops the next candidate at the',
    'AC17: adoption waits for an active run, a stale owner cannot',
    'AC10–AC12, AC18: the pinned oracle decides a reviewer example; wrong',
    'AC14: an implementation fitted to the confirmed case is caught by the generator',
    'AC16: an attempt cannot edit the checker or pass evidence of another check',
  ],
  'check-sync': true,
  'check-sync-storage': true,
  'checkout-root': [
    'Embedded workspace: попытки, перенос и проверка базы — под одним корнем в кэше',
    'Embedded workspace: заданный checkoutRoot получают планировщик, проверка базы и',
    'Стандартные фикстуры тестов не пишут в настоящий кэш',
  ],
  'contract-artifacts': true,
  'contract-change': [
    'Work reverted within the branch does not stop the base move; a',
    'A contract change runs as one command: review, rebind, plan',
    'The plan reviewer sees the base the tasks will run on: the base',
    'A contract change resumes after a crash without repeating the',
    'An operation started with the previous step order continues by',
    'A revision without checks is warned about before the model call; a rejected',
    'A contract change waits for running attempts, refuses concurrent changes and',
    'A contract change does not move base work that is not part of the contract, and',
  ],
  'contract-change-base': [
    'A hung git update-ref inside the transaction is stopped by its',
    'A review answer that arrives after the operation was taken over',
    'The base ref move inside the transaction runs no repository',
    'Утрата владения операцией перед самым сдвигом ref — сдвига нет: проверка',
  ],
  'contract-change-reconfigure': [
    'A user pause set before or during the operation survives it;',
    'A crash after repinning or after applying resumes without a',
    'Reconfigure waits for a running attempt and issues nothing new',
    'A running server applies the requested configuration and',
    'The operation repins a context pack that pins the previous',
    'A configuration changed outside the operation is refused with',
  ],
  'contract-change-registered': [
    'After an explicit base-update the stopped operations finish instead of',
    'A base that does not carry the reviewed redaction keeps the operation',
    'A registered document that is not the approved redaction is not carried',
    'Amendments registered without an operation are not carried with open work',
    'A pinned artifact of a contract registered without an operation is carried',
    'A registered document pinned in a context pack: the operation repins',
    'A newer redaction of a registered document, or an operation taking it',
  ],
  'contract-change-siblings': [
    'A sibling document fixed after its operation started does not make the',
    'A sibling document or artifact changed after its approval is not',
    'A waited-for sibling abandoned after review: the waiting operation',
    'A sibling revised after review: its successor is waited for',
    'A newer redaction of the sibling document, registered meanwhile',
    'An artifact pinned differently by another contract of open work',
    'No adoption when HEAD is rewritten or after the base move',
    'A sibling of another component is neither waited for nor carried',
    'Two operations moving the same base: the one that loses the ref race',
    'A newer redaction of the sibling document registered while the base move',
  ],
  'contract-change-staleness': [
    'C-F01: a repin retry accepts only the planned result; an edit',
    'C-F20/C-F22/C-F23/C-F24: the applied configuration is the only',
    'C-F19/C-F20/C-F21: staleness follows generations, not clocks; a',
    'C-F03/C-F04: a fixed config file is applied on retry, and an',
    'C-F11/C-F12/C-F16/C-F17: a stale process accepts nothing even',
    'C-F18: a server that loaded the previous configuration does not',
    'C-F25/C-F26/C-F27: adoption checks the bytes that were parsed,',
    'C-F02/C-F15: an owner that loses the operation mid-write writes',
    'C-F05/C-F07: a verification and a process from the previous',
    'C-F16: a config edit made before the context step is not taken',
  ],
  'contract-closure': ['a pinned acceptance file with an unpinned local helper is refused before'],
  'contract-evals': [
    'The contract feasibility corpus scores false rejections and misses separately',
  ],
  'contract-revise': [
    'AC30: a revise after rebind or base never fakes a rollback, a',
    'AC31: the plan reviewer sees a rebound draft and a new',
    'AC29: a rejected contract fixed before side effects is revised',
    'AC32: a base check wait and a human pause stay distinct, the',
    'A rejected operation is revised from a new proposal file: same operation and',
    'A revise keeps the contract identity: a repositoryId or title change is',
    'Review history belongs to the operation: a same-titled review elsewhere is not',
    'A revise with a file after the review registered the contract continues as a',
  ],
  engineering: [
    'Pinned role/library documents are selected reproducibly,',
    'Ordered codegen runs from its cwd before a real test in',
    'Generated files are protected and implementation discoveries',
  ],
  'engineering-evals': ['Engineering corpus exercises real candidate/integration gates'],
  enterprise: [
    'Manual handoff supports GitLab and GitHub; read-only',
    'Component databases contain local specifications, snapshots and',
  ],
  'git-sync': [
    'Broken receipts, absent commits, graph cycles, deleted history',
    'Two clones add tasks to the same board and merge different',
    'Впервые полученная приёмка сверяется с манифестом, а не со',
    'Conflicting edits require an explicit choice, and conflict',
    'Peer completion needs a committed receipt and present Git',
    'Синхронизация не возрождает задачу, отменённую в ревизии,',
    'An unresolved real Git merge conflict blocks synchronization',
  ],
  'git-sync-artifacts': [
    'Real runner checks and integration survive Git transfer without',
    'Pinned contract artifacts travel through Git sync between',
    'Contracts pinned by the first formula keep syncing, stay',
    'A contract with underTest round-trips between clones, and a changed underTest',
    'Независимый клон получает манифест testcases и подтверждает критерий тем же',
  ],
  'harness-legacy': ['T36: receipts Git-синхронизации прежней версии импортируются'],
  'harness-roles': ['Роль claude → ревьюер claude с same-vendor-allowed проходит'],
  'idle-controller': [
    'An idle paused controller neither rewrites nor reparses the state document; it',
  ],
  intent: [
    'Real Git acceptance covers intent; criteria changes invalidate',
    'Intent format pins local sources, rejects ambiguous IDs and',
    'Покрытие INTENT подтверждается тем же правилом testcase, что и',
    'task_story привязывает принятую задачу к истории без изменения постановки и',
  ],
  'large-artifacts': ['AC09: a byte changed outside the sample, dirty, untracked,'],
  'lead-workflow': [
    'A real Git board resumes after process replacement without',
    'В режиме агента workflow доски сам проверяет перенесённую базу gates: провал',
    'Проверка базы: сдвиг базы до решения не снимает ожидание; смена договора',
    'base-update в режиме агента: работающая очередь встаёт на base-check; нечего',
  ],
  'panel-projections': ['The polled summary is bounded, carries no history bodies and'],
  preview: [
    'Preview не обходит границы: настройки, Compose, секреты,',
    'Preview выкладывает именно проверенный manifest, повтор',
    'Автор пробует проверенную версию в браузере и принимает её, не',
  ],
  product: [
    'A product release needs every local board and real joint tests;',
    'Joint verification masks secrets in its JUnit copy, evidence,',
    'Product map separates monorepo channels and cross-repository',
    'Git sync preserves product release binding across clones',
  ],
  'product-proof': [
    'Changing the product map after joint verification blocks',
    'A release proof pins only its own tasks: other work in the component keeps it',
  ],
  'product-scope': ['A release scenario reworded or removed after acceptance needs the user to'],
  profiles: ['Custom Python gate fails a no-op writer, then verifies candidate and'],
  proof: [
    'Намеренно внесённый дефект ловится названным тестом: без этого',
    'Задача без названного testcase не публикуется и не открывает',
    'На настоящем прогоне приёмка требует именно названный тест',
  ],
  'property-coverage': [
    'AC02: with a pinned manifest a missing, duplicate, foreign,',
    'AC03: failed and running reports keep negative diagnostics;',
  ],
  'property-gate': ['The controller seeds the gate, keeps the property report on'],
  'property-recovery': [
    'AC26: in agent mode the server finishes the narrow route',
    'AC25: an infrastructure failure between failures neither counts',
    'AC28: a human pause, a cancellation, operator mode and a',
    'AC27: a restart, a duplicate or re-registered workflow and a',
    'AC24: two substantive failures on one property with different messages and',
  ],
  'proposal-limits': [
    'contract-impact (CLI) называет превышение пределов в отчёте; contract-change',
    'contract-impact и закрепление спрашивают Git постоянное число раз; отказы и',
  ],
  'receipt-identity': [
    'S3-R3-01: receipt не подтверждает приёмку, если у получателя',
    'S3-R5: переносимость пути — только буквальная запись внутри',
    'T23/S3-R1-01: receipt подтверждает приёмку доски только теми же проверками —',
    'S3-R3-02 (',
    'S3-R6-01: неподтверждённое написание корня не делает переносимым внешний вход —',
  ],
  reproductions: ['Review findings, summary and review.json are masked in every'],
  requirements: ['Requirements survive real Git execution; changed spec loses'],
  runner: [
    'Real git pipeline integrates concurrent siblings and verifies',
    'Writer and both reviewers use the same memory snapshot despite',
    'Тысячи посторонних файлов в кандидате не перечитывают состояние',
    'Crash after Git publication is reconciled from persisted',
  ],
  'runner-base': [
    'Acceptance records the proven SHA, so a base update cannot slip',
    'Кандидат не берётся, если сдвинулась база, ревью отклонило код',
    'A stale run base that is a pure fast-forward moves on the next tick; a diverged',
    'Auto fast-forward refuses commits that touch acceptance or contour files and',
  ],
  'runner-refusals': [
    'Ответ ревьюера вне протокола находок — не замечание к коду;',
    'A retry is told where the previous review objected, not only',
  ],
  'runner-sandbox': [
    'Проверка не оставляет процессов — ни по таймауту, ни при',
    'Проверка исполняется в песочнице: полезное работает,',
  ],
  'shutdown-abort': ['Shutdown aborts a host adapter wrapped by fromAgentAdapter and requeues its'],
  workspace: [
    'Real multi-repo DAG, isolated ownership, failing then passing',
    'Consumer impact executes prerequisites and affected product',
    'Workspace gates cannot change manifest or another component',
  ],
  'workspace-mode': [
    'Embedded product map and local intent drive real worktrees,',
    'One-Git preparation and task memory survive independent clones;',
  ],
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Name patterns for node:test `testSkipPatterns`: a prefix of the test name. */
export const slowPatterns = () =>
  Object.values(slowTests)
    .filter(Array.isArray)
    .flat()
    .map((prefix) => new RegExp('^' + escape(prefix)));
/** A file the slow tier holds entirely, by its name without `.test.ts`. */
export const slowFile = (name) => slowTests[name] === true;
