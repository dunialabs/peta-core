import * as http from 'http';
import * as fs from 'fs';
import { createLogger } from '../logger/index.js';

interface DockerMount {
  Source: string;
  Destination: string;
  Mode: string;
  RW: boolean;
  Type: string;
}

interface ContainerInfo {
  Mounts: DockerMount[];
}

const logger = createLogger('DockerHostPathResolver');
const DOCKER_SOCKET = '/var/run/docker.sock';

// Cached result: null = not yet fetched, [] = fetched but none found
let cachedMounts: DockerMount[] | null = null;
// Sentinel to avoid repeated failures
let resolutionFailed = false;

/**
 * Try to get the current Docker container ID.
 *
 * Attempt 1: HOSTNAME env var – Docker sets container hostname to the short container ID.
 * Attempt 2: Parse /proc/self/cgroup – available on Linux-based containers.
 */
async function getSelfContainerId(): Promise<string | null> {
  const hostname = process.env.HOSTNAME ?? '';
  if (/^[0-9a-f]{12,64}$/i.test(hostname)) {
    return hostname;
  }

  try {
    const cgroup = await fs.promises.readFile('/proc/self/cgroup', 'utf8');
    for (const line of cgroup.split('\n')) {
      const match = line.match(/\/docker\/([0-9a-f]{64})/i);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // /proc/self/cgroup is not available on non-Linux systems – this is expected
  }

  return null;
}

/**
 * Perform a GET request over the Docker Unix socket.
 */
function httpGetUnixSocket(socketPath: string, urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Docker socket request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch and cache the mount list for this container via the Docker socket.
 * Returns null when the environment is not Docker or the socket is unavailable.
 */
async function getMounts(): Promise<DockerMount[] | null> {
  if (cachedMounts !== null) return cachedMounts;
  if (resolutionFailed) return null;

  // Docker socket must exist and be accessible
  try {
    await fs.promises.access(DOCKER_SOCKET, fs.constants.R_OK);
  } catch {
    resolutionFailed = true;
    return null;
  }

  const containerId = await getSelfContainerId();
  if (!containerId) {
    logger.debug('Could not determine container ID; skipping Docker host path resolution');
    resolutionFailed = true;
    return null;
  }

  try {
    const body = await httpGetUnixSocket(DOCKER_SOCKET, `/containers/${containerId}/json`);
    const info: ContainerInfo = JSON.parse(body);
    cachedMounts = Array.isArray(info.Mounts) ? info.Mounts : [];
    logger.debug({ mountCount: cachedMounts.length }, 'Docker container mounts cached');
    return cachedMounts;
  } catch (error) {
    logger.warn({ error }, 'Failed to query Docker socket for container mounts; falling back to original paths');
    resolutionFailed = true;
    return null;
  }
}

/**
 * Resolve a container-side absolute path to its host-side absolute path.
 *
 * Returns null when:
 * - Not running inside Docker
 * - Docker socket is unavailable
 * - The given path has no corresponding mount entry
 */
export async function resolveHostPath(containerPath: string): Promise<string | null> {
  const mounts = await getMounts();
  if (!mounts) return null;

  const mount = mounts.find((m) => m.Destination === containerPath);
  if (!mount) {
    logger.debug({ containerPath }, 'No Docker mount entry found for container path');
    return null;
  }

  return mount.Source;
}

/** Exposed for testing – resets cached state. */
export function resetCache(): void {
  cachedMounts = null;
  resolutionFailed = false;
}
