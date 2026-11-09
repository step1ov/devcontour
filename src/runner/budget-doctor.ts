// Тарифы и бюджеты в doctor: что действует и где оценка стоимости
// разойдётся с ожиданием оператора. Без чтения базы: вызовы передаёт doctor.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  budgetsSchema,
  configSchema,
  pricesSchema,
  type Config,
  type DevContourState,
} from '../core/model.ts';
import {
  configKeyDigests,
  loadedDigest,
  operationalKeys,
  type AppliedConfigKeys,
} from '../core/service.ts';
import { COST_ESTIMATE_RU, type Price, type UsageRecord } from '../core/usage.ts';
import { declaredRoles, repositories, reviewerBinding, roleBinding } from '../core/repositories.ts';

type Check = { id: string; status: 'passed' | 'degraded'; detail: string };
/** Вызов в doctor: только то, что нужно для сопоставления с тарифом. */
export type DoctorCall = Pick<UsageRecord, 'runtime' | 'model' | 'startedAt' | 'costSource'> & {
  outcome?: UsageRecord['outcome'];
};

/**
 * Runtime, стоимость вызова которого сообщает провайдер: тариф для него —
 * лишь запасная оценка. Остальным (codex) без тарифа стоимость неизвестна.
 */
const reportsCost = new Set(['claude']);
/** Окно «недавних вызовов». */
export const recentCallsMs = 30 * 24 * 60 * 60 * 1000;

const label = (runtime: string, model?: string | null) =>
  model ? `${runtime}/${model}` : `${runtime} (модель не сообщена)`;
const tariff = (p: Price) =>
  `${p.runtime}/${p.model} с ${p.effectiveAt}: input ${p.input}, output ${p.output}, cacheRead ${p.cacheRead}, cacheWrite ${p.cacheWrite} USD/MTok`;
const limit = (l?: { usd?: number; timeMs?: number }) =>
  l
    ? [l.usd !== undefined ? `${l.usd} USD` : '', l.timeMs !== undefined ? `${l.timeMs} мс` : '']
        .filter(Boolean)
        .join(', ')
    : 'нет';

/** Действующий сейчас тариф runtime/model (последний effectiveAt не позже `now`). */
const priced = (config: Config, runtime: string, model: string | null | undefined, now: number) =>
  !!model &&
  config.prices.some(
    (p) => p.runtime === runtime && p.model === model && Date.parse(p.effectiveAt) <= now,
  );

/** Эксплуатационные ключи, которые может объявить `workspace.json`. */
export type WorkspaceDeclaration = Partial<Pick<Config, 'budgets' | 'prices' | 'inputPolicy'>>;

