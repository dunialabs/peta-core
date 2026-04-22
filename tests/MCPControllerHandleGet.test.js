import { jest } from '@jest/globals';

const getProxySession = jest.fn();

jest.unstable_mockModule('../dist/mcp/core/SessionStore.js', () => ({
  SessionStore: {
    instance: {
      getProxySession,
    },
  },
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  }),
}));

const { MCPController } = await import('../dist/mcp/controllers/MCPController.js');

describe('MCPController GET handling', () => {
  beforeEach(() => {
    getProxySession.mockReset();
  });

  test('delegates Last-Event-ID reconnect GET requests to proxySession.handleRequest', async () => {
    const handleRequest = jest.fn(async () => {});
    getProxySession.mockReturnValue({ handleRequest });

    const controller = new MCPController();
    const req = {
      headers: {
        'mcp-session-id': 'session-1',
        'last-event-id': 'event-123',
      },
      clientSession: {
        sessionId: 'session-1',
        markSseConnected: jest.fn(),
        markSseDisconnected: jest.fn(),
      },
      body: undefined,
    };
    const res = {
      headersSent: false,
      statusCode: 200,
      getHeader: jest.fn(() => undefined),
      writeHead: jest.fn(function () {
        return this;
      }),
      on: jest.fn(),
      status: jest.fn(function () {
        return this;
      }),
      json: jest.fn(),
    };

    await controller.handleGet(req, res);

    expect(handleRequest).toHaveBeenCalledWith(req, res, undefined);
  });
});
