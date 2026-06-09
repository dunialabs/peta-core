/**
 * OAuth Service
 * Handles OAuth core logic: token generation, PKCE verification, client verification, etc.
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { OAUTH_CONFIG } from '../types/oauth.types.js';

export class OAuthService {
  private jwtSecret: string;

  constructor() {
    this.jwtSecret = process.env.JWT_SECRET || '';
  }

  private getJwtSecret(): string {
    if (!this.jwtSecret) {
      throw new Error('JWT_SECRET environment variable is required');
    }
    return this.jwtSecret;
  }

  /**
   * Generate OAuth access token (JWT format)
   */
  generateAccessToken(
    clientId: string,
    userId: string,
    scopes: string[],
    resource?: string
  ): string {
    const payload: any = {
      type: 'access_token',
      client_id: clientId,
      user_id: userId,
      scopes: scopes,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + OAUTH_CONFIG.ACCESS_TOKEN_LIFETIME,
    };

    // RFC 8707: Include resource (aud claim) if provided
    if (resource) {
      payload.aud = resource;
    }

    return jwt.sign(payload, this.getJwtSecret());
  }

  /**
   * Generate refresh token (random string)
   */
  generateRefreshToken(): string {
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Generate authorization code (random string)
   */
  generateAuthorizationCode(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate client secret
   */
  generateClientSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate client ID
   */
  generateClientId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Verify PKCE code_verifier
   */
  verifyPKCEChallenge(
    codeVerifier: string,
    codeChallenge: string,
    method: 'plain' | 'S256' = 'S256'
  ): boolean {
    if (method === 'plain') {
      return codeVerifier === codeChallenge;
    }

    if (method === 'S256') {
      const hash = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      return hash === codeChallenge;
    }

    return false;
  }

  /**
   * Verify client credentials
   */
  async verifyClientCredentials(
    _clientId: string,
    clientSecret: string,
    storedSecret: string | null
  ): Promise<boolean> {
    if (!storedSecret) {
      return false;
    }
    return clientSecret === storedSecret;
  }

  /**
   * Parse and validate scope
   */
  parseScope(scopeString?: string): string[] {
    if (!scopeString) {
      return ['mcp:tools']; // Default scope
    }
    return scopeString.split(' ').filter(s => s.length > 0);
  }

  /**
   * Validate if redirect_uri is in the allowed list
   */
  validateRedirectUri(redirectUri: string, allowedUris: string[]): boolean {
    if (allowedUris.includes(redirectUri)) {
      return true;
    }

    const requestedLoopback = this.loopbackRedirectPortAgnosticKey(redirectUri);
    if (!requestedLoopback) {
      return false;
    }

    return allowedUris.some((allowedUri) => this.portlessLoopbackRedirectKey(allowedUri) === requestedLoopback);
  }

  private portlessLoopbackRedirectKey(redirectUri: string): string | null {
    try {
      const url = new URL(redirectUri);
      if (url.port !== '') {
        return null;
      }
      return this.loopbackRedirectPortAgnosticKeyFromUrl(url);
    } catch {
      return null;
    }
  }

  private loopbackRedirectPortAgnosticKey(redirectUri: string): string | null {
    try {
      const url = new URL(redirectUri);
      return this.loopbackRedirectPortAgnosticKeyFromUrl(url);
    } catch {
      return null;
    }
  }

  private loopbackRedirectPortAgnosticKeyFromUrl(url: URL): string | null {
    if (url.protocol !== 'http:') {
      return null;
    }
    if (!this.isLoopbackRedirectHost(url.hostname)) {
      return null;
    }
    url.port = '';
    return url.toString();
  }

  private isLoopbackRedirectHost(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
  }

  /**
   * Build authorization error response URL
   */
  buildErrorRedirectUrl(
    redirectUri: string,
    error: string,
    errorDescription?: string,
    state?: string
  ): string {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    if (errorDescription) {
      url.searchParams.set('error_description', errorDescription);
    }
    if (state) {
      url.searchParams.set('state', state);
    }
    return url.toString();
  }

  /**
   * Build authorization success response URL
   */
  buildSuccessRedirectUrl(
    redirectUri: string,
    code: string,
    state?: string,
    issuer?: string
  ): string {
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) {
      url.searchParams.set('state', state);
    }
    if (issuer) {
      url.searchParams.set('iss', issuer);
    }
    return url.toString();
  }

  /**
   * Verify JWT token (for introspection)
   */
  verifyAccessToken(token: string): {
    valid: boolean;
    payload?: any;
    error?: string;
  } {
    try {
      const payload = jwt.verify(token, this.getJwtSecret());
      return { valid: true, payload };
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        return { valid: false, error: 'Invalid token signature' };
      } else if (error instanceof jwt.TokenExpiredError) {
        return { valid: false, error: 'Token has expired' };
      } else {
        return {
          valid: false,
          error: error instanceof Error ? error.message : 'Token verification failed'
        };
      }
    }
  }

  /**
   * Parse Basic Authentication header
   */
  parseBasicAuth(authHeader: string): {
    clientId: string;
    clientSecret: string;
  } | null {
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return null;
    }

    try {
      const base64 = authHeader.substring(6);
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      const [clientId, clientSecret] = decoded.split(':');

      if (!clientId || !clientSecret) {
        return null;
      }

      return { clientId, clientSecret };
    } catch (error) {
      return null;
    }
  }

  /**
   * Verify if scope is a subset of original scope
   */
  isScopeSubset(requestedScopes: string[], originalScopes: string[]): boolean {
    return requestedScopes.every(scope => originalScopes.includes(scope));
  }

  /**
   * Generate authorization server metadata
   */
  generateAuthorizationServerMetadata(issuerUrl: string): any {
    return {
      issuer: issuerUrl,
      authorization_endpoint: `${issuerUrl}/authorize`,
      token_endpoint: `${issuerUrl}/token`,
      registration_endpoint: `${issuerUrl}/register`,
      revocation_endpoint: `${issuerUrl}/revoke`,
      introspection_endpoint: `${issuerUrl}/introspect`,
      scopes_supported: ['mcp:tools', 'mcp:resources', 'mcp:prompts'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'none'
      ],
      // New: Revocation endpoint authentication methods
      revocation_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'none'
      ],
      // New: Token endpoint signature algorithm
      token_endpoint_auth_signing_alg_values_supported: ['HS256'],
      code_challenge_methods_supported: ['S256', 'plain'],
      authorization_response_iss_parameter_supported: true,
      // New: SEP-991 - URL-based Client ID support
      client_id_metadata_document_supported: true,
      service_documentation: `${issuerUrl}/docs/oauth`
    };
  }

  /**
   * Generate protected resource metadata
   */
  generateProtectedResourceMetadata(
    resourceUrl: string,
    authorizationServerUrl: string
  ): any {
    return {
      resource: resourceUrl,
      authorization_servers: [authorizationServerUrl],
      bearer_methods_supported: ['header'],
      resource_documentation: `${authorizationServerUrl}/docs/mcp-gateway`,
      resource_signing_alg_values_supported: ['HS256'],
      scopes_supported: ['mcp:tools', 'mcp:resources', 'mcp:prompts']
    };
  }
}
