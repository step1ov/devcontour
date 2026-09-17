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

export function createMcpServer(service: AgentService) {
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
          const result = service.execute({ operation: name, input });
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

export async function serveMcp(service: AgentService) {
  const server = createMcpServer(service);
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 }),
  );
  return server;
}
