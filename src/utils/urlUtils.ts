import { Request } from 'express';
import { isIP } from 'node:net';

const PUBLIC_URL_CONFIGURATION_ERROR = 'PETA_PUBLIC_URL or a trusted proxy is required for public URLs';

function getConfiguredPublicUrl(): string | undefined {
  const publicUrl = process.env.PETA_PUBLIC_URL?.trim();
  return publicUrl ? `${publicUrl.replace(/\/+$/, '')}/mcp` : undefined;
}

function usesTrustedProxy(req: Request): boolean {
  const trustProxy = req.app?.get('trust proxy fn');
  const remoteAddress = req.socket?.remoteAddress;
  return typeof trustProxy === 'function' && !!remoteAddress && trustProxy(remoteAddress, 0);
}

function getForwardedHeader(req: Request, name: 'x-forwarded-host' | 'x-forwarded-proto'): string | undefined {
  if (!usesTrustedProxy(req)) {
    return undefined;
  }

  const value = req.headers[name];
  const header = Array.isArray(value) ? value[0] : value;
  return header?.split(',', 1)[0]?.trim();
}

function getLocalRawHost(req: Request): string {
  const host = req.headers.host || req.get('host');
  if (!host || host.trim() !== host || /[/#?@]/.test(host) || host.endsWith(':')) {
    throw new Error(PUBLIC_URL_CONFIGURATION_ERROR);
  }

  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    throw new Error(PUBLIC_URL_CONFIGURATION_ERROR);
  }

  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(PUBLIC_URL_CONFIGURATION_ERROR);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const isLoopbackIpv4 = isIP(hostname) === 4 && hostname.startsWith('127.');
  const isLoopbackIpv6 = isIP(hostname) === 6 && hostname === '::1';
  if (hostname !== 'localhost' && !hostname.endsWith('.localhost') && !isLoopbackIpv4 && !isLoopbackIpv6) {
    throw new Error(PUBLIC_URL_CONFIGURATION_ERROR);
  }

  return host;
}

export function getPublicUrl(req: Request): string {
  const configuredPublicUrl = getConfiguredPublicUrl();
  if (configuredPublicUrl) {
    return configuredPublicUrl;
  }

  const forwardedProtocol = getForwardedHeader(req, 'x-forwarded-proto');
  const forwardedHost = getForwardedHeader(req, 'x-forwarded-host');
  const protocol = forwardedProtocol || req.protocol || (process.env.ENABLE_HTTPS === 'true' ? 'https' : 'http');
  const host = forwardedHost || getLocalRawHost(req);

  return `${protocol}://${host}/mcp`;
}

export function getAuthorizationServerUrl(req: Request): string {

  const gatewayUrl = getPublicUrl(req);

  // Remove /mcp path if present
  const url = new URL(gatewayUrl);
  if (url.pathname === '/mcp') {
    url.pathname = '';
  }

  return url.toString().replace(/\/$/, ''); // Remove trailing slash
}