/** Разобранный `<workspace>/workspace.json` или undefined (нет файла, нечитаем). */
function registry(config: Config) {
  if (!config.workspaceRoot) return undefined;
  const file = join(config.workspaceRoot, 'workspace.json');
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Объявление `budgets`/`prices`/`inputPolicy` в `<workspace>/workspace.json`,
 * если оно есть и читается. Нечитаемый реестр — не повод для отказа doctor:
 * расхождение тогда не проверяется. Каждый ключ разбирается отдельно:
 * неверный ключ не отключает сравнение остальных, а назван в `invalid`.
 */
export function workspaceDeclaration(
  config: Config,
): (WorkspaceDeclaration & { invalid?: (keyof WorkspaceDeclaration)[] }) | undefined {
  const raw = registry(config);
  if (!raw) return undefined;
  const schemas = {
    budgets: budgetsSchema,
    prices: pricesSchema,
    inputPolicy: configSchema.shape.inputPolicy,
  };
  const declared: WorkspaceDeclaration = {};
  const invalid: (keyof WorkspaceDeclaration)[] = [];
  for (const key of ['budgets', 'prices', 'inputPolicy'] as const) {
    if (raw[key] === undefined) continue;
    const parsed = schemas[key].safeParse(raw[key]);
    if (parsed.success) Object.assign(declared, { [key]: parsed.data });
    else invalid.push(key);
  }
  return { ...declared, ...(invalid.length ? { invalid } : {}) };
}

/**
 * Объявляет ли реестр ключ — как есть, без проверки значения: правку,
 * которую заменит следующий `workspace-init`, видно и при неверном
 * объявлении (его отклонит сам `workspace-init`).
 */
export function workspaceDeclares(config: Config, key: keyof WorkspaceDeclaration) {
  return registry(config)?.[key] !== undefined;
}

export function budgetChecks(
  config: Config,
  calls: DoctorCall[] = [],
  declaration?: WorkspaceDeclaration & { invalid?: (keyof WorkspaceDeclaration)[] },
  now = Date.now(),
): Check[] {
  const checks: Check[] = [];
  const budgets = config.budgets;
  checks.push({
    id: 'prices',
    status: 'passed',
    detail: config.prices.length
      ? [...config.prices]
          .sort(
            (a, b) =>
              a.runtime.localeCompare(b.runtime) ||
              a.model.localeCompare(b.model) ||
              Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt),
          )
          .map(tariff)
          .join('; ') + ` (по ним стоимость — ${COST_ESTIMATE_RU}, не списание)`
      : 'Тарифы не заданы: стоимость известна только там, где её сообщает провайдер (claude)',
  });
  checks.push({
    id: 'budgets',
    status: 'passed',
    // Предел workspace — на весь прошлый расход, а не на сессию; суммы —
    // эквивалент по тарифам API, а не списание по подписке.
    detail: budgets
      ? `задача: ${limit(budgets.task)}; доска: ${limit(budgets.board)}; workspace (за всё время workspace): ${limit(budgets.workspace)}; onUnknown: ${budgets.onUnknown}` +
        ([budgets.task, budgets.board, budgets.workspace].some((l) => l?.usd !== undefined)
          ? `; суммы USD — ${COST_ESTIMATE_RU}, не списание`
          : '')
      : 'Бюджеты не заданы: расходы вызовов не ограничены',
  });

  // Привязки ролей (исполнитель и ревьюер) без тарифа у runtime, чью стоимость
  // провайдер не сообщает: их вызовы будут с неизвестной стоимостью.
  const unpriced = new Map<string, string[]>();
  for (const repo of repositories(config))
    for (const role of declaredRoles(config, repo.id))
      for (const [binding, who] of [
        [roleBinding(config, role, repo.id), role],
        [reviewerBinding(config, role, repo.id), `${role} (ревьюер)`],
      ] as const) {
        if (binding.runtime === 'demo' || reportsCost.has(binding.runtime)) continue;
        if (priced(config, binding.runtime, binding.model, now)) continue;
        const key = label(binding.runtime, binding.model);
        unpriced.set(key, [...(unpriced.get(key) ?? []), `${repo.id}:${who}`]);
      }
  if (unpriced.size)
    checks.push({
      id: 'prices:roles',
      status: 'degraded',
      detail: `Роли на runtime без тарифа, чью стоимость провайдер не сообщает: ${[...unpriced]
        .map(([key, roles]) => `${key} — ${roles.join(', ')}`)
        .join(
          '; ',
        )}. Их вызовы будут с неизвестной стоимостью. Задайте prices для модели, которую сообщает runtime (без закреплённой модели тариф не сопоставить заранее).`,
    });

  // Недавние завершённые вызовы с неизвестной стоимостью и без тарифа сейчас:
  // так же будут оценены и следующие вызовы этой модели.
  const seen = new Map<string, number>();
  for (const call of calls) {
    if (call.outcome === 'active' || call.costSource !== 'unknown') continue;
    if (now - Date.parse(call.startedAt) > recentCallsMs) continue;
    if (priced(config, call.runtime, call.model, now)) continue;
    const key = label(call.runtime, call.model);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  if (seen.size)
    checks.push({
      id: 'prices:calls',
      status: 'degraded',
      detail: `Вызовы за 30 дней с неизвестной стоимостью и без действующего тарифа: ${[...seen]
        .map(([key, n]) => `${key} — ${n}`)
        .join(
          '; ',
        )}. Добавьте тариф для модели; вызовы без сообщённой модели оценить нельзя. Прошлые вызовы тариф не переоценивает.`,
    });

  const usd = !!budgets && [budgets.task, budgets.board, budgets.workspace].some((l) => l?.usd);
  if (usd && budgets.onUnknown === 'stop' && unpriced.size)
    checks.push({
      id: 'budgets:on-unknown',
      status: 'degraded',
      detail: `onUnknown: "stop" при ролях без тарифа (${[...unpriced.keys()].join(', ')}): первый же их вызов с неизвестной стоимостью сделает денежный бюджет неопределённым, и выдача в его области остановится. Задайте prices или onUnknown: "continue".`,
    });
  if (usd && budgets.onUnknown === 'continue') {
    const estimated = [
      ...new Set(
        [...unpriced.keys(), ...seen.keys()]
          .map((key) => key.split(/[/ ]/)[0])
          .filter(
            (runtime) =>
              !reportsCost.has(runtime) && config.prices.every((p) => p.runtime !== runtime),
          ),
      ),
    ];
    if (estimated.length)
      checks.push({
        id: 'budgets:prices',
        status: 'degraded',
        detail: `Денежные бюджеты заданы, а тарифов для ${estimated.join(', ')} нет: их вызовы в предел не входят, и расход считается по нижней границе.`,
      });
  }

  if (declaration) {
    const differs = (['budgets', 'prices', 'inputPolicy'] as const).filter(
      (k) =>
        declaration[k] !== undefined &&
        JSON.stringify(declaration[k]) !== JSON.stringify(config[k] ?? null),
    );
    if (differs.length)
      checks.push({
        id: 'budgets:declaration',
        status: 'degraded',
        detail: `config.json расходится с объявлением workspace.json: ${differs.join(', ')}. Действует значение config.json (локальное переопределение) до следующего workspace-init, который вернёт объявление.`,
      });
    if (declaration.invalid?.length)
      checks.push({
        id: 'budgets:declaration-invalid',
        status: 'degraded',
        detail: `workspace.json объявляет неверное значение: ${declaration.invalid.join(', ')}. Этот ключ с config.json не сравнивается, и workspace-init отклонит такой реестр; исправьте объявление.`,
      });
  }
  return checks;
}

/**
 * Показанные `prices`/`budgets` — из config.json; работающий контур действует
 * по применённой конфигурации. Если её digest другой, правка файла ещё не
 * действует: doctor говорит, как её применить. Без записи о применении
 * (контур не запускался) сравнивать не с чем — проверки нет.
 *
 * Когда известны digest ключей применённой конфигурации (`appliedKeys` с тем
 * же общим digest), сравниваются ключи: `budgets:applied` — только если
 * отличаются `budgets` или `prices`. Отличие одних прочих ключей (например,
 * `contextPacks` после context-lock) — отдельная проверка `config:applied`.
 * Способ применения назван по ключам: эксплуатационные (`stallSweep`,
 * `inputPolicy`, `gateTimeoutFloorMs`) работающий сервер применяет
 * `config-apply --keys`, прочие —
 * только перезапуск serve.
 */
export function appliedCheck(
  config: Config,
  state?: Partial<Pick<DevContourState, 'leader' | 'appliedConfig'>> & {
    appliedKeys?: AppliedConfigKeys;
  },
  now = Date.now(),
): Check | undefined {
  const applied = state?.appliedConfig;
  if (!applied || applied.digest === loadedDigest(config)) return undefined;
  const live = !!state.leader && state.leader.leaseUntil > now;
  const recorded =
    state.appliedKeys?.digest === applied.digest ? state.appliedKeys.keys : undefined;
  let changed: string[] | undefined;
  if (recorded) {
    const current = configKeyDigests(config);
    changed = [...new Set([...Object.keys(current), ...Object.keys(recorded)])]
      .filter((key) => current[key] !== recorded[key])
      .sort();
    // Общий digest отличается только порядком ключей: содержимое то же.
    if (!changed.length) return undefined;
    if (!changed.some((key) => key === 'budgets' || key === 'prices'))
      return {
        id: 'config:applied',
        status: live ? 'degraded' : 'passed',
        detail: `config.json отличается от конфигурации, применённой контуром ${applied.at}, ключами ${changed.join(', ')}; prices и budgets те же. ${
          live
            ? `Работающий сервер их не применил — ${remedy(changed)}`
            : 'Следующий запуск serve применит config.json целиком'
        }.`,
      };
  }
  return {
    id: 'budgets:applied',
    status: 'degraded',
    detail: `config.json отличается от конфигурации, применённой контуром ${applied.at}${
      changed ? ` (ключи ${changed.join(', ')})` : ''
    }: показанные prices и budgets могут ещё не действовать. ${
      live
        ? `Не применено — ${
            changed
              ? remedy(changed)
              : 'выполните devcontour config-apply --keys budgets,prices (прочие ключи применяет перезапуск serve)'
          }`
        : 'Не применено — следующий запуск serve применит config.json целиком'
    }.`,
  };
}

/**
 * Как применить отличающиеся ключи к работающему серверу: эксплуатационные
 * (`config-apply --keys` из `operationalKeys`) — без перезапуска, прочие —
 * перезапуском serve.
 */
function remedy(changed: readonly string[]) {
  const live = operationalKeys.filter((key) => changed.includes(key));
  const restart = changed.filter((key) => !(operationalKeys as readonly string[]).includes(key));
  return [
    ...(live.length ? [`выполните devcontour config-apply --keys ${live.join(',')}`] : []),
    ...(restart.length
      ? [
          live.length
            ? `${restart.join(', ')} применит только перезапуск serve`
            : 'перезапустите serve',
        ]
      : []),
  ].join('; ');
}
