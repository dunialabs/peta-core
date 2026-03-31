import { AuthStrategyFactory } from '../dist/mcp/auth/AuthStrategyFactory.js';
import { GoogleAuthStrategy } from '../dist/mcp/auth/GoogleAuthStrategy.js';
import { ServerAuthType } from '../dist/types/enums.js';
import { AuthUtils } from '../dist/utils/AuthUtils.js';

const googleFamilyAuthTypes = [
  ServerAuthType.GoogleAuth,
  ServerAuthType.GoogleCalendarAuth,
  ServerAuthType.GmailAuth,
  ServerAuthType.GoogleDocsAuth,
  ServerAuthType.GoogleSheetsAuth,
  ServerAuthType.GoogleFormsAuth,
];

describe('Google-family ServerAuthType coverage', () => {
  test.each(googleFamilyAuthTypes)(
    'maps auth type %s to the google OAuth provider',
    (authType) => {
      expect(AuthUtils.getOAuthProvider(authType)).toBe('google');
    },
  );

  test.each(googleFamilyAuthTypes)(
    'creates GoogleAuthStrategy for auth type %s',
    (authType) => {
      const strategy = AuthStrategyFactory.create(authType, {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      });

      expect(strategy).toBeInstanceOf(GoogleAuthStrategy);
    },
  );
});
