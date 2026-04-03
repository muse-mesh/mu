import { experimental_createMCPClient } from '@ai-sdk/mcp';
import type { MuConfig } from '../config.js';
import type { MuLogger } from '../logger.js';

// ── MCP Client ─────────────────────────────────────────────────────
// Connects to external MCP servers and imports their tools into the
// agent's tool set.

export async function loadMCPTools(
  config: MuConfig,
  logger: MuLogger,
): Promise<Record<string, any>> {
  const tools: Record<string, any> = {};
  const servers = config.mcpServers ?? [];

  if (servers.length === 0) return tools;

  for (const server of servers) {
    try {
      logger.info(`Connecting to MCP server: ${server.name} (${server.transport})`);

      let transport: any;
      if (server.transport === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        transport = new StdioClientTransport({
          command: server.config.command!,
          args: server.config.args ?? [],
        });
      } else {
        // SSE or HTTP transport
        transport = {
          type: server.transport as 'sse' | 'http',
          url: server.config.url!,
        };
      }

      const client = await experimental_createMCPClient({ transport });
      const serverTools = await client.tools();

      // Namespace MCP tools to avoid collisions
      for (const [name, tool] of Object.entries(serverTools)) {
        const namespacedKey = `mcp__${server.name}__${name}`;
        tools[namespacedKey] = tool;
      }

      logger.info(`Loaded ${Object.keys(serverTools).length} tools from MCP server: ${server.name}`);
    } catch (err: any) {
      logger.error(`Failed to connect to MCP server ${server.name}: ${err.message}`);
    }
  }

  return tools;
}
