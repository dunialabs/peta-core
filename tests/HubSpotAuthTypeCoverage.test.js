import { AuthStrategyFactory } from '../dist/mcp/auth/AuthStrategyFactory.js';
import { HubSpotAuthStrategy } from '../dist/mcp/auth/HubSpotAuthStrategy.js';
import { ServerAuthType } from '../dist/types/enums.js';
import { AuthUtils } from '../dist/utils/AuthUtils.js';

describe('HubSpot ServerAuthType coverage', () => {
  test('maps HubSpotAuth to the hubspot OAuth provider', () => {
    expect(AuthUtils.getOAuthProvider(ServerAuthType.HubSpotAuth)).toBe('hubspot');
  });

  test('creates HubSpotAuthStrategy for HubSpotAuth', () => {
    const strategy = AuthStrategyFactory.create(ServerAuthType.HubSpotAuth, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });

    expect(strategy).toBeInstanceOf(HubSpotAuthStrategy);
  });
});
