import { planDraft, planDraftJsonSchema } from 'devcontour-harness/contracts';
import { z } from 'zod';
import { relatedRepositoriesTooMany, TASK_LIMITS, taskInput } from './model.ts';
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
/**
 * Вход импорта. `planResult` — общая схема harness и байты схемы runtime,
 * поэтому пределы задачи добавлены поверх неё, только на приёме плана.
 */
const draftTask = planResult.shape.tasks.element;
export const planIngest = planResult.extend({
  tasks: z
    .array(
      draftTask.extend({
        relatedRepositories: draftTask.shape.relatedRepositories
          .unwrap()
          .max(TASK_LIMITS.relatedRepositories, relatedRepositoriesTooMany)
          .optional(),
        dependsOn: draftTask.shape.dependsOn.max(
          TASK_LIMITS.dependsOn,
          `Зависимостей задачи не больше ${TASK_LIMITS.dependsOn}`,
        ),
        acceptance: draftTask.shape.acceptance.max(
          TASK_LIMITS.acceptance,
          `Критериев приёмки не больше ${TASK_LIMITS.acceptance}`,
        ),
        contracts: draftTask.shape.contracts.max(
          TASK_LIMITS.contracts,
          `Контрактов задачи не больше ${TASK_LIMITS.contracts}`,
        ),
      }),
    )
    .min(1)
    .max(30),
});
