import { ClientSession } from './ClientSession.js';
import { DisconnectReason, DetailedLogEntry } from '../../types/auth.types.js';
import { LogService } from '../../log/LogService.js';
import { ProxySession } from './ProxySession.js';
import { AuthContext } from '../../types/auth.types.js';
import { ServerManager } from './ServerManager.js';
import { PersistentEventStore } from './PersistentEventStore.js';
import { GlobalRequestRouter } from './GlobalRequestRouter.js';
import { SessionLogger } from '../../log/SessionLogger.js';
import { MCPEventLogType } from '../../types/enums.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import { McpServerCapabilities } from '../types/mcp.js';
import { CapabilitiesService } from '../services/CapabilitiesService.js';
import { createLogger } from '../../logger/index.js';

/**
 * Manages all active ClientSession and ProxySession
 */
export class SessionStore {
  private sessions: Map<string, ClientSession> = new Map();
  private proxySessions: Map<string, ProxySession> = new Map(); // New: Manage ProxySession
  private userSessions: Map<string, Set<string>> = new Map(); // userId -> sessionIds
  private eventStores: Map<string, PersistentEventStore> = new Map(); // New: Manage EventStore
  private sessionLoggers: Map<string, SessionLogger> = new Map(); // New: Manage SessionLogger

  // Logger for SessionStore
  private logger = createLogger('SessionStore');
  private static readonly SESSION_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

  static instance: SessionStore = new SessionStore();

  static getInstance(): SessionStore {
    return SessionStore.instance;
  }

  private constructor() {}

  /**
   * Create complete Session entity (ClientSession + ProxySession)
   */
  async createSession(
    sessionId: string,
    userId: string,
    token: string,
    authContext: AuthContext,
    ip: string,
    userAgent: string,
  ): Promise<ClientSession> {
    // 1. Create ClientSession
    const clientSession = new ClientSession(sessionId, userId, token, authContext);

    clientSession.updateLastUserInfoRefresh(Date.now());

    // 2. Create EventStore instance
    const eventStore = new PersistentEventStore(sessionId, userId);

    // 3. Store EventStore
    this.eventStores.set(sessionId, eventStore);

    // 4. Create SessionLogger with initial HTTP context
    const tokenMask = token.substring(0, 8) + '***' + token.substring(token.length - 8);
    const sessionLogger = new SessionLogger({
      userId,
      sessionId,
      tokenMask,
      ip,
      userAgent,
    });

    // 5. Store SessionLogger
    this.sessionLoggers.set(sessionId, sessionLogger);

    // 5.5. Log SessionInit event (1301)
    await sessionLogger.logSessionLifecycle({
      action: MCPEventLogType.SessionInit,
    });

    // 6. Create corresponding ProxySession, pass SessionLogger
    const proxySession = new ProxySession(
      sessionId,
      userId,
      authContext.tenantId,
      clientSession,
      sessionLogger,
      eventStore,
      (sessionId: string) => this.removeSingleSession(sessionId),
    );

    // 7. Associate ProxySession with ClientSession
    clientSession.setProxySession(proxySession);

    // 8. Store to SessionStore
    this.sessions.set(sessionId, clientSession);
    this.proxySessions.set(sessionId, proxySession);

    // 9. Add to user session mapping
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId)!.add(sessionId);

