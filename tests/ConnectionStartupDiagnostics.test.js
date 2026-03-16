import { PassThrough } from 'node:stream';
import {
  createConnectionStartupDiagnostics,
  formatConnectionDiagnosticError,
} from '../dist/mcp/core/ConnectionStartupDiagnostics.js';

function createFakeTransport(stderr = new PassThrough()) {
  return {
    start: async () => {},
    send: async () => {},
    close: async () => {},
    stderr,
  };
}

describe('ConnectionStartupDiagnostics', () => {
  test('formats nested network causes for fetch failures', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8123'), {
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
      address: '127.0.0.1',
      port: 8123,
    });
    const error = new TypeError('fetch failed');
    error.cause = cause;

    const formatted = formatConnectionDiagnosticError(error);

    expect(formatted).toContain('TypeError: fetch failed');
    expect(formatted).toContain('cause=connect ECONNREFUSED 127.0.0.1:8123');
    expect(formatted).toContain('code=ECONNREFUSED');
    expect(formatted).toContain('syscall=connect');
  });

  test('prefers the first transport parse error over a later timeout', () => {
    const transport = createFakeTransport();
    const diagnostics = createConnectionStartupDiagnostics(transport, {});

    transport.onerror?.(new SyntaxError('Unexpected token o in JSON at position 1'));

    expect(diagnostics.getPreferredMessage(new Error('Request timed out'))).toContain(
      'Unexpected token o in JSON at position 1',
    );

    diagnostics.deactivate();
  });

  test('prefers stderr output over a generic close message', () => {
    const stderr = new PassThrough();
    const transport = createFakeTransport(stderr);
    const diagnostics = createConnectionStartupDiagnostics(transport, {});

    stderr.write('fatal: missing required config file\n');
    diagnostics.captureClose('Connection closed');

    expect(diagnostics.getPreferredMessage(new Error('Connection closed'))).toContain(
      'fatal: missing required config file',
    );

    diagnostics.deactivate();
  });
});
