import * as path from 'path';

export const CUSTOM_STDIO_RUNNER_IMAGE = 'petaio/mcp-runner:latest';
const CUSTOM_STDIO_RUNNER_CACHE_VOLUME = 'peta-mcp-runner-cache:/home/runner/.cache';
const DEFAULT_STDERR_TAIL_MAX_LENGTH = 4096;

const RUNNER_STARTUP_STDERR_KEYWORDS = [
  'cannot connect to the docker daemon',
  'is the docker daemon running',
  'permission denied while trying to connect',
  'error response from daemon',
  'dial unix',
  'docker.sock',
  'pull access denied',
  'no such image',
  'manifest for',
  'failed to solve'
];

const RUNNER_COMMAND_STDERR_KEYWORDS = [
  'executable file not found',
  'command not found',
  'exec format error',
  'permission denied',
  'no such file or directory',
  'failed to exec'
];

export type RunnerFailureCategory = 'runner_startup_failure' | 'runner_command_failure' | 'runner_unknown_failure';

export interface CustomStdioRunnerMetadata {
  runnerImage: string;
  originalCommand: string;
}

export interface CustomStdioRunnerLaunchPlan {
  launchConfig: Record<string, any>;
  metadata: CustomStdioRunnerMetadata;
}

export interface RunnerFailureClassification {
  category: RunnerFailureCategory;
  reason: string;
}

function normalizeCommandForMatch(command: string): string {
  const trimmed = command.trim();
  if (trimmed === '') {
    return '';
  }

  const unquoted = trimmed.replace(/^["']|["']$/g, '');
  const normalizedPath = unquoted.replace(/\\/g, '/');
  const baseName = path.posix.basename(normalizedPath);
  return baseName.replace(/\.exe$/i, '').toLowerCase();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item));
}

function toStringEnvEntries(envValue: unknown): Array<[string, string]> {
  if (!envValue || typeof envValue !== 'object' || Array.isArray(envValue)) {
    return [];
  }

  return Object.entries(envValue as Record<string, unknown>)
    .filter(([key, value]) => key.trim() !== '' && value !== undefined)
    .map(([key, value]) => [key, value === null ? '' : String(value)]);
}

function findKeyword(source: string, keywords: string[]): string | null {
  for (const keyword of keywords) {
    if (source.includes(keyword)) {
      return keyword;
    }
  }
  return null;
}

export function isExplicitDockerCommand(command: unknown): boolean {
  if (typeof command !== 'string') {
    return false;
  }
  return normalizeCommandForMatch(command) === 'docker';
}

export function buildCustomStdioRunnerLaunchPlan(
  originalLaunchConfig: Record<string, any>,
  runnerImage: string = CUSTOM_STDIO_RUNNER_IMAGE
): CustomStdioRunnerLaunchPlan {
  if (typeof originalLaunchConfig.command !== 'string' || originalLaunchConfig.command.trim() === '') {
    throw new Error('CustomStdio launchConfig.command must be a non-empty string');
  }

  const originalCommand = originalLaunchConfig.command;
  const originalArgs = toStringArray(originalLaunchConfig.args);
  const dockerArgs: string[] = [
    'run',
    '-i',
    '--rm',
    '--init',
    '-v',
    CUSTOM_STDIO_RUNNER_CACHE_VOLUME
  ];

  if (typeof originalLaunchConfig.cwd === 'string' && originalLaunchConfig.cwd.trim() !== '') {
    dockerArgs.push('-w', originalLaunchConfig.cwd);
  }

  for (const [key, value] of toStringEnvEntries(originalLaunchConfig.env)) {
    dockerArgs.push('-e', `${key}=${value}`);
  }

  dockerArgs.push(runnerImage, originalCommand, ...originalArgs);

  const launchConfig: Record<string, any> = {
    ...originalLaunchConfig,
    command: 'docker',
    args: dockerArgs,
    stderr: 'pipe'
  };

  delete launchConfig.cwd;
  delete launchConfig.env;

  return {
    launchConfig,
    metadata: {
      runnerImage,
      originalCommand
    }
  };
}

export function appendStderrTail(
  currentTail: string,
  chunk: unknown,
  maxLength: number = DEFAULT_STDERR_TAIL_MAX_LENGTH
): string {
  if (chunk === undefined || chunk === null) {
    return currentTail;
  }

  const chunkText = typeof chunk === 'string'
    ? chunk
    : Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk).toString('utf8')
      : String(chunk);

  const merged = currentTail + chunkText;
  if (merged.length <= maxLength) {
    return merged;
  }
  return merged.slice(-maxLength);
}

export function classifyCustomStdioRunnerFailure(
  exitCode: number | null | undefined,
  stderrTail: string,
  errorText: string = ''
): RunnerFailureClassification {
  const combinedText = `${stderrTail}\n${errorText}`.toLowerCase();

  const startupKeyword = findKeyword(combinedText, RUNNER_STARTUP_STDERR_KEYWORDS);
  if (exitCode === 125 || startupKeyword) {
    return {
      category: 'runner_startup_failure',
      reason: startupKeyword ?? `docker exit code ${exitCode}`
    };
  }

  const commandKeyword = findKeyword(combinedText, RUNNER_COMMAND_STDERR_KEYWORDS);
  if (exitCode === 126 || exitCode === 127 || commandKeyword) {
    return {
      category: 'runner_command_failure',
      reason: commandKeyword ?? `docker exit code ${exitCode}`
    };
  }

  if (typeof exitCode === 'number' && exitCode !== 0) {
    return {
      category: 'runner_command_failure',
      reason: `docker exit code ${exitCode}`
    };
  }

  if (combinedText.includes('spawn') && combinedText.includes('enoent')) {
    return {
      category: 'runner_startup_failure',
      reason: 'spawn enoent'
    };
  }

  return {
    category: 'runner_unknown_failure',
    reason: 'unable to classify'
  };
}
