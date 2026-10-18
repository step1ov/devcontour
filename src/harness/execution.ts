// Исполнение DevContour — движок harness над тем же Store.
//
// Правила выдачи, fencing, приёмки, повторов, бюджетов и recovery живут в
// пакете harness; здесь только сборка движка из конфигурации DevContour и
// перевод его отказов в ошибки прикладного слоя (тот же текст, класс по коду).
import { Engine, HarnessError, type ErrorCode } from 'devcontour-harness';
import { DomainError } from '../core/model.ts';
import { loadedDigest, type DevContour } from '../core/service.ts';
import { devcontourHost, projectionOptions } from './host.ts';
import { policyFromConfig } from './policy.ts';
import { DevContourExecutionStore } from './store.ts';

/** Движок и адаптер хранилища одного экземпляра DevContour с его конфигурацией. */
export interface Execution {
  /** Digest конфигурации, из которой собран движок. */
  readonly config: string;
  readonly store: DevContourExecutionStore;
  readonly engine: Engine;
}

const executions = new WeakMap<DevContour, Execution>();

/**
 * Движок для текущей конфигурации `h`. Изменилась конфигурация (применение
 * операции, правка объекта в процессе) — движок пересобирается: его политика
 * должна быть той, под которой процесс работает.
 */
export function executionOf(h: DevContour): Execution {
  const config = loadedDigest(h.config);
  const cached = executions.get(h);
  if (cached && cached.config === config) return cached;
  const store = new DevContourExecutionStore(h.store, projectionOptions(h));
  const engine = new Engine({
    host: devcontourHost(h, store),
    policy: policyFromConfig(h.config),
    policyIdentity: h.configDigest,
    provenance: () => h.configProvenance(),
    // Применённую конфигурацию записывает запуск планировщика (`recordConfig`),
    // как и прежде; прямая выдача попытки её не меняет.
    recordPolicyOnLead: false,
  });
  const execution = { config, store, engine };
  executions.set(h, execution);
  return execution;
}

const statusOf: Partial<Record<ErrorCode, number>> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
};

/** Отказ движка — ошибка прикладного слоя с тем же текстом; прочие ошибки — как есть. */
export function domain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw toDomain(error);
  }
}

export function toDomain(error: unknown) {
  if (error instanceof HarnessError) {
    const domainError = new DomainError(error.message, statusOf[error.code] ?? 409);
    (domainError as DomainError & { code?: ErrorCode }).code = error.code;
    return domainError;
  }
  return error;
}
