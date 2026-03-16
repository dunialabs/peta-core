import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { appendStderrTail } from './CustomStdioRunner.js';

type ErrorHandler = (error: Error) => void;

type ConnectionDiagnosticSource = 'transport' | 'client' | 'close';

interface ConnectionDiagnosticEvent {
  source: ConnectionDiagnosticSource;
  message: string;
  isGeneric: boolean;
}

interface ConnectionDiagnosticClient {
  onerror?: ErrorHandler;
}

interface DiagnosticStderrStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  off?(event: 'data', listener: (chunk: unknown) => void): unknown;
  removeListener?(event: 'data', listener: (chunk: unknown) => void): unknown;
}

export interface ConnectionStartupDiagnosticSnapshot {
  preferredMessage?: string;
  firstEvent?: ConnectionDiagnosticEvent;
  firstMeaningfulEvent?: ConnectionDiagnosticEvent;
  stderrSummary?: string;
  eventCount: number;
}

export interface ConnectionStartupDiagnostics {
  captureError(source: Exclude<ConnectionDiagnosticSource, 'close'>, error: unknown): string;
  captureClose(message: string): string;
  deactivate(): void;
  getPreferredMessage(finalError?: unknown): string | undefined;
  getSnapshot(finalError?: unknown): ConnectionStartupDiagnosticSnapshot;
}

const GENERIC_CONNECTION_MESSAGES = new Set([
  'request timed out',
  'error: request timed out',
  'mcperror: request timed out',
  'connection closed',
  'error: connection closed',
  'mcperror: connection closed',
  'transport closed by server',
  'fetch failed',
  'error: fetch failed',
  'typeerror: fetch failed'
]);

const DETAIL_HINTS = ['cause=', 'issues=', 'stderr=', 'errno=', 'syscall=', 'address=', 'port='];
const SENSITIVE_KEY_PATTERN = /token|password|secret|authorization|api[-_]?key|refresh[-_]?token|client[-_]?secret/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/("?(?:token|password|secret|authorization|api[_-]?key|refresh[_-]?token|client[_-]?secret)"?\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function sanitizeDiagnosticText(text: string, maxLength: number = 400): string {
  const normalized = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
  return truncateText(normalized, maxLength);
}

function sanitizeDiagnosticValue(value: unknown, depth: number = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeDiagnosticText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return `[array(${value.length})]`;
    }
    return value.slice(0, 5).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }

  if (isRecord(value)) {
    if (depth >= 2) {
      return `[object keys=${Object.keys(value).slice(0, 5).join(',')}]`;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, 10)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeDiagnosticValue(nestedValue, depth + 1);
      }
    }
    return sanitized;
  }

  return sanitizeDiagnosticText(String(value));
}

function formatDiagnosticValue(value: unknown, maxLength: number = 400): string {
  try {
    return truncateText(JSON.stringify(sanitizeDiagnosticValue(value)), maxLength);
  } catch {
    return sanitizeDiagnosticText(String(value), maxLength);
  }
}

function formatIssuePath(pathValue: unknown): string {
  if (!Array.isArray(pathValue) || pathValue.length === 0) {
    return '<root>';
  }

  return pathValue
    .map((segment) => sanitizeDiagnosticText(String(segment), 60))
    .join('.');
}

function formatIssues(issuesValue: unknown): string | undefined {
  if (!Array.isArray(issuesValue) || issuesValue.length === 0) {
    return undefined;
  }

  const formattedIssues = issuesValue.slice(0, 3).map((issue) => {
    if (!isRecord(issue)) {
      return sanitizeDiagnosticText(String(issue), 120);
    }

    const pathText = formatIssuePath(issue.path);
    const messageText = sanitizeDiagnosticText(String(issue.message ?? 'Invalid value'), 120);
    return `${pathText}: ${messageText}`;
  });

  return `[${formattedIssues.join('; ')}]`;
}

function formatObjectLikeError(error: Record<string, unknown>, depth: number): string {
  const name = typeof error.name === 'string' && error.name.trim() !== '' ? sanitizeDiagnosticText(error.name, 80) : undefined;
  const message = typeof error.message === 'string'
    ? sanitizeDiagnosticText(error.message, 240)
    : sanitizeDiagnosticText(formatDiagnosticValue(error), 240);

  const baseMessage = name && name !== 'Error' ? `${name}: ${message}` : message;
  const details: string[] = [];

  for (const field of ['code', 'errno', 'syscall', 'address', 'port'] as const) {
    const value = error[field];
    if (value !== undefined) {
      details.push(`${field}=${sanitizeDiagnosticText(String(value), 120)}`);
    }
  }

  if (error instanceof McpError && error.data !== undefined) {
    details.push(`data=${formatDiagnosticValue(error.data, 320)}`);
  } else if (error.data !== undefined && typeof error.data !== 'function') {
    details.push(`data=${formatDiagnosticValue(error.data, 320)}`);
  }

  const issuesText = formatIssues(error.issues);
  if (issuesText) {
    details.push(`issues=${issuesText}`);
  }

  if (depth < 1 && error.cause !== undefined) {
    details.push(`cause=${formatConnectionDiagnosticError(error.cause, depth + 1)}`);
  }

  return details.length > 0 ? `${baseMessage} (${details.join(', ')})` : baseMessage;
}

