import { createLogger } from '../../logger/index.js';

const logger = createLogger('IntercomTokenHelper');

const INTERCOM_ME_ENDPOINT = 'https://api.intercom.io/me';
const RETRYABLE_ERROR_CODES = new Set(['rate_limit_exceeded', 'retry_after']);
const INVALID_TOKEN_ERROR_CODES = new Set([
  'token_revoked',
  'token_blocked',
  'token_not_found',
  'token_unauthorized',
  'token_expired',
]);

export const INTERCOM_FAKE_REFRESH_TOKEN = '__INTERCOM_NO_REFRESH_TOKEN__';
export const INTERCOM_SYNTHETIC_EXPIRES_IN = 30 * 24 * 60 * 60;

export interface IntercomTokenMetadata {
  intercomRegion: string;
}

export interface IntercomTokenErrorClassification {
  invalidToken: boolean;
  retryable: boolean;
  status: number;
  errorCodes: string[];
  parsed: boolean;
}

export class IntercomInvalidTokenError extends Error {
  readonly status?: number;
  readonly errorCodes: string[];
  readonly responseBody?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      errorCodes?: string[];
      responseBody?: string;
    } = {},
  ) {
    super(message);
    this.name = 'IntercomInvalidTokenError';
    this.status = options.status;
    this.errorCodes = options.errorCodes ?? [];
    this.responseBody = options.responseBody;
  }
}

function extractErrorCodes(responseBody: string): { parsed: boolean; errorCodes: string[] } {
  if (!responseBody || responseBody.trim() === '') {
    return { parsed: false, errorCodes: [] };
  }

  try {
    const parsed = JSON.parse(responseBody) as {
      errors?: Array<{ code?: string }>;
    };
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    const errorCodes = errors
      .map((error) => (typeof error?.code === 'string' ? error.code : undefined))
      .filter((code): code is string => !!code);

    return { parsed: true, errorCodes };
  } catch (error) {
    logger.debug({ error }, 'Failed to parse Intercom error response');
    return { parsed: false, errorCodes: [] };
  }
}

export function classifyIntercomTokenError(
  responseBody: string,
  status: number,
): IntercomTokenErrorClassification {
  const { parsed, errorCodes } = extractErrorCodes(responseBody);

  if (status >= 500) {
    return {
      invalidToken: false,
      retryable: true,
      status,
      errorCodes,
      parsed,
    };
  }

  if (errorCodes.some((code) => RETRYABLE_ERROR_CODES.has(code))) {
    return {
      invalidToken: false,
      retryable: true,
      status,
      errorCodes,
      parsed,
    };
  }

  if (errorCodes.some((code) => INVALID_TOKEN_ERROR_CODES.has(code))) {
    return {
      invalidToken: true,
      retryable: false,
      status,
      errorCodes,
      parsed,
    };
  }

  if ((status === 401 || status === 403) && !parsed) {
    return {
      invalidToken: true,
      retryable: false,
      status,
      errorCodes,
      parsed,
    };
  }

  if ((status === 401 || status === 403) && errorCodes.length === 0) {
    return {
      invalidToken: true,
      retryable: false,
      status,
      errorCodes,
      parsed,
    };
  }

  return {
    invalidToken: false,
    retryable: false,
    status,
    errorCodes,
    parsed,
  };
}

export async function fetchIntercomTokenMetadata(
  accessToken: string,
): Promise<IntercomTokenMetadata> {
  let response: Response;

  try {
    response = await fetch(INTERCOM_ME_ENDPOINT, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown fetch error';
    throw new Error(`Intercom token metadata request failed: ${message}`);
  }

  const responseBody = await response.text();
  if (!response.ok) {
    const classification = classifyIntercomTokenError(responseBody, response.status);
    if (classification.invalidToken) {
      throw new IntercomInvalidTokenError(
        `Intercom token validation failed (${response.status})`,
        {
          status: response.status,
          errorCodes: classification.errorCodes,
          responseBody,
        },
      );
    }

    throw new Error(
      `Intercom token metadata request failed (${response.status}): ${responseBody}`,
    );
  }

  let parsed: {
    app?: {
      region?: string;
    };
  };
  try {
    parsed = JSON.parse(responseBody);
  } catch (error) {
    throw new Error('Intercom token metadata response is not valid JSON');
  }

  const intercomRegion = parsed.app?.region;
  if (typeof intercomRegion !== 'string' || intercomRegion.trim() === '') {
    throw new Error('Intercom token metadata response missing app.region');
  }

  return {
    intercomRegion: intercomRegion.trim(),
  };
}
