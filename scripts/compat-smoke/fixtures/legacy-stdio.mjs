import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const fixtureId = process.env.FIXTURE_ID || 'legacy-stdio';
const toolName = `compat-smoke-${fixtureId}-tool`;
const resourceName = `compat-smoke-${fixtureId}-resource`;
const resourceUri = `compat://smoke/${fixtureId}/resource`;
const promptName = `compat-smoke-${fixtureId}-prompt`;

const server = new McpServer({
  name: `compat-smoke-${fixtureId}`,
  version: '1.0.0',
});

server.tool(toolName, async () => ({
  content: [{ type: 'text', text: `legacy stdio tool ok: ${fixtureId}` }],
}));

server.resource(resourceName, resourceUri, async () => ({
  contents: [{ uri: resourceUri, mimeType: 'text/plain', text: `legacy stdio resource ok: ${fixtureId}` }],
}));

server.prompt(promptName, async () => ({
  messages: [{
    role: 'user',
    content: { type: 'text', text: `legacy stdio prompt ok: ${fixtureId}` },
  }],
}));

process.stderr.write(JSON.stringify({ event: 'ready', fixtureId, toolName, resourceUri, promptName }) + '\n');

await server.connect(new StdioServerTransport());
