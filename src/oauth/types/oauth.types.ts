/**
 * OAuth type definitions
 * Define all OAuth-related type interfaces
 */

/**
 * OAuth configuration constants
 */
export const OAUTH_CONFIG = {
  // Access token lifetime (seconds)
  ACCESS_TOKEN_LIFETIME: 3600,
  // Refresh token lifetime (seconds)
  REFRESH_TOKEN_LIFETIME: 2592000, // 30 days
  // Authorization code lifetime (seconds)
  AUTHORIZATION_CODE_LIFETIME: 600, // 10 minutes
};

export const MCP_OAUTH_SCOPES = ['mcp:tools', 'mcp:resources', 'mcp:prompts'] as const;

/**
 * OAuth client metadata (RFC 7591 + SEP-991)
 */
export interface OAuthClientMetadata {
  client_id?: string; // New: Optional, for URL-based client ID (SEP-991)
  issuer?: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  application_type?: 'web' | 'native';
  scope?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: 'none' | 'client_secret_post' | 'client_secret_basic';
  grant_types?: string[];
  response_types?: string[];
  contacts?: string[];
}

/**
 * OAuth client complete information (includes secret)
 */
export interface OAuthClientInformation {
  client_id: string;
  issuer?: string;
  client_secret?: string;
  client_name?: string;
  application_type?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scopes: string[];
  token_endpoint_auth_method: string;
  trusted?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

/**
 * OAuth authorization request parameters
 */
export interface AuthorizationRequest {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string; // RFC 8707: Resource Indicators
}

/**
 * OAuth authorization approval request
 */
export interface AuthorizationApprovalRequest {
  client_id: string;
  redirect_uri: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
  approved: boolean;
  user_token: string; // User's access token
}

/**
 * OAuth Token request parameters
 */
export interface TokenRequest {
  grant_type: 'authorization_code' | 'refresh_token';
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
  refresh_token?: string;
  scope?: string;
}

/**
 * OAuth Token response
 */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
  resource?: string; // RFC 8707: Resource Indicators
}

/**
 * OAuth Token revocation request
 */
export interface TokenRevocationRequest {
  token: string;
  token_type_hint?: 'access_token' | 'refresh_token';
  client_id?: string;
  client_secret?: string;
}

/**
 * OAuth authorization server metadata (RFC 8414)
 */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  service_documentation?: string;
}

/**
 * OAuth protected resource metadata (RFC 9728)
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
  resource_signing_alg_values_supported?: string[];
  scopes_supported?: string[];
}

/**
 * PKCE verification method
 */
export type PKCEMethod = 'S256';

/**
 * OAuth error response
 */
export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * Authorization code database record
 */
export interface AuthorizationCodeRecord {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string[];
  code_challenge?: string;
  challenge_method?: string;
  resource?: string;
  expires_at: Date;
  used: boolean;
}

/**
 * Token database record
 */
export interface TokenRecord {
  access_token: string;
  refresh_token: string;
  client_id: string;
  user_id: string;
  scope: string[];
  resource?: string;
  access_token_expires_at: Date;
  refresh_token_expires_at: Date;
  revoked: boolean;
}
