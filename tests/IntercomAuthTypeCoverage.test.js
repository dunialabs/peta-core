import { AuthStrategyFactory } from '../dist/mcp/auth/AuthStrategyFactory.js';
import { IntercomAuthStrategy } from '../dist/mcp/auth/IntercomAuthStrategy.js';
import { ServerAuthType } from '../dist/types/enums.js';
import { AuthUtils } from '../dist/utils/AuthUtils.js';
import { INTERCOM_FAKE_REFRESH_TOKEN } from '../dist/mcp/auth/IntercomTokenHelper.js';

describe('Intercom ServerAuthType coverage', () => {
  test('maps IntercomAuth to the intercom OAuth provider', () => {
    expect(AuthUtils.getOAuthProvider(ServerAuthType.IntercomAuth)).toBe('intercom');
  });

  test('creates IntercomAuthStrategy for IntercomAuth', () => {
    const strategy = AuthStrategyFactory.create(ServerAuthType.IntercomAuth, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: INTERCOM_FAKE_REFRESH_TOKEN,
      accessToken: 'access-token',
      intercomRegion: 'US',
    });

    expect(strategy).toBeInstanceOf(IntercomAuthStrategy);
  });
});
