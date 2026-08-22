#!/usr/bin/env node
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import process from 'node:process';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
dotenv.config({ path: join(repoRoot, '.env') });

const prisma = new PrismaClient();
const report = {
  startedAt: new Date().toISOString(),
  cases: [],
  fixtures: {},
  cleanup: [],
  petaCoreLogs: [],
};
const children = [];

const OWNER_TOKEN = getArg('--owner-token') || process.env.PETA_COMPAT_OWNER_TOKEN;
if (!OWNER_TOKEN) {
  failUsage('Missing --owner-token or PETA_COMPAT_OWNER_TOKEN');
}

const KEEP_DATA = hasArg('--keep-data');
const START_PETA_CORE = !hasArg('--no-start-core');
const BACKEND_PORT = Number(getArg('--backend-port') || process.env.PETA_COMPAT_BACKEND_PORT || await getFreePort());
const BASE_URL = getArg('--base-url') || `http://localhost:${BACKEND_PORT}`;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  failUsage('JWT_SECRET is required in .env or environment');
}

const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const MODERN_ERROR_CODES = {
  invalidRequest: -32600,
  invalidParams: -32602,
  authFailure: -32000,
  unsupportedProtocolVersion: -32022,
};
const PREFIX = 'compat-smoke';
const oauthClientId = `${PREFIX}-client`;
const resource = `${BASE_URL}/mcp`;

const serverSpecs = [];

