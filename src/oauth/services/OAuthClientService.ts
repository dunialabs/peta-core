/**
 * OAuth Client Management Service
 * Handles client registration, query, update and other operations
 */

import { prisma } from '../../config/prisma.js';
import { OAuthService } from './OAuthService.js';
import { MCP_OAUTH_SCOPES, OAuthClientMetadata, OAuthClientInformation } from '../types/oauth.types.js';
import { createLogger } from '../../logger/index.js';
import { ClientMetadataFetcher } from './ClientMetadataFetcher.js';

type OAuthClientRecord = {
  clientId: string;
  issuer: string;
  clientSecret: string | null;
  applicationType: string;
  tokenEndpointAuthMethod: string;
  name: string;
  redirectUris: unknown;
  scopes: unknown;
  grantTypes: unknown;
  responseTypes: unknown;
  userId: string | null;
  trusted: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type OAuthClientCreateData = {
  clientId: string;
  issuer: string;
  clientSecret?: string | null;
  applicationType: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scopes: string[];
  tokenEndpointAuthMethod: string;
  userId?: string;
  trusted: boolean;
};

type OAuthClientUpdateData = Partial<{
  name: string;
  redirectUris: string[];
  scopes: string[];
  grantTypes: string[];
  responseTypes: string[];
  applicationType: string;
}>;

type OAuthClientDelegate = {
  findUnique(args: { where: { clientId: string } }): Promise<OAuthClientRecord | null>;
  findFirst(args: {
    where: {
      clientId?: string;
      name?: string;
      issuer?: string;
      redirectUris?: { equals: string[] };
      tokenEndpointAuthMethod?: string;
      grantTypes?: { equals: string[] };
      responseTypes?: { equals: string[] };
    };
  }): Promise<OAuthClientRecord | null>;
  findMany(args: { where: { userId?: string }; orderBy: { createdAt: 'desc' } }): Promise<OAuthClientRecord[]>;
  create(args: { data: OAuthClientCreateData }): Promise<OAuthClientRecord>;
  update(args: { where: { clientId: string }; data: OAuthClientUpdateData }): Promise<OAuthClientRecord>;
  delete(args: { where: { clientId: string } }): Promise<OAuthClientRecord>;
};

export class OAuthClientService {
  private oauthService: OAuthService;
  private logger = createLogger('OAuthClientService');
  private clients = prisma.oAuthClient as unknown as OAuthClientDelegate;

  constructor() {
    this.oauthService = new OAuthService();
  }

  /**
   * Dynamic client registration (RFC 7591 + SEP-991)
   */
  async registerClient(
    metadata: OAuthClientMetadata,
    userId?: string,
    issuer: string = 'default',
  ): Promise<OAuthClientInformation> {
    // ========== New: SEP-991 URL-based Client ID handling ==========

    // 1. Check if using URL-based client ID
    // Criteria: metadata provides client_id and that client_id is an HTTPS URL
    const providedClientId = metadata.client_id;
    const isUrlBasedClientId = providedClientId && typeof providedClientId === 'string' && providedClientId.startsWith('https://');

    if (isUrlBasedClientId) {
      this.logger.info({
        clientId: providedClientId,
        providedMetadata: {
          client_name: metadata.client_name,
          redirect_uris: metadata.redirect_uris
        }
      }, 'URL-based client ID registration detected');

      // 2. Use ClientMetadataFetcher to fetch and validate client metadata
      const fetcher = new ClientMetadataFetcher();
      const validationResult = await fetcher.fetchAndValidateClientMetadata(providedClientId);

      if (!validationResult.valid) {
        this.logger.warn({
          clientId: providedClientId,
          error: validationResult.error,
          errorDescription: validationResult.errorDescription
        }, 'URL-based client ID validation failed');

        throw new Error(`${validationResult.error}: ${validationResult.errorDescription}`);
      }

      // 3. Use metadata fetched from URL (takes priority over metadata in request)
      const fetchedMetadata = validationResult.metadata!;

      this.logger.info({
        clientId: providedClientId,
        fetchedMetadata: {
          client_name: fetchedMetadata.client_name,
          redirect_uris: fetchedMetadata.redirect_uris,
          grant_types: fetchedMetadata.grant_types,
          token_endpoint_auth_method: fetchedMetadata.token_endpoint_auth_method
        }
      }, 'Client metadata fetched successfully from URL');

      // 4. Check if a client with this URL as client_id already exists in database
      const existingClient = await this.clients.findFirst({
        where: { clientId: providedClientId, issuer }
      });

      if (existingClient) {
        const reconciledClient = await this.reconcileUrlBasedClientScopes(existingClient, fetchedMetadata);
        this.logger.info({
          clientId: providedClientId
        }, 'URL-based client already registered, returning existing client');

        return {
          client_id: reconciledClient.clientId,
          client_secret: reconciledClient.clientSecret || undefined,
          issuer: reconciledClient.issuer,
          client_name: reconciledClient.name,
          application_type: reconciledClient.applicationType,
          redirect_uris: reconciledClient.redirectUris as string[],
          grant_types: reconciledClient.grantTypes as string[],
          response_types: reconciledClient.responseTypes as string[],
          scopes: reconciledClient.scopes as string[],
          token_endpoint_auth_method: reconciledClient.tokenEndpointAuthMethod,
          trusted: reconciledClient.trusted,
          created_at: reconciledClient.createdAt,
          updated_at: reconciledClient.updatedAt,
        };
      }

      const existingClientForAnotherIssuer = await this.clients.findUnique({
        where: { clientId: providedClientId },
      });
      if (existingClientForAnotherIssuer) {
        throw new Error('invalid_client_metadata: client_id is already registered for a different issuer');
      }

      // 5. Create new URL-based client record
      const authMethod = fetchedMetadata.token_endpoint_auth_method || 'none';
      const applicationType = fetchedMetadata.application_type || 'web';
      const scopes = this.scopesForUrlBasedClient(fetchedMetadata);
      const grantTypes = fetchedMetadata.grant_types || ['authorization_code', 'refresh_token'];
      const responseTypes = fetchedMetadata.response_types || ['code'];

      // URL-based client doesn't need client_secret (identity verified through URL)
      const client = await this.clients.create({
        data: {
          clientId: providedClientId, // URL as client_id
          issuer,
          clientSecret: null, // URL-based clients don't use secret
          applicationType,
          name: fetchedMetadata.client_name || `URL Client ${providedClientId}`,
          redirectUris: fetchedMetadata.redirect_uris,
          grantTypes,
          responseTypes,
          scopes,
          tokenEndpointAuthMethod: authMethod,
          userId: userId ?? undefined,
          trusted: false,
        },
      });

      this.logger.info({
        clientId: providedClientId,
        clientName: client.name
      }, 'URL-based client registered successfully');

      return {
        client_id: client.clientId,
        issuer: client.issuer,
        client_secret: undefined, // URL-based clients don't return secret
        client_name: client.name,
        application_type: client.applicationType,
        redirect_uris: client.redirectUris as string[],
        grant_types: client.grantTypes as string[],
        response_types: client.responseTypes as string[],
        scopes: client.scopes as string[],
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        trusted: client.trusted,
        created_at: client.createdAt,
        updated_at: client.updatedAt,
      };
    }

    // ========== Original traditional client registration logic ==========

    this.validateClientMetadata(metadata);

    // Decide whether to generate client_secret based on authentication method
    const authMethod = metadata.token_endpoint_auth_method || 'client_secret_post';
    const applicationType = metadata.application_type || 'web';

    // Parse and validate scope
    const scopes = this.oauthService.parseScope(metadata.scope);

    // Default grant types and response types
    const grantTypes = metadata.grant_types || ['authorization_code', 'refresh_token'];
    const responseTypes = metadata.response_types || ['code'];

    // Check for duplicate clients (global uniqueness check)
    // Duplicate criteria: name + redirectUris + tokenEndpointAuthMethod + grantTypes all the same
    // Note: Only perform duplicate check when client_name is explicitly provided
    if (metadata.client_name) {
      const existingClient = await this.clients.findFirst({
        where: {
          name: metadata.client_name,
          redirectUris: { equals: metadata.redirect_uris },
          issuer,
          tokenEndpointAuthMethod: authMethod,
          grantTypes: { equals: grantTypes },
          responseTypes: { equals: responseTypes },
        },
      });

      // If duplicate client found, return existing client information
      if (existingClient) {
        this.logger.info({
          existingClientId: existingClient.clientId,
          attemptedClientName: metadata.client_name,
          redirectUris: metadata.redirect_uris,
          authMethod,
          grantTypes,
        }, 'Duplicate client registration detected, returning existing client');

        return {
          client_id: existingClient.clientId,
          issuer: existingClient.issuer,
          client_secret: existingClient.clientSecret || undefined,
          client_name: existingClient.name,
          application_type: existingClient.applicationType,
          redirect_uris: existingClient.redirectUris as string[],
          grant_types: existingClient.grantTypes as string[],
          response_types: existingClient.responseTypes as string[],
          scopes: existingClient.scopes as string[],
          token_endpoint_auth_method: existingClient.tokenEndpointAuthMethod,
          trusted: existingClient.trusted,
          created_at: existingClient.createdAt,
          updated_at: existingClient.updatedAt,
        };
      }
    }

    // Generate client credentials (only when confirmed to create new client)
    const clientId = this.oauthService.generateClientId();
    const clientSecret = authMethod === 'none'
      ? undefined
      : this.oauthService.generateClientSecret();

    // Create client record
    const client = await this.clients.create({
      data: {
        clientId,
        issuer,
        clientSecret,
        applicationType,
        name: metadata.client_name || `Client ${clientId}`,
        redirectUris: metadata.redirect_uris,
        grantTypes,
        responseTypes,
        scopes,
        tokenEndpointAuthMethod: authMethod,
        userId: userId ?? undefined,
        trusted: false,
      },
    });

    return {
      client_id: client.clientId,
      issuer: client.issuer,
      client_secret: clientSecret,
      client_name: client.name,
      application_type: client.applicationType,
      redirect_uris: client.redirectUris as string[],
      grant_types: client.grantTypes as string[],
      response_types: client.responseTypes as string[],
      scopes: client.scopes as string[],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      trusted: client.trusted,
      created_at: client.createdAt,
      updated_at: client.updatedAt,
    };
  }

  private scopesForUrlBasedClient(metadata: OAuthClientMetadata): string[] {
    return typeof metadata.scope === 'string'
      ? this.oauthService.parseScope(metadata.scope)
      : [...MCP_OAUTH_SCOPES];
  }

  private async reconcileUrlBasedClientScopes(
    client: OAuthClientRecord,
    metadata: OAuthClientMetadata,
  ): Promise<OAuthClientRecord> {
    if (typeof metadata.scope === 'string') {
      return client;
    }

    const currentScopes = client.scopes as string[];
    if (!this.isLegacyUrlBasedDefaultScopes(currentScopes)) {
      return client;
    }

    const updatedScopes = [...MCP_OAUTH_SCOPES];
    this.logger.info({
      clientId: client.clientId,
      issuer: client.issuer,
      oldScopes: currentScopes,
      newScopes: updatedScopes,
    }, 'Upgrading URL-based OAuth client scopes from legacy default');

    return this.clients.update({
      where: { clientId: client.clientId },
      data: { scopes: updatedScopes },
    });
  }

  private isLegacyUrlBasedDefaultScopes(scopes: string[]): boolean {
    return Array.isArray(scopes) && scopes.length === 1 && scopes[0] === 'mcp:tools';
  }

  /**
   * Get client information by client_id
   */
  async getClient(clientId: string): Promise<OAuthClientInformation | null> {
    const client = await this.clients.findUnique({
      where: { clientId },
    });

    return this.toClientInformation(client, true);
  }

  async getClientForIssuer(clientId: string, issuer: string): Promise<OAuthClientInformation | null> {
    const client = await this.clients.findFirst({
      where: { clientId, issuer },
    });

    if (client || issuer === 'default') {
      return this.toClientInformation(client, true);
    }

    const legacyClient = await this.clients.findFirst({
      where: { clientId, issuer: 'default' },
    });

    return this.toClientInformation(legacyClient, true);
  }

  private toClientInformation(client: OAuthClientRecord | null, includeSecret: boolean): OAuthClientInformation | null {
    if (!client) {
      return null;
    }

    return {
      client_id: client.clientId,
      issuer: client.issuer,
      ...(includeSecret ? { client_secret: client.clientSecret || undefined } : {}),
      client_name: client.name,
      application_type: client.applicationType,
      redirect_uris: client.redirectUris as string[],
      grant_types: client.grantTypes as string[],
      response_types: client.responseTypes as string[],
      scopes: client.scopes as string[],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      trusted: client.trusted,
      created_at: client.createdAt,
      updated_at: client.updatedAt,
    };
  }

  /**
   * Get all clients (admin function)
   */
  async listClients(userId?: string): Promise<OAuthClientInformation[]> {
    const where = userId ? { userId } : {};

    const clients = await this.clients.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return clients.map(client => ({
      client_id: client.clientId,
      issuer: client.issuer,
      // Don't return client_secret
      client_name: client.name,
      application_type: client.applicationType,
      redirect_uris: client.redirectUris as string[],
      grant_types: client.grantTypes as string[],
      response_types: client.responseTypes as string[],
      scopes: client.scopes as string[],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      trusted: client.trusted,
      created_at: client.createdAt,
      updated_at: client.updatedAt,
    }));
  }

  /**
   * Update client information
   */
  async updateClient(
    clientId: string,
    updates: Partial<OAuthClientMetadata>
  ): Promise<OAuthClientInformation | null> {
    this.validateClientMetadata(updates as OAuthClientMetadata, true);

    const client = await this.clients.findUnique({
      where: { clientId },
    });

    if (!client) {
      return null;
    }

    const data: OAuthClientUpdateData = {};

    if (updates.client_name) {
      data.name = updates.client_name;
    }

    if (updates.redirect_uris) {
      data.redirectUris = updates.redirect_uris;
    }

    if (updates.scope) {
      data.scopes = this.oauthService.parseScope(updates.scope);
    }

    if (updates.grant_types) {
      data.grantTypes = updates.grant_types;
    }

    if (updates.response_types) {
      data.responseTypes = updates.response_types;
    }

    if (updates.application_type) {
      this.validateApplicationType(updates.application_type);
      data.applicationType = updates.application_type;
    }

    const updated = await this.clients.update({
      where: { clientId },
      data,
    });

    return {
      client_id: updated.clientId,
      issuer: updated.issuer,
      client_name: updated.name,
      application_type: updated.applicationType,
      redirect_uris: updated.redirectUris as string[],
      grant_types: updated.grantTypes as string[],
      response_types: updated.responseTypes as string[],
      scopes: updated.scopes as string[],
      token_endpoint_auth_method: updated.tokenEndpointAuthMethod,
      trusted: updated.trusted,
      created_at: updated.createdAt,
      updated_at: updated.updatedAt,
    };
  }

  /**
   * Delete client
   */
  async deleteClient(clientId: string): Promise<boolean> {
    try {
      // Also delete related authorization codes and tokens
      await prisma.$transaction([
        prisma.oAuthAuthorizationCode.deleteMany({
          where: { clientId },
        }),
        prisma.oAuthToken.deleteMany({
          where: { clientId },
        }),
        prisma.oAuthClient.delete({
          where: { clientId },
        }),
      ]);

      return true;
    } catch (error) {
      // Return false on deletion failure, error handled by caller
      return false;
    }
  }

  /**
   * Verify client credentials
   */
  async verifyClientCredentials(
    clientId: string,
    clientSecret: string,
    issuer?: string,
  ): Promise<boolean> {
    const client = issuer ? await this.getClientForIssuer(clientId, issuer) : await this.getClient(clientId);

    if (!client) {
      return false;
    }

    // Public clients don't need to verify secret
    if (client.token_endpoint_auth_method === 'none') {
      return true;
    }

    // Verify secret
    return await this.oauthService.verifyClientCredentials(
      clientId,
      clientSecret,
      client.client_secret || null
    );
  }

  private validateApplicationType(applicationType: string | undefined): void {
    if (applicationType === undefined) {
      return;
    }
    if (applicationType !== 'web' && applicationType !== 'native') {
      throw new Error(`invalid_client_metadata: Unsupported application_type: ${applicationType}`);
    }
  }

  private validateClientMetadata(metadata: OAuthClientMetadata, partial = false): void {
    this.validateApplicationType(metadata.application_type);
    if (!partial || metadata.redirect_uris !== undefined) {
      if (!Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0) {
        throw new Error('invalid_client_metadata: redirect_uris must be a non-empty array');
      }
      for (const redirectUri of metadata.redirect_uris) {
        if (typeof redirectUri !== 'string' || redirectUri.length === 0) {
          throw new Error('invalid_client_metadata: redirect_uris must contain only non-empty strings');
        }
        try {
          const parsed = new URL(redirectUri);
          if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') {
            throw new Error('non-https redirect URI');
          }
        } catch {
          throw new Error(`invalid_redirect_uri: Invalid redirect_uri: ${redirectUri}`);
        }
      }
    }
    const grantTypes = this.validateStringArray(metadata.grant_types, 'grant_types');
    const supportedGrantTypes = ['authorization_code', 'refresh_token'];
    const invalidGrants = grantTypes.filter((grant) => !supportedGrantTypes.includes(grant));
    if (invalidGrants.length > 0) {
      throw new Error(`invalid_client_metadata: Unsupported grant_types: ${invalidGrants.join(', ')}`);
    }
    const responseTypes = this.validateStringArray(metadata.response_types, 'response_types');
    const invalidResponseTypes = responseTypes.filter((responseType) => responseType !== 'code');
    if (invalidResponseTypes.length > 0) {
      throw new Error(`invalid_client_metadata: Unsupported response_types: ${invalidResponseTypes.join(', ')}`);
    }
    const authMethod = metadata.token_endpoint_auth_method;
    if (authMethod !== undefined && !['client_secret_basic', 'client_secret_post', 'none'].includes(authMethod)) {
      throw new Error(`invalid_client_metadata: Unsupported token_endpoint_auth_method: ${authMethod}`);
    }
  }

  private validateStringArray(value: unknown, field: string): string[] {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error(`invalid_client_metadata: ${field} must be an array`);
    }
    if (value.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new Error(`invalid_client_metadata: ${field} must contain only non-empty strings`);
    }
    return value;
  }
}
