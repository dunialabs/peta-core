import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { TokenValidator } from '../security/TokenValidator.js';
import { AuthContext, AuthError, AuthErrorType, DisconnectReason } from '../types/auth.types.js';
import { Permissions, ServerConfigWithEnabled } from '../mcp/types/mcp.js';
import { SessionStore } from '../mcp/core/SessionStore.js';
import { ClientSession } from '../mcp/core/ClientSession.js';
import { UserRepository } from '../repositories/UserRepository.js';
import { AuthUtils } from '../utils/AuthUtils.js';
import { isInitializeRequest, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AUTH_CONFIG } from '../config/auth.config.js';
import { OAuthTokenValidator } from '../security/OAuthTokenValidator.js';
import { UserRole, UserStatus, MCPEventLogType } from '../types/enums.js';
import { LogService } from '../log/LogService.js';
import { createLogger } from '../logger/index.js';
import { prisma } from '../config/prisma.js';
import { getAuthorizationServerUrl } from '../utils/urlUtils.js';
import { maskToken } from '../utils/tokenMask.js';

const PUBLIC_URL_CONFIGURATION_ERROR = 'PETA_PUBLIC_URL or a trusted proxy is required for public URLs';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
      clientSession?: ClientSession;
    }
  }
}

export class AuthMiddleware {
  private userRepository = UserRepository;
  private oauthTokenValidator: OAuthTokenValidator;
  
  // Logger for AuthMiddleware
  private logger = createLogger('AuthMiddleware');

  constructor(
    private tokenValidator: TokenValidator,
  ) {
    this.oauthTokenValidator = new OAuthTokenValidator();
  }

  /**
   * Authentication middleware main function
   */
  authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // 1. Check if there's already a valid session
      const sessionId = req.headers['Mcp-Session-Id'] as string || req.headers['mcp-session-id'] as string;
      if (sessionId && sessionId.length > 0) {
        this.logger.debug({ sessionId }, 'Session ID found');
        const existingSession = SessionStore.instance.getSession(sessionId);
        if (existingSession) {

          const token = existingSession.token;
          const isJwtFormat = token.includes('.') && token.split('.').length === 3;
          if (isJwtFormat) {
            const oauthResult = await this.oauthTokenValidator.validateToken(token);
            if (!oauthResult.valid) {
              await SessionStore.instance.removeAllUserSessions(
                existingSession.userId,
                DisconnectReason.SESSION_REMOVED
              );
              const authError = new AuthError(
                AuthErrorType.INVALID_TOKEN,
                oauthResult.error || 'OAuth token validation failed',
                existingSession.userId
              );
              return this.sendAuthError(req, res, authError);
            }
          }
           
          // New: Check if user info needs to be refreshed (every 5 minutes)
          await this.refreshUserInfoIfNeeded(existingSession);
          
          // Check if session is expired
          if (existingSession.isExpired()) {
            // Query database to confirm if really expired
            const user = await this.userRepository.findByUserId(existingSession.userId);
            
            if (!user || (user.expiresAt && user.expiresAt > 0 && Math.floor(Date.now() / 1000) > user.expiresAt)) {
              // Confirmed expired, clean up all user sessions
              await SessionStore.instance.removeAllUserSessions(
                existingSession.userId,
                DisconnectReason.USER_EXPIRED
              );
              const authError = new AuthError(
                AuthErrorType.USER_EXPIRED,
                'User authorization has expired',
                existingSession.userId
              );
              return this.sendAuthError(req, res, authError);
            } else {
              // User was renewed, update cache
              existingSession.updateExpiresAt(
                user.expiresAt && user.expiresAt > 0 ? user.expiresAt : null
              );
            }
          }

          // Session valid, set request context
          req.authContext = existingSession.authContext;
          req.clientSession = existingSession;
          SessionStore.instance.getSessionLogger(existingSession.sessionId)?.updateContext(req.clientIp ?? '0.0.0.0', req.headers['user-agent'] as string || 'unknown');
          
          // Update session active time
          existingSession.touch();
          
          // Return session ID in response header
          res.setHeader('Mcp-Session-Id', existingSession.sessionId);
          res.setHeader('mcp-session-id', existingSession.sessionId);
          
          return next();
        } else {
          if (req.method === 'DELETE') {
            return next();
          }
          this.logger.debug({ sessionId }, 'No valid session ID provided');
          // res.status(400).json({
          //   jsonrpc: '2.0',
          //   error: {
          //     code: ErrorCode.ConnectionClosed,
          //     message: 'Bad Request: No valid session ID provided',
          //   },
          //   id: null,
          // });
          // return ;
        }
      }

