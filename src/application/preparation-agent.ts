import { Preparation } from '../core/preparation.ts';
import { preparationInputs, type PreparationOperation } from '../core/preparation-model.ts';
import type { Store } from '../core/store.ts';
import { agentRequest } from './agent.ts';
import { DomainError } from '../core/model.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { preparationStore } from '../runner/preparation-store.ts';
import { loadConfig } from '../runner/config.ts';
import { DevContour } from '../core/service.ts';
import { AgentService } from './agent.ts';

// The early workspace has no repository, stack, fake gates or model configuration.
export class PreparationAgent {
  constructor(readonly store: Store) {}
  execute(raw: unknown): Record<string, unknown> {
    if (Buffer.byteLength(JSON.stringify(raw)) > 100000)
      throw new DomainError('Слишком большой запрос', 413);
    const { operation, input } = agentRequest.parse(raw);
    if (!(operation in preparationInputs))
      throw new DomainError(
        'Пока доступна проработка продукта и архитектуры. Техническая конфигурация ещё не подключена',
        409,
      );
    const result = new Preparation(this.store).execute(
      operation as PreparationOperation,
      input ?? {},
    );
    if (Buffer.byteLength(JSON.stringify(result)) > 65536)
      throw new DomainError('Ответ превышает 64 KiB', 413);
    return result;
  }
}

// A stdio MCP connection can outlive bootstrap: open the current storage layout
// on each call instead of retaining a pre-component SQLite connection.
export class WorkspaceAgent {
  constructor(readonly root: string) {}
  execute(raw: unknown): Record<string, unknown> {
    const store = preparationStore(this.root);
    try {
      if (!existsSync(join(this.root, 'config.json')))
        return new PreparationAgent(store).execute(raw);
      return new AgentService(
        new DevContour(store, loadConfig(join(this.root, 'config.json'))),
      ).execute(raw);
    } finally {
      store.close();
    }
  }
}
