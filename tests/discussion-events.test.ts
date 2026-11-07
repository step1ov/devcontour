import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discussionChanged, onDiscussionChanged } from '../src/web/discussion-events.ts';

// Тред задачи в панели читает ответ на вопрос исполнителя сразу после
// действия карточки вопроса, а не на следующем опросе раз в 20 с: без этого
// ответ появлялся в обсуждении с задержкой до 20 с, и e2e ответа в панели
// ловил гонку с опросом.

test('Изменение обсуждения задачи будит подписку этой задачи и только её; отписка снимает', () => {
  const seen: string[] = [];
  const offA = onDiscussionChanged('T-a', () => seen.push('a'));
  const offB = onDiscussionChanged('T-b', () => seen.push('b'));
  discussionChanged('T-a');
  assert.deepEqual(seen, ['a']);
  offA();
  discussionChanged('T-a');
  discussionChanged('T-b');
  assert.deepEqual(seen, ['a', 'b']);
  offB();
});
