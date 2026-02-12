/**
 * OAuth Utility Functions
 */

/**
 * Resolve token expiration from response or adapter default
 *
 * @param responseExpiresIn - expires_in from the OAuth response
 * @param defaultExpiresIn - Default expiration from the adapter
 * @returns Object with expiresIn (seconds) and expiresAt (Unix timestamp in ms)
 */
export function resolveExpires(
  responseExpiresIn?: number,
  defaultExpiresIn?: number
): { expiresIn?: number; expiresAt?: number } {
  const expiresIn = responseExpiresIn ?? defaultExpiresIn;

  if (expiresIn === undefined) {
    return {};
  }

  return {
    expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}
