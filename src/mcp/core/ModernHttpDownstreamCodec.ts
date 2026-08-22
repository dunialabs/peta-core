import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

export type JsonObject = Record<string, unknown>;

export type JsonRpcId = string | number;
export type HeaderAnnotation = { readonly headerName: string; readonly path: readonly string[] };
export type JsonRpcResponse<T> =
  | { readonly result: T; readonly error?: never }
  | { readonly result?: never; readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isImplementation(value: unknown): value is Implementation {
  return isJsonObject(value) && typeof value.name === 'string' && typeof value.version === 'string';
}

export function encodeHeaderValue(value: string): string {
  const plainAscii = /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
  return plainAscii && !/^=\?base64\?.*\?=$/.test(value)
    ? value
    : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function headerAnnotations(schema: JsonObject, path: readonly string[] = [], seen = new Set<string>()): HeaderAnnotation[] | undefined {
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const annotations: HeaderAnnotation[] = [];
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (!isJsonObject(propertySchema)) {
      continue;
    }
    const childPath = [...path, propertyName];
    const suffix = propertySchema['x-mcp-header'];
    if (suffix !== undefined) {
      const headerName = typeof suffix === 'string' ? `Mcp-Param-${suffix}` : '';
      const normalized = headerName.toLowerCase();
      if ((propertySchema.type !== 'string' && propertySchema.type !== 'integer' && propertySchema.type !== 'boolean')
        || !/^Mcp-Param-[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(headerName) || seen.has(normalized)) {
        return undefined;
      }
      seen.add(normalized);
      annotations.push({ headerName, path: childPath });
    }
    const nested = headerAnnotations(propertySchema, childPath, seen);
    if (nested === undefined) {
      return undefined;
    }
    annotations.push(...nested);
  }
  return annotations;
}

export function toolHeaderValues(schema: JsonObject | undefined, args: JsonObject): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const annotation of schema ? headerAnnotations(schema) ?? [] : []) {
    let value: unknown = args;
    for (const segment of annotation.path) {
      value = isJsonObject(value) ? value[segment] : undefined;
    }
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isInteger(value))) {
      headers[annotation.headerName] = encodeHeaderValue(String(value));
    }
  }
  return headers;
}

export function createRequestBody(
  params: JsonObject,
  id: JsonRpcId,
  method: string,
  protocolVersion: string,
  clientInfo: { readonly name: string; readonly version: string },
): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        ...(isJsonObject(params._meta) ? params._meta : {}),
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
        'io.modelcontextprotocol/clientInfo': clientInfo,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

export async function readJsonRpcResponse<T>(response: Response, expectedId: JsonRpcId): Promise<JsonRpcResponse<T>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('text/event-stream')) {
    if (!response.body) {
      throw new Error('Modern downstream SSE response did not include a body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let boundary = /(?:\r\n|\r|\n){2}/.exec(buffer);
        while (boundary) {
          const result = parseSseEvent<T>(buffer.slice(0, boundary.index), expectedId);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (result) {
            return result;
          }
          boundary = /(?:\r\n|\r|\n){2}/.exec(buffer);
        }
        if (done) {
          const result = parseSseEvent<T>(buffer, expectedId);
          if (result) {
            return result;
          }
          break;
        }
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    throw new Error('Modern downstream response did not include a matching JSON-RPC response');
  }

  let candidate: unknown;
  try {
    candidate = await response.json();
  } catch {
    throw new Error('Modern downstream response was not valid JSON');
  }
  const result = parseJsonRpcCandidate<T>(candidate, expectedId);
  if (!result) {
    throw new Error('Modern downstream response did not include a matching JSON-RPC response');
  }
  return result;
}

function parseSseEvent<T>(event: string, expectedId: JsonRpcId): JsonRpcResponse<T> | undefined {
  const data = event
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
  if (data.length === 0) {
    return undefined;
  }
  try {
    return parseJsonRpcCandidate<T>(JSON.parse(data), expectedId);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Modern downstream SSE response included malformed JSON');
    }
    throw error;
  }
}

function parseJsonRpcCandidate<T>(candidate: unknown, expectedId: JsonRpcId): JsonRpcResponse<T> | undefined {
  if (!isJsonObject(candidate) || candidate.id !== expectedId) {
    return undefined;
  }
  if (candidate.jsonrpc !== '2.0') {
    throw new Error('Modern downstream response was malformed');
  }
  const hasResult = Object.prototype.hasOwnProperty.call(candidate, 'result');
  const error = candidate.error;
  const hasError = isJsonObject(error);
  if (hasResult === hasError) {
    throw new Error('Modern downstream response was malformed');
  }
  if (hasResult) {
    return { result: candidate.result as T };
  }
  if (!hasError) {
    throw new Error('Modern downstream response was malformed');
  }
  if (typeof error.code !== 'number' || typeof error.message !== 'string') {
    throw new Error('Modern downstream error response was malformed');
  }
  return { error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } };
}
