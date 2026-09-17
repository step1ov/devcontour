import { roleBinding, reviewerBinding } from '../core/repositories.ts';
import type { Config, Role, RuntimeName } from '../core/model.ts';
import type { ToolProfile } from '../core/integrations.ts';
import { executionEnvironment } from './environment.ts';

export function toolProfileFor(
  config: Config,
  runtime: RuntimeName,
  role?: Role,
  review = false,
  repositoryId = config.repositories[0]?.id ?? 'main',
) {
  const selected = role
    ? review
      ? reviewerBinding(config, role, repositoryId)
      : roleBinding(config, role, repositoryId)
    : undefined;
  const id = selected?.runtime === runtime ? selected.toolProfile : undefined;
  const profile = config.toolProfiles[id ?? `${runtime}${review ? '-review' : ''}`];
  if (id && !profile) throw new Error('Неизвестный профиль инструментов: ' + id);
  if (profile && profile.runtime !== runtime)
    throw new Error('Runtime профиля инструментов не совпадает');
  return profile;
}
export function agentEnvironment(
  config: Config,
  profile: ToolProfile | undefined,
  extra: NodeJS.ProcessEnv = {},
) {
  const mcpNames = [
    ...new Set(
      Object.values(profile?.mcp ?? {}).flatMap((s) => [
        ...s.env,
        ...(s.bearerTokenEnv ? [s.bearerTokenEnv] : []),
      ]),
    ),
  ];
  // Native credential files remain available through HOME; env credentials are explicit.
  return executionEnvironment(
    [config.environment, profile?.environment, { inherit: mcpNames, values: {}, secrets: {} }],
    extra,
  );
}
const toml = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(toml).join(', ') + ']';
  if (value && typeof value === 'object')
    return (
      '{ ' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`)
        .join(', ') +
      ' }'
    );
  return JSON.stringify(value);
};
export function codexTools(profile: ToolProfile) {
  const servers = Object.fromEntries(
    Object.entries(profile.mcp).map(([id, s]) => [
      id,
      {
        enabled: true,
        required: true,
        enabled_tools: s.tools,
        ...(s.transport === 'stdio'
          ? { command: s.command, args: s.args, env_vars: s.env }
          : { url: s.url, bearer_token_env_var: s.bearerTokenEnv }),
      },
    ]),
  );
  return [
    '--ignore-user-config',
    '-c',
    `mcp_servers=${toml(servers)}`,
    '-c',
    `features.shell_tool=${profile.codexShell}`,
    '-c',
    `sandbox_workspace_write.network_access=${profile.codexNetwork}`,
  ];
}
export function claudeMcp(profile: ToolProfile) {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(profile.mcp).map(([id, s]) => [
        id,
        s.transport === 'stdio'
          ? {
              type: 'stdio',
              command: s.command,
              args: s.args,
              env: Object.fromEntries(s.env.map((key) => [key, '${' + key + '}'])),
            }
          : {
              type: 'http',
              url: s.url,
              ...(s.bearerTokenEnv
                ? { headers: { Authorization: 'Bearer ${' + s.bearerTokenEnv + '}' } }
                : {}),
            },
      ]),
    ),
  };
}
export function claudeRules(profile: ToolProfile) {
  return [
    ...profile.claudeAllowedTools,
    ...Object.entries(profile.mcp).flatMap(([id, s]) =>
      s.tools.map((tool) => `mcp__${id}__${tool}`),
    ),
  ];
}
