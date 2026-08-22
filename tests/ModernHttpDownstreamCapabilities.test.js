import { jest } from '@jest/globals';
import http from 'node:http';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { ModernHttpDownstreamClient } = await import('../dist/mcp/core/ModernHttpDownstreamClient.js');

test('does not invent resources for a tools-only modern downstream', async () => {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const { port } = server.address();
    const client = await ModernHttpDownstreamClient.connect({
      url: new URL(`http://127.0.0.1:${port}/mcp`),
    });

    expect(client.getServerCapabilities()).toEqual({ tools: {} });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
