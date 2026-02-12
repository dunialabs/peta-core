/**
 * Admin operation type definitions
 */

/**
 * Admin operation type enum - Uses numeric values for better performance
 */
export enum AdminActionType {
  // User operations (1000-1999)
  DISABLE_USER = 1001,                    // Disable access permissions for specified user
  UPDATE_USER_PERMISSIONS = 1002,         // Update user permissions
  CREATE_USER = 1010,                     // Create user
  GET_USERS = 1011,                       // Query user list
  UPDATE_USER = 1012,                     // Update user
  DELETE_USER = 1013,                     // Delete user
  DELETE_USERS_BY_PROXY = 1014,           // Batch delete users by proxy
  COUNT_USERS = 1015,                     // Count number of users
  GET_OWNER = 1016,                       // Get Owner information

  // Server operations (2000-2999)
  START_SERVER = 2001,                    // Start specified server
  STOP_SERVER = 2002,                     // Stop specified server
  UPDATE_SERVER_CAPABILITIES = 2003,      // Update server capabilities configuration
  UPDATE_SERVER_LAUNCH_CMD = 2004,        // Update launch command
  CONNECT_ALL_SERVERS = 2005,             // Connect all servers
  CREATE_SERVER = 2010,                   // Create server
  GET_SERVERS = 2011,                     // Query server list
  UPDATE_SERVER = 2012,                   // Update server
  DELETE_SERVER = 2013,                   // Delete server
  DELETE_SERVERS_BY_PROXY = 2014,         // Batch delete servers by proxy
  COUNT_SERVERS = 2015,                   // Count number of servers

  // Query operations (3000-3999)
  GET_AVAILABLE_SERVERS_CAPABILITIES = 3002, // Get all server capabilities configuration
  GET_USER_AVAILABLE_SERVERS_CAPABILITIES = 3003, // Get user accessible server capabilities configuration
  GET_SERVERS_STATUS = 3004,              // Get all server status
  GET_SERVERS_CAPABILITIES = 3005,        // Get specified server capabilities configuration

  // IP whitelist operations (4000-4999)
  UPDATE_IP_WHITELIST = 4001,             // Replace mode: Delete all existing IPs, save new IP list to database and load into memory
  GET_IP_WHITELIST = 4002,                // Query IP whitelist
  DELETE_IP_WHITELIST = 4003,             // Delete specified IP whitelist
  ADD_IP_WHITELIST = 4004,                // Append mode: Add IP to whitelist (without deleting existing IPs)
  SPECIAL_IP_WHITELIST_OPERATION = 4005,  // IP filter switch: allow-all disables filtering/deny-all enables filtering

  // Proxy operations (5000-5099)
  GET_PROXY = 5001,                       // Query proxy information
  CREATE_PROXY = 5002,                    // Create proxy
  UPDATE_PROXY = 5003,                    // Update proxy
  DELETE_PROXY = 5004,                    // Delete proxy
  STOP_PROXY   = 5005,                    // Stop all servers for proxy

  // Backup and restore (6000-6099)
  BACKUP_DATABASE = 6001,                 // Full database backup
  RESTORE_DATABASE = 6002,                // Full database restore

  // Log operations (7000-7099)
  SET_LOG_WEBHOOK_URL = 7001,             // Set log sync webhook URL
  GET_LOGS = 7002,                        // Get log records

  // Cloudflared operations (8000-8099)
  UPDATE_CLOUDFLARED_CONFIG = 8001,       // Update cloudflared configuration
  GET_CLOUDFLARED_CONFIGS = 8002,         // Query cloudflared configuration list
  DELETE_CLOUDFLARED_CONFIG = 8003,       // Delete cloudflared configuration
  RESTART_CLOUDFLARED = 8004,             // Restart cloudflared
  STOP_CLOUDFLARED = 8005,                // Stop cloudflared

  // Skills operations (10040-10043)
  LIST_SKILLS = 10040,                    // List all skills
  UPLOAD_SKILL = 10041,                   // Upload skill (ZIP file)
  DELETE_SKILL = 10042,                   // Delete skill
  DELETE_SERVER_SKILLS = 10043,           // Delete all skills for a server
}

/**
 * Generic identifier type - Used for user ID and server ID
 */
export interface TargetIdentifier {
  targetId: string;
}

/**
 * Unified admin request interface
 */
export interface AdminRequest<T = any> {
  action: AdminActionType;
  data: T;  // Uses generic type T, defaults to any type
}

/**
 * Unified response interface
 */
export interface AdminResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Admin operation error code enum
 */
export enum AdminErrorCode {
  // General errors (1000-1999)
  INVALID_REQUEST = 1001,
  UNAUTHORIZED = 1002,
  FORBIDDEN = 1003,

  // User-related errors (2000-2999)
  USER_NOT_FOUND = 2001,
  USER_ALREADY_DISABLED = 2002,
  USER_ALREADY_EXISTS = 2003,

  // Server-related errors (3000-3999)
  SERVER_NOT_FOUND = 3001,
  SERVER_ALREADY_RUNNING = 3002,
  SERVER_ALREADY_EXISTS = 3003,

  // Permission-related errors (4000-4999)
  INSUFFICIENT_PERMISSIONS = 4001,
  INVALID_PERMISSION_FORMAT = 4002,

  // Proxy-related errors (5000-5099)
  PROXY_NOT_FOUND = 5001,
  PROXY_ALREADY_EXISTS = 5002,

  // IpWhitelist-related errors (5100-5199)
  IPWHITELIST_NOT_FOUND = 5101,
  INVALID_IP_FORMAT = 5102,

  // Database operation errors (5200-5299)
  DATABASE_OPERATION_FAILED = 5201,
  TRANSACTION_FAILED = 5202,

  // Backup and restore errors (5300-5399)
  BACKUP_FAILED = 5301,
  RESTORE_FAILED = 5302,
  INVALID_BACKUP_DATA = 5303,

  // Cloudflared-related errors (8000-8099)
  CLOUDFLARED_CONFIG_NOT_FOUND = 8001,
  INVALID_CREDENTIALS_FORMAT = 8002,
  CLOUDFLARED_RESTART_FAILED = 8003,
  TUNNEL_DELETE_FAILED = 8004,
  CLOUDFLARED_DATABASE_CONFIG_NOT_FOUND = 8005,
  CLOUDFLARED_LOCAL_FILE_NOT_FOUND = 8006,
  CLOUDFLARED_STOP_FAILED = 8007,
  TUNNEL_CREATE_FAILED = 8008,

  // Skills-related errors (9000-9099)
  SKILL_NOT_FOUND = 9001,
  SKILL_UPLOAD_FAILED = 9002,
  SKILL_DELETE_FAILED = 9003,
  INVALID_SKILL_FORMAT = 9004,
}

// Extended Error class that includes AdminErrorCode
export class AdminError extends Error {
  constructor(message: string, public code: AdminErrorCode) {
    super(message);
  }
}