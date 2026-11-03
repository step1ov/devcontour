// Тарифы и бюджеты в doctor: что действует и где оценка стоимости
// разойдётся с ожиданием оператора. Без чтения базы: вызовы передаёт doctor.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetsSchema, pricesSchema, type Config, type DevContourState } from '../core/model.ts';
import { loadedDigest } from '../core/service.ts';
import type { Price, UsageRecord } from '../core/usage.ts';
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

/**
 * Объявление `budgets`/`prices` в `<workspace>/workspace.json`, если оно есть
 * и читается. Нечитаемый реестр — не повод для отказа doctor: расхождение
 * тогда не проверяется.
 */
export function workspaceDeclaration(config: Config) {
  if (!config.workspaceRoot) return undefined;
  const file = join(config.workspaceRoot, 'workspace.json');
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return {
      ...(raw.budgets !== undefined ? { budgets: budgetsSchema.parse(raw.budgets) } : {}),
      ...(raw.prices !== undefined ? { prices: pricesSchema.parse(raw.prices) } : {}),
    };
  } catch {
    return undefined;
  }
}

export function budgetChecks(
  config: Config,
  calls: DoctorCall[] = [],
  declaration?: { budgets?: Config['budgets']; prices?: Config['prices'] },
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
          .join('; ')
      : 'Тарифы не заданы: стоимость известна только там, где её сообщает провайдер (claude)',
  });
  checks.push({
    id: 'budgets',
    status: 'passed',
    detail: budgets
      ? `задача: ${limit(budgets.task)}; доска: ${limit(budgets.board)}; workspace: ${limit(budgets.workspace)}; onUnknown: ${budgets.onUnknown}`
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
    const differs = (['budgets', 'prices'] as const).filter(
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
  }
  return checks;
}

/**
 * Показанные `prices`/`budgets` — из config.json; работающий контур действует
 * по применённой конфигурации. Если её digest другой, правка файла ещё не
 * действует: doctor говорит, как её применить. Без записи о применении
 * (контур не запускался) сравнивать не с чем — проверки нет.
 */
export function appliedCheck(
  config: Config,
  state?: Partial<Pick<DevContourState, 'leader' | 'appliedConfig'>>,
  now = Date.now(),
): Check | undefined {
  const applied = state?.appliedConfig;
  if (!applied || applied.digest === loadedDigest(config)) return undefined;
  const live = !!state.leader && state.leader.leaseUntil > now;
  return {
    id: 'budgets:applied',
    status: 'degraded',
    detail: `config.json отличается от конфигурации, применённой контуром ${applied.at}: показанные prices и budgets могут ещё не действовать. ${
      live
        ? 'Не применено — выполните devcontour config-apply --keys budgets,prices (прочие ключи применяет перезапуск serve)'
        : 'Не применено — следующий запуск serve применит config.json целиком'
    }.`,
  };
}
