const { resolveClientIp } = await import('../dist/security/ClientIpResolver.js');

describe('ClientIpResolver', () => {
  const originalTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;

  afterEach(() => {
    if (originalTrustedProxyIps === undefined) delete process.env.TRUSTED_PROXY_IPS;
    else process.env.TRUSTED_PROXY_IPS = originalTrustedProxyIps;
  });

  test('ignores forwarding headers from an untrusted peer', () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.0/8';

    expect(resolveClientIp('198.51.100.8', { 'x-forwarded-for': '203.0.113.5' })).toBe('198.51.100.8');
  });

  test('uses the first untrusted hop from the right of a trusted forwarding chain', () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.0/8';

    expect(resolveClientIp('10.0.0.2', {
      'x-forwarded-for': '203.0.113.9, 198.51.100.7, 10.1.2.3',
    })).toBe('198.51.100.7');
  });

  test('uses the leftmost address when every forwarded hop is trusted', () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.0/8';

    expect(resolveClientIp('10.0.0.2', { 'x-forwarded-for': '10.2.0.1, 10.1.2.3' })).toBe('10.2.0.1');
  });
});
