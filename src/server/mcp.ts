import type { Readable, Writable } from 'node:stream';
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ZodError } from 'zod';
import {
  AgentService,
  agentInputs,
  agentOperations,
  descriptions,
  readOnly,
  capabilities,
} from '../application/agent.ts';
import { DomainError } from '../core/model.ts';

export function createMcpServer(service: Pick<AgentService, 'run'>) {
  const { version } = capabilities();
  const server = new McpServer({ name: 'devcontour', version });
  for (const name of agentOperations) {
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      name,
      {
        description: descriptions[name],
        inputSchema: agentInputs[name],
        annotations: {
          readOnlyHint: readOnly(name),
          destructiveHint: !readOnly(name) && name !== 'checkpoint_save',
          idempotentHint:
            readOnly(name) || ['queue_set', 'workflow_start', 'signal_ingest'].includes(name),
          openWorldHint:
            name === 'queue_set' || name === 'workflow_start' || name === 'workflow_retry',
        },
      },
      async (input: unknown) => {
        try {
          const result = await service.run({ operation: name, input });
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          const status =
            error instanceof DomainError ? error.status : error instanceof ZodError ? 400 : 500;
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status,
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
          };
        }
      },
    );
  }
  return server;
}

/**
 * Клиент закрывает соединение и концом stdin, а вызов с внешними процессами при
 * этом продолжает работать: `onDrained` срабатывает один раз, когда соединение
 * закрыто и все начатые вызовы завершились.
 */
export async function serveMcp(
  service: Pick<AgentService, 'run'>,
  onDrained: () => void = () => {},
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
) {
  let active = 0,
    closed = false,
    drained = false;
  const settle = () => {
    if (!closed || active || drained) return;
    drained = true;
    onDrained();
  };
  const server = createMcpServer({
    run: async (request) => {
      active += 1;
      try {
        return await service.run(request);
      } finally {
        active -= 1;
        settle();
      }
    },
  });
  server.server.onclose = () => {
    closed = true;
    settle();
  };
  await server.connect(new StdioServerTransport(stdin, stdout, { maxBufferSize: 128 * 1024 }));
  return server;
}
