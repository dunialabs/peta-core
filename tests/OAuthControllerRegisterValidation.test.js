import { jest } from '@jest/globals';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

jest.unstable_mockModule('../dist/oauth/services/OAuthClientService.js', () => ({
  OAuthClientService: class {
    async registerClient() {
      throw new Error('invalid_redirect_uri: Invalid redirect_uri: ftp://bad.example/callback');
    }
  },
}));

jest.unstable_mockModule('../dist/oauth/services/OAuthService.js', () => ({
  OAuthService: class {},
}));

jest.unstable_mockModule('../dist/security/TokenValidator.js', () => ({
  TokenValidator: class {},
}));

jest.unstable_mockModule('../dist/security/OAuthTokenValidator.js', () => ({
  OAuthTokenValidator: class {},
}));

const { OAuthController } = await import('../dist/oauth/controllers/OAuthController.js');

describe('OAuthControllerRegisterValidation', () => {
  test('maps invalid_redirect_uri registration errors to 400', async () => {
    const controller = new OAuthController();
    const status = jest.fn(() => res);
    const json = jest.fn(() => res);
    const setHeader = jest.fn();
    const res = { status, json, setHeader };

    await controller.register({
      body: {
        client_name: 'Bad Client',
        redirect_uris: ['ftp://bad.example/callback'],
      },
      headers: { host: 'issuer.example' },
      protocol: 'https',
      get: () => 'issuer.example',
    }, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: 'invalid_redirect_uri',
      error_description: 'Invalid redirect_uri: ftp://bad.example/callback',
    });
  });
});
