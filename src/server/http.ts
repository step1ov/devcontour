import { DeliveryRunner } from '../runner/forge.ts';
import { AgentContext, contextOperations } from '../application/context.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, extname, sep } from 'node:path';
import { ZodError, z } from 'zod';
import { Harness, specDigest } from '../core/service.ts';
import { DomainError } from '../core/model.ts';
import { blockers, readyTasks } from '../core/graph.ts';
import { Scheduler } from '../runner/scheduler.ts';
import { acceptBoard } from '../runner/agent-control.ts';
import { repositories } from '../core/repositories.ts';
import { WorkspaceRunner } from '../runner/workspace.ts';
import { attachJournal, renderJournal } from '../runner/journal.ts';
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
    if (Buffer.byteLength(text) > 100_000) throw new DomainError('Слишком большой запрос', 413);
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new DomainError('Некорректный JSON', 400);
  }
}
export async function serve(
  h: Harness,
  scheduler: Scheduler,
  options: { port: number; dev?: boolean },
) {
  attachJournal(h);
  const workspaceRunner = new WorkspaceRunner(h, scheduler.root);
  const deliveryRunner = new DeliveryRunner(h, scheduler.root);
  let origin = `http://127.0.0.1:${options.port}`;
  const vite = options.dev
    ? await (
        await import('vite')
      ).createServer({ server: { middlewareMode: true }, appType: 'spa' })
    : undefined;
  const server = createServer(async (req, res) => {
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
          (req.headers['x-harness-request'] !== '1' ||
            !req.headers['content-type']?.startsWith('application/json'))
        )
          throw new DomainError('Отсутствует заголовок локального клиента', 403);
        const parts = path.split('/').filter(Boolean);
        let result: unknown;
        if (req.method === 'POST' && path === '/api/agent') {
          const request = z
            .object({ operation: z.enum(contextOperations), input: z.unknown().optional() })
            .strict()
            .parse(await body(req));
          result = new AgentContext(h).execute(request.operation, request.input ?? {});
        } else if (req.method === 'GET' && path === '/api/state') {
          const state = h.store.read();
          result = {
            ...state,
            tasks: state.tasks.map((t) => ({
              ...t,
              specDigest: specDigest(t),
              blockers: blockers(t, state),
            })),
            events: h.store.events(),
            journalError: h.store.projectionError,
            dataRoot: resolve(scheduler.root),
            ready: readyTasks(state).map((t) => t.id),
            config: {
              name: h.config.name,
              workspaceRoot: h.config.workspaceRoot,
              repositories: repositories(h.config),
              workspaceGates: h.config.workspaceGates,
              mode: h.config.mode,
              approvalMode: h.config.approvalMode,
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
        } else if (req.method === 'GET' && parts[1] === 'changesets' && parts[3] === 'journal')
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
        } else if (req.method === 'GET' && parts[1] === 'boards' && parts[3] === 'impact')
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
          const file = await realpath(e.log);
          const roots = [
            join(scheduler.root, 'artifacts'),
            ...(h.config.storage === 'component'
              ? repositories(h.config).map((r) => join(r.path, '.harness/local/artifacts'))
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
          else if (parts[1] === 'changesets') {
            if (parts[3] === 'handoff' || parts[3] === 'remote-check') {
              result = await deliveryRunner[parts[3] === 'handoff' ? 'prepare' : 'check'](parts[2]);
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
          else if (path === '/api/scheduler') {
            const start = z.boolean().parse(input.start);
            h.pause(!start);
            if (start) await scheduler.tick();
            result = { paused: !start };
          } else if (parts[1] === 'boards') {
            if (parts[3] === 'tasks') result = h.addTask(parts[2], input);
            else if (parts[3] === 'approve')
              result = h.approve(parts[2], z.array(z.string()).optional().parse(input.taskIds));
            else if (parts[3] === 'accept') {
              result = await acceptBoard(h, parts[2], 'codex', true);
            } else if (parts[3] === 'correct')
              result = h.correct(
                parts[2],
                z.array(z.string()).parse(input.roots),
                z.string().parse(input.reason),
              );
            else throw new DomainError('Команда не найдена', 404);
          } else if (parts[1] === 'tasks') {
            if (parts[3] === 'retry') result = h.retry(parts[2]);
            else if (parts[3] === 'cancel') result = h.cancel(parts[2]);
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
      });
    }
  });
  await new Promise<void>((r, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', r);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  scheduler.start();
  return {
    server,
    url: origin,
    close: async () => {
      await deliveryRunner.stop();
      await workspaceRunner.stop();
      await scheduler.stop();
      await vite?.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
