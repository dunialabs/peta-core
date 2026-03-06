/**
 * Socket.IO related type definitions
 *
 * Used for bidirectional communication between server and client
 */

/**
 * User connection information
 * Records device connection details for each user
 */
export interface UserConnection {
  userId: string;           // User ID (from AuthContext)
  socketId: string;         // Socket.IO connection ID
  deviceType?: string;      // Device type: 'desktop' | 'mobile' | 'web'
  deviceName?: string;      // Device name (optional)
  appVersion?: string;      // Client application version (optional)
  connectedAt: Date;        // Connection time
}

/**
 * Client information (optional)
 * Device information sent by client after connection
 */
export interface ClientInfo {
  deviceType?: string;      // Device type
  deviceName?: string;      // Device name
  appVersion?: string;      // Application version
  platform?: string;        // Platform information (e.g., 'darwin', 'win32', 'linux')
}

/**
 * Notification data structure
 * Notification content pushed by server to client
 */
export interface NotificationData {
  type: string;             // Notification type (e.g., 'user_disabled', 'permission_changed', 'system_message')
  message: string;          // Notification message content
  timestamp: number;        // Timestamp (milliseconds)
  data?: any;               // Additional data (optional)
  severity?: 'info' | 'warning' | 'error' | 'success';  // Severity level (optional)
}

/**
 * Socket authentication data
 * Authentication information passed when client connects
 */
export interface SocketAuthData {
  token: string;            // Bearer token
}

/**
 * Socket data extension
 * Custom data stored in socket.data
 */
export interface SocketData {
  userId: string;           // User ID
  authContext: any;         // Authentication context (AuthContext)
  userToken: string;        // User token (used for encrypting launchConfig)
  deviceType?: string;      // Device type
  deviceName?: string;      // Device name
  appVersion?: string;      // Application version
}

/**
 * Socket event name constants
 */
export const SocketEvents = {
  // Client → Server
  CLIENT_MESSAGE: 'client-message',       // Client sends message
  CLIENT_INFO: 'client-info',             // Client sends device information

  // Server → Client
  NOTIFICATION: 'notification',           // Server pushes notification
  ACK: 'ack',                             // Message acknowledgment
  ERROR: 'error',                         // Error information

  // Connection events (Socket.IO built-in)
  CONNECT: 'connect',                     // Connection successful
  DISCONNECT: 'disconnect',               // Connection disconnected
  RECONNECT: 'reconnect',                 // Reconnection successful
  CONNECT_ERROR: 'connect_error',         // Connection error
} as const;

/**
 * Notification type constants
 */
export const NotificationTypes = {
  // User management
  USER_DISABLED: 'user_disabled',                 // User disabled
  USER_ENABLED: 'user_enabled',                   // User enabled
  USER_EXPIRED: 'user_expired',                   // User expired
  USER_DELETED: 'user_deleted',                   // User deleted

  // Permission management
  PERMISSION_CHANGED: 'permission_changed',       // Permission changed
  PERMISSION_REVOKED: 'permission_revoked',       // Permission revoked

  // System messages
  SYSTEM_MESSAGE: 'system_message',               // System message
  SYSTEM_MAINTENANCE: 'system_maintenance',       // System maintenance
  SYSTEM_UPDATE: 'system_update',                 // System update

  // Business messages
  BUSINESS_MESSAGE: 'business_message',           // Business message
  TASK_NOTIFICATION: 'task_notification',         // Task notification

  // Session management
  ONLINE_SESSIONS: 'online_sessions',             // Online session list changed

  // Server status
  SERVER_STATUS_CHANGE: 'server_status_change',   // Server status changed
  MCP_SERVER_ONLINE: 'mcp_server_online',         // MCP server online
  MCP_SERVER_OFFLINE: 'mcp_server_offline',       // MCP server offline
} as const;

// ==================== Request-Response Pattern Related Types ====================

/**
 * Socket action type enum (fully open, can add new actions at any time)
 * Similar to AdminActionType, used to identify different request types
 */
export enum SocketActionType {
  // ========== 1000-1999: User confirmation category ==========
  ASK_USER_CONFIRM = 1001,              // Request user confirmation for operation
  ASK_USER_SELECT = 1002,               // Request user selection

