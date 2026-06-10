import http from 'node:http';

const port = Number(process.env.PORT || 43102);
const fixtureId = process.env.FIXTURE_ID || 'modern-http';
const unsupported = process.env.UNSUPPORTED_MODERN === 'true';
const toolName = `compat-smoke-${fixtureId}-tool`;
const resourceName = `compat-smoke-${fixtureId}-resource`;
const resourceUri = `compat://smoke/${fixtureId}/resource`;
const promptName = `compat-smoke-${fixtureId}-prompt`;
const logs = [];

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function result(id, value) {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function record(req, body) {
  logs.push({
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: {
      'mcp-session-id': req.headers['mcp-session-id'],
      'mcp-protocol-version': req.headers['mcp-protocol-version'],
      'mcp-method': req.headers['mcp-method'],
      'mcp-name': req.headers['mcp-name'],
      accept: req.headers.accept,
    },
    body,
  });
}

function discoverResult() {
  return {
    supportedVersions: unsupported ? ['2025-11-25'] : ['2026-07-28'],
    serverInfo: { name: `compat-smoke-${fixtureId}`, version: '1.0.0' },
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
    },
  };
}

function handleRpc(body) {
  const method = body?.method;
  const id = body?.id ?? null;
  switch (method) {
    case 'server/discover':
      return result(id, discoverResult());
    case 'tools/list':
      return result(id, {
        tools: [{
          name: toolName,
          description: `Modern fixture tool ${fixtureId}`,
          inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        }],
      });
    case 'tools/call':
      return result(id, {
        content: [{
          type: 'text',
          text: `modern http tool ok: ${fixtureId}; name=${body.params?.name}; message=${body.params?.arguments?.message ?? ''}`,
        }],
      });
    case 'resources/list':
      return result(id, {
        resources: [{
          uri: resourceUri,
          name: resourceName,
          mimeType: 'text/plain',
          description: `Modern fixture resource ${fixtureId}`,
        }],
      });
    case 'resources/templates/list':
      return result(id, { resourceTemplates: [] });
    case 'resources/read':
      return result(id, {
        contents: [{
          uri: body.params?.uri ?? resourceUri,
          mimeType: 'text/plain',
          text: `modern http resource ok: ${fixtureId}; uri=${body.params?.uri ?? ''}`,
        }],
      });
    case 'prompts/list':
      return result(id, {
        prompts: [{
          name: promptName,
          description: `Modern fixture prompt ${fixtureId}`,
          arguments: [],
        }],
      });
    case 'prompts/get':
      return result(id, {
        messages: [{
          role: 'user',
          content: { type: 'text', text: `modern http prompt ok: ${fixtureId}; name=${body.params?.name ?? ''}` },
        }],
      });
    case 'ping':
      return result(id, {});
    default:
      return error(id, -32601, `Unknown method: ${method}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { ok: true, fixtureId, unsupported, toolName, resourceUri, promptName });
      return;
    }
    if (req.method === 'GET' && req.url === '/logs') {
      json(res, 200, { logs });
      return;
    }
    if (req.method === 'POST' && req.url === '/reset') {
      logs.length = 0;
      json(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      json(res, 404, { error: 'not found' });
      return;
    }

    const body = await readBody(req);
    record(req, body);
    json(res, 200, handleRpc(body));
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, () => {
  console.log(JSON.stringify({ event: 'ready', fixture: 'modern-http', fixtureId, unsupported, port, toolName, resourceUri, promptName }));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
