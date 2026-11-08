/** Ссылки панели: вид задаётся параметрами адреса. */
export const hrefs = {
  /** Изменение подготовки; этап и якорь ведут к его вопросам. */
  preparation: (changeId?: string, stage?: string, anchor?: string) =>
    (changeId
      ? `/?change=${encodeURIComponent(changeId)}` +
        (stage ? `&stage=${encodeURIComponent(stage)}` : '')
      : '/') + (anchor ? `#${anchor}` : ''),
  // Панель разработки внутри оболочки подготовки показывается с view=boards;
  // без подготовки параметр безвреден.
  task: (taskId: string) => `/?view=boards&tab=list&task=${encodeURIComponent(taskId)}`,
  /** Вопрос исполнителя в карточке задачи (якорь `input`: фокус на вопросе). */
  input: (taskId: string) => `/?view=boards&tab=list&task=${encodeURIComponent(taskId)}#input`,
  /** Сообщение обсуждения задачи (якорь `dm-<id>`). */
  message: (taskId: string, messageId: string) =>
    `/?view=boards&tab=list&task=${encodeURIComponent(taskId)}#dm-${messageId}`,
  board: (boardId: string) => `/?view=boards&tab=graph&board=${encodeURIComponent(boardId)}`,
  changesets: () => '/?view=boards&tab=changesets',
  /** Карточка изменения на экране изменений (якорь `changeset-<id>`). */
  changeset: (changeSetId: string) =>
    `/?view=boards&tab=changesets#changeset-${encodeURIComponent(changeSetId)}`,
  contracts: () => '/?view=boards&tab=contracts',
  overview: () => '/',
};
