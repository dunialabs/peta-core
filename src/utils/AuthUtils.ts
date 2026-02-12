import { Permissions } from '../mcp/types/mcp.js';
import { DetailedLogEntry } from '../types/auth.types.js';
import { createLogger } from '../logger/index.js';
import { ServerAuthType } from '../types/enums.js';

// Logger for AuthUtils
const logger = createLogger('AuthUtils');

/**
 * Authentication-related utility functions
 */
export class AuthUtils {
  /**
   * Log authentication event
   */
  static logAuthEvent(
    eventType: string,
    userId?: string,
    serverName?: string,
    success: boolean = true,
    message?: string
  ): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      eventType,
      userId,
      serverName,
      success,
      message,
      details: {
        userAgent: 'admin-interface',
        source: 'config-controller'
      }
    };

    logger.info(logEntry, 'Auth event');
  }

  /**
   * Log permission change
   */
  static logPermissionChange(
    userId: string,
    oldPermissions?: Permissions,
    newPermissions?: Permissions
  ): void {
    const logEntry: DetailedLogEntry = {
      userId,
      sessionId: 'admin-session',
      eventType: 'permission_change',
      details: {
        oldPermissions,
        newPermissions
      },
      timestamp: Math.floor(Date.now() / 1000)
    };

    logger.info(logEntry, 'Permission change');
  }

  /**
   * Validate permissions object format
   */
  static validatePermissions(permissions: any): boolean {
    if (typeof permissions !== 'object' || permissions === null) {
      return false;
    }

    for (const [serverID, serverPerms] of Object.entries(permissions)) {
      if (typeof serverPerms !== 'object' || serverPerms === null) {
        return false;
      }

      // Check required enabled field
      if (typeof (serverPerms as any).enabled !== 'boolean') {
        return false;
      }

      // Check optional tools, resources, prompts fields
      const subFields = ['tools', 'resources', 'prompts'];
      for (const field of subFields) {
        const value = (serverPerms as any)[field];
        if (value !== undefined && (typeof value !== 'object' || value === null)) {
          return false;
        }
        
        // If field exists, check its structure
        if (value && typeof value === 'object') {
          for (const [itemName, itemPerms] of Object.entries(value)) {
            if (typeof itemPerms !== 'object' || itemPerms === null) {
              return false;
            }
            // Check if each item has enabled field
            if (typeof (itemPerms as any).enabled !== 'boolean') {
              return false;
            }
          }
        }
      }
    }

    return true;
  }

  /**
   * Generate session ID
   */
  static generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Sanitize sensitive data (for logging)
   */
  static sanitizeForLogging(data: any): any {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    const sanitized = { ...data };
    const sensitiveFields = ['token', 'api_key', 'password', 'secret', 'key'];

    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  /**
   * Format error message
   */
  static formatErrorMessage(error: any): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return 'Unknown error occurred';
  }

  /**
   * Validate and sanitize sensitive log content
   */
  static sanitizeLogContent(content: any): any {
    if (typeof content === 'string') {
      // Remove possible token information
      return content.replace(/Bearer\s+[A-Za-z0-9+/=]+/g, 'Bearer ***');
    }
    
    if (typeof content === 'object' && content !== null) {
      const cleaned = { ...content };
      
      // Remove sensitive fields
      const sensitiveFields = ['token', 'authorization', 'apiKey', 'password', 'secret'];
      for (const field of sensitiveFields) {
        if (cleaned[field]) {
          cleaned[field] = '***';
        }
      }
      
      return cleaned;
    }
    
    return content;
  }

  /**
   * Format user ID (for log display)
   */
  static formatUserIdForLog(userId: string): string {
    if (!userId || userId.length < 8) return '***';
    return `***${userId.slice(-8)}`;
  }

  /**
   * Validate session ID format
   */
  static isValidSessionId(sessionId: string): boolean {
    return /^[a-f0-9]{32}$/.test(sessionId);
  }

  /**
   * Log user info refresh event
   */
  static logUserInfoRefresh(
    userId: string, 
    sessionId: string, 
    oldPermissions: Permissions, 
    newPermissions: Permissions
  ): void {
    const hasChanges = JSON.stringify(oldPermissions) !== JSON.stringify(newPermissions);
    
    const message = `User info refreshed${hasChanges ? ' with permission changes' : ''}`;
    
    this.logAuthEvent(
      'user_info_refreshed',
      userId,
      sessionId,
      true,
      message
    );
    
    // If there are permission changes, log detailed information
    if (hasChanges) {
      this.logPermissionChange(userId, oldPermissions, newPermissions);
    }
  }

  /**
   * Get OAuth provider string from ServerAuthType
   * 
   * @param authType - Server authentication type
   * @returns OAuth provider string ('google', 'notion', 'figma') or undefined if not an OAuth type
   * 
   * @example
   * ```typescript
   * const provider = AuthUtils.getOAuthProvider(ServerAuthType.GoogleAuth); // 'google'
   * const provider = AuthUtils.getOAuthProvider(ServerAuthType.ApiKey); // undefined
   * ```
   */
  static getOAuthProvider(authType: ServerAuthType): string | undefined {
    switch (authType) {
      case ServerAuthType.GoogleAuth:
      case ServerAuthType.GoogleCalendarAuth:
        return 'google';
      case ServerAuthType.NotionAuth:
        return 'notion';
      case ServerAuthType.FigmaAuth:
        return 'figma';
      case ServerAuthType.GithubAuth:
        return 'github';
      case ServerAuthType.CanvasAuth:
        return 'canvas';
      case ServerAuthType.ZendeskAuth:
        return 'zendesk';
      case ServerAuthType.ApiKey:
        return undefined;
      default:
        return undefined;
    }
  }
}