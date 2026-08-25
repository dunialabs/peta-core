import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: { instance: { getAvailableServers: jest.fn(() => []) } },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: { getInstance: () => ({ generateUniformRequestId: jest.fn(() => 'modern-test'), enqueueLog: jest.fn() }) },
}));

const { ModernMcpController } = await import('../dist/mcp/modern/ModernMcpController.js');
const { modernSubscriptionBus } = await import('../dist/mcp/modern/ModernSubscriptionBus.js');

describe('ModernSubscriptionLifecycle', () => {
  test('keeps a POST subscription open after the request body closes', async () => {
    // Given
    const controller = new ModernMcpController();
    const initialListenerCount = modernSubscriptionBus.listenerCount('event');
    let markServerResponseClosed;
    const serverResponseClosed = new Promise((resolve) => { markServerResponseClosed = resolve; });
    const app = express();
    app.post('/mcp', async (req, res, next) => {
      try {
        await controller.handleSubscriptionListen({
          req,
          res,
          authContext: {
            userId: 'user-1',
            oauthScopes: ['mcp:tools'],
            permissions: {},
            userPreferences: {},
          },
          protocolVersion: '2026-07-28',
          clientCapabilities: {},
          requestId: 1,
          uniformRequestId: 'request-1',
          isPublicEndpoint: false,
        }, {
          jsonrpc: '2.0',
          id: 1,
          method: 'subscriptions/listen',
          params: { notifications: { toolsListChanged: true } },
        });
        res.once('close', markServerResponseClosed);
        req.once('close', () => {
          setImmediate(() => modernSubscriptionBus.publish({
            method: 'notifications/tools/list_changed',
            params: {},
          }));
        });
        req.resume();
      } catch (error) {
        next(error);
      }
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP address');
    }

    let response;
    let request;
    try {
      // When
      const eventBody = await new Promise((resolve, reject) => {
        request = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '2',
          },
        }, (stream) => {
          response = stream;
          let body = '';
          stream.setEncoding('utf8');
          stream.on('data', (chunk) => {
            body += chunk;
            if (body.includes('notifications/subscriptions/acknowledged') && !request.writableEnded) {
              request.end('{}');
            }
            if (body.includes('notifications/tools/list_changed')) {
              resolve(body);
            }
          });
          stream.on('end', () => reject(new Error(`Subscription ended after request close: ${body}`)));
          stream.on('error', reject);
        });
        request.on('error', reject);
        request.flushHeaders();
      });

      // Then
      expect(eventBody).toContain('notifications/subscriptions/acknowledged');
      expect(eventBody).toContain('notifications/tools/list_changed');
      response.destroy();
      await serverResponseClosed;
      expect(modernSubscriptionBus.listenerCount('event')).toBe(initialListenerCount);
    } finally {
      response?.destroy();
      request?.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