try {
  const ownerUserId = await calculateUserId(OWNER_TOKEN);
  await ensureOwnerUser(ownerUserId);

  const ports = {
    legacyHttpAuto: await getFreePort(),
    legacyHttpForced: await getFreePort(),
    modernAuto: await getFreePort(),
    modernForced: await getFreePort(),
    modernUnsupported: await getFreePort(),
  };

  const fixtureInfos = [
    await startFixture('legacy-http-auto', 'legacy-http.mjs', ports.legacyHttpAuto),
    await startFixture('legacy-http-forced', 'legacy-http.mjs', ports.legacyHttpForced),
    await startFixture('modern-auto', 'modern-http.mjs', ports.modernAuto),
    await startFixture('modern-forced', 'modern-http.mjs', ports.modernForced),
    await startFixture('modern-unsupported', 'modern-http.mjs', ports.modernUnsupported, { UNSUPPORTED_MODERN: 'true' }),
  ];
  for (const info of fixtureInfos) {
    report.fixtures[info.fixtureId] = info;
  }

  serverSpecs.push(
    {
      id: `${PREFIX}-legacy-stdio-auto`,
      name: 'Compat Smoke Legacy Stdio Auto',
      fixtureId: 'legacy-stdio-auto',
      launchConfig: {
        command: process.execPath,
        args: [join(repoRoot, 'scripts/compat-smoke/fixtures/legacy-stdio.mjs')],
        env: { FIXTURE_ID: 'legacy-stdio-auto' },
        mcpProtocol: 'auto',
      },
      expectedToolOriginal: 'compat-smoke-legacy-stdio-auto-tool',
    },
    {
      id: `${PREFIX}-legacy-http-auto`,
      name: 'Compat Smoke Legacy HTTP Auto',
      fixtureId: 'legacy-http-auto',
      launchConfig: {
        type: 'http',
        url: `http://127.0.0.1:${ports.legacyHttpAuto}/mcp`,
        mcpProtocol: 'auto',
      },
      expectedToolOriginal: 'compat-smoke-legacy-http-auto-tool',
      logUrl: `http://127.0.0.1:${ports.legacyHttpAuto}/logs`,
    },
    {
      id: `${PREFIX}-legacy-http-forced`,
      name: 'Compat Smoke Legacy HTTP Forced Legacy',
      fixtureId: 'legacy-http-forced',
      launchConfig: {
        type: 'http',
        url: `http://127.0.0.1:${ports.legacyHttpForced}/mcp`,
        mcpProtocol: 'legacy',
      },
      expectedToolOriginal: 'compat-smoke-legacy-http-forced-tool',
      logUrl: `http://127.0.0.1:${ports.legacyHttpForced}/logs`,
    },
    {
      id: `${PREFIX}-modern-http-auto`,
      name: 'Compat Smoke Modern HTTP Auto',
      fixtureId: 'modern-auto',
      launchConfig: {
        type: 'http',
        url: `http://127.0.0.1:${ports.modernAuto}/mcp`,
        mcpProtocol: 'auto',
      },
      expectedToolOriginal: 'compat-smoke-modern-auto-tool',
      logUrl: `http://127.0.0.1:${ports.modernAuto}/logs`,
    },
    {
      id: `${PREFIX}-modern-http-forced`,
      name: 'Compat Smoke Modern HTTP Forced Modern',
      fixtureId: 'modern-forced',
      launchConfig: {
        type: 'http',
        url: `http://127.0.0.1:${ports.modernForced}/mcp`,
        mcpProtocol: 'modern',
      },
      expectedToolOriginal: 'compat-smoke-modern-forced-tool',
      logUrl: `http://127.0.0.1:${ports.modernForced}/logs`,
    },
    {
      id: `${PREFIX}-modern-http-unsupported`,
      name: 'Compat Smoke Modern HTTP Unsupported',
      fixtureId: 'modern-unsupported',
      launchConfig: {
        type: 'http',
        url: `http://127.0.0.1:${ports.modernUnsupported}/mcp`,
        mcpProtocol: 'modern',
      },
      expectedToolOriginal: 'compat-smoke-modern-unsupported-tool',
      logUrl: `http://127.0.0.1:${ports.modernUnsupported}/logs`,
      expectedStartFailure: 'does not advertise MCP 2026-07-28',
    },
    {
      id: `${PREFIX}-stdio-forced-modern`,
      name: 'Compat Smoke Stdio Forced Modern',
      fixtureId: 'stdio-forced-modern',
      launchConfig: {
        command: process.execPath,
        args: [join(repoRoot, 'scripts/compat-smoke/fixtures/legacy-stdio.mjs')],
        env: { FIXTURE_ID: 'stdio-forced-modern' },
        mcpProtocol: 'modern',
      },
      expectedStartFailure: 'only supported for HTTP downstream servers',
    },
  );

  await cleanupTestData();
  await seedServers(serverSpecs);
  const modernToken = await createModernAccessToken(ownerUserId);

  let core;
  if (START_PETA_CORE) {
    core = await startPetaCore();
  } else {
    await waitForHealth(`${BASE_URL}/health`, 'peta-core');
  }

  await startGatewayServer(`${PREFIX}-legacy-stdio-auto`);
  await startGatewayServer(`${PREFIX}-legacy-http-auto`);
  await startGatewayServer(`${PREFIX}-legacy-http-forced`);
  await startGatewayServer(`${PREFIX}-modern-http-auto`);
  await startGatewayServer(`${PREFIX}-modern-http-forced`);
  await expectStartFailure(`${PREFIX}-modern-http-unsupported`, 'does not advertise MCP 2026-07-28');
  await expectStartFailure(`${PREFIX}-stdio-forced-modern`, 'only supported for HTTP downstream servers');

  await verifyDownstreamSelection();
  await verifyLegacyUpstream();
  await verifyModernUpstream(modernToken);
  await verifyModernNegativeCases(modernToken);
  await verifyModernSubscriptionAcknowledgement(modernToken);

  report.completedAt = new Date().toISOString();
  report.ok = report.cases.every((item) => item.ok);
  if (core) {
    report.petaCoreExitCode = core.exitCode ?? null;
  }
} catch (error) {
  report.ok = false;
  report.error = serializeError(error);
  console.error(error);
} finally {
  if (!KEEP_DATA) {
    try {
      await cleanupTestData();
    } catch (error) {
      report.cleanup.push({ ok: false, error: serializeError(error) });
    }
  }
  await prisma.$disconnect();
  for (const child of children.reverse()) {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
    }
  }
  await sleep(500);
  const reportPath = join(repoRoot, 'scripts/compat-smoke/report.json');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, reportPath, baseUrl: BASE_URL, cases: report.cases.length }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

