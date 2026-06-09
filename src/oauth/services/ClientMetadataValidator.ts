import type { OAuthClientMetadata } from '../types/oauth.types.js';
import type { ClientMetadataValidationResult } from './ClientMetadataFetcher.js';

type MetadataRecord = Record<string, unknown>;

export class ClientMetadataValidator {
  validateMetadata(metadata: unknown): ClientMetadataValidationResult {
    if (!this.isRecord(metadata)) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: 'Client metadata must be a JSON object',
      };
    }

    const clientId = metadata.client_id;
    if (typeof clientId !== 'string' || clientId.length === 0) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: 'client_id is required and must be a non-empty string',
      };
    }

    const clientName = metadata.client_name;
    if (typeof clientName !== 'string' || clientName.length === 0) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: 'client_name is required and must be a non-empty string',
      };
    }

    const redirectUris = this.requiredStringArray(metadata.redirect_uris, 'redirect_uris');
    if ('error' in redirectUris) {
      return redirectUris.error;
    }

    for (const uri of redirectUris.value) {
      const error = this.validateRedirectUri(uri);
      if (error) {
        return error;
      }
    }

    const grantTypes = this.optionalStringArray(metadata.grant_types, 'grant_types');
    if ('error' in grantTypes) {
      return grantTypes.error;
    }
    const unsupportedGrantTypes = grantTypes.value.filter((grantType) => !['authorization_code', 'refresh_token'].includes(grantType));
    if (unsupportedGrantTypes.length > 0) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: `Unsupported grant_types: ${unsupportedGrantTypes.join(', ')}`,
      };
    }

    const responseTypes = this.optionalStringArray(metadata.response_types, 'response_types');
    if ('error' in responseTypes) {
      return responseTypes.error;
    }
    const unsupportedResponseTypes = responseTypes.value.filter((responseType) => responseType !== 'code');
    if (unsupportedResponseTypes.length > 0) {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: `Unsupported response_types: ${unsupportedResponseTypes.join(', ')}`,
      };
    }

    const tokenEndpointAuthMethod = metadata.token_endpoint_auth_method;
    if (tokenEndpointAuthMethod !== undefined && tokenEndpointAuthMethod !== 'none') {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: `Unsupported token_endpoint_auth_method: ${String(tokenEndpointAuthMethod)}`,
      };
    }

    const applicationType = metadata.application_type;
    if (applicationType !== undefined && applicationType !== 'web' && applicationType !== 'native') {
      return {
        valid: false,
        error: 'invalid_client_metadata',
        errorDescription: `Unsupported application_type: ${String(applicationType)}`,
      };
    }

    const validatedMetadata: OAuthClientMetadata = {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris.value,
    };

    if (typeof metadata.client_uri === 'string') {
      validatedMetadata.client_uri = metadata.client_uri;
    }
    if (typeof metadata.logo_uri === 'string') {
      validatedMetadata.logo_uri = metadata.logo_uri;
    }
    if (applicationType === 'web' || applicationType === 'native') {
      validatedMetadata.application_type = applicationType;
    }
    if (typeof metadata.scope === 'string') {
      validatedMetadata.scope = metadata.scope;
    }
    if (tokenEndpointAuthMethod === 'none') {
      validatedMetadata.token_endpoint_auth_method = tokenEndpointAuthMethod;
    }
    if (grantTypes.value.length > 0) {
      validatedMetadata.grant_types = grantTypes.value;
    }
    if (responseTypes.value.length > 0) {
      validatedMetadata.response_types = responseTypes.value;
    }
    if (Array.isArray(metadata.contacts) && metadata.contacts.every((contact) => typeof contact === 'string')) {
      validatedMetadata.contacts = metadata.contacts;
    }

    return {
      valid: true,
      metadata: validatedMetadata,
    };
  }

  private validateRedirectUri(uri: string): ClientMetadataValidationResult | null {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol === 'https:' || this.isLoopbackHttpRedirect(parsed)) {
        return null;
      }
    } catch {
      return {
        valid: false,
        error: 'invalid_redirect_uri',
        errorDescription: `Invalid redirect_uri: ${uri}`,
      };
    }

    return {
      valid: false,
      error: 'invalid_redirect_uri',
      errorDescription: `Invalid redirect_uri: ${uri}`,
    };
  }

  private isLoopbackHttpRedirect(url: URL): boolean {
    if (url.protocol !== 'http:') {
      return false;
    }
    const hostname = url.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  }

  private requiredStringArray(value: unknown, field: string):
    | { value: string[] }
    | { error: ClientMetadataValidationResult } {
    const parsed = this.optionalStringArray(value, field);
    if ('error' in parsed) {
      return parsed;
    }
    if (parsed.value.length === 0) {
      return {
        error: {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: `${field} is required and must be a non-empty array`,
        },
      };
    }
    return parsed;
  }

  private optionalStringArray(value: unknown, field: string):
    | { value: string[] }
    | { error: ClientMetadataValidationResult } {
    if (value === undefined) {
      return { value: [] };
    }
    if (!Array.isArray(value)) {
      return {
        error: {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: `${field} must be an array`,
        },
      };
    }
    if (value.some((item) => typeof item !== 'string' || item.length === 0)) {
      return {
        error: {
          valid: false,
          error: 'invalid_client_metadata',
          errorDescription: field === 'redirect_uris'
            ? 'All redirect_uris must be non-empty strings'
            : `${field} must contain only non-empty strings`,
        },
      };
    }
    return { value };
  }

  private isRecord(value: unknown): value is MetadataRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
