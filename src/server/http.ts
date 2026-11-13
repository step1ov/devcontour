import { notApplicableLine } from '../core/evidence-verdict.ts';
import { workspaceDescription } from '../runner/workspace-mode.ts';
import { DiscussionService } from '../application/discussion.ts';
import { quickResultDiff, quickSetupApplied, quickResult } from '../runner/quick.ts';
import { quickFactsCache, quickPrerequisites, quickView } from '../application/quick-view.ts';
import { AttentionService } from '../application/attention.ts';
import type { UsageRecord } from '../core/usage.ts';
import { Preparation } from '../core/preparation.ts';
import { PreparationAgent } from '../application/preparation-agent.ts';
import type { Store } from '../core/store.ts';
import { LeadRunner } from '../runner/lead-workflow.ts';
import { PreviewRunner } from '../runner/preview.ts';
import { authorOverview } from '../application/overview.ts';
import { DeliveryRunner } from '../runner/forge.ts';
import { AgentService, capabilities, SERVER_STOPPING } from '../application/agent.ts';
import { checksSummary, taskChecks } from '../application/checks.ts';
import {
  panelChangeSet,
  panelContract,
  panelContractAttempts,
  panelContractAttemptFindings,
  panelRecoveryHistory,
  panelRevision,
  panelRevisions,
  panelEvents,
  panelQueue,
  panelRun,
  panelRuns,
  panelSummary,
  inputPolicyView,
  panelTask,
  panelTaskSearch,
} from '../application/panel.ts';
import { CheckCorpus } from '../core/check-store.ts';
import { taskProgress } from '../application/context.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, extname, sep, basename, relative, isAbsolute } from 'node:path';
import { ZodError, z } from 'zod';
import { utf8Bytes } from 'devcontour-harness';
import { DevContour, specDigest } from '../core/service.ts';
import { DomainError } from '../core/model.ts';
import { blockers, readyTasks } from '../core/graph.ts';
import { Scheduler } from '../runner/scheduler.ts';
import { requestInputPolicy } from '../runner/reconfigure.ts';
import { modelSettingsView, previewModels, requestModels } from '../runner/model-settings.ts';
import { InputService, inputHolds, stopQuestions } from '../application/input.ts';
import { acceptBoard } from '../runner/agent-control.ts';
import { modelRuntimes, repositories } from '../core/repositories.ts';
import { WorkspaceRunner } from '../runner/workspace.ts';
import { IntentService } from '../runner/intent.ts';
import { attachJournal, renderJournal } from '../runner/journal.ts';
import { runActivity } from '../runner/activity.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { dataIdentity } from '../runner/server-record.ts';
import { queueStopOf, quietAttempts, quietOperations } from '../application/queue-stop.ts';
import {
  cachedValueReport,
  parseReportFormat,
  renderValueReport,
  reportRequestInput,
} from '../application/value-report.ts';
/** Панель утверждает по одной задаче: предел отсекает только чужой запрос. */
/**
 * Путь снимка зависания без абсолютного пути хоста: относительно каталога
 * данных, иначе от `artifacts/` каталога состояния компонента.
 */
function relativeArtifact(root: string, path: string) {
  if (!isAbsolute(path)) return path;
  const inside = relative(resolve(root), path);
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside;
  const at = path.lastIndexOf(sep + 'artifacts' + sep);
  return at >= 0 ? path.slice(at + 1) : basename(path);
}
const APPROVAL_IDS_LIMIT = 1000;
const approvalIds = z
  .array(z.string())
  .max(APPROVAL_IDS_LIMIT, `Задач в одном утверждении не больше ${APPROVAL_IDS_LIMIT}`);