async function verifyDownstreamSelection() {
  await testCase('downstream auto legacy HTTP probes then falls back', async () => {
    const logs = await fixtureLogs('legacy-http-auto');
    const methods = logs.map((entry) => entry.body?.method).filter(Boolean);
    assert(methods.includes('server/discover'), `expected modern probe in ${JSON.stringify(methods)}`);
    assert(methods.includes('initialize'), `expected legacy initialize after fallback in ${JSON.stringify(methods)}`);
    return { methods };
  });

  await testCase('downstream forced legacy HTTP skips modern probe', async () => {
    const logs = await fixtureLogs('legacy-http-forced');
    const methods = logs.map((entry) => entry.body?.method).filter(Boolean);
    assert(!methods.includes('server/discover'), `did not expect modern probe in ${JSON.stringify(methods)}`);
    assert(methods.includes('initialize'), `expected legacy initialize in ${JSON.stringify(methods)}`);
    return { methods };
  });

  await testCase('downstream auto modern HTTP uses modern client', async () => {
    const logs = await fixtureLogs('modern-auto');
    const methods = logs.map((entry) => entry.body?.method).filter(Boolean);
    assert(methods.includes('server/discover'), `expected discover in ${JSON.stringify(methods)}`);
    assert(methods.includes('tools/list'), `expected tools/list in ${JSON.stringify(methods)}`);
    assert(logs.some((entry) => entry.headers['mcp-protocol-version'] === MODERN_VERSION), 'expected modern protocol header');
    return { methods };
  });

  await testCase('downstream forced modern HTTP uses modern client', async () => {
    const logs = await fixtureLogs('modern-forced');
    const methods = logs.map((entry) => entry.body?.method).filter(Boolean);
    assert(methods.includes('server/discover'), `expected discover in ${JSON.stringify(methods)}`);
    assert(methods.includes('tools/list'), `expected tools/list in ${JSON.stringify(methods)}`);
    assert(logs.some((entry) => entry.headers['mcp-protocol-version'] === MODERN_VERSION), 'expected modern protocol header');
    return { methods };
  });
}

async function verifyLegacyUpstream() {
  const init = await legacyRpc('initialize', {
    protocolVersion: LEGACY_VERSION,
    capabilities: {},
    clientInfo: { name: 'compat-smoke-legacy-client', version: '1.0.0' },
  }, { id: 1 });
  await testCase('legacy initialize returns session header', async () => {
    assertLegacyRpcSuccess(init, 1, 'legacy initialize');
    assert(init.headers['mcp-session-id'], 'missing mcp-session-id');
    assert(init.body?.result?.protocolVersion, 'missing initialize result');
    return { sessionId: mask(init.headers['mcp-session-id']), protocolVersion: init.body.result.protocolVersion };
  });

  const sessionId = init.headers['mcp-session-id'];
  await legacyRpc('notifications/initialized', {}, { sessionId, notification: true });
  const list = await legacyRpc('tools/list', {}, { id: 2, sessionId });
  const toolNames = list.body?.result?.tools?.map((tool) => tool.name) ?? [];

  await testCase('legacy tools/list sees all positive compat tools', async () => {
    assertLegacyRpcSuccess(list, 2, 'legacy tools/list');
    for (const original of positiveToolOriginals()) {
      assert(toolNames.some((name) => name.startsWith(`${original}_-_`)), `missing ${original}`);
    }
    return { count: toolNames.length, compatTools: toolNames.filter((name) => name.includes('compat-smoke')) };
  });

  const mixed = await legacyRpc('tools/list', {}, {
    id: 3,
    sessionId,
    headers: {
      'MCP-Protocol-Version': MODERN_VERSION,
      Origin: 'https://attacker.example.test',
    },
  });
  await testCase('legacy valid session tolerates modern-looking header and invalid Origin', async () => {
    assertLegacyRpcSuccess(mixed, 3, 'legacy mixed-era tools/list');
    assert(Array.isArray(mixed.body?.result?.tools), 'missing tools result');
    return { toolCount: mixed.body.result.tools.length };
  });

  const targetTool = findGatewayName(toolNames, 'compat-smoke-modern-auto-tool');
  const call = await legacyRpc('tools/call', {
    name: targetTool,
    arguments: { message: 'legacy-to-modern' },
  }, { id: 4, sessionId });
  await testCase('legacy upstream calls modern downstream tool', async () => {
    assertLegacyRpcSuccess(call, 4, 'legacy tools/call');
    const text = call.body?.result?.content?.[0]?.text ?? '';
    assert(text.includes('modern http tool ok: modern-auto'), `unexpected result: ${text}`);
    return { tool: targetTool, text };
  });

  const resources = await legacyRpc('resources/list', {}, { id: 5, sessionId });
  const resourceUris = resources.body?.result?.resources?.map((resourceItem) => resourceItem.uri) ?? [];
  const modernResource = findGatewayName(resourceUris, 'compat://smoke/modern-auto/resource');
  const read = await legacyRpc('resources/read', { uri: modernResource }, { id: 6, sessionId });
  await testCase('legacy upstream reads modern downstream resource', async () => {
    assertLegacyRpcSuccess(resources, 5, 'legacy resources/list');
    assertLegacyRpcSuccess(read, 6, 'legacy resources/read');
    const text = read.body?.result?.contents?.[0]?.text ?? '';
    assert(text.includes('modern http resource ok: modern-auto'), `unexpected resource result: ${text}`);
    return { uri: modernResource, text };
  });
}

