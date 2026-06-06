import { Permissions } from '../mcp/types/mcp.js';
import { UserStatus, UserRole } from './enums.js';

/**
 * Authentication context information
 */
export interface AuthContext {
  kind?: 'anonymous'; // Only set for anonymous sessions; undefined means authenticated
  userId: string; // User ID (first 32 characters of SHA-256)
  token: string; // Original token
  role: UserRole; // User role
  status: UserStatus; // User status
  permissions: Permissions; // User permissions (configured by administrator)
  userPreferences: Permissions; // User custom preferences
  launchConfigs: string; // User launch configuration
  authenticatedAt: Date; // Authentication time
  expiresAt: number | null; // Expiration time (timestamp), null means never expires
  rateLimit: number; // Rate Limit: maximum number of requests per minute
  // OAuth-related fields (optional)
  oauthClientId?: string; // OAuth client ID
  oauthScopes?: string[]; // OAuth authorization scopes
  oauthAccessTokenExpiresAt?: number;
  userAgent?: string; // User agent
  // Tenant scoping (optional - for multi-tenant cache isolation)
  tenantId?: string; // Tenant ID for tenant-scoped caching
}

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  serverID?: string;
  resourceType?: 'tools' | 'resources' | 'prompts';
  resourceName?: string;
}

/**
 * Authentication error type
 */
export enum AuthErrorType {
  INVALID_TOKEN = 'INVALID_TOKEN',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_DISABLED = 'USER_DISABLED',
  USER_EXPIRED = 'USER_EXPIRED',
  INVALID_PERMISSIONS = 'INVALID_PERMISSIONS',
  INVALID_ACCESS_TOKEN_DATA = 'INVALID_ACCESS_TOKEN_DATA',
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  INVALID_SESSION = 'INVALID_SESSION',
  INVALID_REQUEST = 'INVALID_REQUEST',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
}

/**
 * Disconnect reason
 */
export enum DisconnectReason {
  CLIENT_DISCONNECT = 'CLIENT_DISCONNECT', // Client actively disconnected
  USER_DISABLED = 'USER_DISABLED', // User disabled
  USER_EXPIRED = 'USER_EXPIRED', // User expired
  PERMISSION_REVOKED = 'PERMISSION_REVOKED', // Permission revoked
  ADMIN_REQUEST = 'ADMIN_REQUEST', // Admin request
  SESSION_TIMEOUT = 'SESSION_TIMEOUT', // Session timeout
  SERVER_SHUTDOWN = 'SERVER_SHUTDOWN', // Server shutdown
  SESSION_REMOVED = 'SESSION_REMOVED', // Session removed
}

/**
 * Detailed log entry
 */
export interface DetailedLogEntry {
  userId: string;
  sessionId: string;
  eventType: 'connect' | 'disconnect' | 'permission_change' | 'expiry' | 'error';
  reason?: DisconnectReason;
  details: {
    clientInfo?: any;
    oldPermissions?: Permissions;
    newPermissions?: Permissions;
    serverID?: string;
    errorMessage?: string;
  };
  timestamp: number;
}

/**
 * Permission validation function
 */
export function isValidPermissions(obj: any): obj is Permissions {
  if (typeof obj !== 'object' || obj === null) return false;

  for (const [serverID, serverPerms] of Object.entries(obj)) {
    if (typeof serverPerms !== 'object' || serverPerms === null) return false;

    const typedServerPerms = serverPerms as any;
    if (typeof typedServerPerms.enabled !== 'boolean') return false;

    // Validate structure of tools, resources, prompts
    const subPerms = ['tools', 'resources', 'prompts'];
    for (const key of subPerms) {
      if (typedServerPerms[key] && typeof typedServerPerms[key] !== 'object') return false;
    }
  }
  return true;
}

export class AuthError extends Error {
  constructor(
    public type: AuthErrorType,
    message: string,
    public userId?: string,
    public details?: any,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
