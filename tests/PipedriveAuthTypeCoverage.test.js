import { AuthStrategyFactory } from '../dist/mcp/auth/AuthStrategyFactory.js';
import { PipedriveAuthStrategy } from '../dist/mcp/auth/PipedriveAuthStrategy.js';
import { ServerAuthType } from '../dist/types/enums.js';
import { AuthUtils } from '../dist/utils/AuthUtils.js';

describe('Pipedrive ServerAuthType coverage', () => {
  test('maps PipedriveAuth to the pipedrive OAuth provider', () => {
    expect(AuthUtils.getOAuthProvider(ServerAuthType.PipedriveAuth)).toBe('pipedrive');
  });

  test('creates PipedriveAuthStrategy for PipedriveAuth', () => {
    const strategy = AuthStrategyFactory.create(ServerAuthType.PipedriveAuth, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      apiDomain: 'https://company.pipedrive.com',
    });

    expect(strategy).toBeInstanceOf(PipedriveAuthStrategy);
  });
});
