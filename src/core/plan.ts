import { planDraft, planDraftJsonSchema } from 'devcontour-harness/contracts';
import { taskInput } from './model.ts';
/**
 * Схема плана — общий draft harness (`planDraft`) с полями хоста: фича и
 * исполнитель. Импорт молча отбрасывал фичу: план с featureId у каждой задачи
 * приходил без неё и не утверждался — связь с фичей обязательна. Роли
 * объявляет workspace, и схема плана их не перечисляет: принадлежность
 * объявленным проверяет домен при импорте. `keyOrder` — прежний порядок
 * полей: по нему строятся JSON Schema runtime и каталог агентского API
 * (`catalogDigest`), их байты не меняются.
 */
export const planResult = planDraft(
  { featureId: taskInput.shape.featureId, assignee: taskInput.shape.assignee },
  {
    keyOrder: [
      'featureId',
      'requirements',
      'assignee',
      'scope',
      'relatedRepositories',
      'contextPacks',
      'writePaths',
      'gates',
      'properties',
      'resources',
      'repositoryId',
      'key',
      'title',
      'description',
      'role',
      'dependsOn',
      'acceptance',
      'contracts',
    ],
  },
);
export const planSchema = planDraftJsonSchema(planResult);
