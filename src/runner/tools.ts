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
/**
 * Встроенные инструменты исполнителя claude, когда профиль их не называет.
 *
 * Shell входит в них: исполнитель без него писал вслепую — не запускал ни
 * тестов, ни проверки типов и узнавал о провале только от гейтов после
 * попытки. Shell исполняется в песочнице ОС с той же политикой, что у
 * проверок; без песочницы запуск отказывает, а не идёт без изоляции.
 * Профиль, явно перечисливший инструменты без Bash, — осознанный отказ, и он
 * соблюдается.
 */
export const claudeWriterTools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const;
export function writerTools(profile?: ToolProfile): readonly string[] {
  return profile?.claudeTools ?? claudeWriterTools;
}
/**
 * Может ли ревьюер запускать проверки — одно правило для адаптера, doctor и
 * выдачи инструмента проверок. У claude — только Bash, явно данный профилем.
 * У codex нет инструмента чтения, кроме shell: без профиля он получает shell
 * в песочнице только для чтения; явный codexShell: false соблюдается.
 */
export function reviewerRunsChecks(runtime: RuntimeName, profile?: ToolProfile) {
  if (runtime === 'codex') return profile ? profile.codexShell : true;
  return !!profile?.claudeTools?.includes('Bash');
}
/** Может ли исполнитель запускать команды — одно правило для адаптера и doctor. */
export function writerRunsChecks(runtime: RuntimeName, profile?: ToolProfile) {
  // Codex без профиля не получает флаг shell_tool и остаётся со shell CLI.
  if (runtime === 'codex') return profile ? profile.codexShell : true;
  return writerTools(profile).includes('Bash');
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
/** Имена сервера и инструмента проверок ревьюера в конфигурации CLI. */
export const probeServer = 'devcontour_probe';
export const probeTool = 'run_check';
/**
 * Сервер проверок ревьюера (см. review-probe.ts): команда запуска и имена
 * переменных окружения, которые CLI передаст ему по имени.
 */
export type ProbeServer = {
  command: string;
  args: string[];
  env: string[];
  commandTimeoutMs: number;
};
/** Срок вызова инструмента в CLI — с запасом сверх предела команды контура. */
export const probeCallMs = (probe: ProbeServer) => probe.commandTimeoutMs + 30000;
function codexProbe(probe?: ProbeServer) {
  return probe
    ? {
        [probeServer]: {
          enabled: true,
          required: true,
          enabled_tools: [probeTool],
          command: probe.command,
          args: probe.args,
          env_vars: probe.env,
          // По умолчанию codex обрывает вызов инструмента через минуту —
          // раньше, чем контур остановил бы команду сам.
          tool_timeout_sec: Math.ceil(probeCallMs(probe) / 1000),
        },
      }
    : {};
}
export function codexServers(probe?: ProbeServer) {
  return ['--ignore-user-config', '-c', `mcp_servers=${toml(codexProbe(probe))}`];
}
export function codexTools(profile: ToolProfile, probe?: ProbeServer) {
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
    `mcp_servers=${toml({ ...servers, ...codexProbe(probe) })}`,
    '-c',
    `features.shell_tool=${profile.codexShell}`,
    '-c',
    `sandbox_workspace_write.network_access=${profile.codexNetwork}`,
  ];
}
export function claudeMcp(profile: ToolProfile | undefined, probe?: ProbeServer) {
  return {
    mcpServers: {
      ...Object.fromEntries(
        Object.entries(profile?.mcp ?? {}).map(([id, s]) => [
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
      ...(probe
        ? {
            [probeServer]: {
              type: 'stdio',
              command: probe.command,
              args: probe.args,
              env: Object.fromEntries(probe.env.map((key) => [key, '${' + key + '}'])),
            },
          }
        : {}),
    },
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
