import { jest } from '@jest/globals';
import http from 'node:http';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { ModernHttpDownstreamClient } = await import('../dist/mcp/core/ModernHttpDownstreamClient.js');

describe('ModernHttpDownstreamClient', () => {
  test('sends stateless modern headers and request metadata to downstream HTTP servers', async () => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push({ headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        if (body.method === 'server/discover') {
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              supportedVersions: ['2026-07-28'],
              serverInfo: { name: 'modern-fixture', version: '1.0.0' },
              capabilities: { tools: {} },
            },
          }));
          return;
        }
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({
        url: new URL(`http://127.0.0.1:${port}/mcp`),
        headers: { Authorization: 'Bearer downstream-token' },
      });

      await client.callTool({ name: 'echo', arguments: { value: 'hi' } });

      expect(requests).toHaveLength(2);
      expect(requests[1].headers['mcp-protocol-version']).toBe('2026-07-28');
      expect(requests[1].headers['mcp-method']).toBe('tools/call');
      expect(requests[1].headers['mcp-name']).toBe('echo');
      expect(requests[1].headers.authorization).toBe('Bearer downstream-token');
      expect(requests[1].body.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
      expect(requests[1].body.params._meta['io.modelcontextprotocol/clientInfo'].name).toBe('peta-core');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
