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
});
