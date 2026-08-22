import { DownstreamTransportFactory } from '../dist/mcp/core/DownstreamTransportFactory.js';

describe('DownstreamTransportFactory', () => {
  test.each(['/sse', '/events'])('explicit modern protocol uses HTTP for arbitrary endpoint path %s', (path) => {
    expect(
      DownstreamTransportFactory.detectTransportType({
        url: `https://downstream.example${path}`,
        mcpProtocol: 'modern',
      }),
    ).toBe('http');
  });

  test('explicit SSE transport remains SSE even when modern protocol is requested', () => {
    expect(
      DownstreamTransportFactory.detectTransportType({
        type: 'sse',
        url: 'https://downstream.example/events',
        mcpProtocol: 'modern',
      }),
    ).toBe('sse');
  });

  test('auto and legacy URL inference remains backward-compatible', () => {
    expect(DownstreamTransportFactory.detectTransportType({ url: 'https://downstream.example/sse', mcpProtocol: 'auto' })).toBe('sse');
    expect(DownstreamTransportFactory.detectTransportType({ url: 'https://downstream.example/events', mcpProtocol: 'legacy' })).toBe('sse');
    expect(DownstreamTransportFactory.detectTransportType({ url: 'https://downstream.example/mcp', mcpProtocol: 'auto' })).toBe('http');
  });

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
