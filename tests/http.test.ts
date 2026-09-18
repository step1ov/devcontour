import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
test('Loopback API rejects cross-origin writes, validates input and survives missing assets', async () => {
  const f = fixture();
  const scheduler = new Scheduler(f.h, f.root);
  const app = await serve(f.h, scheduler, { port: 0 });
  try {
    const request = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(app.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await request(
          '/api/boards',
          { title: 'Injected board' },
          { Origin: 'https://untrusted.example', 'X-DevContour-Request': '1' },
        )
      ).status,
      403,
    );
    assert.equal((await request('/api/boards', { title: 'Injected board' })).status, 403);
    assert.equal(
      (await request('/api/boards', { title: 'x' }, { 'X-DevContour-Request': '1' })).status,
      400,
    );
    assert.equal(
      (await request('/api/evidence', { passed: true }, { 'X-DevContour-Request': '1' })).status,
      404,
    );
    assert.equal((await fetch(app.url + '/assets/does-not-exist.js')).status, 404);
    const response = await fetch(app.url + '/api/state');
    assert.equal(response.status, 200);
    const agent = await request(
      '/api/agent',
      { operation: 'project_context', input: {} },
      { 'X-DevContour-Request': '1' },
    );
    assert.equal(agent.status, 200);
    assert.equal((await agent.json()).protocolVersion, 1);
    assert.equal(
      (
        await request(
          '/api/agent',
          { operation: 'mark_done', input: { passed: true } },
          { 'X-DevContour-Request': '1' },
        )
      ).status,
      400,
    );
    assert.equal(
      (await request('/api/agent', { operation: 'project_context', input: {} })).status,
      403,
    );
    assert.equal(((await response.json()) as { dataRoot: string }).dataRoot, f.root);
    assert.equal(
      (await request('/api/boards', { title: 'Valid board' }, { 'X-DevContour-Request': '1' }))
        .status,
      200,
    );
    assert.equal(f.store.read().boards.length, 1);
    const headers = { 'X-DevContour-Request': '1' };
    const created = await request(
      '/api/changesets',
      {
        title: 'Feature review',
        description: 'Verify product and library together',
        boardIds: [f.store.read().boards[0].id],
      },
      headers,
    );
    assert.equal(created.status, 200);
    const change = (await created.json()) as { id: string };
    assert.equal((await request(`/api/changesets/${change.id}/verify`, {}, headers)).status, 409);
    assert.equal((await request(`/api/changesets/${change.id}/accept`, {}, headers)).status, 409);
    for (const action of ['handoff', 'remote-check']) {
      assert.equal(
        (await request(`/api/changesets/${change.id}/${action}`, {}, headers)).status,
        409,
      );
    }
    assert.equal(
      (await request(`/api/changesets/${change.id}/evidence`, { passed: true }, headers)).status,
      404,
    );
    const journal = await fetch(app.url + `/api/changesets/${change.id}/journal`);
    assert.equal(journal.status, 200);
    assert.match(((await journal.json()) as { content: string }).content, /Feature review/);
    assert.equal(f.store.read().changeSets[0].acceptance, undefined);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('Two workspace servers use distinct ports and report their own state paths', async () => {
  const left = fixture(),
    right = fixture();
  let a: Awaited<ReturnType<typeof serve>> | undefined,
    b: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    left.h.config.workspaceRoot = left.root;
    right.h.config.workspaceRoot = right.root;
    left.h.createBoard('Shop workspace');
    right.h.createBoard('CRM workspace');
    a = await serve(left.h, new Scheduler(left.h, left.root), { port: 0 });
    b = await serve(right.h, new Scheduler(right.h, right.root), { port: 0 });
    assert.notEqual(a.url, b.url);
    const [sa, sb] = await Promise.all([
      fetch(a.url + '/api/state').then((r) => r.json()),
      fetch(b.url + '/api/state').then((r) => r.json()),
    ]);
    assert.equal(sa.boards[0].title, 'Shop workspace');
    assert.equal(sb.boards[0].title, 'CRM workspace');
    assert.equal(sa.dataRoot, left.root);
    assert.equal(sb.dataRoot, right.root);
    assert.equal(sa.config.workspaceRoot, left.root);
    assert.equal(sb.config.workspaceRoot, right.root);
  } finally {
    await a?.close();
    await b?.close();
    left.cleanup();
    right.cleanup();
  }
});
