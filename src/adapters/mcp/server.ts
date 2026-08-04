import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGenericFetchProvider, createGenericLlmProvider, createGenericSearchProvider } from '../../app/create-generic-dependencies.ts';
import { createResearchMcpHandlers } from './tools.ts';
import { parseResearchRunTimeoutMs } from '../../app/research-deadline.ts';

const researchOptionsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxIterations: { type: 'integer', minimum: 1, maximum: 100 },
    completionMode: { type: 'string', enum: ['target_results', 'rounds'] },
    targetResultCount: { type: 'integer', minimum: 1, maximum: 100 },
    evidenceRequired: { type: 'boolean' },
    minFetchedPages: { type: 'integer', minimum: 1, maximum: 100 },
    maxSearchActionsPerTurn: { type: 'integer', minimum: 1, maximum: 8 },
    maxFetchActionsPerTurn: { type: 'integer', minimum: 1, maximum: 8 },
    locale: { type: 'string', minLength: 1, maxLength: 100 },
    outputFormat: { type: 'string', enum: ['json', 'markdown'] },
  },
} as const;

export function genericResearchToolDefinitions(exposeAtomicTools = false): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
    { name: 'research', description: 'Run an autonomous research task through the unified Auto search interface.', inputSchema: { type: 'object', additionalProperties: false, properties: { question: { type: 'string', minLength: 1 }, options: researchOptionsSchema }, required: ['question'] } },
  ];
  if (exposeAtomicTools) tools.push(
    { name: 'search', description: 'Diagnostic atomic search.', inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] } },
    { name: 'fetch', description: 'Diagnostic atomic page fetch.', inputSchema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] } },
  );
  return tools;
}

export function createGenericMcpServer(env: NodeJS.ProcessEnv = process.env): Server {
  const exposeAtomicTools = env.RESEARCH_EXPOSE_ATOMIC_TOOLS === '1';
  const runTimeoutMs = parseResearchRunTimeoutMs(env);
  const handlers = createResearchMcpHandlers({
    llm: createGenericLlmProvider(env),
    search: createGenericSearchProvider(),
    fetch: createGenericFetchProvider(),
  }, { runTimeoutMs });
  const server = new Server({ name: 'nano-researcher', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: genericResearchToolDefinitions(exposeAtomicTools),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    let result: unknown;
    if (request.params.name === 'research') result = await handlers.research(args as any, { signal: extra.signal });
    else if (exposeAtomicTools && request.params.name === 'search') result = await handlers.search(args as any, { signal: extra.signal });
    else if (exposeAtomicTools && request.params.name === 'fetch') result = await handlers.fetch(args as any, { signal: extra.signal });
    else return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  return server;
}

export async function startGenericMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = createGenericMcpServer(env);
  await server.connect(new StdioServerTransport());
}
