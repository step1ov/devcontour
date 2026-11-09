/**
 * Заголовок и текст раздела «Разработка» показанного изменения. Изменения
 * независимы: пока показанное изменение ждёт согласований, работа уже
 * утверждённых изменений идёт — их доски, повторы задач и очередь доступны,
 * и панель называет их вместо «разработка ещё не разрешена» для всего workspace.
 */
export interface DevelopmentStatusInput {
  developmentReady: boolean;
  engineConnected?: boolean;
  blocker: string;
  current?: { id: string };
  readyChanges?: { id: string; key: string; title: string }[];
}
export function developmentStatus(view: DevelopmentStatusInput) {
  const others = (view.readyChanges ?? []).filter((c) => c.id !== view.current?.id);
  if (view.developmentReady)
    return {
      title: 'Постановка и архитектура утверждены',
      text: view.engineConnected
        ? 'Агент может декомпозировать работу и запустить технический workflow. Тесты, независимое ревью и приёмка остаются обязательными.'
        : 'Агент готовит репозитории, профили и настоящие проверки. Панель подключит технический workflow автоматически.',
      step: 'Разрешена',
    };
  if (others.length)
    return {
      title: 'Разработка этого изменения ещё не разрешена',
      text: `${view.blocker.replace(/\.$/, '')}. Работа утверждённых изменений продолжается: ${others
        .map((c) => `${c.key} — ${c.title}`)
        .join('; ')}.`,
      step: 'Ожидает согласований',
    };
  return {
    title: 'Разработка ещё не разрешена',
    text: view.blocker,
    step: 'Ожидает согласований',
  };
}