  // ========== 2000-2999: Client status query category ==========
  GET_CLIENT_STATUS = 2001,             // Get client status
  GET_CURRENT_PAGE = 2002,              // Get current page information
  GET_CLIENT_CONFIG = 2003,             // Get client configuration
  GET_CONNECTION_INFO = 2004,           // Get connection information

  // ========== 3000-3999: Capability configuration query category ==========
  GET_CAPABILITIES = 3001,              // Get user capability configuration

  // ========== 4000-4999: Server configuration category ==========
  CONFIGURE_SERVER = 4001,              // Configure server
  UNCONFIGURE_SERVER = 4002,            // Unconfigure server

  // ========== 5000-5999: Approval workflow category ==========
  APPROVAL_CREATED = 5001,               // Notify client of new pending approval
  APPROVAL_DECIDED = 5002,               // Notify client of approval decision
  APPROVAL_EXPIRED = 5003,               // Notify client of expired approval
  GET_PENDING_APPROVALS = 5004,          // Client requests list of pending approvals

}

/**
 * Socket error code enum
 * Used for unified error handling
 */
export enum SocketErrorCode {
  // General errors (1000-1099)
  TIMEOUT = 1001,                       // Response timeout
  USER_OFFLINE = 1002,                  // User offline
  INVALID_REQUEST = 1003,               // Invalid request
  UNKNOWN_ACTION = 1004,                // Unknown action type

  // Client errors (1100-1199)
  CLIENT_ERROR = 1101,                  // Client processing error
  USER_REJECTED = 1102,                 // User rejected operation
  USER_CANCELLED = 1103,                // User cancelled operation
  PERMISSION_DENIED = 1104,             // Insufficient permissions

  // Server errors (1200-1299)
  SERVER_ERROR = 1201,                  // Server internal error
  SERVICE_UNAVAILABLE = 1202,           // Service unavailable
}

/**
 * Socket request interface (similar to AdminRequest)
 * Used for server to send requests to client
 */
export interface SocketRequest<T = any> {
  requestId: string;                    // Unique request ID (UUID)
  action: SocketActionType;             // Action type
  data: T;                              // Request data (generic)
  timestamp: number;                    // Send timestamp (milliseconds)
}

/**
 * Socket response interface (similar to AdminResponse)
 * Used for client to return response to server
 */
export interface SocketResponse<T = any> {
  requestId: string;                    // Associated request ID
  success: boolean;                     // Whether successful
  data?: T;                             // Response data (on success)
  error?: {                             // Error information (on failure)
    code: SocketErrorCode;
    message: string;
    details?: any;                      // Additional error details
  };
  timestamp: number;                    // Response timestamp (milliseconds)
}

/**
 * Helper function: Convert SocketActionType to event name
 * @param action Action type enum value
 * @returns Event name (lowercase underscore format)
 * @example actionToEventName(SocketActionType.ASK_USER_CONFIRM) => 'ask_user_confirm'
 */
export function actionToEventName(action: SocketActionType): string {
  // Get enum key name (e.g., 'ASK_USER_CONFIRM')
  const enumKey = SocketActionType[action];
  if (!enumKey) {
    throw new Error(`Unknown SocketActionType: ${action}`);
  }
  // Convert to lowercase ('ask_user_confirm')
  return enumKey.toLowerCase();
}

/**
 * Helper function: Convert event name to SocketActionType
 * @param eventName Event name (lowercase underscore format)
 * @returns Action type enum value, returns null if not found
 * @example eventNameToAction('ask_user_confirm') => SocketActionType.ASK_USER_CONFIRM
 */
export function eventNameToAction(eventName: string): SocketActionType | null {
  // Convert to uppercase ('ASK_USER_CONFIRM')
  const enumKey = eventName.toUpperCase();

  // Find corresponding enum value
  const actionValue = (SocketActionType as any)[enumKey];

  return actionValue !== undefined ? actionValue : null;
}

/**
 * Socket response event name constant
 * Clients uniformly use this event name to send responses
 */
export const SOCKET_RESPONSE_EVENT = 'socket_response' as const;
