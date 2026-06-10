import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const port = Number(process.env.PORT || 43101);
const fixtureId = process.env.FIXTURE_ID || 'legacy-http';
const toolName = `compat-smoke-${fixtureId}-tool`;
const resourceName = `compat-smoke-${fixtureId}-resource`;
const resourceUri = `compat://smoke/${fixtureId}/resource`;
const promptName = `compat-smoke-${fixtureId}-prompt`;
const logs = [];
const transports = {};

function record(req) {
  logs.push({
    at: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl,
    headers: {
      'mcp-session-id': req.headers['mcp-session-id'],
      'mcp-protocol-version': req.headers['mcp-protocol-version'],
      'mcp-method': req.headers['mcp-method'],
      accept: req.headers.accept,
    },
    body: req.body,
  });
}

function isInitializeRequest(body) {
  return body && typeof body === 'object' && body.method === 'initialize';
}

function createServer() {
  const server = new McpServer({
    name: `compat-smoke-${fixtureId}`,
    version: '1.0.0',
  });

  server.tool(toolName, async () => ({
    content: [{ type: 'text', text: `legacy http tool ok: ${fixtureId}` }],
  }));

  server.resource(resourceName, resourceUri, async () => ({
    contents: [{ uri: resourceUri, mimeType: 'text/plain', text: `legacy http resource ok: ${fixtureId}` }],
  }));

  server.prompt(promptName, async () => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `legacy http prompt ok: ${fixtureId}` },
    }],
  }));

  return server;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, fixtureId, toolName, resourceUri, promptName });
});

app.get('/logs', (_req, res) => {
  res.json({ logs });
});

app.post('/reset', (_req, res) => {
  logs.length = 0;
  res.json({ ok: true });
});

app.all('/mcp', async (req, res) => {
  record(req);
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports[newSessionId] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };
      await createServer().connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid legacy session' },
        id: req.body?.id ?? null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        id: req.body?.id ?? null,
      });
    }
  }
});

const httpServer = app.listen(port, () => {
  console.log(JSON.stringify({ event: 'ready', fixture: 'legacy-http', fixtureId, port, toolName, resourceUri, promptName }));
});

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
