import { jest } from '@jest/globals';

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

const { RequestIdMapper } = await import('../dist/mcp/core/RequestIdMapper.js');

describe('RequestIdMapper progress and downstream request tracking', () => {
  let mapper;

  afterEach(() => {
    mapper?.destroy();
    mapper = undefined;
  });

  test('tracks number request ids, original progress tokens, and downstream request ids', () => {
    mapper = new RequestIdMapper('session-1');

    const proxyRequestId = mapper.registerClientRequest(7, 'tools/call', 'server-1');
    mapper.setOriginalProgressToken(proxyRequestId, 'client-progress-1');
    mapper.registerDownstreamMapping(proxyRequestId, 0, 'server-1');

    expect(mapper.getProxyRequestId(7)).toBe(proxyRequestId);
    expect(mapper.getOriginalRequestId(proxyRequestId)).toBe(7);
    expect(mapper.getOriginalProgressToken(proxyRequestId)).toBe('client-progress-1');
    expect(mapper.getDownstreamRequestId(proxyRequestId)).toBe(0);
    expect(mapper.getProxyRequestIdFromDownstream(0, 'server-1')).toBe(proxyRequestId);

    mapper.removeMapping(proxyRequestId);
    expect(mapper.getProxyRequestIdFromDownstream(0, 'server-1')).toBeUndefined();
  });
});
