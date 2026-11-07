import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspace } from '../src/runner/start.ts';
import { product } from '../tests/preparation-fixture.ts';

// Центр внимания через API работающего сервера до setup: список, отметки,
// действие с проверкой показанной версии, история и операция ведущего.
// Интерфейс центра — D05; здесь только договор данных.

interface Item {
  id: string;
  sourceKey: string;
  occurrenceId: string;
  sourceVersion: string;
  source: string;
  actor: 'operator' | 'lead';
  category: string;
  actions: { id: string; kind: string }[];
  state: { read: boolean; acknowledged: boolean; unread: boolean };
}

test('Attention API before setup: list, marks, stale and resolved acts, history and the lead op', async ({
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-ui-attention-'));
  const app = await startWorkspace(join(root, 'workspace'), { port: 0, workspaceMode: 'embedded' });
  const headers = { 'X-DevContour-Request': '1' };
  const agent = async (operation: string, input: unknown = {}) => {
    const response = await request.post(app.url + '/api/agent', {
      headers,
      data: { operation, input },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()) as Record<string, unknown>;
  };
  const list = async (query = '') => {
    const response = await request.get(app.url + '/api/attention' + query);
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()) as {
      engineConnected: boolean;
      counts: { unread: number };
      items: Item[];
    };
  };
  try {
    await agent('preparation_create', { title: 'Модерация чата' });
    const status = await agent('preparation_status');
    const changeId = String(status.activeChangeId);
    await agent('preparation_question', {
      changeId,
      stage: 'architecture',
      add: [{ text: 'Кто модерирует чат ночью?', options: ['Бот', 'Дежурный'] }],
    });
    const draft = (await agent('preparation_product', {
      changeId,
      expectedDigest: null,
      reason: 'Постановка',
      content: product,
    })) as { current: { product: { digest: string } } };
    await agent('preparation_submit', {
      changeId,
      stage: 'product',
      expectedDigest: draft.current.product.digest,
    });

    const view = await list();
    expect(view.engineConnected).toBe(false);
    const question = view.items.find((i) => i.source === 'prep-question')!;
    const stage = view.items.find((i) => i.source === 'prep-stage')!;
    expect(question.actor).toBe('operator');
    expect(question.state.unread).toBe(true);
    expect(stage.actions.map((a) => a.id)).toContain('approve');
    expect((await list('?actor=lead')).items.every((i) => i.actor === 'lead')).toBe(true);

    // «Увидел» — не «решено»: карточка остаётся в списке.
    const marked = await request.post(app.url + '/api/attention/marks', {
      headers,
      data: {
        marks: [
          {
            sourceKey: question.sourceKey,
            occurrenceId: question.occurrenceId,
            version: question.sourceVersion,
            kind: 'ack',
          },
        ],
      },
    });
    expect(marked.ok()).toBeTruthy();
    const seen = (await list()).items.find((i) => i.id === question.id)!;
    expect(seen.state).toEqual({ read: true, acknowledged: true, unread: false });

    // Решение из старой вкладки: версия другая — attention-stale.
    const stale = await request.post(app.url + '/api/attention/act', {
      headers,
      data: {
        sourceKey: stage.sourceKey,
        occurrenceId: stage.occurrenceId,
        expectedVersion: 'not-the-shown-version',
        action: 'approve',
      },
    });
    expect(stale.status()).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('attention-stale');

    const act = (item: Item, action: string, input?: unknown) =>
      request.post(app.url + '/api/attention/act', {
        headers,
        data: {
          sourceKey: item.sourceKey,
          occurrenceId: item.occurrenceId,
          expectedVersion: item.sourceVersion,
          action,
          ...(input ? { input } : {}),
        },
      });
    const answered = await act(question, 'answer', { text: 'Дежурный модератор' });
    expect(answered.ok(), await answered.text()).toBeTruthy();
    expect(((await answered.json()) as { resolved: boolean }).resolved).toBe(true);
    const again = await act(question, 'answer', { text: 'Дежурный модератор' });
    expect(again.status()).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('attention-resolved');

    const history = (await (await request.get(app.url + '/api/attention?view=history')).json()) as {
      items: (Item & { resolvedAt: string | null })[];
    };
    const resolved = history.items.find((i) => i.id === question.id)!;
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.actions).toEqual([]);

    // Ведущему — тот же список его карточек, без отметок оператора.
    const lead = await agent('attention_list', {});
    expect(Array.isArray(lead.items)).toBe(true);
    for (const item of lead.items as Record<string, unknown>[]) {
      expect(item.actor).toBe('lead');
      expect('state' in item).toBe(false);
    }
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
