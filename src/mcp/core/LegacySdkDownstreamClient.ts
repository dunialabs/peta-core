import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { DownstreamMcpClient } from './DownstreamMcpClient.js';

export class LegacySdkDownstreamClient implements DownstreamMcpClient {
  readonly protocolEra = 'legacy' as const;

  constructor(readonly legacyClient: Client) {}

  getServerCapabilities() {
    return this.legacyClient.getServerCapabilities();
  }

  getServerVersion() {
    return this.legacyClient.getServerVersion();
  }

  ping(options?: { timeout?: number }) {
    return this.legacyClient.ping(options);
  }

  close() {
    return this.legacyClient.close();
  }

  listTools(params?: Record<string, unknown>, options?: unknown) {
    return this.legacyClient.listTools(params as never, options as never);
  }

  callTool(params: Record<string, unknown>, resultSchema?: unknown, options?: unknown) {
    return this.legacyClient.callTool(params as never, resultSchema as never, options as never);
  }

  listResources(params?: Record<string, unknown>, options?: unknown) {
    return this.legacyClient.listResources(params as never, options as never);
  }

  listResourceTemplates(params?: Record<string, unknown>, options?: unknown) {
    return this.legacyClient.listResourceTemplates(params as never, options as never);
  }

  readResource(params: Record<string, unknown>, options?: unknown) {
    return this.legacyClient.readResource(params as never, options as never);
  }

  listPrompts(params?: Record<string, unknown>, options?: unknown) {
    return this.legacyClient.listPrompts(params as never, options as never);
  }

  getPrompt(params: Record<string, unknown>, options?: unknown) {
    return this.legacyClient.getPrompt(params as never, options as never);
  }

  complete(params: Record<string, unknown>, options?: unknown) {
    return this.legacyClient.complete(params as never, options as never);
  }

  subscribeResource(params: Record<string, unknown>, options?: unknown) {
    return this.legacyClient.subscribeResource(params as never, options as never);
  }

  unsubscribeResource(params: Record<string, unknown>, options?: unknown) {
    return this.legacyClient.unsubscribeResource(params as never, options as never);
  }

  notification(notification: unknown, options?: unknown) {
    return this.legacyClient.notification(notification as never, options as never);
  }

  setNotificationHandler(schema: unknown, handler: (...args: any[]) => Promise<void> | void) {
    this.legacyClient.setNotificationHandler(schema as never, handler as never);
  }

  sendRootsListChanged() {
    return this.legacyClient.sendRootsListChanged();
  }
}
