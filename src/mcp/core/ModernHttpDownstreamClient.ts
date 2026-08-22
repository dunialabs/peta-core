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
import { MODERN_MCP_CONFIG, MODERN_MCP_PROTOCOL_VERSION } from '../../config/modernMcp.config.js';
import type { DownstreamMcpClient } from './DownstreamMcpClient.js';
import {
  createRequestBody,
  encodeHeaderValue,
  headerAnnotations,
  isImplementation,
  isJsonObject,
  readJsonRpcResponse,
  toolHeaderValues,
  type JsonObject,
  type JsonRpcId,
} from './ModernHttpDownstreamCodec.js';

type NormalizedOptions = Required<ModernHttpDownstreamClientOptions> & { protocolVersion: string };

export interface ModernHttpDownstreamClientOptions {
  url: URL;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface ModernDiscoverResult extends JsonObject {
  capabilities?: ServerCapabilities;
  serverInfo?: Implementation;
  _meta?: JsonObject;
}

export class ModernHttpDownstreamClient implements DownstreamMcpClient {
  readonly protocolEra = 'modern' as const;
  private nextId = 1;
  private capabilities: ServerCapabilities;
  private serverInfo: Implementation | undefined;
  private readonly toolInputSchemas = new Map<string, JsonObject>();

  private constructor(
    private readonly options: NormalizedOptions,
    discoverResult: ModernDiscoverResult,
  ) {
    const capabilities = discoverResult.capabilities ?? { tools: {}, resources: {}, prompts: {} };
    if (capabilities.resources?.subscribe === true) {
      const resources = { ...capabilities.resources };
      delete resources.subscribe;
      this.capabilities = { ...capabilities, resources };
    } else {
      this.capabilities = capabilities;
    }
    this.serverInfo = discoverResult.serverInfo;
  }

  static async connect(options: ModernHttpDownstreamClientOptions): Promise<ModernHttpDownstreamClient> {
    const normalized: NormalizedOptions = {
      headers: { ...options.headers },
      protocolVersion: MODERN_MCP_PROTOCOL_VERSION,
      timeoutMs: options.timeoutMs ?? 10_000,
      url: options.url,
    };
    let discoverResult: ModernDiscoverResult;
    try {
      discoverResult = await ModernHttpDownstreamClient.sendRequest(normalized, 'server/discover', {});
    } catch (error) {
      const supported = error instanceof McpError && error.code === -32022 && isJsonObject(error.data)
        ? error.data.supported
        : undefined;
      const mutuallySupported = Array.isArray(supported)
        ? MODERN_MCP_CONFIG.supportedVersions.find((version) => supported.includes(version))
        : undefined;
      if (!mutuallySupported) {
        throw error;
      }
      normalized.protocolVersion = mutuallySupported;
      discoverResult = await ModernHttpDownstreamClient.sendRequest(normalized, 'server/discover', {});
    }
    if (!Array.isArray(discoverResult.supportedVersions) || !discoverResult.supportedVersions.includes(normalized.protocolVersion)) {
      throw new Error(`Downstream server does not advertise MCP ${normalized.protocolVersion}`);
    }
    const canonicalServerInfo = discoverResult._meta?.['io.modelcontextprotocol/serverInfo'];
    const serverInfo = isImplementation(canonicalServerInfo)
      ? canonicalServerInfo
      : discoverResult.serverInfo;
    return new ModernHttpDownstreamClient(normalized, { ...discoverResult, serverInfo });
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

  async listTools(): Promise<ListToolsResult> {
    const result = await this.request<ListToolsResult>('tools/list', {});
    return {
      ...result,
      tools: result.tools.filter((tool) => {
        const inputSchema = isJsonObject(tool.inputSchema) ? tool.inputSchema : undefined;
        if (!inputSchema) {
          this.toolInputSchemas.delete(tool.name);
          return true;
        }
        if (headerAnnotations(inputSchema) === undefined) {
          this.toolInputSchemas.delete(tool.name);
          return false;
        }
        this.toolInputSchemas.set(tool.name, inputSchema);
        return true;
      }),
    };
  }

  callTool(params: JsonObject): Promise<CallToolResult | unknown> {
    return this.request('tools/call', params, this.headerNameFromParams(params, 'name'), this.toolHeaders(params));
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

  async notification(notification: unknown): Promise<void> {
    if (!isJsonObject(notification) || notification.method !== 'notifications/token/update') {
      return;
    }
    const params = notification.params;
    if (isJsonObject(params) && typeof params.token === 'string') {
      this.options.headers.Authorization = `Bearer ${params.token}`;
    }
  }

  setNotificationHandler(): void {
    // Modern downstream notifications require subscriptions/listen and are not bridged in this slice.
  }

  async sendRootsListChanged(): Promise<void> {
    // Shared downstream reverse-request roots are not bridged for modern HTTP downstreams.
  }

  private request<T>(method: string, params: JsonObject, nameHeader?: string, headers: Record<string, string> = {}): Promise<T> {
    return ModernHttpDownstreamClient.sendRequest<T>(this.options, method, params, nameHeader, this.nextRequestId(), headers);
  }

  private nextRequestId(): JsonRpcId {
    return this.nextId++;
  }

  private headerNameFromParams(params: JsonObject, key: 'name' | 'uri'): string | undefined {
    const value = params[key];
    return typeof value === 'string' ? value : undefined;
  }

  private toolHeaders(params: JsonObject): Record<string, string> {
    const name = params.name;
    const schema = typeof name === 'string' ? this.toolInputSchemas.get(name) : undefined;
    return toolHeaderValues(schema, isJsonObject(params.arguments) ? params.arguments : {});
  }

  private static async sendRequest<T>(
    options: NormalizedOptions,
    method: string,
    params: JsonObject,
    nameHeader?: string,
    id: JsonRpcId = 0,
    customHeaders: Record<string, string> = {},
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
          'MCP-Protocol-Version': options.protocolVersion,
          'Mcp-Method': method,
          ...(nameHeader === undefined ? {} : { 'Mcp-Name': encodeHeaderValue(nameHeader) }),
          ...customHeaders,
        },
        body: JSON.stringify(createRequestBody(params, id, method, options.protocolVersion, APP_INFO)),
        signal: controller.signal,
      });

      const body = await readJsonRpcResponse<T>(response, id).catch(async (error) => {
        if (!response.ok) {
          throw new Error(`Modern downstream HTTP ${response.status}: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      });
      if (body.error) {
        throw new McpError(
          body.error.code,
          body.error.message,
          body.error.data,
        );
      }
      if (!response.ok) {
        throw new Error(`Modern downstream HTTP ${response.status}`);
      }
      return body.result;
    } finally {
      clearTimeout(timeout);
    }
  }

}
