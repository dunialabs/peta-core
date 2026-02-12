import { DangerLevel, ServerAuthType, ServerCategory, ServerStatus } from '../../types/enums';


// Base capability configuration (common part)
export type BaseCapabilityConfig = {
  enabled: boolean;
  description?: string;
};

// Tool capability configuration (extends base configuration, adds danger level)
export type ToolCapabilityConfig = BaseCapabilityConfig & {
  dangerLevel?: DangerLevel;
};

// Resource capability configuration (currently same as base configuration, for future extension)
export type ResourceCapabilityConfig = BaseCapabilityConfig;

// Prompt capability configuration (currently same as base configuration, for future extension)
export type PromptCapabilityConfig = BaseCapabilityConfig;

// Base capability configuration definition
export type ServerConfigCapabilities = {
  tools: { [toolName: string]: ToolCapabilityConfig };
  resources: { [resourceName: string]: ResourceCapabilityConfig };
  prompts: { [promptName: string]: PromptCapabilityConfig };
};

// Server configuration with enabled status (extends base configuration)
export type ServerConfigWithEnabled = ServerConfigCapabilities & {
  enabled: boolean;
  serverName: string;
  allowUserInput: boolean;
  authType: ServerAuthType;
  category?: ServerCategory;
  configTemplate: string;      // JSON string format
  configured: boolean;          // Whether user has configured this Server
  status?: ServerStatus;
};

// User permission configuration (indexed by serverID)
export type Permissions = {
  [serverID: string]: ServerConfigWithEnabled;
};

// MCP server capability configuration (same structure as Permissions)
export type McpServerCapabilities = Permissions;

export type McpRequest = {
  id: string | number;
  method: string;
  params: any;
  serverID: string;
};

export type McpResponse = {
  id: string | number;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

export type McpNotification = {
  method: string;
  params: any;
  serverID: string;
};

/**
 * MCP EventStore related type definitions
 */

export type StreamId = string;
export type EventId = string;

/**
 * JSON-RPC message type (imported from MCP SDK)
 */
export interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * EventStore interface definition
 * Used to support MCP protocol resumability feature
 */
export interface EventStore {
  /**
   * Store event for subsequent retrieval
   * @param streamId ID of the stream the event belongs to
   * @param message JSON-RPC message to store
   * @returns Event ID generated for the stored event
   */
  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;

  /**
   * Replay events after specified event ID
   * @param lastEventId Last received event ID
   * @param options Replay options
   * @returns Stream ID
   */
  replayEventsAfter(lastEventId: EventId, options: ReplayOptions): Promise<StreamId>;
}

/**
 * Event replay options
 */
export interface ReplayOptions {
  /**
   * Callback function to send events
   */
  send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
}

/**
 * Cached event type
 */
export interface CachedEvent {
  eventId: string;
  message: JSONRPCMessage;
  timestamp: Date;
  streamId: string;
}
