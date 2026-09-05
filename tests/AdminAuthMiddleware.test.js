import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { AdminAuthMiddleware } = await import('../dist/middleware/AdminAuthMiddleware.js');

async function withAdminApp(tokenValidator, callback) {
  const app = express();
  app.use(express.json());
  const middleware = new AdminAuthMiddleware(tokenValidator);
  app.use('/admin', middleware.authenticate);
  app.post('/admin', (_req, res) => res.status(204).end());
  app.use('/oauth/admin', middleware.authenticate);
  app.get('/oauth/admin/clients', (_req, res) => res.status(204).end());

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await callback(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('AdminAuthMiddleware', () => {
  const ownerContext = { role: 1, userId: 'owner' };
  const adminContext = { role: 2, userId: 'admin' };
  const userContext = { role: 3, userId: 'user' };

  test('rejects absent, malformed, invalid, and non-admin credentials on protected Admin and OAuth routes', async () => {
    const validateToken = jest.fn(async (token) => {
      if (token === 'owner') return ownerContext;
      if (token === 'admin') return adminContext;
      if (token === 'user') return userContext;
      throw new Error('invalid token');
    });

    await withAdminApp({ validateToken }, async (port) => {
      const url = `http://127.0.0.1:${port}`;
      const post = (headers, body) => fetch(`${url}/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

      expect((await post({}, { action: 1015, data: {} })).status).toBe(401);
      expect((await post({ Authorization: 'Basic ignored' }, { action: 1015, data: {} })).status).toBe(401);
      expect((await post({ Authorization: 'Bearer invalid' }, { action: 1015, data: {} })).status).toBe(401);
      expect((await post({ Authorization: 'Bearer user' }, { action: 1015, data: {} })).status).toBe(403);
      expect((await post({ Authorization: 'Bearer owner' }, { action: 1015, data: {} })).status).toBe(204);
      expect((await post({ Authorization: 'Bearer admin' }, { action: 2015, data: {} })).status).toBe(204);
      expect((await fetch(`${url}/oauth/admin/clients`)).status).toBe(401);
      expect((await fetch(`${url}/oauth/admin/clients`, { headers: { Authorization: 'Bearer owner' } })).status).toBe(204);
    });
  });

  test('allows only documented no-header admin bootstrap and login actions', async () => {
    await withAdminApp({ validateToken: jest.fn() }, async (port) => {
      const url = `http://127.0.0.1:${port}/admin`;
      const post = (body, headers = {}) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

      expect((await post({ action: 1016, data: {} })).status).toBe(204);
      expect((await post({ action: 5001, data: {} })).status).toBe(204);
      expect((await post({ action: 5002, data: { name: 'Peta', proxyKey: 'key' } })).status).toBe(204);
      expect((await post({ action: 6002, data: { backup: {} } })).status).toBe(204);
      expect((await post({ action: 1010, data: { role: 1 } })).status).toBe(204);
      expect((await post({ action: 1010, data: { role: 2 } })).status).toBe(401);
      expect((await post({ action: 1010, data: {} })).status).toBe(401);
      expect((await post({ action: 1016, data: {} }, { Authorization: 'Bearer malformed' })).status).toBe(401);
      expect((await post({ action: 1016, data: {} }, { Authorization: '' })).status).toBe(401);
    });
  });
});
