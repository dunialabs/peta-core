export type ClientIpHeaders = Record<string, string | string[] | undefined>;

export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  if (trimmed === '::1') return '127.0.0.1';
  if (trimmed.includes(':') && trimmed.includes('.')) {
    const possibleIpv4 = trimmed.slice(trimmed.lastIndexOf(':') + 1);
    if (isIpv4(possibleIpv4)) return possibleIpv4;
  }
  return trimmed;
}

export function isTrustedProxyIp(ip: string): boolean {
  const normalizedIp = normalizeIp(ip);
  return (process.env.TRUSTED_PROXY_IPS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => entry === normalizedIp || matchesCidr(normalizedIp, entry));
}

export function resolveClientIp(peerIp: string, headers: ClientIpHeaders): string {
  const normalizedPeer = normalizeIp(peerIp);
  if (!isTrustedProxyIp(normalizedPeer)) return normalizedPeer;

  const forwarded = headerValue(headers['x-forwarded-for']);
  if (forwarded) {
    const hops = forwarded.split(',').map(normalizeIp).filter(Boolean);
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      if (!isTrustedProxyIp(hops[index])) return hops[index];
    }
    if (hops.length > 0) return hops[0];
  }

  const directHeader = headerValue(headers['x-real-ip']) || headerValue(headers['cf-connecting-ip']);
  return directHeader ? normalizeIp(directHeader) : normalizedPeer;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.trim();
  return value?.trim();
}

function matchesCidr(ip: string, entry: string): boolean {
  const [network, bitsText] = entry.split('/');
  if (!bitsText || !isIpv4(ip) || !isIpv4(network)) return false;
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToNumber(ip) & mask) === (ipToNumber(network) & mask);
}

function isIpv4(ip: string): boolean {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function ipToNumber(ip: string): number {
  return ip.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
}