async function verifyModernUpstream(modernToken) {
  const discover = await modernRpc(modernToken, 'server/discover', {}, { id: 101 });
  await testCase('modern server/discover is sessionless', async () => {
    assertJsonRpcSuccess(discover, 101, 'modern server/discover');
    assert(!discover.headers['mcp-session-id'], 'modern response must not include session id');
    assert(discover.body?.result?.supportedVersions?.includes(MODERN_VERSION), 'missing modern version');
    return { supportedVersions: discover.body.result.supportedVersions };
  });

  const list = await modernRpc(modernToken, 'tools/list', {}, { id: 102 });
  const toolNames = list.body?.result?.tools?.map((tool) => tool.name) ?? [];
  await testCase('modern tools/list sees all positive compat tools', async () => {
    assertJsonRpcSuccess(list, 102, 'modern tools/list');
    assert(!list.headers['mcp-session-id'], 'modern tools/list must not include session id');
    for (const original of positiveToolOriginals()) {
      assert(toolNames.some((name) => name.startsWith(`${original}_-_`)), `missing ${original}`);
    }
    return { count: toolNames.length, compatTools: toolNames.filter((name) => name.includes('compat-smoke')) };
  });

  const legacyTool = findGatewayName(toolNames, 'compat-smoke-legacy-stdio-auto-tool');
  const legacyCall = await modernRpc(modernToken, 'tools/call', {
    name: legacyTool,
    arguments: { message: 'modern-to-legacy' },
  }, { id: 103, nameHeader: legacyTool });
  await testCase('modern upstream calls legacy stdio downstream tool', async () => {
    assertJsonRpcSuccess(legacyCall, 103, 'modern legacy tools/call');
    const text = legacyCall.body?.result?.content?.[0]?.text ?? '';
    assert(text.includes('legacy stdio tool ok: legacy-stdio-auto'), `unexpected result: ${text}`);
    return { tool: legacyTool, text };
  });

  const modernTool = findGatewayName(toolNames, 'compat-smoke-modern-forced-tool');
  const modernCall = await modernRpc(modernToken, 'tools/call', {
    name: modernTool,
    arguments: { message: 'modern-to-modern' },
  }, { id: 104, nameHeader: modernTool });
  await testCase('modern upstream calls modern downstream tool', async () => {
    assertJsonRpcSuccess(modernCall, 104, 'modern tools/call');
    const text = modernCall.body?.result?.content?.[0]?.text ?? '';
    assert(text.includes('modern http tool ok: modern-forced'), `unexpected result: ${text}`);
    return { tool: modernTool, text };
  });

  const resources = await modernRpc(modernToken, 'resources/list', {}, { id: 105 });
  const resourceUris = resources.body?.result?.resources?.map((resourceItem) => resourceItem.uri) ?? [];
  const legacyResource = findGatewayName(resourceUris, 'compat://smoke/legacy-http-auto/resource');
  const read = await modernRpc(modernToken, 'resources/read', { uri: legacyResource }, { id: 106, nameHeader: legacyResource });
  await testCase('modern upstream reads legacy downstream resource', async () => {
    assertJsonRpcSuccess(resources, 105, 'modern resources/list');
    assertJsonRpcSuccess(read, 106, 'modern resources/read');
    const text = read.body?.result?.contents?.[0]?.text ?? '';
    assert(text.includes('legacy http resource ok: legacy-http-auto'), `unexpected resource result: ${text}`);
    return { uri: legacyResource, text };
  });
}

