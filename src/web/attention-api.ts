// Запросы центра внимания. В отличие от локальных помощников `post()`, они
// не бросают текст ошибки, а возвращают статус и тело: интерфейсу нужны
// `code` и текущая карточка ответа 409. Сетевой отказ — статус 0.
import type { AttentionActInput, AttentionMarkInput } from '../core/attention-model.ts';
import type { AttentionHistoryView, AttentionView } from '../application/attention.ts';
import type { AttentionItem } from './attention-logic.ts';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  body?: T & { error?: string; code?: string; item?: AttentionItem };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    const response = await fetch('/api/attention' + path, init);
    const body = (await response.json().catch(() => undefined)) as ApiResult<T>['body'];
    return { ok: response.ok, status: response.status, body };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return { ok: false, status: 0 };
  }
}

const post = <T>(path: string, value: unknown) =>
  call<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
    body: JSON.stringify(value),
  });

const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  return search ? '?' + search : '';
};

export type ListParams = { actor?: string; category?: string; component?: string };

export const getAttention = (params: ListParams, signal?: AbortSignal) =>
  call<AttentionView>(query(params), { signal });

export const getHistory = (params: ListParams, signal?: AbortSignal) =>
  call<AttentionHistoryView>(query({ view: 'history', ...params }), { signal });

export const postMarks = (marks: AttentionMarkInput['marks']) =>
  post<{
    marked: { sourceKey: string; occurrenceId: string }[];
    ignored: { sourceKey: string; occurrenceId: string }[];
  }>('/marks', { marks });

export type ActResponse = {
  result?: { replayed?: boolean } & Record<string, unknown>;
  item?: AttentionItem;
  resolved?: true;
};
export const postAct = (input: AttentionActInput) => post<ActResponse>('/act', input);
