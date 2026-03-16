import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Server } from '@prisma/client';
import { ServerCategory } from '../../types/enums.js';
import { assertDockerRuntimeAvailable } from '../../utils/DockerRuntimeProbe.js';
import {
  appendStderrTail,
  buildCustomStdioRunnerLaunchPlan,
  classifyCustomStdioRunnerFailure,
  CUSTOM_STDIO_RUNNER_IMAGE,
  type CustomStdioRunnerMetadata,
  isExplicitDockerCommand
} from './CustomStdioRunner.js';

export interface CustomStdioLaunchPlan {
  launchConfig: Record<string, any>;
  runnerMetadata?: CustomStdioRunnerMetadata;
}

export interface RunnerExecutionTrace {
  stderrTail: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunnerFailureDetails {
  category: string;
  reason: string;
  message: string;
  stderrSummary: string;
}

export class CustomStdioRunnerService {
  resolveLaunchPlan(serverEntity: Server, launchConfig: Record<string, any>): CustomStdioLaunchPlan {
    if (serverEntity.category !== ServerCategory.CustomStdio) {
      return { launchConfig };
    }

    if (process.env.PETA_CORE_IN_DOCKER !== 'true') {
      return { launchConfig };
    }

    if (isExplicitDockerCommand(launchConfig.command)) {
      return { launchConfig };
    }

    assertDockerRuntimeAvailable('CustomStdioRunner', `server ${serverEntity.serverId}`);

    const runnerLaunchPlan = buildCustomStdioRunnerLaunchPlan(
      launchConfig,
      CUSTOM_STDIO_RUNNER_IMAGE
    );

    return {
      launchConfig: runnerLaunchPlan.launchConfig,
      runnerMetadata: runnerLaunchPlan.metadata
    };
  }

  attachExecutionTrace(transport: Transport): RunnerExecutionTrace {
    const trace: RunnerExecutionTrace = {
      stderrTail: '',
      exitCode: null,
      signal: null
    };

    const stdioTransport = transport as any;
    const stderrStream = stdioTransport.stderr;
    if (stderrStream && typeof stderrStream.on === 'function') {
      stderrStream.on('data', (chunk: unknown) => {
        trace.stderrTail = appendStderrTail(trace.stderrTail, chunk);
      });
    }

    if (typeof stdioTransport.start === 'function') {
      const originalStart = stdioTransport.start.bind(stdioTransport) as (...args: unknown[]) => Promise<void>;
      stdioTransport.start = async (...args: unknown[]): Promise<void> => {
        await originalStart(...args);
        const childProcess = stdioTransport._process;
        if (childProcess && typeof childProcess.once === 'function') {
          childProcess.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
            trace.exitCode = code;
            trace.signal = signal;
          });
        }
      };
    }

    return trace;
  }

  buildFailureDetails(
    serverId: string,
    runnerMetadata: CustomStdioRunnerMetadata,
    trace: RunnerExecutionTrace,
    error?: unknown
  ): RunnerFailureDetails | null {
    const errorText = error instanceof Error ? error.message : error !== undefined ? String(error) : '';
    const stderrSummary = this.summarizeStderrTail(trace.stderrTail);
    const classification = classifyCustomStdioRunnerFailure(trace.exitCode, trace.stderrTail, errorText);

    if (
      classification.category === 'runner_unknown_failure' &&
      trace.exitCode === null &&
      stderrSummary === '' &&
      errorText === ''
    ) {
      return null;
    }

    const exitCodeText = trace.exitCode === null ? 'unknown' : String(trace.exitCode);
    let prefix = 'CustomStdio runner failed';
    if (classification.category === 'runner_startup_failure') {
      prefix = 'CustomStdio runner startup failed';
    } else if (classification.category === 'runner_command_failure') {
      prefix = 'CustomStdio runner command failed';
    }

    let message =
      `${prefix} (serverId=${serverId}, originalCommand=${runnerMetadata.originalCommand}, ` +
      `runnerImage=${runnerMetadata.runnerImage}, exitCode=${exitCodeText}, reason=${classification.reason})`;

    if (stderrSummary !== '') {
      message += ` stderr=${stderrSummary}`;
    }

    return {
      category: classification.category,
      reason: classification.reason,
      message,
      stderrSummary
    };
  }

  private summarizeStderrTail(stderrText: string, maxLength: number = 300): string {
    const normalized = stderrText.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return normalized.slice(-maxLength);
  }
}

export const customStdioRunnerService = new CustomStdioRunnerService();
