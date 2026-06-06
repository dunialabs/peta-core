import type { NextFunction, Request, Response } from 'express';
import type { TokenValidator } from '../../security/TokenValidator.js';
import { OAuthTokenValidator } from '../../security/OAuthTokenValidator.js';
import { AuthError, AuthErrorType, type AuthContext } from '../../types/auth.types.js';
import { MCPEventLogType } from '../../types/enums.js';
import { LogService } from '../../log/LogService.js';
import { getPublicUrl } from '../../utils/urlUtils.js';
import { createLogger } from '../../logger/index.js';
import { MODERN_MCP_CONFIG } from '../../config/modernMcp.config.js';

export class ModernMcpAuthMiddleware {
  private oauthTokenValidator = new OAuthTokenValidator();
  private logger = createLogger('ModernMcpAuthMiddleware');

  constructor(_tokenValidator: TokenValidator) {}

  authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';
      const hasQueryToken = req.query.token !== undefined || req.query.api_key !== undefined;

      if (hasQueryToken) {
        return this.sendAuthError(req, res, 'invalid_request', 'Modern MCP requires bearer tokens in the Authorization header');
      }

      if (!bearerToken) {
        return this.sendAuthError(req, res, 'invalid_token', 'Authorization header with Bearer token is required');
      }

      const resource = this.getCanonicalMcpResource(req);
      const authContext = await this.validateBearerToken(bearerToken, resource);
      this.enforceRolloutAllowlist(authContext);
      authContext.userAgent = req.headers['user-agent'] as string | undefined;
      req.authContext = authContext;
      await this.logAuth(req, authContext, authContext.token);
      return next();
    } catch (error) {
      this.logger.error({
        error,
        protocolEra: 'modern',
        protocolVersion: req.headers['mcp-protocol-version'],
        authFailureReason: error instanceof Error ? error.message : 'Token validation failed',
      }, 'Modern MCP authentication failed');
      if (error instanceof AuthError) {
        return this.sendAuthError(req, res, 'invalid_token', error.message);
      }
      return this.sendAuthError(req, res, 'invalid_token', error instanceof Error ? error.message : 'Token validation failed');
    }
  };

  private async validateBearerToken(token: string, resource: string): Promise<AuthContext> {
    const result = await this.oauthTokenValidator.validateToken(token, { expectedAudience: resource });
    if (!result.valid || !result.authContext) {
      throw new AuthError(AuthErrorType.INVALID_TOKEN, result.error ?? 'OAuth token validation failed');
    }
    return result.authContext;
  }

  private enforceRolloutAllowlist(authContext: AuthContext): void {
    if (MODERN_MCP_CONFIG.allowedClientIds.length > 0) {
      const clientId = authContext.oauthClientId;
      if (!clientId || !MODERN_MCP_CONFIG.allowedClientIds.includes(clientId)) {
        throw new AuthError(AuthErrorType.PERMISSION_DENIED, 'OAuth client is not enabled for MCP 2026');
      }
    }
    if (MODERN_MCP_CONFIG.allowedTenantIds.length > 0) {
      const tenantId = authContext.tenantId ?? '';
      if (!MODERN_MCP_CONFIG.allowedTenantIds.includes(tenantId)) {
        throw new AuthError(AuthErrorType.PERMISSION_DENIED, 'Tenant is not enabled for MCP 2026');
      }
    }
  }

  private sendAuthError(
    req: Request,
    res: Response,
    error: 'invalid_token' | 'invalid_request' | 'insufficient_scope',
    description: string,
  ): void {
    const protocol = req.headers['x-forwarded-proto'] as string || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] as string || req.headers.host;
    const metadataUrl = `${protocol}://${host}/.well-known/oauth-protected-resource/mcp`;
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="peta-core", error="${error}", error_description="${description}", resource_metadata="${metadataUrl}", scope="mcp:tools mcp:resources mcp:prompts"`,
    );
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: description },
      id: null,
    });
  }

  private getCanonicalMcpResource(req: Request): string {
    const base = getPublicUrl(req);
    return base.endsWith('/mcp') ? base : `${base}/mcp`;
  }

  private async logAuth(req: Request, authContext: AuthContext, tokenMask: string): Promise<void> {
    await LogService.getInstance().enqueueLog({
      action: MCPEventLogType.AuthTokenValidation,
      userId: authContext.userId,
      sessionId: undefined,
      ip: req.clientIp || req.ip,
      userAgent: req.headers['user-agent'],
      tokenMask,
      requestParams: JSON.stringify({
        _peta: {
          protocolEra: 'modern',
          protocolVersion: req.headers['mcp-protocol-version'] ?? null,
          authFailureReason: null,
        },
      }),
    });
  }
}