      if (req.method !== 'POST') {
        this.logger.debug({ method: req.method }, 'Request method is not POST, skipping authentication');
        return next();
      }

      // Check if this is an MCP initialization request
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: ErrorCode.ConnectionClosed,
            message: 'Bad Request: Server not initialized',
          },
          id: null,
        });
        return ;
      }

      let token: string | undefined = undefined;
      // 2. Extract token from Authorization header
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      } else if (req.query.token && typeof req.query.token === 'string') {
        token = req.query.token;
      } else if (req.query.api_key && typeof req.query.api_key === 'string') {
        token = req.query.api_key;
      }

      const hasAuthAttempt = !!(authHeader || req.query.token !== undefined || req.query.api_key !== undefined);
      // Use the original request path so anonymous access detection does not depend
      // on how Express strips mount prefixes for the current middleware layer.
      const originalPath = new URL(req.originalUrl, 'http://localhost').pathname;
      const requestsAnonymous = originalPath === '/mcp/public' || originalPath === '/mcp/public/';

      if (!token && hasAuthAttempt) {
        const authError = new AuthError(
          AuthErrorType.INVALID_TOKEN,
          'Authorization header with Bearer token is required'
        );
        return this.sendAuthError(req, res, authError, 'invalid_request');
      }

      // Anonymous access is signaled by the /mcp/public path.
      // The standard /mcp path always returns 401 + WWW-Authenticate to preserve
      // the OAuth discovery flow (MCP SDK expects 401 to trigger authorization).
      if (!token && !hasAuthAttempt && requestsAnonymous) {
        return this.handleAnonymousAccess(req, res, next);
      }

      if (!token) {
        // No token and not on /mcp/public path → standard 401 for OAuth discovery
        const authError = new AuthError(
          AuthErrorType.INVALID_TOKEN,
          'Authorization header with Bearer token is required'
        );
        return this.sendAuthError(req, res, authError, 'invalid_request');
      }


      // 3. Try to validate OAuth token
      let authContext: AuthContext;

      // Determine type based on token format characteristics
      const isJwtFormat = token.includes('.') && token.split('.').length === 3;
      const isHexFormat = /^[a-f0-9]{128}$/i.test(token);

      try {
        if (isJwtFormat) {
          // JWT format, use OAuth validation
          this.logger.debug('Token detected as JWT format, using OAuth validation');
          const oauthResult = await this.oauthTokenValidator.validateToken(token);
          if (oauthResult.valid) {
            authContext = oauthResult.authContext!;
          } else {
            throw new AuthError(
              AuthErrorType.INVALID_TOKEN,
              oauthResult.error || 'OAuth token validation failed'
            );
          }
        } else if (isHexFormat) {
          // 128-character hex format, use traditional token validation
          this.logger.debug('Token detected as traditional format (128-character hex), using traditional validation');
          authContext = await this.tokenValidator.validateToken(token);
        } else {
          // Unknown format, try both validation methods
          this.logger.debug('Unknown token format, attempting both validations');
          try {
            const oauthResult = await this.oauthTokenValidator.validateToken(token);
            if (oauthResult.valid) {
              authContext = oauthResult.authContext!;
            } else {
              // OAuth validation failed, try traditional token validation
              authContext = await this.tokenValidator.validateToken(token);
            }
          } catch (oauthError) {
            // OAuth validation failed, try traditional token validation
            authContext = await this.tokenValidator.validateToken(token);
          }
        }
      } catch (error) {
        this.logger.error({ error }, 'Token validation failed');
        LogService.getInstance().enqueueLog({
          action: MCPEventLogType.AuthError,
          error: `Token validation failed: ${error}`,
        });
        throw error;
      }

      authContext.userAgent = req.headers['user-agent'] as string || undefined;

      // 6. Set request context
      req.authContext = authContext;

      // 4. Create new client session
      const newSessionId = SessionStore.instance.consumeTerminatedSession(sessionId, authContext, token)
        ? sessionId
        : AuthUtils.generateSessionId();

      const clientSession = await SessionStore.instance.createSession(
        newSessionId,
        authContext.userId,
        token,
        authContext,
        req.clientIp || '0.0.0.0',
        (req.headers['user-agent'] as string) || 'unknown'
      );
      req.clientSession = clientSession;

      // Log AuthTokenValidation (3001) - Only on FIRST validation (new session creation)
      const sessionLogger = SessionStore.instance.getSessionLogger(clientSession.sessionId);
      if (sessionLogger) {
        await sessionLogger.logAuth({
          action: MCPEventLogType.AuthTokenValidation,
        });
      }

      // 7. Return session ID in response header
      res.setHeader('Mcp-Session-Id', clientSession.sessionId);
      res.setHeader('mcp-session-id', clientSession.sessionId);
      
      // 8. Log connection
      AuthUtils.logAuthEvent('user_connected', authContext.userId, undefined, true);

      next();
    } catch (error) {
      this.logger.error({ error }, 'Authentication middleware error');
      if (error instanceof AuthError) {
        return this.sendAuthError(req, res, error);
      } else {
        this.logger.error({ error }, 'Authentication middleware error (non-AuthError)');
        const authError = new AuthError(
          AuthErrorType.INVALID_TOKEN,
          'Internal authentication error',
          undefined
        );
        return this.sendAuthError(req, res, authError);
      }
    }
  };

  /**
   * Build WWW-Authenticate response header
   * Follows RFC 6750 and MCP extension specifications
   */
  private buildWWWAuthenticateHeader(
    req: Request,
    error: 'invalid_token' | 'invalid_request' | 'insufficient_scope',
    errorDescription: string
  ): string | undefined {
    let metadataUrl: string;
    try {
      metadataUrl = `${getAuthorizationServerUrl(req)}/.well-known/oauth-protected-resource`;
    } catch (error) {
      if (error instanceof Error && error.message === PUBLIC_URL_CONFIGURATION_ERROR) {
        return undefined;
      }
      throw error;
    }

    // Build WWW-Authenticate header
    // Format: Bearer error="...", error_description="...", resource_metadata="..."
    return `Bearer realm="peta-core", error="${error}", error_description="${errorDescription}", resource_metadata="${metadataUrl}"`;
  }

  /**
   * Send authentication error response (unified method)
   */
  private sendAuthError(
    req: Request,
    res: Response,
    error: AuthError,
    wwwAuthError: 'invalid_token' | 'invalid_request' | 'insufficient_scope' = 'invalid_token'
  ): void {
    const statusCode = this.getStatusCodeForError(error.type);

    // Log authentication failure
    AuthUtils.logAuthEvent('auth_failed', error.userId, undefined, false, error.message);

    // For 401 errors, add WWW-Authenticate response header
    if (statusCode === 401) {
      const header = this.buildWWWAuthenticateHeader(req, wwwAuthError, error.message);
      if (header) {
        res.setHeader('WWW-Authenticate', header);
      }
    }

    res.status(statusCode).json({
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.ConnectionClosed,
        message: error.message
      }
    });
  }

  /**
   * Get HTTP status code based on error type
   */
  private getStatusCodeForError(errorType: AuthErrorType): number {
    switch (errorType) {
      case AuthErrorType.INVALID_TOKEN:
      case AuthErrorType.USER_NOT_FOUND:
        return 401;
      case AuthErrorType.USER_DISABLED:
      case AuthErrorType.USER_EXPIRED:
      case AuthErrorType.PERMISSION_DENIED:
        return 403;
      case AuthErrorType.SESSION_EXPIRED:
        return 401;
      case AuthErrorType.DECRYPTION_FAILED:
        return 500;
      default:
        return 401;
    }
  }

  /**
   * Handle anonymous (token-less) access to MCP endpoint.
   * Only called when the client connects via the /mcp/public endpoint path.
   * Creates a synthetic session with permissions for all anonymously-enabled servers.
   *
   * IMPORTANT: Anonymous identity is derived from source IP (sha256 hash).
   * This means rate limiting is per-source-IP, NOT per-user.
   * Multiple users behind NAT/proxy/platform IPs share the same rate limit bucket.
   */
  private async handleAnonymousAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    // 1. Origin validation (MCP spec — block non-HTTP(S) origins)
    const origin = req.headers['origin'];
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          const authError = new AuthError(AuthErrorType.PERMISSION_DENIED, 'Forbidden: invalid Origin header');
          return this.sendAuthError(req, res, authError);
        }
      } catch {
          const authError = new AuthError(AuthErrorType.PERMISSION_DENIED, 'Forbidden: invalid Origin header');
        return this.sendAuthError(req, res, authError);
      }
    }

    // 2. Query all anonymously-accessible servers
    const servers = await prisma.server.findMany({
      where: { anonymousAccess: true, enabled: true, allowUserInput: false },
      select: { serverId: true, serverName: true, authType: true, anonymousRateLimit: true }
    });

    if (servers.length === 0) {
      const authError = new AuthError(AuthErrorType.INVALID_TOKEN, 'No anonymous access available');
      return this.sendAuthError(req, res, authError, 'invalid_request');
    }

    // 3. Build permissions for all anonymous servers
    const permissions: Permissions = {};
    let minRateLimit = Infinity;
    for (const server of servers) {
      permissions[server.serverId] = {
        enabled: true,
        serverName: server.serverName,
        allowUserInput: false,
        authType: server.authType,
        tools: {}, resources: {}, prompts: {},
        configured: false,
        configTemplate: '{}',
      } as ServerConfigWithEnabled;
      minRateLimit = Math.min(minRateLimit, server.anonymousRateLimit);
    }

    // 4. Build synthetic AuthContext
    // NOTE: userId is IP-derived — this is a per-source-IP identity, not a true user identity.
    // Rate limiting applied downstream uses this userId as the bucket key.
    const clientIp = req.clientIp || '0.0.0.0';
    const ipHash = createHash('sha256').update(clientIp).digest('hex').substring(0, 12);
    const authContext: AuthContext = {
      kind: 'anonymous',
      userId: `anon:${ipHash}`,
      token: `anon-${ipHash}`,
      role: UserRole.Guest,
      status: UserStatus.Enabled,
      permissions,
      userPreferences: {} as Permissions,
      launchConfigs: '{}',
      authenticatedAt: new Date(),
      expiresAt: null,
      rateLimit: minRateLimit === Infinity ? 10 : minRateLimit,
    };
    authContext.userAgent = req.headers['user-agent'] as string || undefined;

    // 5. Create session via existing SessionStore
    const requestedSessionId =
      typeof req.headers['Mcp-Session-Id'] === 'string'
        ? req.headers['Mcp-Session-Id']
        : typeof req.headers['mcp-session-id'] === 'string'
          ? req.headers['mcp-session-id']
          : undefined;
    const newSessionId = SessionStore.instance.consumeTerminatedSession(
      requestedSessionId,
      authContext,
      authContext.token,
    )
      ? requestedSessionId!
      : AuthUtils.generateSessionId();

    const clientSession = await SessionStore.instance.createSession(
      newSessionId,
      authContext.userId,
      authContext.token,
      authContext,
      clientIp,
      (req.headers['user-agent'] as string) || 'anonymous'
    );

    req.authContext = authContext;
    req.clientSession = clientSession;
    res.setHeader('Mcp-Session-Id', clientSession.sessionId);
    res.setHeader('mcp-session-id', clientSession.sessionId);

    // 6. Audit log
    LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AuthTokenValidation,
      userId: authContext.userId,
      sessionId: clientSession.sessionId,
      ip: clientIp,
      userAgent: req.headers['user-agent'] as string,
      tokenMask: 'anonymous',
    });

    this.logger.info({ ip: clientIp, sessionId: clientSession.sessionId, serverCount: servers.length }, 'Anonymous session created');

    next();
  }

  /**
   * Check and refresh user info (every 5 minutes)
   */
  private async refreshUserInfoIfNeeded(session: ClientSession): Promise<void> {
    // Skip refresh for anonymous sessions (no real user in DB)
    if (session.authContext.kind === 'anonymous') return;
    const now = Date.now();
    const lastRefresh = session.getLastUserInfoRefresh();
    
    // Check if more than 5 minutes have passed
    if (!lastRefresh || (now - lastRefresh) >= AUTH_CONFIG.USER_INFO_REFRESH_INTERVAL) {
      try {
        await this.refreshUserInfo(session);
        session.updateLastUserInfoRefresh(now);
      } catch (error) {
        this.logger.warn({ error, sessionId: session.sessionId }, 'Failed to refresh user info for session');
        // Don't throw error, continue using existing information
      }
    }
  }

  /**
   * Refresh user information
   */
  private async refreshUserInfo(session: ClientSession): Promise<void> {
    const user = await this.userRepository.findByUserId(session.userId);
    if (!user) {
      throw new Error(`User ${session.userId} not found`);
    }

    // Update authentication context
    const parsedPermissions: any = typeof user.permissions === 'string' 
      ? JSON.parse(user.permissions) 
      : user.permissions;
    
    // Ensure permissions object structure is correct
    const permissions = parsedPermissions as Permissions;
    const userPreferences = JSON.parse(user.userPreferences || '{}') as Permissions;

    const tokenMask = maskToken(session.token);

    const updatedAuthContext: AuthContext = {
      kind: session.authContext.kind,
      userId: user.userId,
      token: tokenMask,
      role: user.role,
      status: user.status,
      permissions: permissions,
      userPreferences: userPreferences,
      launchConfigs: user.launchConfigs,
      authenticatedAt: session.authContext.authenticatedAt,
      expiresAt: user.expiresAt && user.expiresAt > 0 ? user.expiresAt : null,
      rateLimit: user.ratelimit,
      tenantId: user.proxyId > 0 ? String(user.proxyId) : undefined,
    };

    // Update authentication context in session
    session.updateAuthContext(updatedAuthContext);
    
    // Log user information refresh
    AuthUtils.logAuthEvent('user_info_refreshed', user.userId, undefined, true);
  }
}
