export function maskToken(token: string): string {
  if (token.length <= 16) {
    return '[redacted]';
  }
  return `${token.substring(0, 8)}...${token.substring(token.length - 8)}`;
}
