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
import type { IncomingHttpHeaders } from 'node:http';
import {
  ClientMetadataNetwork,
  type ClientMetadataHttpResponse,
  type ClientMetadataNetworkValidationResult,
} from './ClientMetadataNetwork.js';
import { ClientMetadataValidator } from './ClientMetadataValidator.js';

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
  private readonly MAX_METADATA_BYTES = 64 * 1024;
  private readonly network = new ClientMetadataNetwork(this.FETCH_TIMEOUT, this.MAX_METADATA_BYTES);
  private readonly validator = new ClientMetadataValidator();

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
      const networkValidation = await this.validatePublicNetworkTarget(clientMetadataUrl);
      if (!networkValidation.valid) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: networkValidation.error,
        };
      }

      const response = await this.fetchPinnedMetadataDocument(clientMetadataUrl, networkValidation.addresses ?? []);

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

      const contentType = this.headerValue(response.headers, 'content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: 'Client metadata must be JSON (application/json)'
        };
      }

      const declaredLength = this.headerValue(response.headers, 'content-length');
      if (declaredLength && Number(declaredLength) > this.MAX_METADATA_BYTES) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: 'Client metadata document is too large'
        };
      }

      const metadata = JSON.parse(response.body) as unknown;

      // 4. Validate metadata
      const validationResult = this.validateMetadata(metadata);
      if (!validationResult.valid) {
        return validationResult;
      }
      if (validationResult.metadata?.client_id !== clientMetadataUrl) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: 'client_id in metadata must exactly match the client metadata document URL'
        };
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
  private validateMetadata(metadata: unknown): ClientMetadataValidationResult {
    return this.validator.validateMetadata(metadata);
  }

  private validatePublicNetworkTarget(url: string): Promise<ClientMetadataNetworkValidationResult> {
    return this.network.validatePublicNetworkTarget(url);
  }

  private fetchPinnedMetadataDocument(url: string, addresses: readonly string[]): Promise<ClientMetadataHttpResponse> {
    return this.network.fetchPinnedMetadataDocument(url, addresses);
  }

  private headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
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