async function verifyModernNegativeCases(modernToken) {
  const invalidOrigin = await rawRpc(`${BASE_URL}/mcp`, {
    jsonrpc: '2.0',
    id: 200,
    method: 'tools/list',
    params: modernParams({}),
  }, {
    Authorization: `Bearer ${modernToken}`,
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MODERN_VERSION,
    'Mcp-Method': 'tools/list',
    Origin: 'https://attacker.example.test',
  });
  await testCase('modern invalid Origin is rejected', async () => {
    assertJsonRpcError(invalidOrigin, 403, MODERN_ERROR_CODES.invalidRequest, null, 'modern invalid Origin');
    return { status: invalidOrigin.status, error: invalidOrigin.body.error };
  });

  const invalidMixed = await rawRpc(`${BASE_URL}/mcp`, {
    jsonrpc: '2.0',
    id: 201,
    method: 'tools/list',
    params: modernParams({}),
  }, {
    Authorization: `Bearer ${modernToken}`,
    'MCP-Protocol-Version': MODERN_VERSION,
    'Mcp-Method': 'tools/list',
    'Mcp-Session-Id': 'stale-compat-smoke-session',
  });
  await testCase('invalid mixed-era request fails closed', async () => {
    assertJsonRpcError(invalidMixed, 400, MODERN_ERROR_CODES.invalidRequest, 201, 'mixed-era request');
    return { status: invalidMixed.status, error: invalidMixed.body.error };
  });

  const queryToken = await rawRpc(`${BASE_URL}/mcp?token=${encodeURIComponent(OWNER_TOKEN)}`, {
    jsonrpc: '2.0',
    id: 202,
    method: 'tools/list',
    params: modernParams({}),
  }, {
    'MCP-Protocol-Version': MODERN_VERSION,
    'Mcp-Method': 'tools/list',
  });
  await testCase('modern query token is rejected', async () => {
    assertJsonRpcError(queryToken, 401, MODERN_ERROR_CODES.authFailure, null, 'modern query token');
    return { status: queryToken.status, error: queryToken.body?.error };
  });

  const missingMeta = await rawRpc(`${BASE_URL}/mcp`, {
    jsonrpc: '2.0',
    id: 203,
    method: 'tools/list',
    params: {},
  }, {
    Authorization: `Bearer ${modernToken}`,
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MODERN_VERSION,
    'Mcp-Method': 'tools/list',
  });
  await testCase('modern missing _meta is rejected', async () => {
    assertJsonRpcError(missingMeta, 400, MODERN_ERROR_CODES.invalidParams, 203, 'modern missing _meta');
    return { status: missingMeta.status, error: missingMeta.body.error };
  });

  const future = await rawRpc(`${BASE_URL}/mcp`, {
    jsonrpc: '2.0',
    id: 204,
    method: 'tools/list',
    params: modernParams({}, '2027-01-01'),
  }, {
    Authorization: `Bearer ${modernToken}`,
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2027-01-01',
    'Mcp-Method': 'tools/list',
  });
  await testCase('future modern version is rejected', async () => {
    assertJsonRpcError(future, 400, MODERN_ERROR_CODES.unsupportedProtocolVersion, 204, 'future modern version');
    return { status: future.status, error: future.body.error };
  });
}

async function verifyModernSubscriptionAcknowledgement(modernToken) {
  const acknowledgement = await modernSseRpc(modernToken, 'subscriptions/listen', {
    notifications: { toolsListChanged: true },
  }, { id: 107 });
  await testCase('modern subscription acknowledgement is SSE-correlated', async () => {
    assertSseContentType(acknowledgement, 'modern subscriptions/listen');
    assert(acknowledgement.status === 200, `modern subscriptions/listen status ${acknowledgement.status}`);
    assert(acknowledgement.body?.jsonrpc === '2.0', 'modern subscriptions/listen must return JSON-RPC SSE data');
    assert(acknowledgement.body?.method === 'notifications/subscriptions/acknowledged', 'missing subscription acknowledgement');
    assert(
      acknowledgement.body?.params?._meta?.['io.modelcontextprotocol/subscriptionId'] === 107,
      `unexpected subscription id: ${JSON.stringify(acknowledgement.body)}`,
    );
    assert(acknowledgement.body?.params?.notifications?.toolsListChanged === true, 'missing acknowledged toolsListChanged filter');
    return { subscriptionId: 107, notification: acknowledgement.body.params.notifications };
  });
}

function positiveToolOriginals() {
  return [
    'compat-smoke-legacy-stdio-auto-tool',
    'compat-smoke-legacy-http-auto-tool',
    'compat-smoke-legacy-http-forced-tool',
    'compat-smoke-modern-auto-tool',
    'compat-smoke-modern-forced-tool',
  ];
}

