import { jest } from '@jest/globals';
import http from 'node:http';

process.env.MCP_2026_SUPPORTED_VERSIONS = '2026-07-28,2026-06-01';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { ModernHttpDownstreamClient } = await import('../dist/mcp/core/ModernHttpDownstreamClient.js');

const toolHeaderServer = (tools, requests) => http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    requests.push({ body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: body.method === 'server/discover'
        ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
        : body.method === 'tools/list' ? { tools } : { content: [] },
    }));
  });
});

describe('ModernHttpDownstreamClient', () => {
  test('does not expose unsupported modern resource subscriptions', async () => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            supportedVersions: ['2026-07-28'],
            capabilities: { resources: { subscribe: true } },
          },
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({
        url: new URL(`http://127.0.0.1:${port}/mcp`),
      });

      expect(client.getServerCapabilities()?.resources).not.toHaveProperty('subscribe');
      await expect(client.subscribeResource({ uri: 'resource://unsupported' })).rejects.toMatchObject({
        code: -32601,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

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
              _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'modern-fixture', version: '1.0.0' } },
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

      expect(client.getServerVersion()).toEqual({ name: 'modern-fixture', version: '1.0.0' });
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

  test('returns the matching SSE response after request-scoped notifications', async () => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (body.method === 'server/discover') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
          }));
          return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.end([
          `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1, total: 2 } })}`,
          '',
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: { ignored: true } })}`,
          '',
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'matched' }] } })}`,
          '',
        ].join('\n'));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });

      await expect(client.listTools()).resolves.toEqual({ tools: [{ name: 'matched' }] });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('returns a matching SSE response without waiting for the stream to close', async () => {
    let openResponse;
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        res.setHeader('Content-Type', body.method === 'server/discover' ? 'application/json' : 'text/event-stream');
        if (body.method === 'server/discover') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } }));
          return;
        }
        openResponse = res;
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'open-stream' }] } })}\n\n`);
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({
        url: new URL(`http://127.0.0.1:${port}/mcp`),
        timeoutMs: 200,
      });

      await expect(client.listTools()).resolves.toEqual({ tools: [{ name: 'open-stream' }] });
    } finally {
      openResponse?.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('rejects an incomplete SSE event that exceeds the response buffer limit', async () => {
    let openResponse;
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        res.setHeader('Content-Type', body.method === 'server/discover' ? 'application/json' : 'text/event-stream');
        if (body.method === 'server/discover') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } }));
          return;
        }
        openResponse = res;
        res.write(`data: ${'x'.repeat(65 * 1024)}`);
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({
        url: new URL(`http://127.0.0.1:${port}/mcp`),
        timeoutMs: 500,
      });

      await expect(client.listTools()).rejects.toThrow('Modern downstream SSE response exceeded the buffer limit');
    } finally {
      openResponse?.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('ignores an unrelated SSE error before the matching response', async () => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (body.method === 'server/discover') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
          }));
          return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.end([
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, error: { code: -32603, message: 'other request failed' } })}`,
          '',
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'matched-after-error' }] } })}`,
          '',
        ].join('\n'));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });

      await expect(client.listTools()).resolves.toEqual({ tools: [{ name: 'matched-after-error' }] });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('reads an SSE response with lone-CR line endings', async () => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        res.setHeader('Content-Type', body.method === 'server/discover' ? 'application/json' : 'text/event-stream');
        res.end(body.method === 'server/discover'
          ? JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } })
          : `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'lone-cr' }] } })}\r\r`);
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });

      await expect(client.listTools()).resolves.toEqual({ tools: [{ name: 'lone-cr' }] });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test.each([
    ['missing response', [{ jsonrpc: '2.0', method: 'notifications/progress', params: {} }]],
    ['mismatched response', [{ jsonrpc: '2.0', id: 999, result: {} }]],
    ['malformed response', [{ jsonrpc: '2.0', id: 2 }]],
  ])('rejects an SSE stream with a %s', async (_name, events) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (body.method === 'server/discover') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
          }));
          return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(events.map((event) => `data: ${JSON.stringify(event)}\n`).join('\n'));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });

      await expect(client.listTools()).rejects.toThrow(/response/i);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('propagates the matching JSON-RPC error from an SSE response', async () => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        res.setHeader('Content-Type', body.method === 'server/discover' ? 'application/json' : 'text/event-stream');
        res.end(body.method === 'server/discover'
          ? JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
          })
          : `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'bad params' } })}\n\n`);
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });

      const error = await client.listTools().catch((caught) => caught);
      expect(error).toMatchObject({ code: -32602 });
      expect(error.message).toContain('bad params');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('rejects a valid JSON-RPC result envelope returned with a non-2xx status', async () => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        res.setHeader('Content-Type', 'application/json');
        if (body.method === 'server/discover') {
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
          }));
          return;
        }
        res.statusCode = 400;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });

      await expect(client.listTools()).rejects.toThrow('Modern downstream HTTP 400');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('encodes unsafe and sentinel-looking Mcp-Name values with the Base64 sentinel', async () => {
    const names = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        names.push(req.headers['mcp-name']);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: body.method === 'server/discover'
            ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
            : { content: [] },
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });

      await client.callTool({ name: 'Hello, 世界', arguments: {} });
      await client.callTool({ name: '=?base64?literal?=', arguments: {} });

      expect(names.slice(1)).toEqual([
        `=?base64?${Buffer.from('Hello, 世界').toString('base64')}?=`,
        `=?base64?${Buffer.from('=?base64?literal?=').toString('base64')}?=`,
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('retries server discovery with a mutually supported version', async () => {
    const versions = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        versions.push({
          header: req.headers['mcp-protocol-version'],
          meta: body.params._meta['io.modelcontextprotocol/protocolVersion'],
        });
        res.setHeader('Content-Type', 'application/json');
        if (versions.length === 1) {
          res.statusCode = 400;
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: {
              code: -32022,
              message: 'Unsupported protocol version',
              data: { supported: ['2026-06-01'] },
            },
          }));
          return;
        }
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: body.method === 'server/discover'
            ? { supportedVersions: ['2026-06-01'], capabilities: { tools: {} } }
            : { tools: [] },
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });
      await client.listTools();

      expect(versions).toEqual([
        { header: '2026-07-28', meta: '2026-07-28' },
        { header: '2026-06-01', meta: '2026-06-01' },
        { header: '2026-06-01', meta: '2026-06-01' },
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('uses a refreshed bearer token for later requests', async () => {
    const authorizations = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        authorizations.push(req.headers.authorization);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: body.method === 'server/discover'
            ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
            : { tools: [] },
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({
        url: new URL(`http://127.0.0.1:${port}/mcp`),
        headers: { Authorization: 'Bearer old-token' },
      });

      await client.notification({ method: 'notifications/token/update', params: { token: 'new-token' } });
      await client.listTools();

      expect(authorizations).toEqual(['Bearer old-token', 'Bearer new-token']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('mirrors nested annotated primitive values into Mcp-Param headers', async () => {
    const requests = [];
    const server = toolHeaderServer([{
      name: 'annotated',
      inputSchema: {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              tenant: { type: 'string', 'x-mcp-header': 'tenant-id' },
              count: { type: 'integer', 'x-mcp-header': 'count' },
              flag: { type: 'boolean', 'x-mcp-header': 'flag' },
            },
          },
        },
      },
    }], requests);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });
      await client.listTools();
      await client.callTool({ name: 'annotated', arguments: { nested: { tenant: 'tenant-a', count: 7, flag: true } } });

      const headers = requests.at(-1).headers;
      expect(headers['mcp-param-tenant-id']).toBe('tenant-a');
      expect(headers['mcp-param-count']).toBe('7');
      expect(headers['mcp-param-flag']).toBe('true');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('encodes unsafe and sentinel-looking Mcp-Param values with the Base64 sentinel', async () => {
    const requests = [];
    const server = toolHeaderServer([{
      name: 'encoded',
      inputSchema: {
        type: 'object',
        properties: {
          unsafe: { type: 'string', 'x-mcp-header': 'unsafe' },
          literal: { type: 'string', 'x-mcp-header': 'literal' },
        },
      },
    }], requests);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });
      await client.listTools();
      await client.callTool({ name: 'encoded', arguments: { unsafe: 'Hello, 世界', literal: '=?base64?literal?=' } });

      const headers = requests.at(-1).headers;
      expect(headers['mcp-param-unsafe']).toBe(`=?base64?${Buffer.from('Hello, 世界').toString('base64')}?=`);
      expect(headers['mcp-param-literal']).toBe(`=?base64?${Buffer.from('=?base64?literal?=').toString('base64')}?=`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('omits annotated headers for missing and null values', async () => {
    const requests = [];
    const server = toolHeaderServer([{
      name: 'optional',
      inputSchema: { type: 'object', properties: { value: { type: 'string', 'x-mcp-header': 'value' } } },
    }], requests);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });
      await client.listTools();
      await client.callTool({ name: 'optional', arguments: { value: null } });
      expect(requests.at(-1).headers['mcp-param-value']).toBeUndefined();
      await client.callTool({ name: 'optional', arguments: {} });
      expect(requests.at(-1).headers['mcp-param-value']).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('filters tools with invalid x-mcp-header annotations and keeps unlisted tools header-free', async () => {
    const requests = [];
    const server = toolHeaderServer([
      { name: 'bad-type', inputSchema: { type: 'object', properties: { value: { type: 'array', 'x-mcp-header': 'value' } } } },
      { name: 'bad-name', inputSchema: { type: 'object', properties: { value: { type: 'string', 'x-mcp-header': 'bad header' } } } },
      { name: 'duplicate', inputSchema: { type: 'object', properties: { left: { type: 'string', 'x-mcp-header': 'tenant' }, right: { type: 'string', 'x-mcp-header': 'Tenant' } } } },
      { name: 'plain', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
    ], requests);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const client = await ModernHttpDownstreamClient.connect({ url: new URL(`http://127.0.0.1:${port}/mcp`) });
      await expect(client.listTools()).resolves.toEqual({ tools: [{ name: 'plain', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] });
      await client.callTool({ name: 'never-listed', arguments: { value: 'x' } });
      expect(requests.at(-1).headers['mcp-param-value']).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
