import * as fs from 'fs';
import { spawnSync } from 'node:child_process';

export const DOCKER_SOCKET_PATH = '/var/run/docker.sock';

function summarizeProcessOutput(text: string, maxLength: number = 300): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(-maxLength);
}

export function assertDockerRuntimeAvailable(context: string, target: string): void {
  if (!fs.existsSync(DOCKER_SOCKET_PATH)) {
    throw new Error(
      `[${context}] Docker socket not found (${DOCKER_SOCKET_PATH}) for ${target}`
    );
  }

  try {
    fs.accessSync(DOCKER_SOCKET_PATH, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[${context}] Docker socket is not accessible (${DOCKER_SOCKET_PATH}) for ${target}: ${reason}`
    );
  }

  const dockerCliCheck = spawnSync('docker', ['--version'], {
    encoding: 'utf8',
    timeout: 5000
  });
  if (dockerCliCheck.error) {
    throw new Error(
      `[${context}] docker CLI is not available for ${target}: ${dockerCliCheck.error.message}`
    );
  }
  if (dockerCliCheck.status !== 0) {
    const reason = summarizeProcessOutput(
      dockerCliCheck.stderr || dockerCliCheck.stdout || 'docker --version failed'
    );
    throw new Error(
      `[${context}] docker CLI check failed for ${target}: ${reason}`
    );
  }

  const dockerDaemonCheck = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 5000
  });
  if (dockerDaemonCheck.error) {
    throw new Error(
      `[${context}] Docker daemon check failed for ${target}: ${dockerDaemonCheck.error.message}`
    );
  }
  if (dockerDaemonCheck.status !== 0) {
    const reason = summarizeProcessOutput(
      dockerDaemonCheck.stderr || dockerDaemonCheck.stdout || 'docker daemon is unavailable'
    );
    throw new Error(
      `[${context}] Docker daemon is unavailable for ${target}: ${reason}`
    );
  }
}