async function startGatewayServer(serverId) {
  await testCase(`start gateway server ${serverId}`, async () => {
    const result = await admin(2001, { targetId: serverId });
    assert(result.status === 200, `admin status ${result.status}`);
    assert(result.body?.success === true, `admin failed: ${JSON.stringify(result.body)}`);
    return result.body;
  });
}

async function expectStartFailure(serverId, expectedMessage) {
  await testCase(`start failure ${serverId}`, async () => {
    const result = await admin(2001, { targetId: serverId });
    assert(result.status >= 400, `expected failure, got ${result.status}`);
    const message = result.body?.error?.message ?? '';
    assert(message.includes(expectedMessage), `expected ${expectedMessage}, got ${message}`);
    return { status: result.status, message };
  });
}

async function admin(action, data = {}) {
  return rawRpc(`${BASE_URL}/admin`, { action, data }, {
    Authorization: `Bearer ${OWNER_TOKEN}`,
  });
}

async function legacyRpc(method, params, options = {}) {
  const body = options.notification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: options.id ?? 1, method, params };
  const headers = {
    Authorization: `Bearer ${OWNER_TOKEN}`,
    Accept: 'application/json, text/event-stream',
    ...(options.sessionId ? { 'Mcp-Session-Id': options.sessionId } : {}),
    ...(options.headers ?? {}),
  };
  return rawRpc(`${BASE_URL}/mcp`, body, headers);
}

async function modernRpc(token, method, params, options = {}) {
  return rawRpc(`${BASE_URL}/mcp`, {
    jsonrpc: '2.0',
    id: options.id ?? 1,
    method,
    params: modernParams(params),
  }, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MODERN_VERSION,
    'Mcp-Method': method,
    ...(options.nameHeader ? { 'Mcp-Name': options.nameHeader } : {}),
  });
}

async function modernSseRpc(token, method, params, options = {}) {
  const controller = new AbortController();
  try {
    const response = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': MODERN_VERSION,
        'Mcp-Method': method,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: options.id ?? 1,
        method,
        params: modernParams(params),
      }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    assert(reader, 'modern SSE response has no body');
    const { value } = await reader.read();
    const raw = new TextDecoder().decode(value);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: parseRpcBody(raw, response.headers.get('content-type') ?? ''),
      raw,
    };
  } finally {
    controller.abort();
  }
}

