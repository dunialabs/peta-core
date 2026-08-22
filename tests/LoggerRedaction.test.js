import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import pino from 'pino';
import { loggerConfig } from '../dist/logger/LoggerConfig.js';

function writeLog(run) {
  const destination = new PassThrough();
  let output = '';
  destination.on('data', chunk => {
    output += chunk.toString();
  });

  run(pino(loggerConfig, destination));
  return JSON.parse(output);
}

describe('LoggerConfig operational log redaction', () => {
  test('redacts nested credentials and Bearer values while preserving sanitized Error details', () => {
    const error = new Error('upstream rejected Bearer error-token-marker and Basic error-basic-marker');
    error.details = {
      access_token: 'nested-access-token-marker',
      authConf: [{ key: 'AUTH_KEY', value: 'nested-auth-conf-value-marker' }],
      launchConfig: { privateKey: 'nested-private-key-marker', cookie: 'nested-cookie-marker' },
    };

    const entry = writeLog(logger => {
      logger
        .child({ request: { authorization: 'Bearer child-binding-token-marker' } })
        .error({
          metadata: {
            connection: { client_secret: 'nested-client-secret-marker' },
            bearerText: 'Bearer nested-bearer-token-marker',
            basicText: 'Basic nested-basic-token-marker',
            jsonString: JSON.stringify({
              nested: [{ details: { 'api-key': 'json-api-key-marker', vendorToken: 'json-string-token-marker' } }],
            }),
            doubleEncoded: JSON.stringify(JSON.stringify({ client_secret: 'double-encoded-secret-marker' })),
            malformed: '{"vendorToken":"malformed-token-marker"',
            malformedBare: 'client_secret: malformed-bare-secret-marker',
            malformedEquals: 'api-key=malformed-equals-key-marker',
            malformedUnquoted: '{vendorToken:"malformed-unquoted-token-marker"',
          },
          error,
        }, 'request failed with Bearer message-token-marker and Basic message-basic-token-marker');
    });

    expect(entry.request.authorization).toBe('[REDACTED]');
    expect(entry.metadata.connection.client_secret).toBe('[REDACTED]');
    expect(entry.metadata.bearerText).toBe('Bearer [REDACTED]');
    expect(entry.metadata.basicText).toBe('Basic [REDACTED]');
    expect(JSON.parse(entry.metadata.jsonString)).toEqual({
      nested: [{ details: { 'api-key': '[REDACTED]', vendorToken: '[REDACTED]' } }],
    });
    expect(JSON.parse(JSON.parse(entry.metadata.doubleEncoded))).toEqual({ client_secret: '[REDACTED]' });
    expect(entry.metadata.malformed).toBe('{"vendorToken":"[REDACTED]"');
    expect(entry.metadata.malformedBare).toBe('client_secret: [REDACTED]');
    expect(entry.metadata.malformedEquals).toBe('api-key=[REDACTED]');
    expect(entry.metadata.malformedUnquoted).toBe('{vendorToken:"[REDACTED]"');
    expect(entry.msg).toBe('request failed with Bearer [REDACTED] and Basic [REDACTED]');
    expect(entry.error).toEqual(expect.objectContaining({
      type: 'Error',
      name: 'Error',
      message: 'upstream rejected Bearer [REDACTED] and Basic [REDACTED]',
      details: expect.objectContaining({ access_token: '[REDACTED]' }),
    }));
    expect(entry.error.stack).toContain('Bearer [REDACTED]');
    expect(entry.error.details.authConf).toBe('[REDACTED]');
    expect(entry.error.details.launchConfig).toEqual({
      privateKey: '[REDACTED]',
      cookie: '[REDACTED]',
    });
    expect(JSON.stringify(entry)).not.toMatch(/(?:child-binding|nested-client-secret|nested-access-token|nested-auth-conf-value|nested-private-key|nested-cookie|nested-bearer|nested-basic-token|json-api-key|json-string-token|double-encoded-secret|malformed(?:-bare-secret|-equals-key|-unquoted-token|-token)|message-token|message-basic-token|error-token|error-basic)-marker/);
  });

  test('redacts credentials through the actual development pretty transport', () => {
    const probe = `
      import pino from 'pino';
      import { loggerConfig } from './dist/logger/LoggerConfig.js';

      const error = new Error('upstream rejected Bearer pretty-error-token-marker and Basic pretty-error-basic-marker');
      error.details = { client_secret: 'pretty-error-secret-marker', code: 'UPSTREAM' };
      const logger = pino(loggerConfig);

      logger
        .child({ request: { authorization: 'Bearer pretty-child-token-marker' } })
        .error({
          metadata: {
            jsonString: JSON.stringify({ vendorToken: 'pretty-json-token-marker' }),
            doubleEncoded: JSON.stringify(JSON.stringify({ client_secret: 'pretty-double-secret-marker' })),
            malformed: '{"vendorToken":"pretty-malformed-token-marker"',
            malformedBare: 'client_secret: pretty-bare-secret-marker',
            malformedEquals: 'vendorToken=pretty-equals-token-marker',
            basicText: 'Basic pretty-basic-token-marker',
          },
          error,
        }, 'pretty diagnostic Bearer pretty-message-token-marker and Basic pretty-message-basic-marker');

      await new Promise(resolve => logger.flush(resolve));
    `;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        LOG_PRETTY: 'true',
        NODE_ENV: 'development',
      },
      timeout: 5_000,
    });
    const output = stripVTControlCharacters(`${result.stdout}${result.stderr}`);

    expect(result.status).toBe(0);
    expect(output).toContain('pretty diagnostic Bearer [REDACTED] and Basic [REDACTED]');
    expect(output).toContain('"type": "Error"');
    expect(output).toContain('"name": "Error"');
    expect(output).toContain('upstream rejected Bearer [REDACTED] and Basic [REDACTED]');
    expect(output).toContain('"code": "UPSTREAM"');
    expect(output).not.toMatch(/pretty-(?:child-token|error-token|error-basic|error-secret|json-token|double-secret|malformed-token|bare-secret|equals-token|basic-token|message-token|message-basic)-marker/);
  });
});
