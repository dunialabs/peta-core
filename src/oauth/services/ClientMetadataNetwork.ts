import type { IncomingHttpHeaders } from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { createLogger } from '../../logger/index.js';

const BLOCKED_IPV4_SUBNETS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const;

const FAKE_IP_IPV4_SUBNETS = [
  ['198.18.0.0', 15],
] as const;

const BLOCKED_IPV6_SUBNETS = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const;

function createBlockedIpv4Ranges(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of BLOCKED_IPV4_SUBNETS) {
    blockList.addSubnet(address, prefix, 'ipv4');
  }
  return blockList;
}

function createBlockedIpv6Ranges(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of BLOCKED_IPV6_SUBNETS) {
    blockList.addSubnet(address, prefix, 'ipv6');
  }
  return blockList;
}

const BLOCKED_IPV4_RANGES = createBlockedIpv4Ranges();
const BLOCKED_IPV6_RANGES = createBlockedIpv6Ranges();

function createFakeIpRanges(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of FAKE_IP_IPV4_SUBNETS) {
    blockList.addSubnet(address, prefix, 'ipv4');
  }
  return blockList;
}

const FAKE_IP_RANGES = createFakeIpRanges();

export type ClientMetadataNetworkValidationResult = {
  valid: boolean;
  error?: string;
  addresses?: string[];
};

export type ClientMetadataHttpResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: string;
};

export class ClientMetadataNetwork {
  private readonly logger = createLogger('ClientMetadataNetwork');

  constructor(
    private readonly fetchTimeoutMs: number,
    private readonly maxMetadataBytes: number,
  ) {}

  async validatePublicNetworkTarget(url: string): Promise<ClientMetadataNetworkValidationResult> {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    const ipHostname = this.unbracketIpv6Hostname(hostname);

    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return { valid: false, error: 'Client metadata URL must not target localhost' };
    }

    const directIpVersion = isIP(ipHostname);
    const addresses = directIpVersion > 0
      ? [{ address: ipHostname }]
      : await lookup(hostname, { all: true, verbatim: true });

    if (addresses.length === 0) {
      return { valid: false, error: 'Client metadata URL host did not resolve' };
    }

    const allowFakeIp = this.allowFakeIpClientMetadata();
    const allowedFakeIpAddresses: string[] = [];

    for (const { address } of addresses) {
      if (this.isPublicIpAddress(address)) {
        continue;
      }

      const fakeIpAddress = this.isFakeIpAddress(address);
      if (fakeIpAddress && directIpVersion > 0) {
        return {
          valid: false,
          error: 'Client metadata URL must not directly target 198.18.0.0/15 fake-IP addresses',
        };
      }

      if (fakeIpAddress && allowFakeIp) {
        allowedFakeIpAddresses.push(address);
        continue;
      }

      if (fakeIpAddress) {
        return {
          valid: false,
          error: 'Client metadata URL resolved to 198.18.0.0/15 fake-IP addresses, but OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP is disabled',
        };
      }

      return { valid: false, error: 'Client metadata URL must resolve only to public IP addresses' };
    }

    if (allowedFakeIpAddresses.length > 0) {
      this.logger.warn({
        hostname,
        addresses: allowedFakeIpAddresses,
      }, 'Allowing URL-based OAuth client metadata host resolved through VPN fake-IP range');
    }

    return { valid: true, addresses: addresses.map(({ address }) => address) };
  }

  async fetchPinnedMetadataDocument(url: string, addresses: readonly string[]): Promise<ClientMetadataHttpResponse> {
    let lastError: Error | undefined;

    for (const address of addresses) {
      try {
        return await this.fetchPinnedMetadataDocumentFromAddress(url, address);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error('Client metadata URL host did not resolve');
  }

  private isPublicIpAddress(address: string): boolean {
    const normalizedAddress = this.unbracketIpv6Hostname(address.toLowerCase());

    const version = isIP(normalizedAddress);
    if (version === 4) {
      const octets = normalizedAddress.split('.').map((part) => Number(part));
      if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
      }
      if (this.isFakeIpAddress(normalizedAddress)) {
        return false;
      }
      return !BLOCKED_IPV4_RANGES.check(normalizedAddress, 'ipv4');
    }

    if (version === 6) {
      return !BLOCKED_IPV6_RANGES.check(normalizedAddress, 'ipv6');
    }

    return false;
  }

  private isFakeIpAddress(address: string): boolean {
    const normalizedAddress = this.unbracketIpv6Hostname(address.toLowerCase());
    return isIP(normalizedAddress) === 4 && FAKE_IP_RANGES.check(normalizedAddress, 'ipv4');
  }

  private allowFakeIpClientMetadata(): boolean {
    return process.env.OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP?.trim().toLowerCase() !== 'false';
  }

  private unbracketIpv6Hostname(hostname: string): string {
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname.slice(1, -1);
    }
    return hostname;
  }

  private fetchPinnedMetadataDocumentFromAddress(url: string, address: string): Promise<ClientMetadataHttpResponse> {
    const parsedUrl = new URL(url);

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
        timeout: this.fetchTimeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > this.maxMetadataBytes) {
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
}
