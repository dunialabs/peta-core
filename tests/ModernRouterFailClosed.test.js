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

describe('ModernRouterFailClosed', () => {
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
        headers: { 'Content-Type': 'application/json' },
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
