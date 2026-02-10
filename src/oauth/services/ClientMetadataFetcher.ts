/**
 * Client metadata fetching service
 * Implements SEP-991: URL-based Client ID
 *
 * Responsibilities:
 * 1. Validate client metadata URL format
 * 2. Fetch client metadata
 * 3. Validate metadata completeness and validity
 * 4. Cache metadata (optional)
 */

import { createLogger } from '../../logger/index.js';
import { OAuthClientMetadata } from '../types/oauth.types.js';

export interface ClientMetadataValidationResult {
  valid: boolean;
  metadata?: OAuthClientMetadata;
  error?: string;
  errorDescription?: string;
}

export class ClientMetadataFetcher {
  private logger = createLogger('ClientMetadataFetcher');

  // Metadata cache (URL → Metadata)
  // TTL: 1 hour
  private metadataCache = new Map<string, {
    metadata: OAuthClientMetadata;
    fetchedAt: number;
  }>();

  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour
  private readonly FETCH_TIMEOUT = 5000; // 5 second timeout

  /**
   * Validate URL format (SEP-991 requirements)
   *
   * Requirements:
   * 1. Must use HTTPS protocol
   * 2. Path cannot be root "/"
   * 3. Must be a valid parseable URL
   */
  validateClientMetadataUrl(url: string): { valid: boolean; error?: string } {
    try {
      const parsedUrl = new URL(url);

      // 1. Check protocol
      if (parsedUrl.protocol !== 'https:') {
        return {
          valid: false,
          error: 'Client metadata URL must use HTTPS protocol'
        };
      }

      // 2. Check path
      if (parsedUrl.pathname === '/' || parsedUrl.pathname === '') {
        return {
          valid: false,
          error: 'Client metadata URL pathname cannot be root ("/"), must specify a document path'
        };
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `Invalid URL format: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Fetch and validate client metadata
   *
   * Steps:
   * 1. Check cache
   * 2. If cache miss or expired, fetch from URL
   * 3. Validate metadata format
   * 4. Cache result
   */
  async fetchAndValidateClientMetadata(
    clientMetadataUrl: string,
    skipCache: boolean = false
  ): Promise<ClientMetadataValidationResult> {
    // 1. Validate URL format
    const urlValidation = this.validateClientMetadataUrl(clientMetadataUrl);
    if (!urlValidation.valid) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: urlValidation.error
      };
    }

    // 2. Check cache
    if (!skipCache) {
      const cached = this.metadataCache.get(clientMetadataUrl);
      if (cached && (Date.now() - cached.fetchedAt < this.CACHE_TTL)) {
        this.logger.debug({ url: clientMetadataUrl }, 'Client metadata cache hit');
        return {
          valid: true,
          metadata: cached.metadata
        };
      }
    }

    // 3. Fetch metadata from URL
    this.logger.info({ url: clientMetadataUrl }, 'Fetching client metadata from URL');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT);

      const response = await fetch(clientMetadataUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'peta-core/1.0'
        },
        signal: controller.signal,
        redirect: 'manual'
      });

      clearTimeout(timeoutId);

      if (response.status >= 300 && response.status < 400) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: 'Client metadata URL must not redirect'
        };
      }

      if (!response.ok) {
        this.logger.warn({
          url: clientMetadataUrl,
          status: response.status,
          statusText: response.statusText
        }, 'Failed to fetch client metadata');

        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: `Failed to fetch client metadata: HTTP ${response.status}`
        };
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: 'Client metadata must be JSON (application/json)'
        };
      }

      const metadata = await response.json();

      // 4. Validate metadata
      const validationResult = this.validateMetadata(metadata);
      if (!validationResult.valid) {
        return validationResult;
      }

      // 5. Cache metadata
      this.metadataCache.set(clientMetadataUrl, {
        metadata: validationResult.metadata!,
        fetchedAt: Date.now()
      });

      this.logger.info({ url: clientMetadataUrl }, 'Client metadata fetched and cached successfully');
      return validationResult;

    } catch (error) {
      this.logger.error({ error, url: clientMetadataUrl }, 'Error fetching client metadata');

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: 'Client metadata fetch timeout (exceeded 5 seconds)'
        };
      }

      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: `Error fetching metadata: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Validate client metadata completeness
   *
   * Required fields (RFC 7591):
   * - redirect_uris: Required, non-empty array
   *
   * Optional but recommended fields:
   * - client_name
   * - grant_types
   * - response_types
   * - scope
   * - token_endpoint_auth_method
   */
  private validateMetadata(metadata: any): ClientMetadataValidationResult {
    // 1. Check required field: redirect_uris
    if (!metadata.redirect_uris || !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: 'redirect_uris is required and must be a non-empty array'
      };
    }

    // 2. Validate redirect_uris format
    for (const uri of metadata.redirect_uris) {
      if (typeof uri !== 'string' || uri.trim() === '') {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: 'All redirect_uris must be non-empty strings'
        };
      }

      try {
        new URL(uri);
      } catch (error) {
        return {
          valid: false,
          error: 'invalid_redirect_uri',
          errorDescription: `Invalid redirect_uri: ${uri}`
        };
      }
    }

    // 3. Validate grant_types (if provided)
    if (metadata.grant_types) {
      if (!Array.isArray(metadata.grant_types)) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: 'grant_types must be an array'
        };
      }

      const supportedGrantTypes = ['authorization_code', 'refresh_token', 'client_credentials'];
      const invalidGrants = metadata.grant_types.filter(
        (g: string) => !supportedGrantTypes.includes(g)
      );

      if (invalidGrants.length > 0) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: `Unsupported grant_types: ${invalidGrants.join(', ')}`
        };
      }
    }

    // 4. Validate response_types (if provided)
    if (metadata.response_types) {
      if (!Array.isArray(metadata.response_types)) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: 'response_types must be an array'
        };
      }

      const supportedResponseTypes = ['code'];
      const invalidTypes = metadata.response_types.filter(
        (t: string) => !supportedResponseTypes.includes(t)
      );

      if (invalidTypes.length > 0) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: `Unsupported response_types: ${invalidTypes.join(', ')}`
        };
      }
    }

    // 5. Validate token_endpoint_auth_method (if provided)
    if (metadata.token_endpoint_auth_method) {
      const supportedMethods = ['client_secret_basic', 'client_secret_post', 'none'];
      if (!supportedMethods.includes(metadata.token_endpoint_auth_method)) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: `Unsupported token_endpoint_auth_method: ${metadata.token_endpoint_auth_method}`
        };
      }
    }

    // Validation passed, return metadata
    return {
      valid: true,
      metadata: metadata as OAuthClientMetadata
    };
  }

  /**
   * Clear cache for specific URL
   */
  clearCache(clientMetadataUrl?: string): void {
    if (clientMetadataUrl) {
      this.metadataCache.delete(clientMetadataUrl);
      this.logger.debug({ url: clientMetadataUrl }, 'Cleared metadata cache for URL');
    } else {
      this.metadataCache.clear();
      this.logger.info('Cleared all metadata cache');
    }
  }

  /**
   * Clean up expired cache entries
   */
  cleanExpiredCache(): void {
    const now = Date.now();
    let removed = 0;

    for (const [url, cached] of this.metadataCache.entries()) {
      if (now - cached.fetchedAt >= this.CACHE_TTL) {
        this.metadataCache.delete(url);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug({ removed }, 'Cleaned expired metadata cache entries');
    }
  }
}
