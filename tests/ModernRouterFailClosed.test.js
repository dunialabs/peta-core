import { jest } from '@jest/globals';
import http from 'node:http';
import express from 'express';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/mcp/controllers/MCPController.js', () => ({
  MCPController: class {
    handlePost = (_req, res) => res.status(599).end();
    handleGet = (_req, res) => res.status(599).end();
    handleDelete = (_req, res) => res.status(599).end();
  },
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: { getAvailableServers: jest.fn(() => []), getServerContext: jest.fn(), ensureServerAvailable: jest.fn() } },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ generateUniformRequestId: jest.fn(() => 'modern-test'), enqueueLog: jest.fn() }) },
}));

const { MCPRouter } = await import('../dist/mcp/MCPRouter.js');
const { SessionStore } = await import('../dist/mcp/core/SessionStore.js');

describe('ModernRouterFailClosed', () => {
  test('rejects an invalid Origin before modern authentication while allowing absent and canonical Origins', async () => {
    const originalPublicUrl = process.env.PETA_PUBLIC_URL;
    const originalAllowedOrigins = process.env.MCP_2026_ALLOWED_ORIGIN_HOSTNAMES;
    delete process.env.PETA_PUBLIC_URL;
    const app = express();
    app.use(express.json());
    new MCPRouter().registerRoutes(app, {
      ipWhitelistMiddleware: { checkIpWhitelist: (_req, _res, next) => next() },
      authMiddleware: { authenticate: (_req, res) => res.status(598).end() },
      rateLimitMiddleware: { checkRateLimit: (_req, _res, next) => next() },
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const postModern = (origin) => fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'MCP-Protocol-Version': '2026-07-28',
          ...(origin === undefined ? {} : { Origin: origin }),
        },
      });

      const invalid = await postModern('https://attacker.example.test');
      expect(invalid.status).toBe(403);
      expect(await invalid.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Origin header' },
        id: null,
      });
      expect((await postModern()).status).toBe(401);
      expect((await postModern(`http://127.0.0.1:${port}`)).status).toBe(401);
      expect((await postModern('http://[::1]')).status).toBe(401);
      process.env.MCP_2026_ALLOWED_ORIGIN_HOSTNAMES = 'console.example.test';
      expect((await postModern('https://console.example.test')).status).toBe(401);
      expect((await postModern('http://console.example.test:8443')).status).toBe(401);
      process.env.MCP_2026_ALLOWED_ORIGIN_HOSTNAMES = 'https://console.example.test';
      expect((await postModern('https://console.example.test')).status).toBe(403);
      process.env.PETA_PUBLIC_URL = 'https://gateway.example.test';
      expect((await postModern('https://gateway.example.test')).status).toBe(401);
      expect((await postModern('not an origin')).status).toBe(403);
      expect((await postModern('null')).status).toBe(403);
      expect((await postModern('http://127.0.0.1?')).status).toBe(403);
      expect((await postModern('http://127.0.0.1#')).status).toBe(403);
      expect((await postModern('https://gateway.example.test/')).status).toBe(403);
    } finally {
      if (originalPublicUrl === undefined) {
        delete process.env.PETA_PUBLIC_URL;
      } else {
        process.env.PETA_PUBLIC_URL = originalPublicUrl;
      }
      if (originalAllowedOrigins === undefined) {
        delete process.env.MCP_2026_ALLOWED_ORIGIN_HOSTNAMES;
      } else {
        process.env.MCP_2026_ALLOWED_ORIGIN_HOSTNAMES = originalAllowedOrigins;
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('keeps an active legacy session authoritative over modern-looking headers and Origin', async () => {
    const originalGetSession = SessionStore.instance.getSession;
    SessionStore.instance.getSession = () => ({ });
    const app = express();
    app.use(express.json());
    new MCPRouter().registerRoutes(app, {
      ipWhitelistMiddleware: { checkIpWhitelist: (_req, _res, next) => next() },
      authMiddleware: { authenticate: (_req, _res, next) => next() },
      rateLimitMiddleware: { checkRateLimit: (_req, _res, next) => next() },
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Session-Id': 'legacy-session',
          Origin: 'https://attacker.example.test',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });

      expect(response.status).toBe(599);
    } finally {
      SessionStore.instance.getSession = originalGetSession;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('rejects modern-signaled initialize before legacy authentication', async () => {
    const app = express();
    app.use(express.json());
    new MCPRouter().registerRoutes(app, {
      ipWhitelistMiddleware: { checkIpWhitelist: (_req, _res, next) => next() },
      authMiddleware: { authenticate: (_req, res) => res.status(598).end() },
      rateLimitMiddleware: { checkRateLimit: (_req, _res, next) => next() },
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'initialize',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Mixed protocol-era signals: initialize is not part of modern MCP',
        },
        id: 1,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('rejects modern DELETE before legacy controller', async () => {
    const app = express();
    app.use(express.json());
    new MCPRouter().registerRoutes(app, {
      ipWhitelistMiddleware: { checkIpWhitelist: (_req, _res, next) => next() },
      authMiddleware: { authenticate: (_req, res) => res.status(598).end() },
      rateLimitMiddleware: { checkRateLimit: (_req, _res, next) => next() },
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'DELETE',
        headers: { 'MCP-Protocol-Version': '2026-07-28' },
      });

      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Modern MCP uses POST-only Streamable HTTP' },
        id: null,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('legacy POST skips modern rate-limit middleware before legacy auth', async () => {
    const app = express();
    app.use(express.json());
    const rateLimitMiddleware = { checkRateLimit: jest.fn((_req, _res, next) => next()) };
    new MCPRouter().registerRoutes(app, {
      ipWhitelistMiddleware: { checkIpWhitelist: (_req, _res, next) => next() },
      authMiddleware: { authenticate: (req, _res, next) => { req.authContext = { userId: 'user-1' }; next(); } },
      rateLimitMiddleware,
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example.test' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });

      expect(response.status).toBe(599);
      expect(rateLimitMiddleware.checkRateLimit).toHaveBeenCalledTimes(1);
      expect(rateLimitMiddleware.checkRateLimit.mock.calls[0][0].authContext).toEqual({ userId: 'user-1' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
