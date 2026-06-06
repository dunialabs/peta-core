import { ResourceUpdatedNotification } from '@modelcontextprotocol/sdk/types.js';
import { socketNotifier } from '../../socket/SocketNotifier.js';
import { ServerManager } from './ServerManager.js';
import { createLogger } from '../../logger/index.js';
import { ResultCacheService } from './cache/ResultCacheService.js';
import { SessionStore } from './SessionStore.js';
import { modernSubscriptionBus } from '../modern/ModernSubscriptionBus.js';

/**
 * Broadcasts downstream notifications to eligible client sessions and deduplicates delivery.
 *
 * Standard MCP reverse requests such as sampling/roots/elicitation are intentionally unsupported
 * under Peta's shared downstream connection model and are not routed here.
 */
export class GlobalRequestRouter {
  private static instance: GlobalRequestRouter;

  // Record sent notifications for deduplication
  private sentNotifications = new Map<string, Set<string>>(); // sessionId -> Set<notificationKey>

  // Logger for GlobalRequestRouter
  private logger = createLogger('GlobalRequestRouter');

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): GlobalRequestRouter {
    if (!GlobalRequestRouter.instance) {
      GlobalRequestRouter.instance = new GlobalRequestRouter();
    }
    return GlobalRequestRouter.instance;
  }

  /**
   * Handle tools list changed notification
   */
  async handleToolsListChanged(serverId: string): Promise<void> {
    this.logger.info({ serverId }, 'Broadcasting tools list changed for server');
    modernSubscriptionBus.publish({
      method: 'notifications/tools/list_changed',
      serverId,
      params: { serverId },
    });

    const sessions = SessionStore.instance.getAllSessions();
    const notificationKey = `tools_changed_${serverId}_${Date.now()}`;

    socketNotifier.notifyUserPermissionChangedByServer(serverId);

    for (const session of sessions) {
      const sessionId = session.sessionId;
      if (!session.canAccessServer(serverId)) {
        continue;
      }

      const sent = this.sentNotifications.get(sessionId) || new Set();
      if (sent.has(notificationKey)) {
        continue;
      }

      try {
        session.sendToolListChanged();
        sent.add(notificationKey);
        this.sentNotifications.set(sessionId, sent);

        if (sent.size > 100) {
          const array = Array.from(sent);
          sent.clear();
          array.slice(-100).forEach((k) => sent.add(k));
        }
      } catch (error) {
        this.logger.error({ error, sessionId }, 'Failed to send tools list changed to session');
      }
    }
  }

  /**
   * Handle resources list changed notification
   */
  async handleResourcesListChanged(serverId: string): Promise<void> {
    this.logger.info({ serverId }, 'Broadcasting resources list changed for server');
    modernSubscriptionBus.publish({
      method: 'notifications/resources/list_changed',
      serverId,
      params: { serverId },
    });

    const sessions = SessionStore.instance.getAllSessions();
    const notificationKey = `resources_changed_${serverId}_${Date.now()}`;

    socketNotifier.notifyUserPermissionChangedByServer(serverId);

    for (const session of sessions) {
      const sessionId = session.sessionId;
      if (!session.canAccessServer(serverId)) {
        continue;
      }

      const sent = this.sentNotifications.get(sessionId) || new Set();
      if (sent.has(notificationKey)) {
        continue;
      }

      try {
        session.sendResourceListChanged();
        sent.add(notificationKey);
        this.sentNotifications.set(sessionId, sent);

        if (sent.size > 100) {
          const array = Array.from(sent);
          sent.clear();
          array.slice(-100).forEach((k) => sent.add(k));
        }
      } catch (error) {
        this.logger.error({ error, sessionId }, 'Failed to send resources list changed to session');
      }
    }
  }

  /**
   * Handle resource updated notification
   */
  async handleResourceUpdated(
    serverId: string,
    notification: ResourceUpdatedNotification,
    scopeId?: string,
  ): Promise<void> {
    const resourceUri = notification.params.uri;
    const subscriptionKey = scopeId ? `${scopeId}::${resourceUri}` : `${serverId}::${resourceUri}`;
    const subscribers = scopeId
      ? ServerManager.instance.getResourceSubscribersForScope(scopeId, resourceUri)
      : ServerManager.instance.getResourceSubscribersForServer(serverId, resourceUri);

    try {
      const cacheService = ResultCacheService.instance;
      if (cacheService.enabled) {
        await cacheService.invalidateResource(serverId, resourceUri);
        this.logger.debug(
          { serverId, resourceUri },
          'Result cache invalidated for updated resource',
        );
      }
    } catch (error) {
      this.logger.warn(
        { error, serverId, resourceUri },
        'Failed to invalidate result cache for resource update',
      );
    }

    modernSubscriptionBus.publish({
      method: 'notifications/resources/updated',
      serverId,
      scopeId,
      resourceUri,
      params: { serverId, uri: resourceUri },
    });

    if (subscribers.size === 0) {
      this.logger.debug({ subscriptionKey }, 'No subscribers for resource, skipping notification');
      return;
    }

    this.logger.debug(
      { serverId, resourceUri, subscriberCount: subscribers.size },
      'Broadcasting resource updated to subscribers',
    );

    const sessions = SessionStore.instance.getAllSessions();
    const notificationKey = `resource_updated_${serverId}_${resourceUri}_${Date.now()}`;

    for (const session of sessions) {
      const sessionId = session.sessionId;

      if (!subscribers.has(sessionId)) {
        continue;
      }

      if (!session.canAccessServer(serverId)) {
        continue;
      }

      const sent = this.sentNotifications.get(sessionId) || new Set();
      if (sent.has(notificationKey)) {
        continue;
      }

      try {
        session.sendResourceUpdated(serverId, notification);
        sent.add(notificationKey);
        this.sentNotifications.set(sessionId, sent);

        if (sent.size > 100) {
          const array = Array.from(sent);
          sent.clear();
          array.slice(-100).forEach((k) => sent.add(k));
        }
      } catch (error) {
        this.logger.error({ error, sessionId }, 'Failed to send resource updated to session');
      }
    }
  }

  /**
   * Handle prompts list changed notification
   */
  async handlePromptsListChanged(serverId: string): Promise<void> {
    this.logger.info({ serverId }, 'Broadcasting prompts list changed for server');
    modernSubscriptionBus.publish({
      method: 'notifications/prompts/list_changed',
      serverId,
      params: { serverId },
    });

    const sessions = SessionStore.instance.getAllSessions();
    const notificationKey = `prompts_changed_${serverId}_${Date.now()}`;

    socketNotifier.notifyUserPermissionChangedByServer(serverId);

    for (const session of sessions) {
      const sessionId = session.sessionId;
      if (!session.canAccessServer(serverId)) {
        continue;
      }

      const sent = this.sentNotifications.get(sessionId) || new Set();
      if (sent.has(notificationKey)) {
        continue;
      }

      try {
        session.sendPromptListChanged();
        sent.add(notificationKey);
        this.sentNotifications.set(sessionId, sent);

        if (sent.size > 100) {
          const array = Array.from(sent);
          sent.clear();
          array.slice(-100).forEach((k) => sent.add(k));
        }
      } catch (error) {
        this.logger.error({ error, sessionId }, 'Failed to send prompts list changed to session');
      }
    }
  }

  /**
   * Clean up notification records for session
   */
  cleanupSessionNotifications(sessionId: string): void {
    this.sentNotifications.delete(sessionId);
  }

  /**
   * Clean up notification records for all sessions
   */
  cleanupAllSessionNotifications(): void {
    this.sentNotifications.clear();
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalSessions: number;
    totalNotificationKeys: number;
  } {
    let totalKeys = 0;
    for (const sent of this.sentNotifications.values()) {
      totalKeys += sent.size;
    }

    return {
      totalSessions: this.sentNotifications.size,
      totalNotificationKeys: totalKeys,
    };
  }

  /**
   * Destroy instance
   */
  destroy(): void {
    this.sentNotifications.clear();
    GlobalRequestRouter.instance = null as any;
  }
}
