import { DownstreamTransportFactory } from '../dist/mcp/core/DownstreamTransportFactory.js';

describe('DownstreamTransportFactory', () => {
  test('forces piped stderr for stdio transports', async () => {
    const { transport, transportType } = await DownstreamTransportFactory.create({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      stderr: 'ignore',
    });

    expect(transportType).toBe('stdio');
    expect(transport.stderr).not.toBeNull();
  });

  test('allows SSE fallback only for auto-detected HTTP remote configs', () => {
    expect(
      DownstreamTransportFactory.canFallbackHttpToSse(
        { url: 'http://localhost:3000/mcp' },
        'http',
      ),
    ).toBe(true);

    expect(
      DownstreamTransportFactory.canFallbackHttpToSse(
        { type: 'http', url: 'http://localhost:3000/mcp' },
        'http',
      ),
    ).toBe(false);

    expect(
      DownstreamTransportFactory.canFallbackHttpToSse(
        { url: 'http://localhost:3000/sse' },
        'sse',
      ),
    ).toBe(false);
  });
});
