import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type CompleteResult,
  type GetPromptResult,
  type Implementation,
  type ListPromptsResult,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import { APP_INFO } from '../../config/config.js';
import { MODERN_MCP_PROTOCOL_VERSION } from '../../config/modernMcp.config.js';
import type { DownstreamMcpClient } from './DownstreamMcpClient.js';

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

export interface ModernHttpDownstreamClientOptions {
  url: URL;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface ModernDiscoverResult extends JsonObject {
  capabilities?: ServerCapabilities;
  serverInfo?: Implementation;
}

export class ModernHttpDownstreamClient implements DownstreamMcpClient {
  readonly protocolEra = 'modern' as const;
  private nextId = 1;
  private capabilities: ServerCapabilities;
  private serverInfo: Implementation | undefined;

  private constructor(
    private readonly options: Required<ModernHttpDownstreamClientOptions>,
    discoverResult: ModernDiscoverResult,
  ) {
    this.capabilities = discoverResult.capabilities ?? { tools: {}, resources: {}, prompts: {} };
    this.serverInfo = discoverResult.serverInfo;
  }

  static async connect(options: ModernHttpDownstreamClientOptions): Promise<ModernHttpDownstreamClient> {
    const normalized: Required<ModernHttpDownstreamClientOptions> = {
      headers: options.headers ?? {},
      timeoutMs: options.timeoutMs ?? 10_000,
      url: options.url,
    };
    const discoverResult = await ModernHttpDownstreamClient.sendRequest<ModernDiscoverResult>(
      normalized,
      'server/discover',
      {},
    );
    if (!Array.isArray(discoverResult.supportedVersions) || !discoverResult.supportedVersions.includes(MODERN_MCP_PROTOCOL_VERSION)) {
      throw new Error(`Downstream server does not advertise MCP ${MODERN_MCP_PROTOCOL_VERSION}`);
    }
    return new ModernHttpDownstreamClient(normalized, discoverResult);
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return this.capabilities;
  }

  getServerVersion(): Implementation | undefined {
    return this.serverInfo;
  }

  async ping(): Promise<unknown> {
    return this.request('server/discover', {});
  }

  async close(): Promise<void> {
    // Stateless modern HTTP has no protocol session to close.
  }

  listTools(): Promise<ListToolsResult> {
    return this.request<ListToolsResult>('tools/list', {});
  }

  callTool(params: JsonObject): Promise<CallToolResult | unknown> {
    return this.request('tools/call', params, this.headerNameFromParams(params, 'name'));
  }

  listResources(): Promise<ListResourcesResult> {
    return this.request<ListResourcesResult>('resources/list', {});
  }

  listResourceTemplates(): Promise<ListResourceTemplatesResult> {
    return this.request<ListResourceTemplatesResult>('resources/templates/list', {});
  }

  readResource(params: JsonObject): Promise<ReadResourceResult> {
    return this.request<ReadResourceResult>('resources/read', params, this.headerNameFromParams(params, 'uri'));
  }

  listPrompts(): Promise<ListPromptsResult> {
    return this.request<ListPromptsResult>('prompts/list', {});
  }

  getPrompt(params: JsonObject): Promise<GetPromptResult> {
    return this.request<GetPromptResult>('prompts/get', params, this.headerNameFromParams(params, 'name'));
  }

  complete(params: JsonObject): Promise<CompleteResult> {
    return this.request<CompleteResult>('completion/complete', params);
  }

  async subscribeResource(): Promise<unknown> {
    throw new McpError(ErrorCode.MethodNotFound, 'Modern HTTP downstream resource subscriptions are not supported yet');
  }

  async unsubscribeResource(): Promise<unknown> {
    throw new McpError(ErrorCode.MethodNotFound, 'Modern HTTP downstream resource subscriptions are not supported yet');
  }

  async notification(): Promise<void> {
    // Stateless modern HTTP downstream cancellation/progress notification bridging is not available yet.
  }

  setNotificationHandler(): void {
    // Modern downstream notifications require subscriptions/listen and are not bridged in this slice.
  }

  async sendRootsListChanged(): Promise<void> {
    // Shared downstream reverse-request roots are not bridged for modern HTTP downstreams.
  }

  private request<T>(method: string, params: JsonObject, nameHeader?: string): Promise<T> {
    return ModernHttpDownstreamClient.sendRequest<T>(this.options, method, params, nameHeader, this.nextRequestId());
  }

  private nextRequestId(): JsonRpcId {
    return this.nextId++;
  }

  private headerNameFromParams(params: JsonObject, key: 'name' | 'uri'): string | undefined {
    const value = params[key];
    return typeof value === 'string' ? value : undefined;
  }

  private static async sendRequest<T>(
    options: Required<ModernHttpDownstreamClientOptions>,
    method: string,
    params: JsonObject,
    nameHeader?: string,
    id: JsonRpcId = 0,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          ...options.headers,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': MODERN_MCP_PROTOCOL_VERSION,
          'Mcp-Method': method,
          ...(nameHeader ? { 'Mcp-Name': nameHeader } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params: {
            ...params,
            _meta: {
              ...(ModernHttpDownstreamClient.isJsonObject(params._meta) ? params._meta : {}),
              'io.modelcontextprotocol/protocolVersion': MODERN_MCP_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientInfo': { name: APP_INFO.name, version: APP_INFO.version },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Modern downstream HTTP ${response.status}: ${await response.text()}`);
      }

      const body = await ModernHttpDownstreamClient.readJsonRpcResponse<T>(response);
      if (body.error) {
        throw new McpError(
          typeof body.error.code === 'number' ? body.error.code : ErrorCode.InternalError,
          body.error.message ?? 'Modern downstream request failed',
        );
      }
      return body.result as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private static isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static async readJsonRpcResponse<T>(response: Response): Promise<{ result?: T; error?: { code?: number; message?: string } }> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      return await response.json() as { result?: T; error?: { code?: number; message?: string } };
    }

    const text = await response.text();
    const dataLine = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('data:'));
    if (!dataLine) {
      throw new Error('Modern downstream SSE response did not include a data event');
    }
    return JSON.parse(dataLine.slice('data:'.length).trim()) as { result?: T; error?: { code?: number; message?: string } };
  }
}
