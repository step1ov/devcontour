import { z } from 'zod';
import { roles, taskInput } from './model.ts';
export const planResult = z.object({
  title: z.string().min(3).max(180),
  description: z.string().max(5000),
  tasks: z
    .array(
      z.object({
        requirements: taskInput.shape.requirements,
        assignee: taskInput.shape.assignee,
        scope: taskInput.shape.scope,
        relatedRepositories: taskInput.shape.relatedRepositories,
        contextPacks: taskInput.shape.contextPacks,
        writePaths: taskInput.shape.writePaths,
        resources: taskInput.shape.resources,
        repositoryId: z.string().default('main'),
        key: z.string().regex(/^[A-Za-z0-9_-]+$/),
        title: z.string().min(3).max(180),
        description: z.string().min(10).max(12000),
        role: z.enum(roles),
        dependsOn: z.array(z.string()),
        acceptance: z.array(z.string().min(3)).min(1),
        contracts: z.array(z.string()),
      }),
    )
    .min(1)
    .max(30),
});
export const planSchema = z.toJSONSchema(planResult, { target: 'draft-7' });
