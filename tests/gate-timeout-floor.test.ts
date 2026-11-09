// Нижний предел срока проверок: короткий `timeoutMs` быстрой проверки под
// нагрузкой хоста срывался и сжигал попытку. Конфигурация передаёт предел
// политике harness; это эксплуатационный ключ — план не переутверждается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '../src/core/model.ts';
import { approvalPolicyDigest, policyFromConfig } from '../src/harness/policy.ts';
import { profile } from '../src/runner/packs.ts';
import { DEFAULT_GATE_TIMEOUT_FLOOR_MS, projectConfig } from '../src/runner/setup.ts';
import { config } from './helpers.ts';

test('gateTimeoutFloorMs доходит до политики harness, ограничен сверху и не требует переутверждения плана', () => {
  const plain = config();
  assert.equal(plain.gateTimeoutFloorMs, undefined);
  assert.equal(
    policyFromConfig(plain).gateTimeoutFloorMs,
    undefined,
    'нет поля — сроки как объявлены',
  );
  const floored = config({ gateTimeoutFloorMs: 60_000 });
  const policy = policyFromConfig(floored);
  assert.equal(policy.gateTimeoutFloorMs, 60_000);
  // Объявленные сроки проверок в политике не меняются: предел действует при запуске.
  assert.deepEqual(
    policy.repositories[0].gates.map((g) => g.timeoutMs),
    policyFromConfig(plain).repositories[0].gates.map((g) => g.timeoutMs),
  );
  assert.equal(approvalPolicyDigest(floored), approvalPolicyDigest(plain));
  // Не безграничный: вне 1000–600000 мс конфигурация не загружается.
  for (const bad of [999, 600_001, 1500.5])
    assert.equal(
      configSchema.safeParse({ ...floored, gateTimeoutFloorMs: bad }).success,
      false,
      String(bad),
    );
});

test('Новая конфигурация setup исполняет каждую проверку не короче минуты', async () => {
  const c = projectConfig('/tmp/example-repository', await profile('npm-project'));
  assert.equal(DEFAULT_GATE_TIMEOUT_FLOOR_MS, 60_000);
  assert.equal(c.gateTimeoutFloorMs, DEFAULT_GATE_TIMEOUT_FLOOR_MS);
  assert.equal(policyFromConfig(c).gateTimeoutFloorMs, 60_000);
});
