import type { Config } from './model.ts';

/** Physical namespace; logical ownership is unchanged when one Git hosts both scopes. */
export function memoryDirectory(config: Config, repositoryId?: string) {
  return config.workspaceMode === 'embedded' && repositoryId
    ? `.devcontour/components/${repositoryId}`
    : '.devcontour';
}
