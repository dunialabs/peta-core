/**
 * OAuth Controller
 * Handles OAuth core endpoints: register, authorize, token, revoke
 */

import { Request, Response } from 'express';
import { prisma } from '../../config/prisma.js';
import { OAuthService } from '../services/OAuthService.js';
import { OAuthClientService } from '../services/OAuthClientService.js';
import { OAUTH_CONFIG } from '../types/oauth.types.js';
import { TokenValidator } from '../../security/TokenValidator.js';
import { OAuthTokenValidator } from '../../security/OAuthTokenValidator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../logger/index.js';
import { ProxyRepository } from '../../repositories/ProxyRepository.js';
import { getAuthorizationServerUrl, getPublicUrl } from '../../utils/urlUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class OAuthController {
  private oauthService: OAuthService;
  private clientService: OAuthClientService;
  private tokenValidator: TokenValidator;
  private oauthTokenValidator: OAuthTokenValidator;
  
  // Logger for OAuthController
  private logger = createLogger('OAuthController');

  /**
   * Escape string for safe inclusion in HTML content
   */
  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private isClientMetadataError(error: unknown): error is Error {
    return error instanceof Error && (error.message.startsWith('invalid_client_metadata:') || error.message.startsWith('invalid_redirect_uri:'));
  }

  private clientMetadataErrorCode(error: Error): string {
    const separator = error.message.indexOf(': ');
    return separator === -1 ? error.message : error.message.slice(0, separator);
  }

  private clientMetadataErrorDescription(error: Error): string {
    const separator = error.message.indexOf(': ');
    return separator === -1 ? error.message : error.message.slice(separator + 2);
  }

  constructor() {
    this.oauthService = new OAuthService();
    this.clientService = new OAuthClientService();
    this.tokenValidator = new TokenValidator();
    this.oauthTokenValidator = new OAuthTokenValidator();
  }

  /**
   * Add CORS headers
   */
  private addCorsHeaders(res: Response): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  /**
   * Handle OPTIONS request (CORS)
   */
  handleOptions = (_req: Request, res: Response): void => {
    this.addCorsHeaders(res);
    res.status(200).end();
  };

  /**
   * POST /register - Dynamic client registration (RFC 7591)
   */
  register = async (req: Request, res: Response): Promise<void> => {
    try {
      const metadata = req.body;

      // Check if it's URL-based client ID (SEP-991)
      const isUrlBasedClientId = metadata.client_id &&
                                  typeof metadata.client_id === 'string' &&
                                  metadata.client_id.startsWith('https://');

      // Validate required fields
      // For URL-based client ID, skip validation (metadata will be fetched from URL)
      if (!isUrlBasedClientId) {
        if (!metadata.redirect_uris || !Array.isArray(metadata.redirect_uris)) {
          this.addCorsHeaders(res);
          res.status(400).json({
            error: 'invalid_client_metadata',
            error_description: 'redirect_uris is required and must be an array'
          });
          return;
        }
      }

      // Register client
      const issuer = getAuthorizationServerUrl(req);
      const clientInfo = await this.clientService.registerClient(metadata, undefined, issuer);

      this.addCorsHeaders(res);
      res.json(clientInfo);
    } catch (error) {
      this.logger.error({ error }, 'Client registration error');
      this.addCorsHeaders(res);

      if (error instanceof Error && (error.message.startsWith('invalid_client_metadata:') || error.message.startsWith('invalid_redirect_uri:'))) {
        const separator = error.message.indexOf(': ');
        res.status(400).json({
          error: separator === -1 ? error.message : error.message.slice(0, separator),
          error_description: separator === -1 ? error.message : error.message.slice(separator + 2)
        });
        return;
      }

      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error'
      });
    }
  };

  /**
   * GET /register/:clientId - Get client information (for authorization page)
   */
  getClientInfo = async (req: Request, res: Response): Promise<void> => {
    try {
      const { clientId } = req.params;

      const issuer = getAuthorizationServerUrl(req);
      const client = await this.clientService.getClientForIssuer(clientId, issuer);

      if (!client) {
        this.addCorsHeaders(res);
        res.status(404).json({
          error: 'not_found',
          error_description: 'Client not found'
        });
        return;
      }

      // Only return public information
      this.addCorsHeaders(res);
      res.json({
        client_id: client.client_id,
        issuer: client.issuer,
        client_name: client.client_name,
        application_type: client.application_type,
        redirect_uris: client.redirect_uris,
        scopes: client.scopes,
      });
    } catch (error) {
      this.logger.error({ error }, 'Get client info error');
      this.addCorsHeaders(res);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error'
      });
    }
  };

  /**
   * GET /authorize - Show authorization confirmation page
   */
  showAuthorizePage = async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        response_type,
        client_id,
        redirect_uri,
        scope,
        state,
        code_challenge,
        code_challenge_method,
        resource
      } = req.query;

      // Validate required parameters
      if (!response_type || !client_id || !redirect_uri) {
        res.status(400).send('Missing required parameters');
        return;
      }

      // Validate response_type
      if (response_type !== 'code') {
        res.status(400).send('Unsupported response_type');
        return;
      }

      // Query client information
      const issuer = getAuthorizationServerUrl(req);
      const client = await this.getAuthorizationClient(client_id, issuer);
      if (!client) {
        res.status(400).send('Invalid client_id');
        return;
      }

      if (!client.response_types.includes(response_type as string)) {
        res.status(400).send('Unsupported response_type for client');
        return;
      }

      // Validate redirect_uri
      if (!this.oauthService.validateRedirectUri(redirect_uri as string, client.redirect_uris)) {
        res.status(400).send('Invalid redirect_uri');
        return;
      }

      // Query Proxy information
      const proxy = await ProxyRepository.findFirst();
      const proxyKey = proxy?.proxyKey || '';

      // Read HTML template
      const templatePath = path.join(__dirname, '../views/consent.html');
      let html = fs.readFileSync(templatePath, 'utf-8');

      // Replace template variables
      const requestedScopes = this.oauthService.parseScope(scope as string);
      if (!this.oauthService.isScopeSubset(requestedScopes, client.scopes)) {
        res.status(400).send('Requested scope exceeds registered client scopes');
        return;
      }
      const scopeDescriptions: Record<string, string> = {
        'mcp:tools': 'Execute MCP tools and functions',
        'mcp:resources': 'Access MCP resources and data',
        'mcp:prompts': 'Use MCP prompt templates',
      };

      const scopeListHtml = requestedScopes
        .map(s => `<li><span class="scope-icon">✓</span>${this.escapeHtml(scopeDescriptions[s] || s)}</li>`)
        .join('');

      const jsEscape = (val: string): string => JSON.stringify(val)
        .slice(1, -1)
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/&/g, '\\u0026');

      html = html
        .replace('__CLIENT_NAME__', this.escapeHtml(client.client_name || 'Unknown Application'))
        .replace('{{SCOPE_LIST}}', scopeListHtml)
        .replace('{{CLIENT_ID}}', jsEscape(client_id as string))
        .replace('{{REDIRECT_URI}}', jsEscape(redirect_uri as string))
        .replace('{{SCOPE}}', jsEscape(scope as string || ''))
        .replace('{{STATE}}', jsEscape(state as string || ''))
        .replace('{{CODE_CHALLENGE}}', jsEscape(code_challenge as string || ''))
        .replace('{{CODE_CHALLENGE_METHOD}}', jsEscape(code_challenge_method as string || ''))
        .replace('{{RESOURCE}}', jsEscape(resource as string || ''))
        .replace('{{PROXY_KEY}}', jsEscape(proxyKey));

      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      this.logger.error({ error }, 'Show authorize page error');
      if (this.isClientMetadataError(error)) {
        res.status(400).send(this.clientMetadataErrorDescription(error));
        return;
      }
      res.status(500).send('Internal server error');
    }
  };

  /**
   * POST /authorize - Handle authorization confirmation
   */
  authorize = async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        client_id,
        redirect_uri,
        scope,
        state,
        code_challenge,
        code_challenge_method,
        resource,
        approved,
        user_token
      } = req.body;

      // Validate client
      const issuer = getAuthorizationServerUrl(req);
      const client = await this.getAuthorizationClient(client_id, issuer);
      if (!client) {
        this.addCorsHeaders(res);
        res.status(400).json({
          error: 'invalid_client',
          error_description: 'Client not found'
        });
        return;
      }

      if (!client.response_types.includes('code')) {
        this.addCorsHeaders(res);
        res.status(400).json({
          error: 'unsupported_response_type',
          error_description: 'Client is not registered for authorization code response'
        });
        return;
      }

      // Validate redirect_uri
      if (!this.oauthService.validateRedirectUri(redirect_uri, client.redirect_uris)) {
        this.addCorsHeaders(res);
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'Invalid redirect_uri'
        });
        return;
      }

      // If user denied authorization
      if (!approved) {
        const errorUrl = this.oauthService.buildErrorRedirectUrl(
          redirect_uri,
          'access_denied',
          'User denied authorization',
          state
        );
        this.addCorsHeaders(res);
        res.json({ redirect: errorUrl });
        return;
      }

      // Validate user token
      if (!user_token) {
        const errorUrl = this.oauthService.buildErrorRedirectUrl(
          redirect_uri,
          'invalid_request',
          'User token is required',
          state
        );
        this.addCorsHeaders(res);
        res.json({ redirect: errorUrl });
        return;
      }

      // Validate user identity
      let userId: string;
      try {
        const authContext = await this.tokenValidator.validateToken(user_token);
        userId = authContext.userId;
      } catch (error) {
        const errorUrl = this.oauthService.buildErrorRedirectUrl(
          redirect_uri,
          'invalid_request',
          'Invalid user token',
          state
        );
        this.addCorsHeaders(res);
        res.json({ redirect: errorUrl });
        return;
      }

      // Generate authorization code
      const code = this.oauthService.generateAuthorizationCode();
      const scopes = this.oauthService.parseScope(scope);
      if (!this.oauthService.isScopeSubset(scopes, client.scopes)) {
        const errorUrl = this.oauthService.buildErrorRedirectUrl(
          redirect_uri,
          'invalid_scope',
          'Requested scope exceeds registered client scopes',
          state
        );
        this.addCorsHeaders(res);
        res.json({ redirect: errorUrl });
        return;
      }
      const canonicalResource = getPublicUrl(req);
      if (typeof resource === 'string' && resource.length > 0 && resource !== canonicalResource) {
        const errorUrl = this.oauthService.buildErrorRedirectUrl(
          redirect_uri,
          'invalid_target',
          'Unsupported resource',
          state
        );
        this.addCorsHeaders(res);
        res.json({ redirect: errorUrl });
        return;
      }
      const expiresAt = new Date(Date.now() + OAUTH_CONFIG.AUTHORIZATION_CODE_LIFETIME * 1000);

      // Save authorization code
      await prisma.oAuthAuthorizationCode.create({
        data: {
          code,
          clientId: client_id,
          userId,
          redirectUri: redirect_uri,
          scopes,
          codeChallenge: code_challenge || null,
          challengeMethod: code_challenge_method || null,
          resource: canonicalResource,
          expiresAt,
          used: false,
        },
      });

      // Build success redirect URL
      const successUrl = this.oauthService.buildSuccessRedirectUrl(
        redirect_uri,
        code,
        state,
          issuer
      );

      this.addCorsHeaders(res);
      res.json({ redirect: successUrl });
    } catch (error) {
      this.logger.error({ error }, 'Authorization error');
      this.addCorsHeaders(res);
      if (this.isClientMetadataError(error)) {
        res.status(400).json({
          error: this.clientMetadataErrorCode(error),
          error_description: this.clientMetadataErrorDescription(error),
        });
        return;
      }
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error'
      });
    }
  };

  private getAuthorizationClient(clientId: unknown, issuer: string) {
    if (typeof clientId !== 'string') {
      return Promise.resolve(null);
    }

    if (clientId.startsWith('https://')) {
      return this.clientService.registerClient({ client_id: clientId, redirect_uris: [] }, undefined, issuer);
    }

    return this.clientService.getClientForIssuer(clientId, issuer);
  }

  /**
   * POST /token - Token exchange endpoint
   */
  token = async (req: Request, res: Response): Promise<void> => {
    try {
      const contentType = req.headers['content-type'];
      let body: any;

      // Support form-urlencoded and JSON
      if (contentType?.includes('application/x-www-form-urlencoded')) {
        body = req.body; // Express has already parsed it
      } else {
        body = req.body;
      }

      const { grant_type } = body;

      if (!grant_type) {
        this.addCorsHeaders(res);
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'grant_type is required'
        });
        return;
      }

      // Handle authorization_code grant
      if (grant_type === 'authorization_code') {
        await this.handleAuthorizationCodeGrant(req, res, body);
        return;
      }

      // Handle refresh_token grant
      if (grant_type === 'refresh_token') {
        await this.handleRefreshTokenGrant(req, res, body);
        return;
      }

      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: `Grant type ${grant_type} is not supported`
      });
    } catch (error) {
      this.logger.error({ error }, 'Token endpoint error');
      this.addCorsHeaders(res);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error'
      });
    }
  };

  /**
   * POST /introspect - Token introspection endpoint (RFC 7662)
   */
  introspect = async (req: Request, res: Response): Promise<void> => {
    try {
      const contentType = req.headers['content-type'];
      let body: any;

      // Support form-urlencoded and JSON
      if (contentType?.includes('application/x-www-form-urlencoded')) {
        body = req.body; // Express has already parsed it
      } else {
        body = req.body;
      }

      const { token, token_type_hint, client_id, client_secret } = body || {};

      if (!token || typeof token !== 'string') {
        this.addCorsHeaders(res);
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'token is required'
        });
        return;
      }

      // Client authentication is optional, but if provided needs to be verified
      let clientId = client_id;
      let clientSecret = client_secret;

      const authHeader = req.headers['authorization'];
      const basicAuth = authHeader ? this.oauthService.parseBasicAuth(authHeader as string) : null;
      if (basicAuth) {
        clientId = basicAuth.clientId;
        clientSecret = basicAuth.clientSecret;
      }

      if (clientId) {
        const issuer = getAuthorizationServerUrl(req);
        const client = await this.clientService.getClientForIssuer(clientId, issuer);
        if (!client) {
          this.addCorsHeaders(res);
          res.status(401).json({
            error: 'invalid_client',
            error_description: 'Client not found'
          });
          return;
        }

        if (client.token_endpoint_auth_method !== 'none') {
          if (!clientSecret) {
            this.addCorsHeaders(res);
            res.status(401).json({
              error: 'invalid_client',
              error_description: 'client_secret is required for confidential clients'
            });
            return;
          }

          const validClient = await this.clientService.verifyClientCredentials(clientId, clientSecret, issuer);
          if (!validClient) {
            this.addCorsHeaders(res);
            res.status(401).json({
              error: 'invalid_client',
              error_description: 'Invalid client credentials'
            });
            return;
          }
        }
      }

      // Only access tokens are supported (Peta Core issues JWT access tokens)
      if (token_type_hint && token_type_hint !== 'access_token') {
        this.addCorsHeaders(res);
        res.json({ active: false });
        return;
      }

      const validation = await this.oauthTokenValidator.validateToken(token);
      if (!validation.valid) {
        this.addCorsHeaders(res);
        res.json({ active: false });
        return;
      }

      // If a client_id was provided, ensure the token belongs to that client
      if (clientId && validation.authContext?.oauthClientId !== clientId) {
        this.addCorsHeaders(res);
        res.json({ active: false });
        return;
      }

      const verified = this.oauthService.verifyAccessToken(token);
      if (!verified.valid || !verified.payload) {
        this.addCorsHeaders(res);
        res.json({ active: false });
        return;
      }

      const payload = verified.payload as any;
      const response: any = {
        active: true,
        client_id: payload.client_id,
        sub: payload.user_id,
        scope: Array.isArray(payload.scopes) ? payload.scopes.join(' ') : undefined,
        exp: payload.exp,
        iat: payload.iat
      };

      if (payload.aud) {
        response.aud = payload.aud;
      }

      this.addCorsHeaders(res);
      res.json(response);
    } catch (error) {
      this.logger.error({ error }, 'Token introspection error');
      this.addCorsHeaders(res);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error'
      });
    }
  };

  /**
   * Handle authorization_code grant
   */
  private async handleAuthorizationCodeGrant(
    req: Request,
    res: Response,
    body: any
  ): Promise<void> {
    const {
      code,
      redirect_uri,
      client_id,
      client_secret,
      code_verifier,
    } = body;

    // Validate required parameters
    if (!code || !redirect_uri) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'code and redirect_uri are required'
      });
      return;
    }

    // Get client credentials
    let clientId = client_id;
    let clientSecret = client_secret;

    const authHeader = req.headers['authorization'];
    const basicAuth = authHeader ? this.oauthService.parseBasicAuth(authHeader as string) : null;
    if (basicAuth) {
      clientId = basicAuth.clientId;
      clientSecret = basicAuth.clientSecret;
    }

    if (!clientId) {
      this.addCorsHeaders(res);
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'client_id is required'
      });
      return;
    }

    // Query client
    const issuer = getAuthorizationServerUrl(req);
    const client = await this.clientService.getClientForIssuer(clientId, issuer);
    if (!client) {
      this.addCorsHeaders(res);
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'Client not found'
      });
      return;
    }

    if (!client.grant_types.includes('authorization_code')) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'unauthorized_client',
        error_description: 'Client is not registered for authorization_code grant'
      });
      return;
    }

    // Verify client credentials
    if (client.token_endpoint_auth_method !== 'none') {
      if (!clientSecret) {
        this.addCorsHeaders(res);
        res.status(401).json({
          error: 'invalid_client',
          error_description: 'client_secret is required for confidential clients'
        });
        return;
      }

      const validClient = await this.clientService.verifyClientCredentials(clientId, clientSecret, issuer);
      if (!validClient) {
        this.addCorsHeaders(res);
        res.status(401).json({
          error: 'invalid_client',
          error_description: 'Invalid client credentials'
        });
        return;
      }
    }

    // Query authorization code
    const authCode = await prisma.oAuthAuthorizationCode.findUnique({
      where: { code },
    });

    if (!authCode) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid authorization code'
      });
      return;
    }

    // Validate authorization code
    if (authCode.used) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Authorization code has been used'
      });
      return;
    }

    if (authCode.expiresAt < new Date()) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Authorization code has expired'
      });
      return;
    }

    if (authCode.clientId !== clientId) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Authorization code was issued to another client'
      });
      return;
    }

    if (authCode.redirectUri !== redirect_uri) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'redirect_uri mismatch'
      });
      return;
    }

    // Validate PKCE
    if (authCode.codeChallenge) {
      if (!code_verifier) {
        this.addCorsHeaders(res);
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'code_verifier is required'
        });
        return;
      }

      const validPKCE = this.oauthService.verifyPKCEChallenge(
        code_verifier,
        authCode.codeChallenge,
        (authCode.challengeMethod as 'plain' | 'S256') || 'S256'
      );

      if (!validPKCE) {
        this.addCorsHeaders(res);
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid code_verifier'
        });
        return;
      }
    }

    const claim = await prisma.oAuthAuthorizationCode.updateMany({
      where: { code, used: false, expiresAt: { gte: new Date() } },
      data: { used: true },
    });
    if (claim.count !== 1) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Authorization code has already been used or expired'
      });
      return;
    }

    // Generate tokens
    const accessToken = this.oauthService.generateAccessToken(
      authCode.clientId,
      authCode.userId,
      authCode.scopes as string[],
      authCode.resource || undefined
    );
    const issueRefreshToken = client.grant_types.includes('refresh_token');
    const refreshToken = issueRefreshToken ? this.oauthService.generateRefreshToken() : null;

    const accessTokenExpiresAt = new Date(
      Date.now() + OAUTH_CONFIG.ACCESS_TOKEN_LIFETIME * 1000
    );
    const refreshTokenExpiresAt = new Date(
      Date.now() + OAUTH_CONFIG.REFRESH_TOKEN_LIFETIME * 1000
    );

    // Save tokens
    await prisma.oAuthToken.create({
      data: {
        accessToken,
        refreshToken,
        clientId: authCode.clientId,
        userId: authCode.userId,
        scopes: authCode.scopes as any, // Prisma Json type
        resource: authCode.resource ?? undefined,
        accessTokenExpiresAt,
        refreshTokenExpiresAt: issueRefreshToken ? refreshTokenExpiresAt : null,
      },
    });

    // Return tokens
    const tokenResponse: any = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: OAUTH_CONFIG.ACCESS_TOKEN_LIFETIME,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: (authCode.scopes as string[]).join(' '),
    };

    if (authCode.resource) {
      tokenResponse.resource = authCode.resource;
    }

    this.addCorsHeaders(res);
    res.json(tokenResponse);
  }


  /**
   * Handle refresh_token grant
   */
  private async handleRefreshTokenGrant(
    req: Request,
    res: Response,
    body: any
  ): Promise<void> {
    const { refresh_token, client_id, client_secret, scope } = body;

    if (!refresh_token) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'refresh_token is required'
      });
      return;
    }

    // Get client credentials
    let clientId = client_id;
    let clientSecret = client_secret;

    const authHeader = req.headers['authorization'];
    const basicAuth = authHeader ? this.oauthService.parseBasicAuth(authHeader as string) : null;
    if (basicAuth) {
      clientId = basicAuth.clientId;
      clientSecret = basicAuth.clientSecret;
    }

    if (!clientId) {
      this.addCorsHeaders(res);
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'client_id is required'
      });
      return;
    }

    // Query client
    const issuer = getAuthorizationServerUrl(req);
    const client = await this.clientService.getClientForIssuer(clientId, issuer);
    if (!client) {
      this.addCorsHeaders(res);
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'Client not found'
      });
      return;
    }

    if (!client.grant_types.includes('refresh_token')) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'unauthorized_client',
        error_description: 'Client is not registered for refresh_token grant'
      });
      return;
    }

    // Verify client credentials
    if (client.token_endpoint_auth_method !== 'none') {
      if (!clientSecret) {
        this.addCorsHeaders(res);
        res.status(401).json({
          error: 'invalid_client',
          error_description: 'client_secret is required for confidential clients'
        });
        return;
      }

      const validClient = await this.clientService.verifyClientCredentials(clientId, clientSecret, issuer);
      if (!validClient) {
        this.addCorsHeaders(res);
        res.status(401).json({
          error: 'invalid_client',
          error_description: 'Invalid client credentials'
        });
        return;
      }
    }

    // Query refresh token
    const token = await prisma.oAuthToken.findUnique({
      where: { refreshToken: refresh_token },
    });

    if (!token) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token'
      });
      return;
    }

    if (token.revoked) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Token has been revoked'
      });
      return;
    }

    if (token.refreshTokenExpiresAt && token.refreshTokenExpiresAt < new Date()) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Refresh token has expired'
      });
      return;
    }

    if (token.clientId !== clientId) {
      this.addCorsHeaders(res);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Refresh token was issued to another client'
      });
      return;
    }

    // Handle scope
    let newScopes = token.scopes as string[];
    if (scope) {
      const requestedScopes = this.oauthService.parseScope(scope);
      const validScopes = this.oauthService.isScopeSubset(requestedScopes, token.scopes as string[]);
      if (!validScopes) {
        this.addCorsHeaders(res);
        res.status(400).json({
          error: 'invalid_scope',
          error_description: 'Requested scope exceeds original grant'
        });
        return;
      }
      newScopes = requestedScopes;
    }

    // Generate new access token
    const newAccessToken = this.oauthService.generateAccessToken(
      token.clientId,
      token.userId,
      newScopes,
      token.resource || undefined
    );

    const accessTokenExpiresAt = new Date(
      Date.now() + OAUTH_CONFIG.ACCESS_TOKEN_LIFETIME * 1000
    );

    // Update token record
    await prisma.oAuthToken.update({
      where: { tokenId: token.tokenId },
      data: {
        accessToken: newAccessToken,
        accessTokenExpiresAt,
        scopes: newScopes,
      },
    });

    // Return new access token
    const refreshResponse: any = {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: OAUTH_CONFIG.ACCESS_TOKEN_LIFETIME,
      refresh_token: refresh_token,
      scope: newScopes.join(' '),
    };

    if (token.resource) {
      refreshResponse.resource = token.resource;
    }

    this.addCorsHeaders(res);
    res.json(refreshResponse);
  }

  /**
   * POST /revoke - Token revocation endpoint
   */
  revoke = async (req: Request, res: Response): Promise<void> => {
    try {
      const { token, token_type_hint, client_id, client_secret } = req.body;

      if (!token) {
        this.addCorsHeaders(res);
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'token is required'
        });
        return;
      }

      // Get client credentials
      let clientId = client_id;
      let clientSecret = client_secret;

      const authHeader = req.headers['authorization'];
      const basicAuth = authHeader ? this.oauthService.parseBasicAuth(authHeader as string) : null;
      if (basicAuth) {
        clientId = basicAuth.clientId;
        clientSecret = basicAuth.clientSecret;
      }

      // Client authentication is optional, but if provided needs to be verified
      if (clientId) {
        const issuer = getAuthorizationServerUrl(req);
        const client = await this.clientService.getClientForIssuer(clientId, issuer);
        if (!client) {
          this.addCorsHeaders(res);
          res.status(401).json({
            error: 'invalid_client',
            error_description: 'Client not found'
          });
          return;
        }

        if (client.token_endpoint_auth_method !== 'none') {
          if (!clientSecret) {
            this.addCorsHeaders(res);
            res.status(401).json({
              error: 'invalid_client',
              error_description: 'client_secret is required for confidential clients'
            });
            return;
          }

          const validClient = await this.clientService.verifyClientCredentials(clientId, clientSecret, issuer);
          if (!validClient) {
            this.addCorsHeaders(res);
            res.status(401).json({
              error: 'invalid_client',
              error_description: 'Invalid client credentials'
            });
            return;
          }
        }
      }

      // Find token
      let tokenRecord = null;

      if (token_type_hint === 'refresh_token' || !token_type_hint) {
        tokenRecord = await prisma.oAuthToken.findUnique({
          where: { refreshToken: token },
        });
      }

      if (!tokenRecord && (token_type_hint === 'access_token' || !token_type_hint)) {
        tokenRecord = await prisma.oAuthToken.findUnique({
          where: { accessToken: token },
        });
      }

      // RFC 7009: Return 200 even if token is not found
      if (!tokenRecord) {
        this.addCorsHeaders(res);
        res.json({});
        return;
      }

      // Verify token belongs to this client
      if (clientId && tokenRecord.clientId !== clientId) {
        this.addCorsHeaders(res);
        res.json({});
        return;
      }

      // Revoke token
      await prisma.oAuthToken.update({
        where: { tokenId: tokenRecord.tokenId },
        data: { revoked: true },
      });

      this.addCorsHeaders(res);
      res.json({});
    } catch (error) {
      this.logger.error({ error }, 'Token revocation error');
      this.addCorsHeaders(res);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error'
      });
    }
  };
}
