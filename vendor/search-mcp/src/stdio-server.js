import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS, SERVER_NAME, SERVER_VERSION, callTool as defaultCallTool } from './index.js';
import { createJsonFileProviderConfigStore } from './local/json-file-provider-config-store.js';

export { TOOLS };

const DEFAULT_PROVIDER_CONFIG_PATH = new URL('../.local/provider-config.json', import.meta.url);

export function createStdioServer(options = {}) {
  const providerConfigPath = options.providerConfigPath || process.env.SEARCH_MCP_PROVIDER_CONFIG_PATH || DEFAULT_PROVIDER_CONFIG_PATH;
  const providerConfigStore = options.providerConfigStore || createJsonFileProviderConfigStore(providerConfigPath);
  const callTool = options.callTool || defaultCallTool;
  const handlers = new Map();

  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  function setHandler(schema, method, handler) {
    handlers.set(method, handler);
    server.setRequestHandler(schema, handler);
  }

  setHandler(ListToolsRequestSchema, 'tools/list', async () => ({ tools: TOOLS }));
  setHandler(CallToolRequestSchema, 'tools/call', async (request) => {
    return await callTool(request.params, { providerConfigStore });
  });

  Object.defineProperty(server, '__localHandlers', {
    value: handlers,
    enumerable: false
  });

  Object.defineProperty(server, '__providerConfigStore', {
    value: providerConfigStore,
    enumerable: false
  });

  return server;
}

export async function startStdioServer(options = {}) {
  const server = createStdioServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startStdioServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