/** Тот же предел, что у `roots` операции `board_correct` агентского API. */
const CORRECTION_ROOTS_LIMIT = 100;
const correctionRoots = z
  .array(z.string())
  .max(CORRECTION_ROOTS_LIMIT, `Корней корректировки не больше ${CORRECTION_ROOTS_LIMIT}`);
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
};
async function body(req: IncomingMessage) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (utf8Bytes(text) > 100_000) throw new DomainError('Слишком большой запрос', 413);
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new DomainError('Некорректный JSON', 400);
  }
}
export async function serve(
  h: DevContour | undefined,
  scheduler: Scheduler | undefined,
  options: {
    port: number;
    dev?: boolean;
    /** Идентификатор экземпляра: `GET /api/server` подтверждает им процесс для `stop`. */
    instance?: string;
    /** Каталог данных workspace: `GET /api/server` называет его для `stop`. */
    dataRoot?: string;
    bootstrap?: {
      store: Store;
      workspace?: string;
      connect: () => Promise<{ h: DevContour; scheduler: Scheduler } | undefined>;
    };
  },
) {
  let workspaceRunner: WorkspaceRunner | undefined;
  let deliveryRunner: DeliveryRunner | undefined;
  let previewRunner: PreviewRunner | undefined;
  let lead: LeadRunner | undefined;
  let connecting: Promise<void> | undefined;
  let startupError: string | undefined;
  let stopping = false;
  // Факты репозитория — процессы Git: общий короткий кэш панели и центра внимания.
  const cachedFacts = quickFactsCache();
  const attentionOf = (store: Store) =>
    new AttentionService(store, h, {
      root: h?.config.workspaceRoot ?? options.bootstrap?.workspace,
      cachedFacts,
    });
  const startEngine = () => {
    if (!h || !scheduler) return;
    attachJournal(h);
    workspaceRunner = new WorkspaceRunner(h, scheduler.root);
    deliveryRunner = new DeliveryRunner(h, scheduler.root);
    previewRunner = new PreviewRunner(h, scheduler.root);
    lead = new LeadRunner(h, scheduler.root);
    scheduler.start();
    lead.start();
  };
  const connect = () => {
    if (h || !options.bootstrap || stopping) return Promise.resolve();
    if (connecting) return connecting;
    connecting = options.bootstrap
      .connect()
      .then((engine) => {
        if (!engine) return;
        h = engine.h;
        scheduler = engine.scheduler;
        startupError = undefined;
        if (!stopping) startEngine();
      })
      .catch((error: unknown) => {
        startupError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        connecting = undefined;
      });
    return connecting;
  };
  let origin = `http://127.0.0.1:${options.port}`;
  const vite = options.dev
    ? await (
        await import('vite')
      ).createServer({ server: { middlewareMode: true }, appType: 'spa' })
    : undefined;
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (
        ![new URL(origin).host, `localhost:${new URL(origin).port}`].includes(
          req.headers.host ?? '',
        )
      )
        throw new DomainError('Host не разрешён', 403);
      const url = new URL(req.url ?? '/', origin);
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        if (
          req.headers.origin &&
          ![origin, `http://localhost:${new URL(origin).port}`].includes(req.headers.origin)
        )
          throw new DomainError('Origin не разрешён', 403);
        if (
          !['GET', 'HEAD'].includes(req.method ?? 'GET') &&
          (req.headers['x-devcontour-request'] !== '1' ||
            !req.headers['content-type']?.startsWith('application/json'))
        )
          throw new DomainError('Отсутствует заголовок локального клиента', 403);
        // Подтверждение процесса для `devcontour stop`: pid и экземпляр,
        // записанные в server.json, и каталог данных `stop` должны совпасть с ответом.
        if (req.method === 'GET' && path === '/api/server') {
          json(res, 200, {
            pid: process.pid,
            instance: options.instance ?? null,
            dataRoot: options.dataRoot ? dataIdentity(options.dataRoot) : null,
          });
          return;
        }
        const preparationStore = h?.store ?? options.bootstrap?.store;
        if (req.method === 'GET' && path === '/api/preparation' && preparationStore) {
          const view = new Preparation(preparationStore).status(
            url.searchParams.get('change') ?? undefined,
          );
          const root = h?.config.workspaceRoot ?? options.bootstrap?.workspace;
          // Setting a contour up is work with a result, so the stage that
          // waits on it reports how far it got and who is busy right now,
          // instead of a task count that stays at zero for the whole of setup.
          const engine = h?.store.read();
          json(res, 200, {
            ...view,
            engineConnected: Boolean(h),
            setup: h
              ? {
                  repositories: h.config.repositories.map((r) => r.id),
                  profile: h.config.packs?.[0]?.id ?? null,
                  gates: h.config.gates.map((g) => g.id),
                  workspaceGates: h.config.workspaceGates.map((g) => g.id),
                  concurrency: h.config.concurrency,
                  maxAttempts: h.config.maxAttempts,
                }
              : undefined,
            workers: (engine?.runs ?? [])
              .filter((r) => r.status === 'active')
              .map((r) => {
                const task = engine?.tasks.find((t) => t.id === r.taskId);
                return {
                  runId: r.id,
                  taskId: r.taskId,
                  title: task?.title ?? r.taskId,
                  role: task?.role,
                  // Имя роли объявляет workspace; экран этапа не читает всю
                  // конфигурацию и без него показывал сырой ключ роли.
                  roleTitle:
                    task && h
                      ? (h.config.repositories.find((x) => x.id === task.repositoryId)?.roles?.[
                          task.role
                        ]?.title ?? h.config.roles[task.role]?.title)
                      : undefined,
                  phase: r.phase,
                  runtime: r.runtime,
                  model: r.model,
                  reviewer: r.reviewer,
                  reviewerModel: r.reviewerModel,
                  attempt: r.attempt,
                  startedAt: r.startedAt,
                };
              }),
            // Экран этапа говорил «все исполнители свободны», пока диспетчер
            // стоял на ошибке: причина была видна только на досках.
            // Тот же вид остановки, что в `/api/state`, сводке и CLI.
            queue: engine ? queueStopOf(h!, engine) : undefined,
            startupError,
            workspace: root ? workspaceDescription(root) : undefined,
          });
          return;
        }
        // Поручение быстрого изменения вводит оператор в панели: происхождение
        // задаёт вход, а не поле запроса. Повтор того же ключа — та же запись.
        if (req.method === 'POST' && path === '/api/preparation/quick' && preparationStore) {
          json(
            res,
            200,
            new Preparation(preparationStore, 'operator').execute(
              'preparation_quick',
              await body(req),
            ),
          );
          return;
        }
        if (req.method === 'GET' && path === '/api/preparation/quick' && preparationStore) {
          const root = h?.config.workspaceRoot ?? options.bootstrap?.workspace;
          const state = preparationStore.read();
          const id = url.searchParams.get('change') ?? state.preparation?.activeChangeId;
          const change = state.preparation?.changes.find((c) => c.id === id);
          if (!change?.intake || !root) throw new DomainError('Быстрое изменение не найдено', 404);
          const prerequisites = await quickPrerequisites({ h, root, state, change, cachedFacts });
          const { facts, factsError, plan } = prerequisites;
          const quick = quickView({
            store: preparationStore,
            h,
            root,
            state,
            change,
            prerequisites,
            now: Date.now(),
          });
          const usage = h
            ? [undefined, ...repositories(h.config).map((r) => r.id)].flatMap((owner) =>
                Object.values(h!.store.localRecords<UsageRecord>('usage', owner)),
              )
            : [];
          // Задачу держит вопрос исполнителя: ожидание ответа, а не сбой попытки.
          const asking = h ? inputHolds(h) : undefined;
          json(res, 200, {
            changeId: change.id,
            title: change.title,
            intake: change.intake,
            setup: change.setup?.at(-1),
            expanded: change.expanded,
            findings: quick.findings,
            setupApplied: quickSetupApplied(join(root, '.devcontour-local'), change.id),
            facts,
            ...(factsError ? { factsError } : {}),
            plan,
            steps: quick.steps,
            lead: quick.lead,
            result: h
              ? await Promise.all(
                  quickResult(h.store.read(), change.id, usage, stopQuestions(h)).map(async (r) => {
                    const repo = repositories(h!.config).find((x) => x.id === r.repositoryId);
                    const diff =
                      repo && r.run
                        ? await quickResultDiff(repo.path, r.run).catch(() => null)
                        : null;
                    return { ...r, diff, ...(asking?.has(r.taskId) ? { waitingInput: true } : {}) };
                  }),
                )
              : [],
          });
          return;
        }
        // Центр внимания — до setup и после него на том же адресе и той же
        // базе. Чтение ничего не пишет и моделей не вызывает.
        if (req.method === 'GET' && path === '/api/attention' && preparationStore) {
          const service = attentionOf(preparationStore);
          const query = Object.fromEntries(url.searchParams);
          json(
            res,
            200,
            query.view === 'history' ? service.history(query) : await service.active(query),
          );
          return;
        }
        // Отметки «прочитано» и «увидел» — локальные записи оператора, не решение.
        if (req.method === 'POST' && path === '/api/attention/marks' && preparationStore) {
          json(res, 200, await attentionOf(preparationStore).mark(await body(req)));
          return;
        }
        // Действие с карточки центра внимания: проверка показанной версии и
        // существующая доменная операция. До setup — только действия подготовки.
        if (req.method === 'POST' && path === '/api/attention/act' && preparationStore) {
          json(
            res,
            200,
            await attentionOf(preparationStore).act(await body(req), {
              ...(scheduler ? { tick: () => scheduler!.tick() } : {}),
              ...(previewRunner ? { deploy: (id: string) => previewRunner!.deploy(id) } : {}),
              stopping: () => stopping || Boolean(scheduler?.stopping),
            }),
          );
          return;
        }
        if (req.method === 'POST' && path === '/api/preparation/decision' && preparationStore) {
          json(res, 200, new Preparation(preparationStore).decide(await body(req)));
          return;
        }
        // Reference screenshots and sketches live beside the design documents.
        // Serve them read-only from that one directory, with the same realpath
        // containment the evidence route uses.
        if (req.method === 'GET' && path === '/api/design/asset') {
          const root = h?.config.workspaceRoot ?? options.bootstrap?.workspace;
          const name = url.searchParams.get('file') ?? '';
          const kind = url.searchParams.get('kind') === 'sketches' ? 'sketches' : 'refs';
          if (!root || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name))
            throw new DomainError('Некорректное имя файла', 400);
          const directory = await realpath(join(root, 'docs', 'design', kind));
          const file = await realpath(join(directory, name));
          if (!file.startsWith(directory + sep)) throw new DomainError('Путь не разрешён', 403);
          const types: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
          };
          const type = types[extname(file).toLowerCase()];
          if (!type) throw new DomainError('Неподдерживаемый тип файла', 415);
          res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
          });
          res.end(await readFile(file));
          return;
        }
        // The handoff package is read in the panel, not only listed there. Files
        // are served under a path-shaped URL so a sketch's own stylesheet and
        // script resolve relatively, and only from docs/ of this workspace.
        if (req.method === 'GET' && path.startsWith('/api/design/file/')) {
          const root = h?.config.workspaceRoot ?? options.bootstrap?.workspace;
          const wanted = decodeURIComponent(path.slice('/api/design/file/'.length));
          if (!root || !wanted.startsWith('docs/') || wanted.split('/').includes('..'))
            throw new DomainError('Путь не разрешён', 400);
          const directory = await realpath(join(root, 'docs'));
          const file = await realpath(join(root, wanted));
          if (!file.startsWith(directory + sep)) throw new DomainError('Путь не разрешён', 403);
          const types: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.mjs': 'text/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.md': 'text/plain; charset=utf-8',
            '.txt': 'text/plain; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
          };
          const type = types[extname(file).toLowerCase()];
          if (!type) throw new DomainError('Неподдерживаемый тип файла', 415);
          // A document keeps its own subresources (CSS, scripts). It is always
          // a sandbox with an opaque origin, also when opened on its own
          // («Открыть отдельно»): a sketch script then sends `Origin: null`
          // and cannot call the panel API, operator routes included.
          const html = type.startsWith('text/html');
          res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': html
              ? "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
                "font-src 'self' data:; " +
                "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
                "connect-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
                "frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts"
              : "default-src 'none'; sandbox",
          });
          res.end(await readFile(file));
          return;
        }
        if (req.method === 'POST' && path === '/api/preparation/answer' && preparationStore) {
          json(res, 200, new Preparation(preparationStore).answer(await body(req)));
          return;
        }
        if (req.method === 'GET' && path === '/api/capabilities') {
          json(res, 200, capabilities());
          return;
        }
        if (req.method === 'POST' && path === '/api/agent' && !h && preparationStore) {
          json(res, 200, new PreparationAgent(preparationStore).execute(await body(req)));
          return;
        }
        if (!h || !scheduler || !workspaceRunner || !deliveryRunner)
          throw new DomainError(
            'Панель подготовки запущена. Разработка ждёт согласований и настройки проекта',
            409,
          );
        // Отчёт об эффекте: документ для чтения (ссылка «Отчёт» в шапке панели),
        // не новая панель. Только чтение; HTML без скриптов и внешних ресурсов.
        if (req.method === 'GET' && path === '/api/report') {
          // GET без заголовка локального клиента доступен любой странице
          // браузера: отчёт читает весь журнал, поэтому чужой сайт его не
          // вызывает. Браузер сообщает источник (`Sec-Fetch-Site`): ссылка
          // панели — same-origin, адрес, набранный вручную, — none; прочие
          // клиенты передают заголовок локального клиента.
          const site = req.headers['sec-fetch-site'];
          if (
            req.headers['x-devcontour-request'] !== '1' &&
            site !== 'same-origin' &&
            site !== 'none'
          )
            throw new DomainError('Отчёт открывается из панели или локальным клиентом', 403);
          const params = Object.fromEntries(url.searchParams);
          const format = parseReportFormat(params.format);
          if (params.noTitles !== undefined && params.noTitles !== '1')
            throw new DomainError('noTitles: ожидается 1', 400);
          const request = reportRequestInput.parse({
            ...(params.repositoryId ? { repositoryId: params.repositoryId } : {}),
            ...(params.since ? { since: params.since } : {}),
            ...(params.until ? { until: params.until } : {}),
            ...(params.asOf ? { asOf: params.asOf } : {}),
            ...(params.noTitles === '1' ? { noTitles: true } : {}),
          });
          const text = renderValueReport(
            cachedValueReport(h, request, {
              label: basename(h.config.workspaceRoot ?? scheduler.root),
              stateDir: scheduler.root,
            }),
            format,
          );
          res.writeHead(200, {
            'Content-Type':
              format === 'html'
                ? 'text/html; charset=utf-8'
                : format === 'md'
                  ? 'text/markdown; charset=utf-8'
                  : 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          });
          res.end(text);
          return;
        }
        const parts = path.split('/').filter(Boolean);
        let result: unknown;
        if (req.method === 'GET' && path === '/api/capabilities') {
          result = capabilities();
        } else if (req.method === 'POST' && path === '/api/agent') {
          result = await new AgentService(h, scheduler.root, {
            stopping: () => stopping || !!scheduler?.stopping,
          }).run(await body(req));
        } else if (req.method === 'GET' && path === '/api/overview') {
          result = authorOverview(h);
        } else if (req.method === 'GET' && path === '/api/summary') {
          result = panelSummary(h, scheduler.root, Object.fromEntries(url.searchParams));
        } else if (req.method === 'GET' && path === '/api/queue') {
          result = panelQueue(h, Object.fromEntries(url.searchParams));
        } else if (req.method === 'GET' && path === '/api/contract-attempts') {
          result = panelContractAttempts(h, Object.fromEntries(url.searchParams));
        } else if (
          req.method === 'GET' &&
          parts[1] === 'contract-attempts' &&
          parts[2] &&
          parts[3] === 'findings'
        ) {
          result = panelContractAttemptFindings(
            h,
            decodeURIComponent(parts[2]),
            Object.fromEntries(url.searchParams),
          );
        } else if (req.method === 'GET' && path === '/api/events') {
          result = panelEvents(h, Object.fromEntries(url.searchParams));
        } else if (req.method === 'GET' && path === '/api/tasks') {
          result = panelTaskSearch(h, Object.fromEntries(url.searchParams));
        } else if (req.method === 'GET' && parts[1] === 'tasks' && parts[2] && !parts[3]) {
          result = panelTask(h, decodeURIComponent(parts[2]), Object.fromEntries(url.searchParams));
        } else if (
          req.method === 'GET' &&
          parts[1] === 'tasks' &&
          parts[3] === 'recovery-history'
        ) {
          result = panelRecoveryHistory(
            h,
            decodeURIComponent(parts[2]),
            Object.fromEntries(url.searchParams),
          );
        } else if (req.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'discussion') {
          result = new DiscussionService(h).read({
            taskId: decodeURIComponent(parts[2]),
            ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
            ...(url.searchParams.get('before') ? { before: url.searchParams.get('before') } : {}),
            ...(url.searchParams.get('latest') === '1' ? { latest: true } : {}),
            ...(url.searchParams.get('limit')
              ? { limit: Number(url.searchParams.get('limit')) }
              : {}),
          });
        } else if (
          req.method === 'GET' &&
          parts[1] === 'tasks' &&
          parts[3] === 'input' &&
          !parts[4]
        ) {
          result = new InputService(h, scheduler.root).taskView(decodeURIComponent(parts[2]));
        } else if (req.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'runs') {
          result = panelRuns(h, decodeURIComponent(parts[2]), Object.fromEntries(url.searchParams));
        } else if (req.method === 'GET' && parts[1] === 'runs' && parts[2] && !parts[3]) {
          result = panelRun(h, decodeURIComponent(parts[2]));
        } else if (req.method === 'GET' && parts[1] === 'changesets' && parts[2] && !parts[3]) {
          result = panelChangeSet(
            h,
            decodeURIComponent(parts[2]),
            Object.fromEntries(url.searchParams),
          );
        } else if (req.method === 'GET' && parts[1] === 'contracts' && parts[2] && !parts[3]) {
          result = panelContract(h, decodeURIComponent(parts[2]));
        } else if (req.method === 'GET' && path === '/api/config/settings') {
          // Настройки оператора: модели ролей и порог вопросов. Только чтение;
          // изменение — маршрутами POST ниже, с ожидаемым digest.
          result = {
            ...inputPolicyView(h, h.store.read(), scheduler.root),
            approvalMode: h.config.approvalMode,
            models: modelSettingsView(h, scheduler.root),
          };
        } else if (req.method === 'GET' && path === '/api/state') {
          const state = h.store.read();
          const events = h.store.events();
          // Один момент на весь ответ: lease-причины задач не расходятся.
          const now = Date.now();
          const inputs = inputHolds(h);
          result = {
            ...state,
            // `paused` и `pauseReason` не объясняли остановку: причину и
            // подсказку несёт общий вид остановки очереди.
            queue: queueStopOf(h, state, events),
            // Идущие попытки без движения тем же видом, что в workflow_status.
            liveness: quietAttempts(state, now),
            operations: quietOperations(h, state, now),
            // Снимок зависания лежит в каталоге состояния: путь хоста — только
            // относительно каталога данных, как его называет журнал.
            runs: state.runs.map((r) =>
              r.liveness?.artifact
                ? {
                    ...r,
                    liveness: {
                      ...r.liveness,
                      artifact: relativeArtifact(scheduler!.root, r.liveness.artifact),
                    },
                  }
                : r,
            ),
            tasks: state.tasks.map((t) => ({
              ...t,
              specDigest: specDigest(t),
              blockers: blockers(t, state, inputs),
              progress: taskProgress(h!, state, t, now),
              checks: checksSummary(t),
            })),
            events,
            journalError: h.store.projectionError,
            workflows: new LeadWorkflow(h).view(),
            dataRoot: resolve(scheduler.root),
            ready: readyTasks(state, inputs).map((t) => t.id),
            config: {
              name: h.config.name,
              workspaceRoot: h.config.workspaceRoot,
              workspaceMode: h.config.workspaceMode,
              repositories: repositories(h.config),
              workspaceGates: h.config.workspaceGates,
              mode: h.config.mode,
              // Метка «без вызовов моделей» — только если их правда нет.
              modelRuntimes: modelRuntimes(h.config),
              approvalMode: h.config.approvalMode,
              // Порог вопросов исполнителя и digest действующей конфигурации:
              // панель меняет порог с ожидаемым digest.
              ...inputPolicyView(h, state, scheduler.root),
              completionMode: h.config.completionMode,
              storage: h.config.storage,
              concurrency: h.config.concurrency,
              roles: h.config.roles,
              reviewer: h.config.reviewer,
              gates: h.config.gates,
              targetBranch: h.config.targetBranch,
              packs: h.config.packs,
            },
          };
        } else if (req.method === 'GET' && path === '/api/product')
          result = new IntentService(h).productView({
            releaseId: url.searchParams.get('release') ?? undefined,
          });
        else if (req.method === 'GET' && parts[1] === 'changesets' && parts[3] === 'journal')
          result = { content: renderJournal(h.store.read(), parts[2], h.store.allEvents()) };
        else if (req.method === 'GET' && parts[1] === 'changesets' && parts[3] === 'evidence') {
          const e = h.store
            .read()
            .changeSets.find((c) => c.id === parts[2])
            ?.verifications.find((v) => v.id === url.searchParams.get('verification'))
            ?.evidence.find((e) => e.gate === url.searchParams.get('gate'));
          if (!e) throw new DomainError('Свидетельство не найдено', 404);
          const file = await realpath(e.log),
            root = await realpath(join(scheduler.root, 'workspace-checks'));
          if (!file.startsWith(root + sep))
            throw new DomainError('Путь артефакта не разрешён', 403);
          result = { content: (await readFile(file, 'utf8')).slice(-100000) };
        } else if (req.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'checks') {
          // Подробности договора проверки — по запросу и страницами: входы
          // корпуса и отчёты не входят в опрашиваемое состояние.
          result = taskChecks(h, {
            taskId: parts[2],
            limit: Number(url.searchParams.get('limit') ?? 20),
            cursor: Number(url.searchParams.get('cursor') ?? 0),
          });
        } else if (req.method === 'GET' && parts[1] === 'runs' && parts[3] === 'activity') {
          // «Чем агент занят прямо сейчас» — самый частый вопрос оператора, и
          // фаза на него отвечает грубо: `running` одинаков и через минуту
          // после выдачи, и на десятом инструменте. Здесь — последние действия
          // runtime, прочитанные из его же потока событий.
          const run = h.store.read().runs.find((r) => r.id === parts[2]);
          if (!run) throw new DomainError('Прогон не найден', 404);
          result = { activity: await runActivity(scheduler, run) };
        } else if (
          req.method === 'GET' &&
          parts[1] === 'boards' &&
          parts[3] === 'revisions' &&
          parts[4] &&
          !parts[5]
        )
          result = panelRevision(h, decodeURIComponent(parts[2]), Number(parts[4]));
        else if (
          req.method === 'GET' &&
          parts[1] === 'boards' &&
          parts[3] === 'revisions' &&
          !parts[4]
        )
          result = panelRevisions(
            h,
            decodeURIComponent(parts[2]),
            Object.fromEntries(url.searchParams),
          );
        else if (req.method === 'GET' && parts[1] === 'boards' && parts[3] === 'impact')
          result = h.impact(
            parts[2],
            (url.searchParams.get('roots') ?? '').split(',').filter(Boolean),
          );
        else if (req.method === 'GET' && parts[1] === 'evidence') {
          const e = h.store
            .read()
            .runs.flatMap((r) => r.evidence)
            .find((e) => e.id === parts[2]);
          if (!e) throw new DomainError('Свидетельство не найдено', 404);
          // Условный gate не исполнялся: лога нет, есть причина.
          if (e.kind === 'not-applicable')
            throw new DomainError(
              `У gate ${e.gate} нет лога: ${notApplicableLine(e.notApplicable)}`,
              404,
            );
          const file = await realpath(e.log);
          const roots = [
            join(scheduler.root, 'artifacts'),
            ...(h.config.storage === 'component'
              ? repositories(h.config).map((r) => join(r.path, '.devcontour-local/artifacts'))
              : []),
          ];
          if (
            !(
              await Promise.all(
                roots.map(async (root) => {
                  try {
                    return file.startsWith((await realpath(root)) + sep);
                  } catch {
                    return false;
                  }
                }),
              )
            ).some(Boolean)
          )
            throw new DomainError('Путь артефакта не разрешён', 403);
          result = { ...e, content: (await readFile(file, 'utf8')).slice(-100000) };
        } else if (req.method === 'POST' || req.method === 'PATCH') {
          const input = await body(req);
          if (path === '/api/changesets') result = workspaceRunner.workspace.create(input);
          else if (path === '/api/preview/rollback') result = await previewRunner!.rollback();
          else if (parts[1] === 'changesets') {
            if (parts[3] === 'handoff' || parts[3] === 'remote-check') {
              result = await deliveryRunner[parts[3] === 'handoff' ? 'prepare' : 'check'](parts[2]);
            } else if (parts[3] === 'preview') {
              // Выкладка идёт минутами: итог записывается в состояние, а
              // ответ сразу говорит, что она начата.
              const pending = previewRunner!.deploy(parts[2]);
              void pending.catch(() => {
                /* Failure is persisted by PreviewRunner. */
              });
              result = { status: 'started', changeSetId: parts[2] };
            } else if (parts[3] === 'verify') {
              const pending = workspaceRunner.verify(parts[2]);
              void pending.catch(() => {
                /* Failure is persisted by WorkspaceRunner. */
              });
              result = { status: 'started', changeSetId: parts[2] };
            } else if (parts[3] === 'accept')
              result = workspaceRunner.workspace.accept(parts[2], { actor: 'operator' });
            else throw new DomainError('Команда не найдена', 404);
          } else if (path === '/api/boards')
            result = h.createBoard(
              z.string().parse(input.title),
              z.string().max(5000).default('').parse(input.description),
              z.string().optional().parse(input.repositoryId),
            );
          else if (path === '/api/contracts')
            result = h.contract(
              z.string().max(180).parse(input.title),
              z.string().parse(input.content),
              { actor: 'operator' },
              z.string().optional().parse(input.repositoryId),
            );
          else if (path === '/api/config/input-policy')
            // Порог вопросов исполнителя — выбор оператора: не операция агента.
            result = requestInputPolicy(h, scheduler.root, input);
          else if (path === '/api/config/models/preview')
            // Что изменит выбор моделей: без записи.
            result = previewModels(h, scheduler.root, input);
          else if (path === '/api/config/models')
            // Модели ролей и независимость ревью — выбор владельца: не операция агента.
            result = requestModels(h, scheduler.root, input);
          else if (path === '/api/scheduler') {
            const start = z.boolean().parse(input.start);
            // Сервер останавливается: запуск очереди снял бы паузу остановки,
            // и такт выдал бы попытку, которую уже некому довести.
            // Остановка начинается в `close` сервера (раньше остановки
            // планировщика: сначала ведущий цикл и прочие исполнители).
            if (start && (stopping || scheduler.stopping))
              throw new DomainError(SERVER_STOPPING, 409);
            h.pause(!start);
            if (start) await scheduler.tick();
            // Такт мог сразу снова остановить очередь: ответ — то, что видно
            // после него, с причиной.
            result = queueStopOf(h);
          } else if (parts[1] === 'boards') {
            if (req.method === 'PATCH' && parts.length === 3)
              result = h.editBoard(
                parts[2],
                z
                  .object({
                    title: z.string().optional(),
                    description: z.string().max(5000).optional(),
                  })
                  .parse(input),
              );
            else if (parts[3] === 'tasks') result = h.addTask(parts[2], input);
            else if (parts[3] === 'approve')
              result = h.approve(
                parts[2],
                z.object({ taskIds: approvalIds.optional() }).parse(input).taskIds,
              );
            else if (parts[3] === 'accept') {
              result = await acceptBoard(
                h,
                parts[2],
                'codex',
                true,
                undefined,
                scheduler ? { root: scheduler.root } : {},
              );
            } else if (parts[3] === 'correct') {
              const { roots, reason } = z
                .object({ roots: correctionRoots, reason: z.string() })
                .parse(input);
              result = h.correct(parts[2], roots, reason);
            } else throw new DomainError('Команда не найдена', 404);
          } else if (parts[1] === 'checks' && parts[3] === 'pending' && parts[5] === 'approve') {
            // Подтверждение оператора из панели: тот же доменный метод, что CLI.
            result = new CheckCorpus(h).approveAdoption(parts[2], parts[4]).pending;
          } else if (parts[1] === 'tasks' && parts[3] === 'input' && parts[4] && parts[5]) {
            // Вопрос исполнителя — действие оператора в панели.
            const input2 = new InputService(h, scheduler.root);
            const [taskId, requestId] = [
              decodeURIComponent(parts[2]),
              decodeURIComponent(parts[4]),
            ];
            if (parts[5] === 'answer') result = input2.answerInTask(taskId, requestId, input);
            else if (parts[5] === 'apply') result = input2.applyInTask(taskId, requestId, input);
            else if (parts[5] === 'cancel') result = input2.cancelInTask(taskId, requestId, input);
            // Подтверждение предложения ведущего (F37) — ответ оператора с его
            // содержимым; агентский API этого действия не имеет.
            else if (parts[5] === 'confirm-proposal')
              result = input2.confirmProposalInTask(taskId, requestId, input);
            else throw new DomainError('Команда не найдена', 404);
          } else if (parts[1] === 'tasks') {
            // Кнопки панели — действие человека (`operator`).
            if (parts[3] === 'discussion')
              // Автор — оператор: его задаёт вход панели, а не поле запроса.
              result = new DiscussionService(h).post(
                { ...input, taskId: decodeURIComponent(parts[2]) },
                'operator',
              );
            else if (parts[3] === 'retry') result = h.retry(parts[2], undefined, 'operator');
            else if (parts[3] === 'cancel') result = h.cancel(parts[2], undefined, 'operator');
            else if (req.method === 'PATCH')
              result = h.editTask(parts[2], input, z.string().parse(input.expectedDigest));
            else throw new DomainError('Команда не найдена', 404);
          } else throw new DomainError('Маршрут не найден', 404);
        } else throw new DomainError('Маршрут не найден', 404);
        json(res, 200, result ?? {});
        return;
      }
      if (vite) {
        vite.middlewares(req, res);
        return;
      }
      const allowed = /^\/assets\/[A-Za-z0-9_.-]+$/.test(path);
      if (path !== '/' && !allowed) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const staticRoot = fileURLToPath(new URL('../../dist/', import.meta.url));
      const file = path === '/' ? join(staticRoot, 'index.html') : join(staticRoot, '.' + path);
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
      };
      const content = await readFile(file);
      res.writeHead(200, {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(content);
    } catch (error) {
      const status =
        error instanceof DomainError
          ? error.status
          : error instanceof ZodError
            ? 400
            : (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 404
              : 500;
      json(res, status, {
        error:
          error instanceof ZodError
            ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
            : error instanceof Error
              ? error.message
              : String(error),
        ...(error instanceof DomainError && error.details ? error.details : {}),
      });
    }
  };
  const server = createServer((req, res) => {
    // Node's HTTP server does not await listener promises. Also catch failures
    // while writing an error response, e.g. after the connection has closed.
    void handleRequest(req, res).catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((r, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', r);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  startEngine();
  const connectionTimer = options.bootstrap
    ? setInterval(() => {
        void connect();
      }, 1000)
    : undefined;
  connectionTimer?.unref();
  return {
    server,
    url: origin,
    close: async () => {
      stopping = true;
      // Ведущий цикл прерывается первым — до отметки остановки: его стадия не
      // пытается снять паузу, которую отметка уже не даст снять. Его идущую
      // стадию `lead.stop` дожидается ниже, в прежнем порядке.
      lead?.halt();
      // Отметка остановки в базе — до остановки прочих исполнителей: запуск
      // очереди из другого процесса отклоняется всё окно остановки.
      try {
        scheduler?.beginStop();
      } catch {
        // Хранилище недоступно: остановка продолжается и без отметки.
      }
      clearInterval(connectionTimer);
      await connecting;
      await deliveryRunner?.stop();
      await previewRunner?.stop();
      await workspaceRunner?.stop();
      await lead?.stop();
      await scheduler?.stop();
      if (options.bootstrap && h) h.store.close();
      await vite?.close();
      const closed = new Promise<void>((r) => server.close(() => r()));
      // Открытая панель опрашивает сервер и держит keep-alive соединения
      // занятыми: без их закрытия остановка ждала бы, пока закроют вкладку.
      server.closeAllConnections();
      await closed;
    },
  };
}
