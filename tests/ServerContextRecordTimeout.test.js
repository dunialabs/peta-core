import { jest } from '@jest/globals';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

const reconnectServer = jest.fn();
const reconnectTemporaryServer = jest.fn();
const getOwnerToken = jest.fn();

jest.unstable_mockModule('../dist/mcp/core/ServerManager.js', () => ({
  ServerManager: {
    instance: {
      reconnectServer,
      reconnectTemporaryServer,
      getOwnerToken,
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

const { ServerContext } = await import('../dist/mcp/core/ServerContext.js');
const { ServerStatus } = await import('../dist/types/enums.js');

function serverEntity(overrides = {}) {
  return {
    serverId: 'server-1',
    serverName: 'Server One',
    status: ServerStatus.Online,
    capabilities: '{}',
    allowUserInput: false,
    enabled: true,
    ...overrides,
  };
}

describe('ServerContext.recordTimeout', () => {
  beforeEach(() => {
    reconnectServer.mockReset();
    reconnectTemporaryServer.mockReset();
    getOwnerToken.mockReset().mockReturnValue('owner-token');
  });

  test('awaits ping rejection and reconnects regular servers after repeated timeouts', async () => {
    const context = new ServerContext(serverEntity());
    context.timeoutCount = context.maxTimeoutCount - 1;
    context.connection = {
      ping: jest.fn(async () => {
        throw new McpError(ErrorCode.RequestTimeout, 'timed out');
      }),
    };

    await expect(
      context.recordTimeout(new McpError(ErrorCode.RequestTimeout, 'request timed out')),
    ).resolves.toBe(true);

    expect(context.connection.ping).toHaveBeenCalledWith({ timeout: 50000 });
    expect(reconnectServer).toHaveBeenCalledWith(context.serverEntity, 'owner-token');
  });
});
