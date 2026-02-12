/**
 * OAuth Exchange Error
 *
 * Custom error class for OAuth authorization code exchange failures.
 */

export type OAuthExchangeErrorType = 'http' | 'parse' | 'unknown_provider';

export interface OAuthExchangeErrorDetails {
  type: OAuthExchangeErrorType;
  provider?: string;
  status?: number;
  responseBody?: string;
  cause?: Error;
}

export class OAuthExchangeError extends Error {
  public readonly type: OAuthExchangeErrorType;
  public readonly provider?: string;
  public readonly status?: number;
  public readonly responseBody?: string;
  public readonly cause?: Error;

  constructor(message: string, details: OAuthExchangeErrorDetails) {
    super(message);
    this.name = 'OAuthExchangeError';
    this.type = details.type;
    this.provider = details.provider;
    this.status = details.status;
    this.responseBody = details.responseBody;
    this.cause = details.cause;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, OAuthExchangeError);
    }
  }

  /**
   * Create an HTTP error (non-2xx response)
   */
  static http(
    provider: string,
    status: number,
    responseBody: string
  ): OAuthExchangeError {
    return new OAuthExchangeError(
      `OAuth token exchange failed for ${provider}: HTTP ${status}`,
      {
        type: 'http',
        provider,
        status,
        responseBody,
      }
    );
  }

  /**
   * Create a parse error (invalid JSON response)
   */
  static parse(
    provider: string,
    responseBody: string,
    cause?: Error
  ): OAuthExchangeError {
    return new OAuthExchangeError(
      `Failed to parse OAuth response for ${provider}`,
      {
        type: 'parse',
        provider,
        responseBody,
        cause,
      }
    );
  }

  /**
   * Create an unknown provider error
   */
  static unknownProvider(provider: string): OAuthExchangeError {
    return new OAuthExchangeError(
      `Unknown OAuth provider: ${provider}`,
      {
        type: 'unknown_provider',
        provider,
      }
    );
  }
}
