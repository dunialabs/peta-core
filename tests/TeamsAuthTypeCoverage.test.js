import { AuthStrategyFactory } from '../dist/mcp/auth/AuthStrategyFactory.js';
import { TeamsAuthStrategy } from '../dist/mcp/auth/TeamsAuthStrategy.js';
import { getSupportedProviders } from '../dist/mcp/oauth/index.js';
import { ServerAuthType } from '../dist/types/enums.js';
import { AuthUtils } from '../dist/utils/AuthUtils.js';

describe('Teams ServerAuthType coverage', () => {
  test('maps TeamsAuth to the teams OAuth provider', () => {
    expect(AuthUtils.getOAuthProvider(ServerAuthType.TeamsAuth)).toBe('teams');
  });

  test('registers teams in the OAuth provider registry', () => {
    expect(getSupportedProviders()).toContain('teams');
  });

  test('creates TeamsAuthStrategy for TeamsAuth', () => {
    const strategy = AuthStrategyFactory.create(ServerAuthType.TeamsAuth, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });

    expect(strategy).toBeInstanceOf(TeamsAuthStrategy);
  });
});
