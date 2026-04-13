import { ServerAuthType } from '../../types/enums.js';
import { IAuthStrategy } from './IAuthStrategy.js';
import { GoogleAuthStrategy } from './GoogleAuthStrategy.js';
import { NotionAuthStrategy } from './NotionAuthStrategy.js';
import { FigmaAuthStrategy } from './FigmaAuthStrategy.js';
import { GithubAuthStrategy } from './GithubAuthStrategy.js';
import { CanvaAuthStrategy } from './CanvaAuthStrategy.js';
import { ZendeskAuthStrategy } from './ZendeskAuthStrategy.js';
import { PipedriveAuthStrategy } from './PipedriveAuthStrategy.js';
import { HubSpotAuthStrategy } from './HubSpotAuthStrategy.js';
import { IntercomAuthStrategy } from './IntercomAuthStrategy.js';
import { SlackAuthStrategy } from './SlackAuthStrategy.js';
import { createLogger } from '../../logger/index.js';

// Logger for AuthStrategyFactory
const logger = createLogger('AuthStrategyFactory');

/**
 * Authentication strategy factory
 *
 * Creates corresponding authentication strategy instances based on authType
 */
export class AuthStrategyFactory {
  /**
   * Create authentication strategy
   *
   * @param authType Authentication type
   * @param config OAuth configuration
   * @returns Authentication strategy instance, returns null if automatic refresh is not needed
   */
  static create(authType: ServerAuthType, config: any): IAuthStrategy | null {
    switch (authType) {
      case ServerAuthType.GoogleAuth:
      case ServerAuthType.GoogleCalendarAuth:
      case ServerAuthType.GmailAuth:
      case ServerAuthType.GoogleDocsAuth:
      case ServerAuthType.GoogleSheetsAuth:
      case ServerAuthType.GoogleFormsAuth:
        return new GoogleAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
        });

      case ServerAuthType.NotionAuth:
        return new NotionAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken,
          expiresAt: config.expiresAt,
        });

      case ServerAuthType.FigmaAuth:
        return new FigmaAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken,
          expiresAt: config.expiresAt,
        });

      case ServerAuthType.GithubAuth:
        return new GithubAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken,
          expiresAt: config.expiresAt,
          refreshTokenExpiresAt: config.refreshTokenExpiresAt,
        });

      case ServerAuthType.CanvaAuth:
        return new CanvaAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken,
          expiresAt: config.expiresAt,
        });

      case ServerAuthType.ZendeskAuth:
        return new ZendeskAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          tokenUrl: config.tokenUrl,
          scope: config.scope,
          accessToken: config.accessToken,
          expiresAt: config.expiresAt,
          refreshTokenExpiresAt: config.refreshTokenExpiresAt,
          expiresInSeconds: config.expiresInSeconds,
          refreshTokenExpiresInSeconds: config.refreshTokenExpiresInSeconds,
        });

      case ServerAuthType.PipedriveAuth:
        return new PipedriveAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken,
          expiresAt: config.expiresAt,
          apiDomain: config.apiDomain,
        });

      case ServerAuthType.HubSpotAuth:
        return new HubSpotAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken,
          expiresAt: config.expiresAt,
        });

      case ServerAuthType.IntercomAuth:
        return new IntercomAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken,
          expiresAt: config.expiresAt,
          intercomRegion: config.intercomRegion,
        });

      case ServerAuthType.SlackAuth:
        return new SlackAuthStrategy({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: config.refreshToken,
          accessToken: config.accessToken,
          expiresAt: config.expiresAt,
          tokenMode: config.tokenMode,
        });

      case ServerAuthType.ApiKey:
        // API Key doesn't need automatic refresh, return null
        return null;

      // Reserved extension point: can add other OAuth providers in the future
      // case ServerAuthType.GitHubAuth:
      //   return new GitHubAuthStrategy(config);

      // case ServerAuthType.MicrosoftAuth:
      //   return new MicrosoftAuthStrategy(config);

      default:
        logger.warn({ authType }, 'Unsupported auth type');
        return null;
    }
  }
}
