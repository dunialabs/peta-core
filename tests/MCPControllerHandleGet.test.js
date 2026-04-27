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

describe('MCPController POST handling', () => {
  beforeEach(() => {
    getProxySession.mockReset();
  });

  test('routes initialize requests through the middleware-created session id', async () => {
    const handleRequest = jest.fn(async () => {});
    getProxySession.mockImplementation((sessionId) =>
      sessionId === 'fresh-session' ? { handleRequest } : undefined,
    );

    const controller = new MCPController();
    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'inspector', version: '1.0.0' },
      },
    };
    const req = {
      headers: {
        'mcp-session-id': 'stale-session',
      },
      clientSession: {
        sessionId: 'fresh-session',
      },
      body: initializeRequest,
    };
    const res = {
      status: jest.fn(function () {
        return this;
      }),
      json: jest.fn(),
    };

    await controller.handlePost(req, res);

    expect(getProxySession).toHaveBeenCalledWith('fresh-session');
    expect(handleRequest).toHaveBeenCalledWith(req, res, initializeRequest);
    expect(res.status).not.toHaveBeenCalled();
  });
});
