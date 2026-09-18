import { z } from 'zod';
import { DevContour, digest } from './service.ts';
import { DomainError } from './model.ts';
import { repository } from './repositories.ts';
import { boardOwner } from './sync-state.ts';

const key = z.string().min(1).max(200);
export const signalInput = z.strictObject({
  source: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  eventId: key,
  incidentId: key,
  repositoryId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  observedAt: z.iso.datetime(),
  state: z.enum(['open', 'resolved']),
  title: z.string().min(3).max(180),
  summary: z.string().min(10).max(8000),
  evidenceUrl: z.url().refine((url) => ['http:', 'https:'].includes(new URL(url).protocol)),
  boardId: key.optional(),
  roots: z.array(key).max(100).optional(),
});
type Signal = z.infer<typeof signalInput>;
type Receipt = {
  kind: 'event';
  payloadDigest: string;
  source: string;
  receivedAt: string;
  action: 'proposed' | 'corrected' | 'observed' | 'out-of-order';
  boardId?: string;
  taskIds: string[];
  signal: Signal;
};
type Incident = {
  kind: 'incident';
  state: Signal['state'];
  observedAt: string;
  boardId?: string;
  taskIds: string[];
};

export class SignalInbox {
  constructor(readonly h: DevContour) {}
  ingest(raw: unknown) {
    const signal = signalInput.parse(raw),
      owner = signal.repositoryId;
    repository(this.h.config, owner);
    if (Date.parse(signal.observedAt) > Date.now() + 300000)
      throw new DomainError('Время сигнала находится в будущем');
    const eventKey = 'event-' + digest([signal.source, signal.eventId]);
    const incidentKey = 'incident-' + digest([signal.source, signal.incidentId]);
    const payloadDigest = digest(signal);
    return this.h.store.atomic(() => {
      const records = this.h.store.localRecords<Receipt | Incident>('signals', owner);
      const duplicate = records[eventKey] as Receipt | undefined;
      if (duplicate) {
        if (duplicate.payloadDigest !== payloadDigest)
          throw new DomainError('Event ID повторён с другим содержимым');
        return {
          eventKey,
          action: duplicate.action,
          boardId: duplicate.boardId,
          taskIds: duplicate.taskIds,
          duplicate: true,
        };
      }
      const previous = records[incidentKey] as Incident | undefined;
      let incident: Incident = previous ?? {
        kind: 'incident',
        state: signal.state,
        observedAt: signal.observedAt,
        taskIds: [],
      };
      let action: Receipt['action'] = 'observed';
      if (previous && Date.parse(signal.observedAt) <= Date.parse(previous.observedAt))
        action = 'out-of-order';
      else if (
        signal.state === 'open' &&
        (!previous?.taskIds.length || previous.state === 'resolved')
      ) {
        const recent = Object.values(records).filter(
          (r): r is Receipt =>
            r.kind === 'event' &&
            r.source === signal.source &&
            ['proposed', 'corrected'].includes(r.action) &&
            Date.parse(r.receivedAt) > Date.now() - 3600000,
        );
        if (recent.length >= this.h.config.signalPolicy.maxActionsPerHour)
          throw new DomainError('Лимит предложений источника за час исчерпан', 429);
        const s = this.h.store.read();
        const boardId = signal.boardId ?? previous?.boardId;
        const b = boardId ? s.boards.find((b) => b.id === boardId) : undefined;
        if (boardId && !b) throw new DomainError('Доска сигнала не найдена');
        if (b && boardOwner(b, s) !== owner)
          throw new DomainError('Сигнал должен поступать на доску своего компонента');
        const description = `Внешнее наблюдение (${signal.source}); сведения требуют проверки.\n${signal.summary}\nИсточник: ${signal.evidenceUrl}\nEvent: ${signal.eventId}; incident: ${signal.incidentId}`;
        if (b?.revisions.at(-1)?.status === 'accepted') {
          const roots = signal.roots ?? previous?.taskIds ?? [];
          const result = this.h.correct(b.id, roots, description.slice(0, 5000));
          incident = {
            kind: 'incident',
            state: signal.state,
            observedAt: signal.observedAt,
            boardId: b.id,
            taskIds: Object.values(result.replacements),
          };
          action = 'corrected';
        } else {
          const board =
            b ?? this.h.createBoard(signal.title, 'Предложенная работа из внешнего сигнала', owner);
          const task = this.h.addTask(board.id, {
            repositoryId: owner,
            scope: 'component',
            role: 'qa',
            title: signal.title,
            description,
            acceptance: [
              'Воспроизвести наблюдение и проверить причинную связь.',
              'Подтвердить исправление обязательными тестами и независимым ревью либо обосновать отсутствие дефекта.',
            ],
          });
          incident = {
            kind: 'incident',
            state: signal.state,
            observedAt: signal.observedAt,
            boardId: board.id,
            taskIds: [task.id],
          };
          action = 'proposed';
        }
      }
      if (action !== 'out-of-order')
        incident = { ...incident, state: signal.state, observedAt: signal.observedAt };
      const receipt: Receipt = {
        kind: 'event',
        payloadDigest,
        source: signal.source,
        receivedAt: new Date().toISOString(),
        action,
        boardId: incident.boardId,
        taskIds: incident.taskIds,
        signal,
      };
      this.h.store.saveLocal('signals', owner, eventKey, receipt);
      this.h.store.saveLocal('signals', owner, incidentKey, incident);
      return {
        eventKey,
        action,
        boardId: incident.boardId,
        taskIds: incident.taskIds,
        duplicate: false,
      };
    });
  }
  list(repositoryId: string) {
    repository(this.h.config, repositoryId);
    return Object.entries(this.h.store.localRecords<Receipt | Incident>('signals', repositoryId))
      .filter(([, v]) => v.kind === 'event')
      .map(([key, r]) => ({ key, ...(r as Receipt) }));
  }
}
