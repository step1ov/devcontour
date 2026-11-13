import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_ASK,
  DEMO_ASK_CONTRACT,
  DEMO_ASK_PRODUCT,
  demoAdapter,
} from '../src/runner/adapters.ts';

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

test('The demo writer asks the contract question for [demo:ask-contract]', async () => {
  assert.ok(!DEMO_ASK_CONTRACT.includes(DEMO_ASK), 'the markers do not contain each other');
  const contract = await ask(`Result ${DEMO_ASK} ${DEMO_ASK_CONTRACT}.`);
  assert.deepEqual(contract?.affects, ['contract', 'acceptance']);
  assert.deepEqual((await ask(`Result ${DEMO_ASK_CONTRACT}.`))?.affects, [
    'contract',
    'acceptance',
  ]);
});

test('A demo review with no task outside the input review is refused with a clear error', async () => {
  const review = (prompt: string) =>
    demoAdapter.execute({
      signal: new AbortController().signal,
      review: true,
      cwd: '/nonexistent',
      prompt,
    } as unknown as Request);
  await assert.rejects(review('Subject: plan B-board\nReview the board plan.'), (e: Error) => {
    assert.ok(!(e instanceof TypeError), e.message);
    assert.match(e.message, /^Demo-ревью без задачи не поддерживается/);
    return true;
  });
  // Ревью ответа на вопрос исполнителя без задачи по-прежнему одобряется.
  const input = (await review('Subject: plan input-IR-' + 'a'.repeat(24) + '\n')) as {
    data: { approved: boolean };
  };
  assert.equal(input.data.approved, true);
});
