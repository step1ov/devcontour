// Test tiers of scripts/test.mjs. Every tier is a subset of `npm test`, which
// still runs every tests/*.test.ts file and every test in it.
//
// Scheduling hints, not a test allowlist: start expensive files first to avoid
// a single long file at the end.
export const slowFirst = [
  'contract-change',
  'runner',
  'check-sync',
  'git-sync',
  'engineering',
  'product',
  'check-corpus',
  'preview',
  'intent',
  'property-recovery',
  'contract-revise',
  'panel-projections',
];

// The slow tier that `--fast` leaves out: whole files (`true`) or top-level
// tests by name prefix. Chosen from per-test durations of a full parallel run
// (0.4.0-alpha.11 log): every test above 30 s there, about 5 s on an idle
// host. Together they are about 80% of the summed test time; the release
// check runs them as before. tests/test-tiers.test.ts keeps each prefix
// pointing at exactly one test file that still contains it. A renamed test
// silently moves to the fast tier, which costs time, never coverage.
export const slowTests = {
  'autonomous-loop': true,
  'check-api': [
    'AC35: metrics keep their denominators over gate, review and',
    'AC33: Agent API, CLI, HTTP and MCP share version checks,',
  ],
  'check-contract': ['AC06: two tasks of one chain share a check file through'],
  'check-corpus': [
    'AC13, AC19: a confirmed defect stops the next candidate at the',
    'AC17: adoption waits for an active run, a stale owner cannot',
  ],
  'check-sync': true,
  'contract-artifacts': true,
  'contract-change': [
    'A user pause set before or during the operation survives it;',
    'C-F01: a repin retry accepts only the planned result; an edit',
    'Work reverted within the branch does not stop the base move; a',
    'A crash after repinning or after applying resumes without a',
    'C-F20/C-F22/C-F23/C-F24: the applied configuration is the only',
    'Reconfigure waits for a running attempt and issues nothing new',
    'A contract change runs as one command: review, rebind, plan',
    'A running server applies the requested configuration and',
    'C-F19/C-F20/C-F21: staleness follows generations, not clocks; a',
    'The operation repins a context pack that pins the previous',
    'C-F03/C-F04: a fixed config file is applied on retry, and an',
    'C-F11/C-F12/C-F16/C-F17: a stale process accepts nothing even',
    'C-F18: a server that loaded the previous configuration does not',
    'The plan reviewer sees the base the tasks will run on: the base',
    'A contract change resumes after a crash without repeating the',
    'C-F25/C-F26/C-F27: adoption checks the bytes that were parsed,',
    'A configuration changed outside the operation is refused with',
    'C-F02/C-F15: an owner that loses the operation mid-write writes',
    'A hung git update-ref inside the transaction is stopped by its',
    'A review answer that arrives after the operation was taken over',
    'An operation started with the previous step order continues by',
    'C-F05/C-F07: a verification and a process from the previous',
    'The base ref move inside the transaction runs no repository',
    'C-F16: a config edit made before the context step is not taken',
  ],
  'contract-revise': [
    'AC30: a revise after rebind or base never fakes a rollback, a',
    'AC31: the plan reviewer sees a rebound draft and a new',
    'AC29: a rejected contract fixed before side effects is revised',
    'AC32: a base check wait and a human pause stay distinct, the',
  ],
  'engineering-evals': ['Engineering corpus exercises real candidate/integration gates'],
  engineering: [
    'Pinned role/library documents are selected reproducibly,',
    'Ordered codegen runs from its cwd before a real test in',
    'Generated files are protected and implementation discoveries',
  ],
  enterprise: [
    'Manual handoff supports GitLab and GitHub; read-only',
    'Component databases contain local specifications, snapshots and',
  ],
  'git-sync': [
    'Real runner checks and integration survive Git transfer without',
    'Pinned contract artifacts travel through Git sync between',
    'Broken receipts, absent commits, graph cycles, deleted history',
    'Two clones add tasks to the same board and merge different',
    'Contracts pinned by the first formula keep syncing, stay',
    'Впервые полученная приёмка сверяется с манифестом, а не со',
    'Conflicting edits require an explicit choice, and conflict',
    'Peer completion needs a committed receipt and present Git',
    'Синхронизация не возрождает задачу, отменённую в ревизии,',
    'An unresolved real Git merge conflict blocks synchronization',
  ],
  'harness-legacy': ['T36: receipts Git-синхронизации прежней версии импортируются'],
  'harness-roles': ['Роль claude → ревьюер claude с same-vendor-allowed проходит'],
  intent: [
    'Real Git acceptance covers intent; criteria changes invalidate',
    'Intent format pins local sources, rejects ambiguous IDs and',
    'Покрытие INTENT подтверждается тем же правилом testcase, что и',
  ],
  'large-artifacts': ['AC09: a byte changed outside the sample, dirty, untracked,'],
  'lead-workflow': ['A real Git board resumes after process replacement without'],
  'panel-projections': ['The polled summary is bounded, carries no history bodies and'],
  preview: [
    'Preview не обходит границы: настройки, Compose, секреты,',
    'Preview выкладывает именно проверенный manifest, повтор',
    'Автор пробует проверенную версию в браузере и принимает её, не',
  ],
  product: [
    'A product release needs every local board and real joint tests;',
    'Changing the product map after joint verification blocks',
    'Joint verification masks secrets in its JUnit copy, evidence,',
    'Product map separates monorepo channels and cross-repository',
    'Git sync preserves product release binding across clones',
  ],
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
  ],
  'receipt-identity': [
    'S3-R3-01: receipt не подтверждает приёмку, если у получателя',
    'S3-R5: переносимость пути — только буквальная запись внутри',
  ],
  reproductions: ['Review findings, summary and review.json are masked in every'],
  requirements: ['Requirements survive real Git execution; changed spec loses'],
  runner: [
    'Проверка не оставляет процессов — ни по таймауту, ни при',
    'Real git pipeline integrates concurrent siblings and verifies',
    'Writer and both reviewers use the same memory snapshot despite',
    'Ответ ревьюера вне протокола находок — не замечание к коду;',
    'Тысячи посторонних файлов в кандидате не перечитывают состояние',
    'Acceptance records the proven SHA, so a base update cannot slip',
    'Crash after Git publication is reconciled from persisted',
    'Проверка исполняется в песочнице: полезное работает,',
    'Кандидат не берётся, если сдвинулась база, ревью отклонило код',
    'A retry is told where the previous review objected, not only',
  ],
  'workspace-mode': [
    'Embedded product map and local intent drive real worktrees,',
    'One-Git preparation and task memory survive independent clones;',
  ],
  workspace: [
    'Real multi-repo DAG, isolated ownership, failing then passing',
    'Consumer impact executes prerequisites and affected product',
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
