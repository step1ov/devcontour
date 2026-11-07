// Сигнал «обсуждение задачи изменилось» внутри панели: карточка вопроса
// исполнителя записывает ответ сообщением обсуждения, и тред задачи читает
// его сразу, а не на следующем опросе (раз в 20 с).
const bus = new EventTarget();
const EVENT = 'discussion-changed';

/** Обсуждение задачи изменилось действием в этой вкладке. */
export function discussionChanged(taskId: string) {
  bus.dispatchEvent(new CustomEvent<string>(EVENT, { detail: taskId }));
}

/** Подписка треда задачи; возвращает отписку. */
export function onDiscussionChanged(taskId: string, listener: () => void): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<string>).detail === taskId) listener();
  };
  bus.addEventListener(EVENT, handler);
  return () => bus.removeEventListener(EVENT, handler);
}
