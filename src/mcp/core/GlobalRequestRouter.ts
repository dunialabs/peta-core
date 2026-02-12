import {
  CreateMessageRequest,
  CreateMessageResult,
  ListRootsRequest,
  ListRootsResult,
  ElicitRequest,
  ElicitResult,
  RequestId,
  ResourceUpdatedNotification,
  McpError,
  ErrorCode
} from "@modelcontextprotocol/sdk/types.js";
import { LogService } from '../../log/LogService.js';
import { SessionStore } from './SessionStore.js';
import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { MCPEventLogType } from "../../types/enums.js";
import { socketNotifier } from '../../socket/SocketNotifier.js';
import { ServerManager } from './ServerManager.js';
import { ProxyContext } from '../../types/mcp.types.js';
import { createLogger } from '../../logger/index.js';
/**
 * Simplified version of RequestHandlerExtra
 * Contains information needed to handle reverse requests
 */
export interface RequestExtra {
  requestId?: RequestId;
  sessionId?: string;
  requestInfo?: {
    relatedRequestId?: RequestId;
  };
}

/**
 * Global request router
 * Responsible for handling reverse requests initiated by Server and routing them to the correct Client
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
   * Handle Sampling request from Server
   */
  async handleSamplingRequest(
    serverId: string,
    request: CreateMessageRequest,
    proxyContext: ProxyContext
  ): Promise<CreateMessageResult> {
    // Extract sessionId from proxyRequestId (format: "sessionId:originalId:timestamp")
    const sessionId = proxyContext.proxyRequestId.split(':')[0];

    this.logger.debug({
      serverId,
      sessionId,
      proxyRequestId: proxyContext.proxyRequestId,
      parentUniformRequestId: proxyContext.uniformRequestId,
      method: 'sampling/createMessage'
    }, 'Handling sampling request from server');

    // Get ProxySession through sessionId
    const proxySession = SessionStore.instance.getProxySession(sessionId);
    if (!proxySession) {
      this.logger.error({ sessionId }, 'No ProxySession found for sessionId');
      throw new McpError(
        ErrorCode.InvalidRequest,
        `No ProxySession found for sessionId: ${sessionId}`
      );
    }

    // Get SessionLogger for this session
    const sessionLogger = SessionStore.instance.getSessionLogger(sessionId);

    // Log ReverseSamplingRequest (1201)
    const uniformRequestId = LogService.getInstance().generateUniformRequestId(sessionId);
    const startTime = Date.now();

    // Permission check
    if (!proxySession.canServerRequestSampling()) {
      if (sessionLogger) {
        await sessionLogger.logReverseRequest({
          action: MCPEventLogType.ReverseSamplingRequest,
          serverId: serverId,
          upstreamRequestId: '',
          uniformRequestId: uniformRequestId,
          parentUniformRequestId: proxyContext.uniformRequestId,
          proxyRequestId: proxyContext.proxyRequestId,
          requestParams: request.params,
          error: 'Client is not allowed to request sampling',
          duration: Date.now() - startTime,
          statusCode: 403,
        });
      }
      throw new McpError(
        ErrorCode.InvalidParams,
        'Client is not allowed to request sampling'
      );
    }

    // Use ProxySession to forward request to Client
    try {
      const options: RequestOptions = {};
      const result = await proxySession.forwardSamplingToClient(request, options);

      // Log ReverseSamplingResponse (1202)
      if (sessionLogger) {
        await sessionLogger.logReverseRequest({
          action: MCPEventLogType.ReverseSamplingResponse,
          serverId: serverId,
          upstreamRequestId: '',
          uniformRequestId: uniformRequestId,
          parentUniformRequestId: proxyContext.uniformRequestId,
          proxyRequestId: proxyContext.proxyRequestId,
          requestParams: request.params,
          responseResult: result,
          duration: Date.now() - startTime,
          statusCode: 200,
        });
      }

      return result;
    } catch (error) {
      // Log error response
      if (sessionLogger) {
        await sessionLogger.logReverseRequest({
          action: MCPEventLogType.ReverseSamplingResponse,
          serverId: serverId,
          upstreamRequestId: '',
          uniformRequestId: uniformRequestId,
          parentUniformRequestId: proxyContext.uniformRequestId,
          proxyRequestId: proxyContext.proxyRequestId,
          requestParams: request.params,
          error: String(error),
          duration: Date.now() - startTime,
          statusCode: 500,
        });
      }
      throw error;
    }
  }
  
  /**
   * Handle Roots List request from Server
   */
  async handleRootsListRequest(
    serverId: string,
    request: ListRootsRequest,
    proxyContext: ProxyContext
  ): Promise<ListRootsResult> {
    // Extract sessionId from proxyRequestId (format: "sessionId:originalId:timestamp")
    const sessionId = proxyContext.proxyRequestId.split(':')[0];

    this.logger.debug({
      serverId,
      sessionId,
      proxyRequestId: proxyContext.proxyRequestId,
      parentUniformRequestId: proxyContext.uniformRequestId,
      method: 'roots/list'
    }, 'Handling roots list request from server');

    // Get ProxySession through sessionId
    const proxySession = SessionStore.instance.getProxySession(sessionId);
    if (!proxySession) {
      this.logger.error({ sessionId }, 'No ProxySession found for sessionId');
      throw new McpError(
        ErrorCode.InvalidRequest,
        `No ProxySession found for sessionId: ${sessionId}`
      );
    }

    // Get SessionLogger for this session
    const sessionLogger = SessionStore.instance.getSessionLogger(sessionId);

    // Log ReverseRootsRequest (1203)
    const uniformRequestId = LogService.getInstance().generateUniformRequestId(sessionId);
    const startTime = Date.now();

    // Permission check - check if client supports roots
    if (!proxySession.clientSupportsRoots()) {
      if (sessionLogger) {
        await sessionLogger.logReverseRequest({
          action: MCPEventLogType.ReverseRootsRequest,
          serverId: serverId,
          upstreamRequestId: '',
          uniformRequestId: uniformRequestId,
          parentUniformRequestId: proxyContext.uniformRequestId,
          proxyRequestId: proxyContext.proxyRequestId,
          requestParams: request.params,
          error: 'Client does not support roots capability',
          duration: Date.now() - startTime,
          statusCode: 403,
        });
      }
      throw new McpError(
        ErrorCode.MethodNotFound,
        'Client does not support roots capability'
      );
    }

    // Use ProxySession to forward request to Client
    try {
      const options: RequestOptions = {};
      const result = await proxySession.forwardRootsListToClient(request, options);

      // Log ReverseRootsResponse (1204)
      if (sessionLogger) {
        await sessionLogger.logReverseRequest({
          action: MCPEventLogType.ReverseRootsResponse,
          serverId: serverId,
          upstreamRequestId: '',
          uniformRequestId: uniformRequestId,
          parentUniformRequestId: proxyContext.uniformRequestId,
          proxyRequestId: proxyContext.proxyRequestId,
          requestParams: request.params,
          responseResult: result,
          duration: Date.now() - startTime,
          statusCode: 200,
        });
      }

      return result;
    } catch (error) {
      // Log error response
      if (sessionLogger) {
        await sessionLogger.logReverseRequest({
          action: MCPEventLogType.ReverseRootsResponse,
          serverId: serverId,
          upstreamRequestId: '',
          uniformRequestId: uniformRequestId,
          parentUniformRequestId: proxyContext.uniformRequestId,
          proxyRequestId: proxyContext.proxyRequestId,
          requestParams: request.params,
          error: String(error),
          duration: Date.now() - startTime,
          statusCode: 500,
        });
      }
      throw error;
    }
  }
  
  /**
   * Handle Elicitation request from Server
   */
  async handleElicitationRequest(
    serverId: string,
    request: ElicitRequest,
    proxyContext: ProxyContext
  ): Promise<ElicitResult> {
    // Extract sessionId from proxyRequestId (format: "sessionId:originalId:timestamp")
    const sessionId = proxyContext.proxyRequestId.split(':')[0];

    this.logger.debug({
      serverId,
      sessionId,
      proxyRequestId: proxyContext.proxyRequestId,
      parentUniformRequestId: proxyContext.uniformRequestId,
      method: 'elicit/input',
      requestedSchema: request.params
    }, 'Handling elicitation request from server');

    // Get ProxySession through sessionId
    const proxySession = SessionStore.instance.getProxySession(sessionId);
    if (!proxySession) {
      this.logger.error({ sessionId }, 'No ProxySession found for sessionId');
      throw new McpError(
        ErrorCode.InvalidRequest,
        `No ProxySession found for sessionId: ${sessionId}`
      );
    }

    // Get SessionLogger for this session
    const sessionLogger = SessionStore.instance.getSessionLogger(sessionId);

    // Log ReverseElicitRequest (1205)
    const uniformRequestId = LogService.getInstance().generateUniformRequestId(sessionId);
    const startTime = Date.now();

    // Permission check
    if (!proxySession.canServerRequestElicitation()) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Client is not allowed to request user input'
      );
    }

    // Use ProxySession to forward request to Client
    try {
      const options: RequestOptions = {};
      const result = await proxySession.forwardElicitationToClient(request, options);

      // Log ReverseElicitResponse (1206)
      if (sessionLogger) {
        await sessionLogger.logReverseRequest({
          action: MCPEventLogType.ReverseElicitResponse,
          serverId: serverId,
          upstreamRequestId: '',
          uniformRequestId: uniformRequestId,
          parentUniformRequestId: proxyContext.uniformRequestId,
          proxyRequestId: proxyContext.proxyRequestId,
          requestParams: request.params,
          responseResult: result,
          duration: Date.now() - startTime,
          statusCode: 200,
        });
      }

      return result;
    } catch (error) {
      // Log error response
      if (sessionLogger) {
        await sessionLogger.logReverseRequest({
          action: MCPEventLogType.ReverseElicitResponse,
          serverId: serverId,
          upstreamRequestId: '',
          uniformRequestId: uniformRequestId,
          parentUniformRequestId: proxyContext.uniformRequestId,
          proxyRequestId: proxyContext.proxyRequestId,
          requestParams: request.params,
          error: String(error),
          duration: Date.now() - startTime,
          statusCode: 500,
        });
      }
      throw error;
    }
  }
  
  
  /**
   * Handle tools list changed notification
   */
  async handleToolsListChanged(serverId: string): Promise<void> {
    this.logger.info({ serverId }, 'Broadcasting tools list changed for server');
    
    // Get all sessions
    const sessions = SessionStore.instance.getAllSessions();
    const notificationKey = `tools_changed_${serverId}_${Date.now()}`;

    socketNotifier.notifyUserPermissionChangedByServer(serverId);
    
    for (const session of sessions) {
      const sessionId = session.sessionId;
      // Check permissions
      if (!session.canAccessServer(serverId)) {
        continue;
      }
      
      // Check if already sent (deduplication)
      const sent = this.sentNotifications.get(sessionId) || new Set();
      if (sent.has(notificationKey)) {
        continue;
      }
      
      // Send notification
      try {
        session.sendToolListChanged();
        // Record as sent
        sent.add(notificationKey);
        this.sentNotifications.set(sessionId, sent);

        // Clean up old notification records (keep last 100)
        if (sent.size > 100) {
          const array = Array.from(sent);
          sent.clear();
          array.slice(-100).forEach(k => sent.add(k));
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
    
    // Get all sessions
    const sessions = SessionStore.instance.getAllSessions();
    const notificationKey = `resources_changed_${serverId}_${Date.now()}`;

    socketNotifier.notifyUserPermissionChangedByServer(serverId);
    
    for (const session of sessions) {
      const sessionId = session.sessionId;
      // Check permissions
      if (!session.canAccessServer(serverId)) {
        continue;
      }
      
      // Check if already sent (deduplication)
      const sent = this.sentNotifications.get(sessionId) || new Set();
      if (sent.has(notificationKey)) {
        continue;
      }
      
      // Send notification
      try {
        session.sendResourceListChanged();
        // Record as sent
        sent.add(notificationKey);
        this.sentNotifications.set(sessionId, sent);

        // Clean up old notification records (keep last 100)
        if (sent.size > 100) {
          const array = Array.from(sent);
          sent.clear();
          array.slice(-100).forEach(k => sent.add(k));
        }
      } catch (error) {
        this.logger.error({ error, sessionId }, 'Failed to send resources list changed to session');
      }
    }
  }

  /**
   * Handle resource updated notification
   */
  async handleResourceUpdated(serverId: string, notification: ResourceUpdatedNotification): Promise<void> {
    const resourceUri = notification.params.uri;
    const subscriptionKey = `${serverId}::${resourceUri}`;

    // Get subscribers for this resource
    const subscribers = ServerManager.instance.getResourceSubscribers(subscriptionKey);

    if (subscribers.size === 0) {
      this.logger.debug({ subscriptionKey }, 'No subscribers for resource, skipping notification');
      return;
    }

    this.logger.debug({ serverId, resourceUri, subscriberCount: subscribers.size }, 'Broadcasting resource updated to subscribers');

    // Get all sessions
    const sessions = SessionStore.instance.getAllSessions();
    const notificationKey = `resource_updated_${serverId}_${resourceUri}_${Date.now()}`;

    for (const session of sessions) {
      const sessionId = session.sessionId;

      // Only notify sessions that subscribed to this resource
      if (!subscribers.has(sessionId)) {
        continue;
      }

      // Check permissions (additional security check)
      if (!session.canAccessServer(serverId)) {
        continue;
      }

      // Check if already sent (deduplication)
      const sent = this.sentNotifications.get(sessionId) || new Set();
      if (sent.has(notificationKey)) {
        continue;
      }

      // Send notification
      try {
        session.sendResourceUpdated(serverId, notification);
        // Record as sent
        sent.add(notificationKey);
        this.sentNotifications.set(sessionId, sent);

        // Clean up old notification records (keep last 100)
        if (sent.size > 100) {
          const array = Array.from(sent);
          sent.clear();
          array.slice(-100).forEach(k => sent.add(k));
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
    
    // Get all sessions
    const sessions = SessionStore.instance.getAllSessions();
    const notificationKey = `prompts_changed_${serverId}_${Date.now()}`;

    socketNotifier.notifyUserPermissionChangedByServer(serverId);
    
    for (const session of sessions) {
      const sessionId = session.sessionId;
      // Check permissions
      if (!session.canAccessServer(serverId)) {
        continue;
      }
      
      // Check if already sent (deduplication)
      const sent = this.sentNotifications.get(sessionId) || new Set();
      if (sent.has(notificationKey)) {
        continue;
      }
      
      // Send notification
      try {
        session.sendPromptListChanged();
        // Record as sent
        sent.add(notificationKey);
        this.sentNotifications.set(sessionId, sent);

        // Clean up old notification records (keep last 100)
        if (sent.size > 100) {
          const array = Array.from(sent);
          sent.clear();
          array.slice(-100).forEach(k => sent.add(k));
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
      totalNotificationKeys: totalKeys
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