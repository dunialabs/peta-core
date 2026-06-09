import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  CallToolResult,
  CompleteResult,
  GetPromptResult,
  Implementation,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';

export type DownstreamProtocolEra = 'legacy' | 'modern';

export interface DownstreamMcpClient {
  readonly protocolEra: DownstreamProtocolEra;
  readonly legacyClient?: Client;

  getServerCapabilities(): ServerCapabilities | undefined;
  getServerVersion(): Implementation | undefined;
  ping(options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;

  listTools(params?: Record<string, unknown>, options?: unknown): Promise<ListToolsResult>;
  callTool(params: Record<string, unknown>, resultSchema?: unknown, options?: unknown): Promise<CallToolResult | unknown>;
  listResources(params?: Record<string, unknown>, options?: unknown): Promise<ListResourcesResult>;
  listResourceTemplates(params?: Record<string, unknown>, options?: unknown): Promise<ListResourceTemplatesResult>;
  readResource(params: Record<string, unknown>, options?: unknown): Promise<ReadResourceResult>;
  listPrompts(params?: Record<string, unknown>, options?: unknown): Promise<ListPromptsResult>;
  getPrompt(params: Record<string, unknown>, options?: unknown): Promise<GetPromptResult>;
  complete(params: Record<string, unknown>, options?: unknown): Promise<CompleteResult>;
  subscribeResource(params: Record<string, unknown>, options?: unknown): Promise<unknown>;
  unsubscribeResource(params: Record<string, unknown>, options?: unknown): Promise<unknown>;

  notification(notification: unknown, options?: unknown): Promise<void>;
  setNotificationHandler(schema: unknown, handler: (...args: any[]) => Promise<void> | void): void;
  sendRootsListChanged(): Promise<void>;
}
