/**
 * User operation type definitions
 *
 * This module defines types for user-facing API operations, following the same
 * pattern as admin.types.ts but for regular user operations.
 */

/**
 * User operation type enum - Uses numeric values for better performance
 * Follows the same pattern as AdminActionType
 */
export enum UserActionType {
  // ========== 1000-1999: Capability configuration operations ==========
  GET_CAPABILITIES = 1001,           // Get user's capability configuration
  SET_CAPABILITIES = 1002,           // Set user's capability configuration

  // ========== 2000-2999: Server configuration operations ==========
  CONFIGURE_SERVER = 2001,           // Configure a server for user
  UNCONFIGURE_SERVER = 2002,         // Unconfigure a server for user

  // ========== 3000-3999: Session query operations ==========
  GET_ONLINE_SESSIONS = 3001,        // Get user's online session list
}

/**
 * Unified user request interface
 * Follows the same pattern as AdminRequest
 */
export interface UserRequest<T = any> {
  action: UserActionType;
  data?: T;  // Optional data (some operations don't require data)
}

/**
 * Unified user response interface
 * Follows the same pattern as AdminResponse
 */
export interface UserResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: UserErrorCode;
    message: string;
  };
}

/**
 * User operation error code enum
 */
export enum UserErrorCode {
  // General errors (1000-1999)
  INVALID_REQUEST = 1001,
  UNAUTHORIZED = 1002,
  USER_DISABLED = 1003,

  // Server configuration errors (2000-2999)
  SERVER_NOT_FOUND = 2001,
  SERVER_DISABLED = 2002,
  SERVER_CONFIG_INVALID = 2003,
  SERVER_NOT_ALLOW_USER_INPUT = 2004,
  SERVER_NO_CONFIG_TEMPLATE = 2005,

  // Capability errors (3000-3999)
  INVALID_CAPABILITIES = 3001,

  // Internal errors (5000+)
  INTERNAL_ERROR = 5001,
}

/**
 * User error class - Extended Error that includes UserErrorCode
 */
export class UserError extends Error {
  constructor(message: string, public code: UserErrorCode) {
    super(message);
    this.name = 'UserError';
  }
}

// ==================== Business data types ====================

/**
 * Session data for GET_ONLINE_SESSIONS
 */
export interface SessionData {
  sessionId: string;
  clientName: string;
  userAgent: string;
  lastActive: Date;
}
/**
 * User configure server request parameters
 */
export interface ConfigureServerRequest {
  serverId: string;
  authConf?: Array<{
    key: string;
    value: string;
    dataType: number;
  }>;
  restfulApiAuth?: Map<any, any>;
  remoteAuth?: { params: Record<string, any>; headers: Record<string, any> };
}

/**
 * User configure server response data
 */
export interface ConfigureServerResponseData {
  serverId: string;      // Original serverId (not concatenated)
  message: string;
}

/**
 * User unconfigure server request parameters
 */
export interface UnconfigureServerRequest {
  serverId: string;
}

/**
 * User unconfigure server response data
 */
export interface UnconfigureServerResponseData {
  serverId: string;
  message: string;
}