function modernParams(params, version = MODERN_VERSION) {
  return {
    ...params,
    _meta: {
      ...(params?._meta ?? {}),
      'io.modelcontextprotocol/protocolVersion': version,
      'io.modelcontextprotocol/clientInfo': { name: 'compat-smoke-modern-client', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  };
}

async function rawRpc(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const responseHeaders = Object.fromEntries(response.headers.entries());
  const text = await response.text();
  return {
    status: response.status,
    headers: responseHeaders,
    body: parseRpcBody(text, responseHeaders['content-type']),
    raw: text,
  };
}

function parseRpcBody(text, contentType = '') {
  if (!text) {
    return null;
  }
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice('data:'.length).trim();
      if (!payload) {
        continue;
      }
      return JSON.parse(payload);
    }
    return { sse: text };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function assertJsonRpcSuccess(response, id, label) {
  assert(response.status === 200, `${label} status ${response.status}`);
  assertJsonContentType(response, label);
  assert(response.body?.jsonrpc === '2.0', `${label} must return JSON-RPC 2.0`);
  assert(response.body?.id === id, `${label} response id ${JSON.stringify(response.body?.id)} does not match ${id}`);
}

function assertLegacyRpcSuccess(response, id, label) {
  assert(response.status === 200, `${label} status ${response.status}`);
  assertSseContentType(response, label);
  assert(response.body?.jsonrpc === '2.0', `${label} must return JSON-RPC 2.0`);
  assert(response.body?.id === id, `${label} response id ${JSON.stringify(response.body?.id)} does not match ${id}`);
}

function assertJsonRpcError(response, status, code, id, label) {
  assert(response.status === status, `${label} status ${response.status}, expected ${status}`);
  assertJsonContentType(response, label);
  assert(response.body?.jsonrpc === '2.0', `${label} must return JSON-RPC 2.0`);
  assert(response.body?.id === id, `${label} error id ${JSON.stringify(response.body?.id)} does not match ${id}`);
  assert(response.body?.error?.code === code, `${label} error code ${response.body?.error?.code}, expected ${code}`);
}

function assertJsonContentType(response, label) {
  assert(
    response.headers['content-type']?.split(';', 1)[0]?.toLowerCase() === 'application/json',
    `${label} content type ${response.headers['content-type']}`,
  );
}

function assertSseContentType(response, label) {
  assert(
    response.headers['content-type']?.split(';', 1)[0]?.toLowerCase() === 'text/event-stream',
    `${label} content type ${response.headers['content-type']}`,
  );
}

async function testCase(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const item = { name, ok: true, durationMs: Date.now() - started, detail };
    report.cases.push(item);
    console.log(`PASS ${name}`);
    return item;
  } catch (error) {
    const item = { name, ok: false, durationMs: Date.now() - started, error: serializeError(error) };
    report.cases.push(item);
    console.error(`FAIL ${name}: ${item.error.message}`);
    throw error;
  }
}

async function seedServers(specs) {
  for (const spec of specs) {
    const launchConfig = JSON.stringify(await encryptData(JSON.stringify(spec.launchConfig), OWNER_TOKEN));
    await prisma.server.upsert({
      where: { serverId: spec.id },
      update: {
        serverName: spec.name,
        enabled: true,
        launchConfig,
        capabilities: '{}',
        allowUserInput: false,
        configTemplate: '',
        proxyId: 0,
        authType: 1,
        category: spec.launchConfig.command ? 5 : 2,
        publicAccess: true,
        usePetaOauthConfig: true,
        transportType: null,
        lazyStartEnabled: false,
        cachedTools: null,
        cachedResources: null,
        cachedResourceTemplates: null,
        cachedPrompts: null,
      },
      create: {
        serverId: spec.id,
        serverName: spec.name,
        enabled: true,
        launchConfig,
        capabilities: '{}',
        createdAt: epochSeconds(),
        updatedAt: epochSeconds(),
        allowUserInput: false,
        configTemplate: '',
        proxyId: 0,
        authType: 1,
        category: spec.launchConfig.command ? 5 : 2,
        publicAccess: true,
        usePetaOauthConfig: true,
        transportType: null,
        lazyStartEnabled: false,
      },
    });
  }
}

async function ensureOwnerUser(userId) {
  const existing = await prisma.user.findUnique({ where: { userId } });
  if (existing) {
    return;
  }
  await prisma.user.create({
    data: {
      userId,
      status: 1,
      role: 1,
      permissions: '{}',
      userPreferences: '{}',
      launchConfigs: '{}',
      expiresAt: 0,
      createdAt: epochSeconds(),
      updatedAt: epochSeconds(),
      ratelimit: 1000,
      name: 'Compat Smoke Owner',
      encryptedToken: null,
      proxyId: 0,
    },
  });
  report.cleanup.push({ createdOwnerUser: userId });
}

async function createModernAccessToken(userId) {
  await prisma.oAuthClient.upsert({
    where: { clientId: oauthClientId },
    update: {
      name: 'Compat Smoke Client',
      redirectUris: ['http://localhost/callback'],
      scopes: ['mcp:tools', 'mcp:resources', 'mcp:prompts'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      trusted: true,
      userId,
    },
    create: {
      clientId: oauthClientId,
      issuer: 'default',
      clientSecret: null,
      applicationType: 'web',
      tokenEndpointAuthMethod: 'none',
      name: 'Compat Smoke Client',
      redirectUris: ['http://localhost/callback'],
      scopes: ['mcp:tools', 'mcp:resources', 'mcp:prompts'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      trusted: true,
      userId,
    },
  });

  await prisma.oAuthToken.deleteMany({ where: { clientId: oauthClientId } });
  const now = Math.floor(Date.now() / 1000);
  const accessToken = jwt.sign({
    type: 'access_token',
    client_id: oauthClientId,
    user_id: userId,
    scopes: ['mcp:tools', 'mcp:resources', 'mcp:prompts'],
    aud: resource,
    iat: now,
    exp: now + 3600,
  }, JWT_SECRET);

  await prisma.oAuthToken.create({
    data: {
      accessToken,
      refreshToken: null,
      clientId: oauthClientId,
      userId,
      scopes: ['mcp:tools', 'mcp:resources', 'mcp:prompts'],
      resource,
      accessTokenExpiresAt: new Date((now + 3600) * 1000),
      refreshTokenExpiresAt: null,
      revoked: false,
    },
  });
  return accessToken;
}

async function cleanupTestData() {
  await prisma.oAuthToken.deleteMany({ where: { clientId: oauthClientId } });
  await prisma.oAuthAuthorizationCode.deleteMany({ where: { clientId: oauthClientId } });
  await prisma.oAuthClient.deleteMany({ where: { clientId: oauthClientId } });
  await prisma.server.deleteMany({ where: { serverId: { startsWith: `${PREFIX}-` } } });
  report.cleanup.push({ ok: true, action: 'delete compat oauth and server records' });
}

async function startPetaCore() {
  const child = spawn('npm', ['run', 'dev:backend-only'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      BACKEND_PORT: String(BACKEND_PORT),
      BACKEND_HTTPS_PORT: String(BACKEND_PORT),
      MCP_2026_ENABLED: 'true',
      MCP_2026_DOWNSTREAM_ENABLED: 'true',
      MCP_2026_SUPPORTED_VERSIONS: MODERN_VERSION,
      PETA_AUTH_AUTOSTART: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (data) => collectCoreLog(data));
  child.stderr.on('data', (data) => collectCoreLog(data));
  child.on('exit', (code, signal) => {
    report.petaCoreExit = { code, signal };
  });
  await waitForHealth(`${BASE_URL}/health`, 'peta-core');
  return child;
}

function collectCoreLog(data) {
  const text = data.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    report.petaCoreLogs.push(line.slice(0, 1000));
  }
  if (report.petaCoreLogs.length > 200) {
    report.petaCoreLogs.splice(0, report.petaCoreLogs.length - 200);
  }
}

async function startFixture(fixtureId, file, port, extraEnv = {}) {
  const child = spawn(process.execPath, [join(repoRoot, 'scripts/compat-smoke/fixtures', file)], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), FIXTURE_ID: fixtureId, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const logs = [];
  child.stdout.on('data', (data) => logs.push(data.toString()));
  child.stderr.on('data', (data) => logs.push(data.toString()));
  child.on('exit', (code, signal) => logs.push(`exit ${code ?? ''} ${signal ?? ''}`));
  await waitForHealth(`http://127.0.0.1:${port}/health`, `fixture ${fixtureId}`);
  const health = await fetchJson(`http://127.0.0.1:${port}/health`);
  return { ...health, port, logsPreview: logs.join('').slice(0, 1000) };
}

async function fixtureLogs(fixtureId) {
  const spec = serverSpecs.find((candidate) => candidate.fixtureId === fixtureId);
  assert(spec?.logUrl, `No log URL for fixture ${fixtureId}`);
  const body = await fetchJson(spec.logUrl);
  return body.logs ?? [];
}

async function waitForHealth(url, label) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${label} health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`${label} did not become healthy at ${url}: ${lastError?.message ?? lastError}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
    server.on('error', reject);
  });
}

async function calculateUserId(token) {
  const hash = await hashHex(token);
  return hash.substring(0, 32);
}

async function hashHex(data) {
  const buffer = new TextEncoder().encode(data);
  const digest = await webcrypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptData(data, key) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const cryptoKey = await deriveKey(key, salt);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(data));
  const encryptedArray = new Uint8Array(encryptedBuffer);
  const encryptedData = encryptedArray.slice(0, -16);
  const tag = encryptedArray.slice(-16);
  return {
    data: Buffer.from(encryptedData).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    salt: Buffer.from(salt).toString('base64'),
    tag: Buffer.from(tag).toString('base64'),
  };
}

async function deriveKey(password, salt) {
  const baseKey = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return webcrypto.subtle.deriveKey({
    name: 'PBKDF2',
    salt,
    iterations: 100000,
    hash: 'SHA-256',
  }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function findGatewayName(names, original) {
  const value = names.find((name) => typeof name === 'string' && name.startsWith(`${original}_-_`));
  assert(value, `missing gateway name for ${original}; got ${JSON.stringify(names.filter((name) => String(name).includes('compat-smoke')))}`);
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function mask(value) {
  if (!value || value.length < 12) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasArg(name) {
  return process.argv.includes(name);
}

function failUsage(message) {
  console.error(`${message}\nUsage: PETA_COMPAT_OWNER_TOKEN=... node scripts/compat-smoke/run.mjs [--backend-port 3002] [--no-start-core] [--keep-data]`);
  process.exit(2);
}
