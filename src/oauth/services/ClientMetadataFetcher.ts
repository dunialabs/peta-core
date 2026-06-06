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
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';

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
  private validateMetadata(metadata: any): ClientMetadataValidationResult {
    if (typeof metadata.client_id !== 'string' || metadata.client_id.length === 0) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: 'client_id is required and must be a non-empty string'
      };
    }

    if (typeof metadata.client_name !== 'string' || metadata.client_name.length === 0) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: 'client_name is required and must be a non-empty string'
      };
    }

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
        const parsed = new URL(uri);
        if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
          throw new Error('non-https redirect URI');
        }
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

      const supportedGrantTypes = ['authorization_code', 'refresh_token'];
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
      const supportedMethods = ['none'];
      if (!supportedMethods.includes(metadata.token_endpoint_auth_method)) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: `Unsupported token_endpoint_auth_method: ${metadata.token_endpoint_auth_method}`
        };
      }
    }

    if (metadata.application_type) {
      const supportedApplicationTypes = ['web', 'native'];
      if (!supportedApplicationTypes.includes(metadata.application_type)) {
        return {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: `Unsupported application_type: ${metadata.application_type}`
        };
      }
    }

    // Validation passed, return metadata
    return {
      valid: true,
      metadata: metadata as OAuthClientMetadata
    };
  }

  private async validatePublicNetworkTarget(url: string): Promise<{ valid: boolean; error?: string; addresses?: string[] }> {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();

    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return { valid: false, error: 'Client metadata URL must not target localhost' };
    }

    const directIpVersion = isIP(hostname);
    const addresses = directIpVersion > 0
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: true });

    if (addresses.length === 0) {
      return { valid: false, error: 'Client metadata URL host did not resolve' };
    }

    for (const { address } of addresses) {
      if (!this.isPublicIpAddress(address)) {
        return { valid: false, error: 'Client metadata URL must resolve only to public IP addresses' };
      }
    }

    return { valid: true, addresses: addresses.map(({ address }) => address) };
  }

  private isPublicIpAddress(address: string): boolean {
    if (address.startsWith('::ffff:')) {
      return this.isPublicIpAddress(address.slice('::ffff:'.length));
    }

    const version = isIP(address);
    if (version === 4) {
      const octets = address.split('.').map((part) => Number(part));
      if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
      }
      const [a, b] = octets;
      return !(
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224
      );
    }

    if (version === 6) {
      const normalized = address.toLowerCase();
      return !(
        normalized === '::1' ||
        normalized === '::' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb')
      );
    }

    return false;
  }

  private fetchPinnedMetadataDocument(url: string, addresses: string[]): Promise<{ ok: boolean; status: number; statusText: string; headers: IncomingHttpHeaders; body: string }> {
    const parsedUrl = new URL(url);
    const address = addresses[0];
    if (!address) {
      throw new Error('Client metadata URL host did not resolve');
    }

    return new Promise((resolve, reject) => {
      const req = request({
        method: 'GET',
        hostname: address,
        servername: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : 443,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: {
          Accept: 'application/json',
          Host: parsedUrl.host,
          'User-Agent': 'peta-core/1.0',
        },
        timeout: this.FETCH_TIMEOUT,
      }, (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > this.MAX_METADATA_BYTES) {
            req.destroy(new Error('Client metadata document is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? '',
            headers: res.headers,
            body: Buffer.concat(chunks, totalBytes).toString('utf8'),
          });
        });
      });
      req.on('timeout', () => req.destroy(new Error('Client metadata fetch timeout (exceeded 5 seconds)')));
      req.on('error', reject);
      req.end();
    });
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
