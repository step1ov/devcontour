import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_ASK, DEMO_ASK_PRODUCT, demoAdapter } from '../src/runner/adapters.ts';

// Fixture demo-исполнителя (не модель): `[demo:ask]` спрашивает без
// критической области — в режиме agent отвечает ведущий; `[demo:ask-product]`
// задевает продукт — отвечает оператор. На этом держатся e2e центра внимания.

type Request = Parameters<typeof demoAdapter.execute>[0];
const ask = async (description: string) => {
  const r = {
    signal: new AbortController().signal,
    task: { id: 'T-demo', description },
    prompt: 'no answer yet',
  } as unknown as Request;
  const out = (await demoAdapter.execute(r)) as {
    data: { inputRequest?: { affects: string[]; options: { id: string }[] } };
  };
  return out.data.inputRequest;
};

test('The demo writer asks the product-area question only for [demo:ask-product]', async () => {
  assert.ok(!DEMO_ASK_PRODUCT.includes(DEMO_ASK), 'the markers do not contain each other');
  const product = await ask(`Result ${DEMO_ASK_PRODUCT}.`);
  assert.deepEqual(product?.affects, ['product']);
  assert.deepEqual(
    product?.options.map((o) => o.id),
    ['json', 'yaml'],
  );
  const plain = await ask(`Result ${DEMO_ASK}.`);
  assert.deepEqual(plain?.affects, []);
});