    this.logger.info(
      { userId, sessionId },
      'Created complete session with EventStore and SessionLogger',
    );
    return clientSession;
  }

  /**
   * Get ProxySession
   */
  getProxySession(sessionId: string): ProxySession | undefined {
    return this.proxySessions.get(sessionId);
  }

  getSession(sessionId: string): ClientSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get EventStore
   */
  getEventStore(sessionId: string): PersistentEventStore | undefined {
    return this.eventStores.get(sessionId);
  }

  /**
   * Get SessionLogger
   */
  getSessionLogger(sessionId: string): SessionLogger | undefined {
    return this.sessionLoggers.get(sessionId);
  }

  /**
   * Perform tiered cleanup based on disconnect reason
   */
  async removeSession(
    sessionId: string,
    reason: DisconnectReason,
    isUserDisconnect: boolean = false,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (isUserDisconnect) {
      await this.removeAllUserSessions(session.userId, reason);
    } else {
      await this.removeSingleSession(sessionId, reason);
    }
  }

  /**
   * Specifically handle session termination requests
   * Perform cleanup operations according to MCP protocol specification
   */
  async terminateSession(
    sessionId: string,
    reason: DisconnectReason = DisconnectReason.CLIENT_DISCONNECT,
  ): Promise<void> {
    this.logger.info({ sessionId, reason }, 'Terminating session');

    try {
      // 1. Get session information
      const clientSession = this.sessions.get(sessionId);
      if (!clientSession) {
        this.logger.debug({ sessionId }, 'Session not found, nothing to terminate');
        return;
      }

      await this.removeSingleSession(sessionId, reason);

      this.logger.info({ sessionId }, 'Session terminated successfully');
    } catch (error) {
      this.logger.error({ error, sessionId }, 'Error terminating session');

      // Even if error occurs, try to cleanup resources
      try {
        await this.removeSingleSession(sessionId, reason);
      } catch (cleanupError) {
        this.logger.error(
          { error: cleanupError, sessionId },
          'Failed to cleanup session after termination error',
        );
      }

      throw error;
    }
  }

  /**
   * Remove single session
   */
  private async removeSingleSession(
    sessionId: string,
    reason: DisconnectReason = DisconnectReason.CLIENT_DISCONNECT,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const proxySession = this.proxySessions.get(sessionId);

    try {
      // 1. Cleanup ProxySession resources
      if (proxySession) {
        try {
          await proxySession.cleanup();
        } catch (error) {
          this.logger.error(
            { error, sessionId },
            'Failed to cleanup ProxySession during session removal',
          );
        }
      }

      // 2. Remove ProxySession from storage
      this.proxySessions.delete(sessionId);

      // 3. Remove ClientSession from storage
      this.sessions.delete(sessionId);

      // 4. Remove EventStore from storage
      this.eventStores.delete(sessionId);

      // 5. Remove SessionLogger from storage
      this.sessionLoggers.delete(sessionId);

      // 6. Remove from GlobalRequestRouter
      GlobalRequestRouter.getInstance().cleanupSessionNotifications(sessionId);

      // 7. Remove from user session mapping
      const userId = session.userId;
      const userSessionSet = this.userSessions.get(userId);
      if (userSessionSet) {
        userSessionSet.delete(sessionId);
        if (userSessionSet.size === 0) {
          this.userSessions.delete(userId);

          // All user sessions disconnected, cleanup user's temporary servers
          try {
            await ServerManager.instance.closeUserTemporaryServers(userId);
            this.logger.info({ userId }, 'Closed all temporary servers for user');
          } catch (error) {
            this.logger.error({ error, userId }, 'Failed to close temporary servers for user');
          }
        }
      }

      await session.close(reason);
      this.logger.debug({ sessionId }, 'Session removed from store');
    } catch (error) {
      this.logger.error({ error, sessionId }, 'Error removing session');
      throw error;
    }
  }

  /**
   * Remove all user sessions
   */
  async removeAllUserSessions(userId: string, reason: DisconnectReason): Promise<void> {
    const userSessionIds = this.userSessions.get(userId);
    if (!userSessionIds || userSessionIds.size === 0) {
      return;
    }

    const sessionIds = Array.from(userSessionIds);

    // Close all sessions in parallel
    const closePromises = sessionIds.map(async (sessionId) => {
      const session = this.sessions.get(sessionId);
      if (session) {
        const proxySession = this.proxySessions.get(sessionId);

        if (proxySession) {
          try {
            await proxySession.cleanup();
          } catch (error) {
            this.logger.error(
              { error, sessionId },
              'Failed to cleanup ProxySession during user session removal',
            );
          }
        }

        // Remove from mapping
        this.sessions.delete(sessionId);
        this.proxySessions.delete(sessionId);
        // Close session
        await session.close(reason);
        this.eventStores.delete(sessionId); // Remove EventStore
        this.sessionLoggers.delete(sessionId); // Remove SessionLogger
        GlobalRequestRouter.getInstance().cleanupSessionNotifications(sessionId);
      }
    });

    await Promise.all(closePromises);

    // Clean up user session collection
    this.userSessions.delete(userId);

    // Clean up user's temporary servers
    try {
      await ServerManager.instance.closeUserTemporaryServers(userId);
      this.logger.info({ userId }, 'Closed all temporary servers for user');
    } catch (error) {
      this.logger.error({ error, userId }, 'Failed to close temporary servers for user');
    }

    this.logger.info({ userId, reason }, 'Removed all sessions for user');
  }

  /**
   * Remove all sessions
   */
  async removeAllSessions(): Promise<void> {
    const closePromises = Array.from(this.sessions.entries()).map(async ([sessionId, session]) => {
      const proxySession = this.proxySessions.get(sessionId);
      if (proxySession) {
        try {
          await proxySession.cleanup();
        } catch (error) {
          this.logger.error(
            { error, sessionId },
            'Failed to cleanup ProxySession during all-session removal',
          );
        }
      }
      await session.close(DisconnectReason.SERVER_SHUTDOWN);
    });
    await Promise.all(closePromises);
    this.sessions.clear();
    this.proxySessions.clear();
    this.userSessions.clear();
    this.eventStores.clear(); // Remove all EventStore
    this.sessionLoggers.clear(); // Remove all SessionLogger
    GlobalRequestRouter.getInstance().cleanupAllSessionNotifications();
  }

  /**
   * Get all user sessions
   */
  getUserSessions(userId: string): ClientSession[] {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return [];

    const sessions: ClientSession[] = [];
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  /**
   * Get user's first session
   */
  getUserFirstSession(userId: string): ClientSession | undefined {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return undefined;
    return this.sessions.get(sessionIds.values().next().value!);
  }

  /**
   * Get active session count
   */
  getActiveSessionCount(): number {
    return Array.from(this.sessions.values()).filter((session) => session.isSseConnected()).length;
  }

  /**
   * Get total session count (including all states)
   */
  getTotalSessionCount(): number {
    return this.sessions.size; // In current implementation, same as active session count
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get session count per user
   */
  getUserSessionCounts(): { [userId: string]: number } {
    const counts: { [userId: string]: number } = {};
    for (const [userId, sessionIds] of this.userSessions.entries()) {
      counts[userId] = sessionIds.size;
    }
    return counts;
  }

  /**
   * Get sessions using specified server
   */
  getSessionsUsingServer(serverID: string): ClientSession[] {
    const sessions: ClientSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.canAccessServer(serverID)) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  /**
   * Check and cleanup expired sessions
   */
  async cleanupExpiredSessions(): Promise<void> {
    const expiredSessions: string[] = [];
    const inactiveSessions: string[] = [];
    const now = new Date();

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.isExpired()) {
        expiredSessions.push(sessionId);
      } else if (session.isInactive(now, SessionStore.SESSION_INACTIVITY_TIMEOUT_MS)) {
        inactiveSessions.push(sessionId);
      }
    }

    // Clean up expired sessions
    for (const sessionId of expiredSessions) {
      await this.removeSession(sessionId, DisconnectReason.USER_EXPIRED, true);
    }

    // Clean up inactive sessions
    for (const sessionId of inactiveSessions) {
      await this.removeSession(sessionId, DisconnectReason.SESSION_TIMEOUT, false);
    }

    if (expiredSessions.length > 0) {
      this.logger.info(
        { expiredSessions: expiredSessions.join(', ') },
        'Cleaned up expired sessions',
      );
    }
    if (inactiveSessions.length > 0) {
      this.logger.info(
        { inactiveSessions: inactiveSessions.join(', ') },
        'Cleaned up inactive sessions',
      );
    }
  }

  /**
   * Start periodic cleanup timer
   */
  startCleanupTimer(): void {
    setInterval(() => {
      this.cleanupExpiredSessions().catch((error) => {
        this.logger.error({ error }, 'Session cleanup error');
      });
    }, 300000); // Clean up every 5 minutes
  }

  /**
   * Get all sessions
   */
  getAllSessions(): ClientSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * After updating user custom configuration, notify all active sessions
   * @param userId User ID
   */
  async updateUserPreferences(userId: string): Promise<void> {
    // 1. Get all sessions for this user
    const userSessions = this.getUserSessions(userId);
    if (userSessions.length === 0) {
      return;
    }

    // 2. Read latest user_preferences from database
    const user = await UserRepository.findByUserId(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    const newUserPreferences = user.userPreferences ? JSON.parse(user.userPreferences) : {};

    // 3. Process each session
    for (const session of userSessions) {
      // 3.1 Get old user_preferences (from session.authContext)
      const oldUserPreferences = session.authContext.userPreferences || {};

      // 3.2 Compare changes
      const { toolsChanged, resourcesChanged, promptsChanged } =
        CapabilitiesService.comparePermissions(oldUserPreferences, newUserPreferences);

      this.logger.debug(
        { toolsChanged, resourcesChanged, promptsChanged, sessionId: session.sessionId },
        'Update User Preferences',
      );

      // 3.3 Update session's userPreferences
      session.userPreferences = newUserPreferences;

      // 3.4 Only notify changed parts
      if (toolsChanged) {
        session.sendToolListChanged();
      }
      if (resourcesChanged) {
        session.sendResourceListChanged();
      }
      if (promptsChanged) {
        session.sendPromptListChanged();
      }
    }

    this.logger.info(
      { userId, sessionCount: userSessions.length },
      'Updated user preferences for sessions',
    );
  }

  private generateSessionId(): string {
    return Math.random().toString(36).slice(2) + Date.now();
  }
}
