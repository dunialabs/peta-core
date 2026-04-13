import { AuthStrategyFactory } from '../dist/mcp/auth/AuthStrategyFactory.js';
import { SlackAuthStrategy } from '../dist/mcp/auth/SlackAuthStrategy.js';
import { ServerAuthType } from '../dist/types/enums.js';
import { AuthUtils } from '../dist/utils/AuthUtils.js';

describe('Slack ServerAuthType coverage', () => {
  test('maps SlackAuth to the slack OAuth provider', () => {
    expect(AuthUtils.getOAuthProvider(ServerAuthType.SlackAuth)).toBe('slack');
  });

  test('creates SlackAuthStrategy for SlackAuth', () => {
    const strategy = AuthStrategyFactory.create(ServerAuthType.SlackAuth, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      tokenMode: 'user',
    });

    expect(strategy).toBeInstanceOf(SlackAuthStrategy);
  });
});
