import { StdioClientTransport, StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createLogger } from '../../logger/index.js';

export type DownstreamTransportType = 'stdio' | 'http' | 'sse';

export interface TransportConfig {
  type?: DownstreamTransportType;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

/**
 * Downstream transport factory
 * Automatically infers and creates corresponding transport instances based on launch_config
 */
export class DownstreamTransportFactory {
  // Logger for DownstreamTransportFactory
  private static logger = createLogger('DownstreamTransportFactory');
  /**
   * Create transport instance based on launch_config
   */
  static async create(launchConfig: Record<string, any>): Promise<{transport: Transport, transportType: DownstreamTransportType}> {
    const transportType = this.detectTransportType(launchConfig);
    
    try {
      switch (transportType) {
        case 'stdio':
          return { transport: this.createStdioTransport(launchConfig), transportType };
        
        case 'http':
          return { transport: await this.createHttpTransport(launchConfig), transportType };
        
        case 'sse':
          return { transport: this.createSSETransport(launchConfig), transportType };
        
        default:
          throw new Error(`Unsupported transport type: ${transportType}`);
      }
    } catch (error) {
      throw new Error(`Failed to create ${transportType} transport: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Infer transport type from launch_config
   */
  public static detectTransportType(config: any): DownstreamTransportType {
    // Explicitly specified type takes priority
    if (config.type) {
      return config.type;
    }

    // Infer from configuration properties
    if (config.command) {
      return 'stdio';
    }

    if (config.url) {
      const url = config.url.toLowerCase();
      // Automatically detect SSE from URL pattern
      if (url.includes('/sse') || url.includes('/events')) {
        return 'sse';
      }
      return 'http';
    }

    throw new Error('Cannot determine transport type from launch_config');
  }

  /**
   * Create stdio transport
   */
  private static createStdioTransport(config: Record<string, any>): Transport {
    this.validateStdioConfig(config);

    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: {
        ...process.env,
        ...config.env
      },
      cwd: config.cwd
    });
  }

  /**
   * Create HTTP transport, supports fallback to SSE
   */
  private static async createHttpTransport(config: Record<string, any>): Promise<Transport> {
    this.validateHttpConfig(config);

    const url = new URL(config.url);
    
    // Try Streamable HTTP first
    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...config.headers
          }
        }
      });

      return transport;

    } catch (error) {
      DownstreamTransportFactory.logger.warn({ error }, 'Streamable HTTP failed, falling back to SSE');
      
      // Fallback to SSE
      return new SSEClientTransport(url);
    }
  }

  /**
   * Create SSE transport
   */
  private static createSSETransport(config: Record<string, any>): Transport {
    this.validateSSEConfig(config);
    return new SSEClientTransport(new URL(config.url));
  }

  private static validateStdioConfig(config: any): void {
    if (!config.command) {
      throw new Error('Stdio transport requires command parameter');
    }
    if (config.command.includes('..')) {
      throw new Error('Command path traversal not allowed');
    }
  }

  private static validateHttpConfig(config: any): void {
    if (!config.url) {
      throw new Error('HTTP transport requires URL parameter');
    }
    try {
      new URL(config.url);
    } catch (error) {
      throw new Error('Invalid URL format');
    }
  }

  private static validateSSEConfig(config: any): void {
    if (!config.url) {
      throw new Error('SSE transport requires URL parameter');
    }
  }
}