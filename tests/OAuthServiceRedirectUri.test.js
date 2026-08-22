process.env.JWT_SECRET = 'test-jwt-secret';

const { OAuthService } = await import('../dist/oauth/services/OAuthService.js');

describe('OAuthService redirect URI compatibility', () => {
  test('accepts loopback redirect URIs with dynamic callback ports', () => {
    const service = new OAuthService();

    expect(service.validateRedirectUri('http://localhost:49152/callback', [
      'http://localhost/callback',
    ])).toBe(true);
    expect(service.validateRedirectUri('http://127.0.0.1:49152/callback', [
      'http://127.0.0.1/callback',
    ])).toBe(true);
    expect(service.validateRedirectUri('http://[::1]:49152/callback', [
      'http://[::1]/callback',
    ])).toBe(true);
  });

  test('does not ignore ports for non-loopback redirect URIs', () => {
    const service = new OAuthService();

    expect(service.validateRedirectUri('https://client.example:49152/callback', [
      'https://client.example/callback',
    ])).toBe(false);
  });

  test('advertises only S256 PKCE support', () => {
    const service = new OAuthService();

    expect(service.generateAuthorizationServerMetadata('https://issuer.example').code_challenge_methods_supported).toEqual(['S256']);
  });
});