export function formatConnectionDiagnosticError(error: unknown, depth: number = 0): string {
  if (error instanceof Error) {
    return formatObjectLikeError(error as unknown as Record<string, unknown>, depth);
  }

  if (isRecord(error)) {
    return formatObjectLikeError(error, depth);
  }

  return sanitizeDiagnosticText(String(error), 240);
}

export function isGenericConnectionDiagnostic(message: string): boolean {
  const normalized = sanitizeDiagnosticText(message, 400).toLowerCase();
  if (DETAIL_HINTS.some((hint) => normalized.includes(hint))) {
    return false;
  }

  const baseMessage = normalized.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return GENERIC_CONNECTION_MESSAGES.has(baseMessage);
}

function summarizeStderr(stderrTail: string, maxLength: number = 300): string | undefined {
  const summary = sanitizeDiagnosticText(stderrTail, maxLength);
  return summary === '' ? undefined : summary;
}

function getTransportStderr(transport: Transport): DiagnosticStderrStream | null {
  const stderr = (transport as Transport & { stderr?: unknown }).stderr;
  if (!stderr || typeof (stderr as DiagnosticStderrStream).on !== 'function') {
    return null;
  }

  return stderr as DiagnosticStderrStream;
}

export function createConnectionStartupDiagnostics(
  transport: Transport,
  client: ConnectionDiagnosticClient
): ConnectionStartupDiagnostics {
  const events: ConnectionDiagnosticEvent[] = [];
  let active = true;
  let stderrTail = '';

  const rememberMessage = (source: ConnectionDiagnosticSource, message: string): string => {
    const normalizedMessage = sanitizeDiagnosticText(message, 400);
    if (normalizedMessage === '') {
      return normalizedMessage;
    }

    if (
      active &&
      !events.some((event) => event.source === source && event.message === normalizedMessage)
    ) {
      events.push({
        source,
        message: normalizedMessage,
        isGeneric: isGenericConnectionDiagnostic(normalizedMessage)
      });
    }

    return normalizedMessage;
  };

  const previousTransportOnError = transport.onerror;
  transport.onerror = (error: Error) => {
    previousTransportOnError?.(error);
    rememberMessage('transport', formatConnectionDiagnosticError(error));
  };

  const previousClientOnError = client.onerror;
  client.onerror = (error: Error) => {
    previousClientOnError?.(error);
    rememberMessage('client', formatConnectionDiagnosticError(error));
  };

  const stderrStream = getTransportStderr(transport);
  const stderrListener = (chunk: unknown) => {
    if (!active) {
      return;
    }
    stderrTail = appendStderrTail(stderrTail, chunk);
  };

  if (stderrStream) {
    stderrStream.on('data', stderrListener);
  }

  const getFirstMeaningfulEvent = (): ConnectionDiagnosticEvent | undefined =>
    events.find((event) => !event.isGeneric);

  const getFirstEvent = (): ConnectionDiagnosticEvent | undefined => events[0];

  return {
    captureError(source, error) {
      return rememberMessage(source, formatConnectionDiagnosticError(error));
    },

    captureClose(message) {
      return rememberMessage('close', message);
    },

    deactivate() {
      if (!active) {
        return;
      }

      active = false;
      client.onerror = previousClientOnError;

      if (stderrStream) {
        if (typeof stderrStream.off === 'function') {
          stderrStream.off('data', stderrListener);
        } else if (typeof stderrStream.removeListener === 'function') {
          stderrStream.removeListener('data', stderrListener);
        }
      }
    },

    getPreferredMessage(finalError?: unknown) {
      const formattedFinalError = finalError !== undefined
        ? formatConnectionDiagnosticError(finalError)
        : undefined;
      const stderrSummary = summarizeStderr(stderrTail);

      return (
        getFirstMeaningfulEvent()?.message ??
        stderrSummary ??
        (formattedFinalError && !isGenericConnectionDiagnostic(formattedFinalError)
          ? formattedFinalError
          : undefined) ??
        getFirstEvent()?.message ??
        formattedFinalError
      );
    },

    getSnapshot(finalError?: unknown) {
      return {
        preferredMessage: this.getPreferredMessage(finalError),
        firstEvent: getFirstEvent(),
        firstMeaningfulEvent: getFirstMeaningfulEvent(),
        stderrSummary: summarizeStderr(stderrTail),
        eventCount: events.length
      };
    }
  };
}
