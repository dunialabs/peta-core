import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RequestHandlerExtra, RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  InitializeRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  PingRequestSchema,
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  ListRootsRequestSchema,
  ListRootsResultSchema,
  ElicitRequestSchema,
  ElicitResultSchema,
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  RootsListChangedNotificationSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
  type ListResourcesRequest,
  type ListResourceTemplatesRequest,
  type ListResourceTemplatesResult,
  type ResourceTemplate,
  type GetPromptRequest,
  type ListPromptsRequest,
  type InitializeRequest,
  type CompleteRequest,
  type SetLevelRequest,
  type PingRequest,
  type CreateMessageRequest,
  type CreateMessageResult,
  type ListRootsRequest,
  type ListRootsResult,
  type ElicitRequest,
  type ElicitResult,
  type CancelledNotification,
  type ProgressNotification,
  type RootsListChangedNotification,
  type SubscribeRequest,
  type UnsubscribeRequest,
  type ServerRequest,
  type CallToolResult,
  type ListToolsResult,
  type ReadResourceResult,
  type ListResourcesResult,
  type GetPromptResult,
  type ListPromptsResult,
  type InitializeResult,
  type CompleteResult,
  type EmptyResult,
  type Tool,
  type Resource,
  type Prompt,
  isInitializeRequest,
  type ClientNotification,
  type ClientNotificationSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { ClientSession } from './ClientSession.js';
import { ServerManager } from './ServerManager.js';
import { LogService } from '../../log/LogService.js';
import {
  getReverseRequestTimeout,
  ReverseRequestTimeoutError,
} from '../../config/reverseRequestConfig.js';
import { SessionLogger } from '../../log/SessionLogger.js';
import { Request, Response } from 'express';
import { PersistentEventStore } from './PersistentEventStore.js';
import { RequestIdMapper } from './RequestIdMapper.js';
import { APP_INFO } from '../../config/config.js';
import { ApprovalStatus, DangerLevel, MCPEventLogType, PolicyDecision } from '../../types/enums.js';
import { socketNotifier } from '../../socket/SocketNotifier.js';
import { ProxyContext } from '../../types/mcp.types.js';
import { createLogger } from '../../logger/index.js';
import { policyEngine } from '../services/PolicyEngine.js';
import { approvalService, ApprovalRateLimitError } from '../services/ApprovalService.js';
import { ResultCacheService } from './cache/ResultCacheService.js';
import type { CacheScopeContext, ResolvedCachePolicy } from './cache/types.js';

/**
 * MCP Proxy Session
 * Core proxy session class that acts as both Server (to upstream) and Client (to downstream)
 */
export class ProxySession {
  private upstreamServer: Server;
  private upstreamTransport?: StreamableHTTPServerTransport;
  private downstreamClients: Map<string, Client> = new Map();
  private isInitialized: boolean = false;
  private eventStore: PersistentEventStore;

  // RequestId mapper
  private requestIdMapper: RequestIdMapper;

  // Progress tracking
  private progressTrackers = new Map<
    string,
    {
      serverId: string;
      total?: number;
      current?: number;
    }
  >();

  // Notification subscription management
  private notificationSubscriptions = new Map<string, Set<string>>();

  // Logger for ProxySession
  private logger: ReturnType<typeof createLogger>;
  private closeTriggered: boolean = false;

  // Approval wait configuration
  private static readonly APPROVAL_POLL_INTERVAL_MS = 3_000;
  private static readonly APPROVAL_WAIT_TIMEOUT_MS = 55_000;

  constructor(
    private sessionId: string,
    private userId: string,
    private clientSession: ClientSession,
    private sessionLogger: SessionLogger,
    eventStore: PersistentEventStore,
    private onclose: (sessionId: string) => Promise<void>,
  ) {
    // Initialize logger (needed in constructor because sessionId is required)
    this.logger = createLogger('ProxySession', { sessionId: this.sessionId });
    this.eventStore = eventStore;
    this.requestIdMapper = new RequestIdMapper(sessionId);

    // Initialize MCP Server instance
    this.upstreamServer = new Server(
      {
        name: APP_INFO.name,
        version: APP_INFO.version,
      },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true, subscribe: true },
          prompts: { listChanged: true },
          completions: {},
          logging: {},
        },
      },
    );
    // Set up request handlers
    this.setupRequestHandlers();
  }

  /**
   * Set up all MCP request handlers
   */
  private setupRequestHandlers(): void {
    this.upstreamServer.oninitialized = () => {
      this.logger.info({ userId: this.userId }, 'ProxySession initialized');

      this.isInitialized = true;
      this.clientSession.connectionInitialized(this.upstreamServer);
    };

    // Tools
    this.upstreamServer.setRequestHandler(
      ListToolsRequestSchema,
      async (request: ListToolsRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handleToolsList(request, extra),
    );

    this.upstreamServer.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handleToolCall(request, extra),
    );

    // Resources
    this.upstreamServer.setRequestHandler(
      ListResourcesRequestSchema,
      async (request: ListResourcesRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handleResourcesList(request, extra),
    );

    this.upstreamServer.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (request: ListResourceTemplatesRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handleResourcesTemplatesList(request, extra),
    );

    this.upstreamServer.setRequestHandler(
      ReadResourceRequestSchema,
      async (request: ReadResourceRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handleResourceRead(request, extra),
    );

    // Resource subscriptions
    this.upstreamServer.setRequestHandler(
      SubscribeRequestSchema,
      async (request: SubscribeRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handleSubscribe(request, extra),
    );

    this.upstreamServer.setRequestHandler(
      UnsubscribeRequestSchema,
      async (request: UnsubscribeRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handleUnsubscribe(request, extra),
    );

    // Prompts
    this.upstreamServer.setRequestHandler(
      ListPromptsRequestSchema,
      async (request: ListPromptsRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handlePromptsList(request, extra),
    );

    this.upstreamServer.setRequestHandler(
      GetPromptRequestSchema,
      async (request: GetPromptRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handlePromptGet(request, extra),
    );

    // Completion
    this.upstreamServer.setRequestHandler(
      CompleteRequestSchema,
      async (request: CompleteRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handleComplete(request, extra),
    );

    // Logging
    this.upstreamServer.setRequestHandler(
      SetLevelRequestSchema,
      async (request: SetLevelRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handleSetLoggingLevel(request, extra),
    );

    // Ping
    this.upstreamServer.setRequestHandler(
      PingRequestSchema,
      async (request: PingRequest, extra: RequestHandlerExtra<any, any>) =>
        this.handlePing(request, extra),
    );
  }

  private setupNotificationHandlers(): void {
    if (this.clientSupportsRoots()) {
      this.upstreamServer.setNotificationHandler(
        RootsListChangedNotificationSchema,
        async (notification: RootsListChangedNotification) =>
          this.handleRootsListChanged(notification),
      );
    }

    this.upstreamServer.setNotificationHandler(
      CancelledNotificationSchema,
      async (notification: CancelledNotification) => this.handleCancelledNotification(notification),
    );

    // this.upstreamServer.setNotificationHandler(
    //   ProgressNotificationSchema,
    //   async (notification: ProgressNotification) => this.handleProgressNotification(notification)
    // );
  }

  /**
   * Handle HTTP request
   */
  async handleRequest(req: Request, res: Response, body: any): Promise<void> {
    try {
      let transport: StreamableHTTPServerTransport;
      if (this.upstreamTransport) {
        transport = this.upstreamTransport;
      } else if (isInitializeRequest(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => this.sessionId,
          onsessioninitialized: async (sessionId) => {
            this.clientSession.capabilities = this.upstreamServer.getClientCapabilities();
            this.clientSession.clientInfo = this.upstreamServer.getClientVersion();

            this.logger.info(
              {
                sessionId: sessionId,
                clientInfo: this.clientSession.clientInfo,
                capabilities: this.clientSession.capabilities,
              },
              'Session initialized',
            );
            this.isInitialized = true;
          },
          onsessionclosed: async (sessionId: string) => {
            this.logger.info({ sessionId }, 'Session closed');
            this.triggerOnClose(sessionId);
          },
        });

        transport.onclose = () => {
          //TODO: Log event
          this.triggerOnClose(this.sessionId);
        };

        // Connect server to transport layer
        await this.upstreamServer.connect(transport);
        this.upstreamTransport = transport;

        this.setupNotificationHandlers();
      } else {
        // Invalid request - no session ID or not initialization request

        let message = 'Bad Request: No valid session ID provided';
        if (req.method === 'DELETE') {
          message = 'Bad Request: No active session to terminate';
        }

        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: ErrorCode.ConnectionClosed,
            message: message,
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, body);
    } catch (error) {
      this.logger.error({ error }, 'ProxySession error');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: ErrorCode.InternalError,
            message: String(error),
          },
          id: null,
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * Handle tools/list request - aggregate tools from all servers
   */
  private async handleToolsList(
    request: ListToolsRequest,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<ListToolsResult> {
    this.logger.debug('Handling tools/list');

    const startTime = Date.now();
    const allTools = this.clientSession.listTools();

    await this.sessionLogger.logClientRequest({
      action: MCPEventLogType.ResponseToolList,
      upstreamRequestId: String(extra.requestId),
      uniformRequestId: LogService.getInstance().generateUniformRequestId(this.sessionId),
      requestParams: request.params,
      responseResult: { tools: allTools.tools.map((tool: Tool) => tool.name) },
      duration: Date.now() - startTime,
      statusCode: 200,
    });

    return allTools;
  }

  /**
   * Handle tools/call request - route to correct server
   */
  private async handleToolCall(
    request: CallToolRequest,
    extra: RequestHandlerExtra<any, any>,
    retryCount: number = 0,
  ): Promise<CallToolResult> {
    const startTime = Date.now();
    const toolName = request.params.name;
    this.logger.debug({ toolName }, 'Handling tool call');

    // Generate uniformRequestId for correlation
    const uniformRequestId = LogService.getInstance().generateUniformRequestId(this.sessionId);
    const originalRequestId = extra.requestId;
    let approvalRequestId: string | null = null;
    let approvalHeartbeatTimer: NodeJS.Timeout | null = null;

    const result = this.clientSession.parseName(toolName);

    if (!result) {
      const errorTime = Date.now();
      const errorMsg = `Tool ${request.params.name} not found`;

      // Log failed request (forward failure)
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestTool,
        serverId: 'unknown',
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `Error: ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 404,
      });

      throw new McpError(ErrorCode.MethodNotFound, errorMsg);
    }

    // Permission check
    if (!this.clientSession.canUseTool(result.serverID, result.originalName)) {
      const errorTime = Date.now();
      const errorMsg = `Permission denied for tool: ${toolName}`;

      // Log failed request
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestTool,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `Error: ErrorPermission: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 403,
      });

      throw new McpError(ErrorCode.InvalidParams, errorMsg);
    }

    // Ensure server is available (lazy start)
    await ServerManager.instance.ensureServerAvailable(result.serverID, this.clientSession.userId);

    const targetServerContext = ServerManager.instance.getServerContext(
      result.serverID,
      this.clientSession.userId,
    );

    // Get downstream connection
    const client = targetServerContext?.connection;

    if (!client) {
      const errorTime = Date.now();
      const errorMsg = `No server available for tool: ${toolName}`;

      // Log failed request
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestTool,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `Error: ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 503,
      });

      throw new McpError(ErrorCode.InvalidParams, errorMsg);
    }

    const userDangerLevel = this.clientSession.getDangerLevel(result.serverID, result.originalName);
    const serverDangerLevel = targetServerContext!.getDangerLevel(result.originalName);
    const dangerLevel: DangerLevel = userDangerLevel ?? serverDangerLevel ?? DangerLevel.Silent;

    const policyResult = await policyEngine.evaluate({
      userId: this.userId,
      serverId: result.serverID,
      toolName: result.originalName,
      args: (request.params.arguments ?? {}) as Record<string, unknown>,
      dangerLevel,
    });

    if (policyResult.decision === PolicyDecision.Deny) {
      const errorTime = Date.now();
      const errorMsg = `Tool execution denied by policy: ${policyResult.reason ?? 'policy rule'}`;

      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestTool,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `Error: PolicyDenied: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 403,
      });

      throw new McpError(ErrorCode.InvalidRequest, errorMsg);
    }

    if (policyResult.decision === PolicyDecision.RequireApproval) {
      let approvalCheck: Awaited<ReturnType<typeof approvalService.checkOrCreateApproval>>;
      try {
        approvalCheck = await approvalService.checkOrCreateApproval({
          userId: this.userId,
          serverId: result.serverID,
          toolName: result.originalName,
          args: (request.params.arguments ?? {}) as Record<string, unknown>,
          policyVersion: policyResult.policyVersion,
          uniformRequestId,
        });
      } catch (error) {
        if (error instanceof ApprovalRateLimitError) {
          const rateLimitMsg = this.buildApprovalOutcomeMessage({
            approvalRequestId: null,
            resumeToken: null,
            requestHash: null,
            toolName: result.originalName,
            reason: policyResult.reason ?? 'Policy requires approval',
            policyVersion: policyResult.policyVersion,
            kind: 'approval_rate_limited',
            status: 'rate_limited',
            summary: error.message,
          });

          await this.sessionLogger.logClientRequest({
            action: MCPEventLogType.RequestTool,
            serverId: result.serverID,
            upstreamRequestId: String(originalRequestId),
            uniformRequestId,
            requestParams: request.params,
            error: `ApprovalRateLimited: ${error.message}`,
            duration: Date.now() - startTime,
            statusCode: 429,
          });

          return {
            content: [{ type: 'text', text: rateLimitMsg.text }],
            isError: false,
            _meta: { approval: rateLimitMsg.meta, retryAfterSeconds: 60 },
          };
        }
        throw error;
      }

      if (approvalCheck.needsApproval) {
        if (approvalCheck.created) {
          socketNotifier.notifyApprovalCreated(this.userId, {
            id: approvalCheck.request!.id,
            toolName: result.originalName,
            serverId: result.serverID,
            redactedArgs: approvalCheck.request!.redactedArgs,
            expiresAt: approvalCheck.request!.expiresAt,
            createdAt: approvalCheck.request!.createdAt,
            status: approvalCheck.request!.status,
            uniformRequestId,
            policyVersion: policyResult.policyVersion,
            matchedRuleId: policyResult.matchedRuleId,
            reason: policyResult.reason,
            resumeToken: approvalCheck.request!.id,
          });
        }

        this.logger.info(
          { approvalRequestId: approvalCheck.request!.id, toolName: result.originalName },
          'Waiting for approval decision',
        );

        const waitResult = await this.waitForApproval(
          approvalCheck.request!.id,
          extra.signal,
          request.params?._meta?.progressToken,
          originalRequestId,
        );

        if (waitResult.status === 'rejected') {
          const errorMsg = `Tool call rejected by administrator: ${waitResult.decisionReason ?? 'No reason provided'}`;
          await this.sessionLogger.logClientRequest({
            action: MCPEventLogType.RequestTool,
            serverId: result.serverID,
            upstreamRequestId: String(originalRequestId),
            uniformRequestId,
            requestParams: request.params,
            error: `Error: ApprovalRejected: ${errorMsg}`,
            duration: Date.now() - startTime,
            statusCode: 403,
          });
          return {
            content: [{ type: 'text', text: errorMsg }],
            isError: true,
          };
        }

        if (waitResult.status !== 'approved') {
          const replayResult = await this.tryBuildReplayToolResult(approvalCheck.request!.id);
          if (replayResult) {
            await this.sessionLogger.logClientRequest({
              action: MCPEventLogType.RequestTool,
              serverId: result.serverID,
              upstreamRequestId: String(originalRequestId),
              uniformRequestId,
              requestParams: request.params,
              responseResult: replayResult,
              duration: Date.now() - startTime,
              statusCode: replayResult.isError ? 500 : 200,
            });
            return replayResult;
          }

          const nonExecutedSummaryByStatus: Record<string, string> = {
            timeout: 'Approval is still pending and this tool call timed out before execution.',
            expired: 'Approval request expired before a decision. This tool call did not execute.',
            aborted: 'Client cancelled while waiting for approval. This tool call did not execute.',
            executing:
              'Execution has started in another session. This call did not execute the tool.',
            executed:
              'This request already executed in another session. This call did not execute the tool.',
            failed: `Execution failed in another session${waitResult.decisionReason ? `: ${waitResult.decisionReason}` : '.'}`,
          };

          const pendingMsg = this.buildApprovalOutcomeMessage({
            approvalRequestId: approvalCheck.request!.id,
            resumeToken: approvalCheck.request!.id,
            requestHash: approvalCheck.requestHash,
            toolName: result.originalName,
            reason: policyResult.reason ?? 'Policy requires approval',
            policyVersion: policyResult.policyVersion,
            kind: 'approval_pending',
            status: waitResult.status,
            summary: nonExecutedSummaryByStatus[waitResult.status] ?? 'Tool was not executed.',
          });

          await this.sessionLogger.logClientRequest({
            action: MCPEventLogType.RequestTool,
            serverId: result.serverID,
            upstreamRequestId: String(originalRequestId),
            uniformRequestId,
            requestParams: request.params,
            error: `ApprovalPending: Awaiting human approval (${waitResult.status}). Request ID: ${approvalCheck.request!.id}`,
            duration: Date.now() - startTime,
            statusCode: 202,
          });

          return {
            content: [{ type: 'text', text: pendingMsg.text }],
            isError: false,
            _meta: { approval: pendingMsg.meta },
          };
        }

        this.logger.info(
          { approvalRequestId: approvalCheck.request!.id, toolName: result.originalName },
          'Approval granted, proceeding with execution',
        );
      }

      const claimResult = await approvalService.claimForExecutionById(approvalCheck.request!.id);
      if (!claimResult.claimed) {
        const latest = await approvalService.getById(approvalCheck.request!.id).catch(() => null);
        const waitStatus = this.mapApprovalStatusToWaitStatus(latest?.status);
        const replayResult = await this.tryBuildReplayToolResult(approvalCheck.request!.id);
        if (replayResult) {
          await this.sessionLogger.logClientRequest({
            action: MCPEventLogType.RequestTool,
            serverId: result.serverID,
            upstreamRequestId: String(originalRequestId),
            uniformRequestId,
            requestParams: request.params,
            responseResult: replayResult,
            duration: Date.now() - startTime,
            statusCode: replayResult.isError ? 500 : 200,
          });
          return replayResult;
        }

        const claimMsg = this.buildApprovalOutcomeMessage({
          approvalRequestId: approvalCheck.request!.id,
          resumeToken: approvalCheck.request!.id,
          requestHash: approvalCheck.requestHash,
          toolName: result.originalName,
          reason: policyResult.reason ?? 'Policy requires approval',
          policyVersion: policyResult.policyVersion,
          kind: 'approval_pending',
          status: waitStatus,
          summary:
            'Execution is already in progress or completed elsewhere. This call did not execute the tool.',
        });

        await this.sessionLogger.logClientRequest({
          action: MCPEventLogType.RequestTool,
          serverId: result.serverID,
          upstreamRequestId: String(originalRequestId),
          uniformRequestId,
          requestParams: request.params,
          error: `ApprovalClaimLost: ${waitStatus}. Request ID: ${approvalCheck.request!.id}`,
          duration: Date.now() - startTime,
          statusCode: 202,
        });

        return {
          content: [{ type: 'text', text: claimMsg.text }],
          isError: false,
          _meta: { approval: claimMsg.meta },
        };
      }

      approvalRequestId = claimResult.request!.id;
    }

    // Use RequestIdMapper to generate unique proxy request ID
    const proxyRequestId = this.requestIdMapper.registerClientRequest(
      originalRequestId,
      request.method,
      result.serverID,
    );

    // Deep copy request and inject proxyContext for reverse request routing
    const proxyContext: ProxyContext = {
      proxyRequestId: proxyRequestId,
      uniformRequestId: uniformRequestId,
    };

    const copyParams = {
      ...request.params,
      name: result.originalName,
      _meta: {
        ...request.params._meta,
        proxyContext: proxyContext,
      },
    };

    this.logger.debug(
      {
        originalRequestId,
        proxyRequestId,
        uniformRequestId,
        toolName,
        serverId: result.serverID,
        method: request.method,
      },
      'Registering tool call request',
    );

    const cacheService = ResultCacheService.instance;
    const toolCachePolicy = cacheService.enabled
      ? cacheService.resolveToolPolicy(targetServerContext!.capabilitiesConfig, result.originalName)
      : null;
    const scopeCtx: CacheScopeContext = { userId: this.userId };

    if (toolCachePolicy && !approvalRequestId) {
      try {
        const cached = await cacheService.lookup(
          'tool',
          result.serverID,
          result.originalName,
          scopeCtx,
          toolCachePolicy,
          request.params.arguments,
        );
        if (cached.hit && cached.entry) {
          this.logger.debug({ toolName, serverId: result.serverID }, 'Tool call served from cache');
          await this.sessionLogger.logClientRequest({
            action: MCPEventLogType.ResponseTool,
            serverId: result.serverID,
            upstreamRequestId: String(originalRequestId),
            uniformRequestId,
            requestParams: request.params,
            responseResult: cached.entry.payload,
            duration: Date.now() - startTime,
            statusCode: 200,
          });
          this.requestIdMapper.removeMapping(proxyRequestId);
          return cached.entry.payload as CallToolResult;
        }
      } catch (cacheError) {
        this.logger.warn(
          { error: cacheError, toolName },
          'Cache lookup failed, proceeding without cache',
        );
      }
    }

    let isReconnected: boolean | undefined;

    try {
      if (approvalRequestId) {
        approvalHeartbeatTimer = setInterval(() => {
          void approvalService.touchExecuting(approvalRequestId!).catch(() => null);
        }, 30_000);
      }

      // Forward request to downstream server, passing signal and proxyRequestId
      const serverResult = (await client.callTool(copyParams, CallToolResultSchema, {
        signal: extra.signal, // Pass cancellation signal
        relatedRequestId: proxyRequestId, // Use proxyRequestId as related ID
      })) as CallToolResult;

      targetServerContext.clearTimeout();

      // Log response to client
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.ResponseTool,
        serverId: targetServerContext.serverEntity.serverId,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        responseResult: serverResult,
        duration: Date.now() - startTime,
        statusCode: serverResult.isError ? 500 : 200,
      });

      if (toolCachePolicy && !serverResult.isError) {
        cacheService
          .storeResult(
            'tool',
            result.serverID,
            result.originalName,
            scopeCtx,
            toolCachePolicy,
            request.params.arguments,
            serverResult,
          )
          .catch((storeError) => {
            this.logger.warn({ error: storeError, toolName }, 'Cache store failed');
          });
      }

      if (approvalRequestId) {
        if (serverResult.isError === true) {
          const failedReq = await approvalService
            .markFailed(approvalRequestId, 'Tool returned error')
            .catch(() => null);
          if (failedReq) {
            socketNotifier.notifyApprovalFailed(this.userId, {
              id: failedReq.id,
              toolName: result.originalName,
              error: 'Tool returned error',
              resumeToken: failedReq.id,
              executionResultAvailable: false,
            });
          }
        } else {
          const executedReq = await approvalService
            .markExecuted(approvalRequestId, serverResult)
            .catch(() => null);
          if (executedReq) {
            const replayPayload = this.extractReplayCallToolResult(executedReq.executionResult);
            socketNotifier.notifyApprovalExecuted(this.userId, {
              id: executedReq.id,
              toolName: result.originalName,
              resumeToken: executedReq.id,
              executionResultAvailable: replayPayload !== null,
              executionResultPreview: replayPayload
                ? this.buildExecutionResultPreview(replayPayload)
                : null,
            });
          }
        }
        approvalRequestId = null;
      }

      return serverResult;
    } catch (error) {
      this.logger.error({ error }, 'Error handling tool call');

      isReconnected = await targetServerContext?.recordTimeout(error);

      const errorMsg = String(error);

      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.ResponseTool,
        serverId: targetServerContext.serverEntity.serverId,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: errorMsg,
        duration: Date.now() - startTime,
        statusCode: 500,
      });

      if (approvalRequestId) {
        const failedReq = await approvalService
          .markFailed(approvalRequestId, errorMsg)
          .catch(() => null);
        if (failedReq) {
          socketNotifier.notifyApprovalFailed(this.userId, {
            id: failedReq.id,
            toolName: result.originalName,
            error: errorMsg,
            resumeToken: failedReq.id,
            executionResultAvailable: false,
          });
        }
        approvalRequestId = null;
      }

      const shouldRetry = approvalRequestId == null && isReconnected === false && retryCount < 2;
      if (shouldRetry) {
        return await this.handleToolCall(request, extra, retryCount + 1);
      }

      // Create error result
      const errorResult: CallToolResult = {
        content: [
          {
            type: 'text',
            text: errorMsg,
          },
        ],
        isError: true,
      };
      return errorResult;
    } finally {
      if (approvalHeartbeatTimer) {
        clearInterval(approvalHeartbeatTimer);
      }
      // Clean up request mapping
      this.requestIdMapper.removeMapping(proxyRequestId);
    }
  }

  /**
   * Wait for an approval request to be decided by polling.
   *
   * Polls approval status every APPROVAL_POLL_INTERVAL_MS until approved, rejected,
   * expired, client-aborted, or timeout (APPROVAL_WAIT_TIMEOUT_MS).
   * Performs an immediate check before entering the poll loop to minimize latency
   * when admin has already approved.
   */
  private async waitForApproval(
    approvalRequestId: string,
    signal?: AbortSignal,
    progressToken?: string | number,
    relatedRequestId?: string | number,
  ): Promise<{
    status:
      | 'approved'
      | 'rejected'
      | 'timeout'
      | 'expired'
      | 'aborted'
      | 'executing'
      | 'executed'
      | 'failed';
    decisionReason?: string | null;
  }> {
    const deadline = Date.now() + ProxySession.APPROVAL_WAIT_TIMEOUT_MS;
    let unknownStatusWarned = false;
    let nextProgressAt = Date.now() + 15_000;
    let progressSeq = 0;
    let lastWaitState: 'pending' | 'executing' = 'pending';

    if (signal?.aborted) {
      return { status: 'aborted' };
    }

    // Immediate check — admin may have already approved before we started waiting
    const immediate = await this.pollApprovalStatus(approvalRequestId, unknownStatusWarned);
    unknownStatusWarned = immediate.unknownStatusWarned;
    lastWaitState = immediate.waitState;
    if (immediate.result) {
      return immediate.result;
    }

    while (Date.now() < deadline) {
      if (signal?.aborted) return { status: 'aborted' };

      if (progressToken !== undefined && Date.now() >= nextProgressAt) {
        progressSeq += 1;
        await this.sendApprovalProgressNotification(progressToken, relatedRequestId, progressSeq);
        nextProgressAt = Date.now() + 15_000;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      // Abortable sleep with proper listener cleanup
      await new Promise<void>((resolve) => {
        const onTimeout = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(
          onTimeout,
          Math.min(ProxySession.APPROVAL_POLL_INTERVAL_MS, remainingMs),
        );
        signal?.addEventListener('abort', onAbort, { once: true });
      });

      if (signal?.aborted) return { status: 'aborted' };

      const poll = await this.pollApprovalStatus(approvalRequestId, unknownStatusWarned);
      unknownStatusWarned = poll.unknownStatusWarned;
      lastWaitState = poll.waitState;
      if (poll.result) {
        return poll.result;
      }
    }

    return { status: lastWaitState === 'executing' ? 'executing' : 'timeout' };
  }

  private async pollApprovalStatus(
    approvalRequestId: string,
    unknownStatusWarned: boolean,
  ): Promise<{
    result: {
      status: 'approved' | 'rejected' | 'expired' | 'executed' | 'failed';
      decisionReason?: string | null;
    } | null;
    waitState: 'pending' | 'executing';
    unknownStatusWarned: boolean;
  }> {
    try {
      const request = await approvalService.getById(approvalRequestId);
      if (!request)
        return { result: { status: 'expired' }, waitState: 'pending', unknownStatusWarned };

      switch (request.status) {
        case ApprovalStatus.Approved:
          return { result: { status: 'approved' }, waitState: 'pending', unknownStatusWarned };
        case ApprovalStatus.Rejected:
          return {
            result: { status: 'rejected', decisionReason: request.decisionReason },
            waitState: 'pending',
            unknownStatusWarned,
          };
        case ApprovalStatus.Expired:
          return { result: { status: 'expired' }, waitState: 'pending', unknownStatusWarned };
        case ApprovalStatus.Pending:
          return { result: null, waitState: 'pending', unknownStatusWarned };
        case ApprovalStatus.Executing:
          return { result: null, waitState: 'executing', unknownStatusWarned };
        case ApprovalStatus.Executed:
          return { result: { status: 'executed' }, waitState: 'executing', unknownStatusWarned };
        case ApprovalStatus.Failed:
          return {
            result: { status: 'failed', decisionReason: request.executionError },
            waitState: 'executing',
            unknownStatusWarned,
          };
        default:
          if (!unknownStatusWarned) {
            this.logger.warn(
              { approvalRequestId, status: request.status },
              'Unknown approval status encountered',
            );
          }
          return { result: null, waitState: 'pending', unknownStatusWarned: true };
      }
    } catch (error) {
      this.logger.warn({ error, approvalRequestId }, 'Failed to poll approval status, retrying');
      return { result: null, waitState: 'pending', unknownStatusWarned };
    }
  }

  private async sendApprovalProgressNotification(
    progressToken: string | number,
    relatedRequestId?: string | number,
    progress?: number,
  ): Promise<void> {
    try {
      await this.upstreamServer.notification(
        {
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: progress ?? 0,
          },
        },
        {
          relatedRequestId,
        },
      );
    } catch (error) {
      this.logger.debug({ error, progressToken }, 'Failed to send approval progress notification');
    }
  }

  private mapApprovalStatusToWaitStatus(
    status?: string,
  ): 'timeout' | 'expired' | 'aborted' | 'executing' | 'executed' | 'failed' {
    switch (status) {
      case ApprovalStatus.Expired:
        return 'expired';
      case ApprovalStatus.Executing:
        return 'executing';
      case ApprovalStatus.Executed:
        return 'executed';
      case ApprovalStatus.Failed:
        return 'failed';
      default:
        return 'timeout';
    }
  }

  private buildApprovalOutcomeMessage(input: {
    approvalRequestId: string | null;
    resumeToken: string | null;
    requestHash: string | null;
    toolName: string;
    reason: string;
    policyVersion: number;
    kind: 'approval_pending' | 'approval_rate_limited';
    status: string;
    summary: string;
  }): {
    text: string;
    meta: {
      kind: 'approval_pending' | 'approval_rate_limited';
      approvalRequestId: string | null;
      resumeToken: string | null;
      status: string;
      requestHash: string | null;
      toolName: string;
      policyVersion: number;
    };
  } {
    const meta = {
      kind: input.kind,
      approvalRequestId: input.approvalRequestId,
      resumeToken: input.resumeToken,
      status: input.status,
      requestHash: input.requestHash,
      toolName: input.toolName,
      policyVersion: input.policyVersion,
    };

    const text = [
      `TOOL NOT EXECUTED: ${input.summary}`,
      '',
      `Approval Request ID: ${input.approvalRequestId ?? 'N/A'}`,
      `Resume Token: ${input.resumeToken ?? 'N/A'}`,
      `Tool: ${input.toolName}`,
      `Reason: ${input.reason}`,
      '',
      this.getApprovalGuidanceByStatus(input.status),
    ].join('\n');

    return { text, meta };
  }

  private getApprovalGuidanceByStatus(status: string): string {
    switch (status) {
      case 'timeout':
      case 'executing':
        return 'Retry this exact tool call after approval or execution completes.';
      case 'expired':
        return 'A new approval request is required. Retry the same tool call to create one.';
      case 'aborted':
        return 'Retry this exact tool call if you still want to request approval.';
      case 'executed':
        return 'No retry needed for this request. Check prior result logs if required.';
      case 'failed':
        return 'Retry the tool call if you want a fresh execution attempt.';
      case 'rate_limited':
        return 'Wait and retry after the rate-limit window.';
      default:
        return 'Retry this exact tool call once approval is granted.';
    }
  }

  private async tryBuildReplayToolResult(
    approvalRequestId: string,
  ): Promise<CallToolResult | null> {
    const resultRequest = await approvalService.getResultById(approvalRequestId).catch(() => null);
    if (!resultRequest) {
      return null;
    }

    const replayPayload = this.extractReplayCallToolResult(resultRequest.executionResult);
    if (resultRequest.status === ApprovalStatus.Executed && replayPayload) {
      return replayPayload;
    }

    if (
      resultRequest.status === ApprovalStatus.Failed &&
      replayPayload &&
      replayPayload.isError === true
    ) {
      return replayPayload;
    }

    if (resultRequest.status === ApprovalStatus.Failed) {
      return {
        content: [
          {
            type: 'text',
            text: resultRequest.executionError ?? 'Execution failed in another request.',
          },
        ],
        isError: true,
      };
    }

    return null;
  }

  private extractReplayCallToolResult(executionResult: unknown): CallToolResult | null {
    if (!executionResult || typeof executionResult !== 'object' || Array.isArray(executionResult)) {
      return null;
    }

    const candidate = executionResult as Partial<CallToolResult>;
    if (!Array.isArray(candidate.content)) {
      return null;
    }

    const hasInvalidContentItem = candidate.content.some(
      (item) =>
        !item || typeof item !== 'object' || typeof (item as { type?: unknown }).type !== 'string',
    );
    if (hasInvalidContentItem) {
      return null;
    }

    return {
      content: candidate.content,
      isError: candidate.isError === true,
      _meta: candidate._meta,
      structuredContent: candidate.structuredContent,
    };
  }

  private buildExecutionResultPreview(result: CallToolResult): string | null {
    const firstText = result.content.find((item) => item.type === 'text');
    if (!firstText || typeof firstText.text !== 'string') {
      return null;
    }

    return firstText.text.slice(0, 180);
  }

  /**
   * Handle resources/list request - aggregate resources from all servers
   */
  private async handleResourcesList(
    request: ListResourcesRequest,
    _extra: RequestHandlerExtra<any, any>,
  ): Promise<ListResourcesResult> {
    this.logger.debug('Handling resources/list');

    const startTime = Date.now();
    const allResources = this.clientSession.listResources();

    await this.sessionLogger.logClientRequest({
      action: MCPEventLogType.ResponseResourceList,
      upstreamRequestId: String(_extra.requestId),
      uniformRequestId: LogService.getInstance().generateUniformRequestId(this.sessionId),
      requestParams: request.params,
      responseResult: {
        resources: allResources.resources.map((resource: Resource) => resource.uri),
      },
      duration: Date.now() - startTime,
      statusCode: 200,
    });

    return allResources;
  }

  private async handleResourcesTemplatesList(
    request: ListResourceTemplatesRequest,
    _extra: RequestHandlerExtra<any, any>,
  ): Promise<ListResourceTemplatesResult> {
    this.logger.debug('Handling resources/templates/list');

    const startTime = Date.now();
    const allResourceTemplates = this.clientSession.listResourceTemplates();

    await this.sessionLogger.logClientRequest({
      action: MCPEventLogType.ResponseResourceList,
      upstreamRequestId: String(_extra.requestId),
      uniformRequestId: LogService.getInstance().generateUniformRequestId(this.sessionId),
      requestParams: request.params,
      responseResult: {
        resourceTemplates: allResourceTemplates.resourceTemplates.map(
          (resourceTemplate: ResourceTemplate) => resourceTemplate.name,
        ),
      },
      duration: Date.now() - startTime,
      statusCode: 200,
    });

    return allResourceTemplates;
  }

  /**
   * Handle resources/read request - route to correct server
   */
  private async handleResourceRead(
    request: ReadResourceRequest,
    extra: RequestHandlerExtra<any, any>,
    retryCount: number = 0,
  ): Promise<ReadResourceResult> {
    const startTime = Date.now();
    const resourceUri = request.params.uri;
    this.logger.debug({ resourceUri }, 'Handling resource read');

    // Generate uniformRequestId for correlation
    const uniformRequestId = LogService.getInstance().generateUniformRequestId(this.sessionId);
    const originalRequestId = extra.requestId;

    const result = this.clientSession.parseName(resourceUri);

    if (!result) {
      const errorTime = Date.now();
      const errorMsg = `Invalid resource URI: ${resourceUri}`;

      // Log failed request
      this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 404,
      });

      throw new McpError(ErrorCode.InvalidParams, errorMsg);
    }

    // Permission check
    if (!this.clientSession.canAccessResource(result.serverID, result.originalName)) {
      const errorTime = Date.now();
      const errorMsg = `Permission denied for resource: ${resourceUri}`;

      this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `ErrorPermission: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 403,
      });

      throw new McpError(ErrorCode.InvalidParams, errorMsg);
    }

    // Ensure server is available (lazy start)
    await ServerManager.instance.ensureServerAvailable(result.serverID, this.clientSession.userId);

    // Routing decision
    const targetServer = ServerManager.instance.getServerContext(
      result.serverID,
      this.clientSession.userId,
    );

    if (!targetServer) {
      const errorTime = Date.now();
      const errorMsg = `No server available for resource: ${result.serverID}`;

      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 503,
      });

      throw new McpError(ErrorCode.InternalError, errorMsg);
    }

    // Get downstream connection
    const client = targetServer.connection;

    if (!client) {
      const errorTime = Date.now();
      const errorMsg = `No client available for resource: ${resourceUri}`;

      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 503,
      });

      throw new McpError(ErrorCode.InternalError, errorMsg);
    }

    // Use RequestIdMapper to generate unique proxy request ID
    const proxyRequestId = this.requestIdMapper.registerClientRequest(
      originalRequestId,
      request.method,
      result.serverID,
    );

    // Deep copy request and inject proxyContext for reverse request routing
    const proxyContext: ProxyContext = {
      proxyRequestId: proxyRequestId,
      uniformRequestId: uniformRequestId,
    };

    const requestCopy = JSON.parse(JSON.stringify(request));
    requestCopy.params.uri = result.originalName;
    requestCopy.params._meta = {
      ...requestCopy.params._meta,
      proxyContext: proxyContext,
    };

    const resCacheService = ResultCacheService.instance;
    const resCachePolicy = resCacheService.enabled
      ? resCacheService.resolveResourcePolicy(targetServer!.capabilitiesConfig, result.originalName)
      : null;
    const resScopeCtx: CacheScopeContext = { userId: this.userId };

    if (resCachePolicy) {
      try {
        const cached = await resCacheService.lookup(
          'resource',
          result.serverID,
          result.originalName,
          resScopeCtx,
          resCachePolicy,
          request.params,
        );
        if (cached.hit && cached.entry) {
          this.logger.debug(
            { resourceUri, serverId: result.serverID },
            'Resource read served from cache',
          );
          await this.sessionLogger.logClientRequest({
            action: MCPEventLogType.ResponseResource,
            serverId: result.serverID,
            upstreamRequestId: String(originalRequestId),
            uniformRequestId,
            requestParams: request.params,
            responseResult: cached.entry.payload,
            duration: Date.now() - startTime,
            statusCode: 200,
          });
          this.requestIdMapper.removeMapping(proxyRequestId);
          return cached.entry.payload as ReadResourceResult;
        }
      } catch (cacheError) {
        this.logger.warn(
          { error: cacheError, resourceUri },
          'Resource cache lookup failed, proceeding without cache',
        );
      }
    }

    let isReconnected: boolean | undefined;

    try {
      // Forward request, passing signal and proxyRequestId
      const serverResult = await client.readResource(requestCopy.params, {
        signal: extra.signal, // Pass cancellation signal
        relatedRequestId: proxyRequestId, // Use proxyRequestId as related ID
      });

      targetServer.clearTimeout();

      if (resCachePolicy) {
        resCacheService
          .storeResult(
            'resource',
            result.serverID,
            result.originalName,
            resScopeCtx,
            resCachePolicy,
            request.params,
            serverResult,
          )
          .catch((storeError) => {
            this.logger.warn({ error: storeError, resourceUri }, 'Resource cache store failed');
          });
      }

      try {
        // Log response to client
        await this.sessionLogger.logClientRequest({
          action: MCPEventLogType.ResponseResource,
          serverId: targetServer.serverEntity.serverId,
          upstreamRequestId: String(originalRequestId),
          uniformRequestId: uniformRequestId,
          requestParams: request.params,
          responseResult: serverResult,
          duration: Date.now() - startTime,
          statusCode: 200,
        });
      } catch (error) {
        this.logger.error({ error }, 'Error logging resource read response');
      }

      return serverResult;
    } catch (error) {
      this.logger.error({ error }, 'Error handling resource read');
      isReconnected = await targetServer.recordTimeout(error);
      const errorMsg = String(error);

      // Log error response to client
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.ResponseResource,
        serverId: targetServer.serverEntity.serverId,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: errorMsg,
        duration: Date.now() - startTime,
        statusCode: 500,
      });

      if (isReconnected === false && retryCount < 2) {
        return await this.handleResourceRead(request, extra, retryCount + 1);
      }

      throw error;
    } finally {
      // Clean up request mapping
      this.requestIdMapper.removeMapping(proxyRequestId);
    }
  }

  /**
   * Handle resources/subscribe request - subscribe to resource update notifications
   */
  private async handleSubscribe(
    request: SubscribeRequest,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<EmptyResult> {
    const startTime = Date.now();
    const resourceUri = request.params.uri;
    this.logger.debug({ resourceUri }, 'Handling resource subscribe');

    // Generate uniformRequestId for correlation
    const uniformRequestId = LogService.getInstance().generateUniformRequestId(this.sessionId);
    const originalRequestId = extra.requestId;

    const result = this.clientSession.parseName(resourceUri);

    if (!result) {
      const errorTime = Date.now();
      const errorMsg = `Invalid resource URI: ${resourceUri}`;

      // Log failed request
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 404,
      });

      throw new McpError(ErrorCode.InvalidParams, errorMsg);
    }

    // Permission check
    if (!this.clientSession.canAccessResource(result.serverID, result.originalName)) {
      const errorTime = Date.now();
      const errorMsg = `Permission denied for resource: ${resourceUri}`;

      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `ErrorPermission: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 403,
      });

      throw new McpError(ErrorCode.InvalidParams, errorMsg);
    }

    try {
      // Call ServerManager to aggregate subscription
      await ServerManager.instance.subscribeResource(
        result.serverID,
        result.originalName,
        this.sessionId,
        this.userId,
      );

      // Log successful subscription
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        responseResult: { subscribed: true },
        duration: Date.now() - startTime,
        statusCode: 200,
      });

      return {};
    } catch (error) {
      const errorMsg = String(error);

      // Log error
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `ErrorSubscribe: ${errorMsg}`,
        duration: Date.now() - startTime,
        statusCode: 500,
      });

      throw error;
    }
  }

  /**
   * Handle resources/unsubscribe request - unsubscribe from resource update notifications
   */
  private async handleUnsubscribe(
    request: UnsubscribeRequest,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<EmptyResult> {
    const startTime = Date.now();
    const resourceUri = request.params.uri;
    this.logger.debug({ resourceUri }, 'Handling resource unsubscribe');

    // Generate uniformRequestId for correlation
    const uniformRequestId = LogService.getInstance().generateUniformRequestId(this.sessionId);
    const originalRequestId = extra.requestId;

    const result = this.clientSession.parseName(resourceUri);

    if (!result) {
      const errorTime = Date.now();
      const errorMsg = `Invalid resource URI: ${resourceUri}`;

      // Log failed request
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 404,
      });

      throw new McpError(ErrorCode.InvalidParams, errorMsg);
    }

    try {
      // Call ServerManager to aggregate unsubscription
      await ServerManager.instance.unsubscribeResource(
        result.serverID,
        result.originalName,
        this.sessionId,
        this.userId,
      );

      // Log successful unsubscription
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        responseResult: { unsubscribed: true },
        duration: Date.now() - startTime,
        statusCode: 200,
      });

      return {};
    } catch (error) {
      const errorMsg = String(error);

      // Log error
      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestResource,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `ErrorUnsubscribe: ${errorMsg}`,
        duration: Date.now() - startTime,
        statusCode: 500,
      });

      throw error;
    }
  }

  /**
   * Handle prompts/list request - aggregate prompts from all servers
   */
  private async handlePromptsList(
    request: ListPromptsRequest,
    _extra: RequestHandlerExtra<any, any>,
  ): Promise<ListPromptsResult> {
    this.logger.debug('Handling prompts/list');

    const startTime = Date.now();
    const allPrompts = this.clientSession.listPrompts();

    await this.sessionLogger.logClientRequest({
      action: MCPEventLogType.ResponsePromptList,
      upstreamRequestId: String(_extra.requestId),
      uniformRequestId: LogService.getInstance().generateUniformRequestId(this.sessionId),
      requestParams: request.params,
      responseResult: { prompts: allPrompts.prompts.map((prompt: Prompt) => prompt.name) },
      duration: Date.now() - startTime,
      statusCode: 200,
    });

    return allPrompts;
  }

  /**
   * Handle prompts/get request - route to correct server
   */
  private async handlePromptGet(
    request: GetPromptRequest,
    extra: RequestHandlerExtra<any, any>,
    retryCount: number = 0,
  ): Promise<GetPromptResult> {
    const promptName = request.params.name;
    this.logger.debug({ promptName }, 'Handling prompt get');

    const startTime = Date.now();
    const uniformRequestId = LogService.getInstance().generateUniformRequestId(this.sessionId);
    const parseResult = this.clientSession.parseName(promptName);

    if (!parseResult) {
      this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestPrompt,
        upstreamRequestId: String(extra.requestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `Invalid prompt name: ${promptName}`,
        duration: Date.now() - startTime,
        statusCode: 404,
      });

      throw new McpError(ErrorCode.InvalidParams, `Invalid prompt name: ${promptName}`);
    }

    // Permission check
    if (!this.clientSession.canUsePrompt(parseResult.serverID, parseResult.originalName)) {
      this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestPrompt,
        upstreamRequestId: String(extra.requestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `Permission denied for prompt: ${promptName}`,
        duration: Date.now() - startTime,
        statusCode: 403,
      });
      throw new McpError(ErrorCode.InvalidParams, `Permission denied for prompt: ${promptName}`);
    }

    // Ensure server is available (lazy start)
    await ServerManager.instance.ensureServerAvailable(
      parseResult.serverID,
      this.clientSession.userId,
    );

    // Routing decision
    const targetServerContext = ServerManager.instance.getServerContext(
      parseResult.serverID,
      this.clientSession.userId,
    );

    if (!targetServerContext) {
      this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestPrompt,
        upstreamRequestId: String(extra.requestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `No server available for prompt: ${promptName}`,
        duration: Date.now() - startTime,
        statusCode: 503,
      });
      throw new McpError(ErrorCode.InternalError, `No server available for prompt: ${promptName}`);
    }

    // Get downstream connection
    const client = targetServerContext.connection;

    if (!client) {
      this.sessionLogger.logClientRequest({
        action: MCPEventLogType.RequestPrompt,
        upstreamRequestId: String(extra.requestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `No client available for prompt: ${promptName}`,
        duration: Date.now() - startTime,
        statusCode: 503,
      });
      throw new McpError(ErrorCode.InternalError, `No client available for prompt: ${promptName}`);
    }

    // Use RequestIdMapper to generate unique proxy request ID
    const originalRequestId = extra.requestId;
    const proxyRequestId = this.requestIdMapper.registerClientRequest(
      originalRequestId,
      request.method,
      parseResult.serverID,
    );

    // Deep copy request and inject proxyContext for reverse request routing
    const proxyContext: ProxyContext = {
      proxyRequestId: proxyRequestId,
      uniformRequestId: uniformRequestId,
    };

    const promptCacheService = ResultCacheService.instance;
    const promptCachePolicy = promptCacheService.enabled
      ? promptCacheService.resolvePromptPolicy(
          targetServerContext!.capabilitiesConfig,
          parseResult.originalName,
        )
      : null;
    const promptScopeCtx: CacheScopeContext = { userId: this.userId };

    if (promptCachePolicy) {
      try {
        const cached = await promptCacheService.lookup(
          'prompt',
          parseResult.serverID,
          parseResult.originalName,
          promptScopeCtx,
          promptCachePolicy,
          request.params.arguments,
        );
        if (cached.hit && cached.entry) {
          this.logger.debug(
            { promptName, serverId: parseResult.serverID },
            'Prompt get served from cache',
          );
          await this.sessionLogger.logClientRequest({
            action: MCPEventLogType.ResponsePrompt,
            serverId: parseResult.serverID,
            upstreamRequestId: String(extra.requestId),
            uniformRequestId,
            requestParams: request.params,
            responseResult: cached.entry.payload,
            duration: Date.now() - startTime,
            statusCode: 200,
          });
          this.requestIdMapper.removeMapping(proxyRequestId);
          return cached.entry.payload as GetPromptResult;
        }
      } catch (cacheError) {
        this.logger.warn(
          { error: cacheError, promptName },
          'Prompt cache lookup failed, proceeding without cache',
        );
      }
    }

    let isReconnected: boolean | undefined;

    try {
      const requestCopy = JSON.parse(JSON.stringify(request));
      requestCopy.params.name = parseResult.originalName;
      requestCopy.params._meta = {
        ...requestCopy.params._meta,
        proxyContext: proxyContext,
      };
      // Forward request, passing signal and proxyRequestId
      const result = await client.getPrompt(requestCopy.params, {
        signal: extra.signal, // Pass cancellation signal
        relatedRequestId: proxyRequestId, // Use proxyRequestId as related ID
      });
      targetServerContext.clearTimeout();

      if (promptCachePolicy) {
        promptCacheService
          .storeResult(
            'prompt',
            parseResult.serverID,
            parseResult.originalName,
            promptScopeCtx,
            promptCachePolicy,
            request.params.arguments,
            result,
          )
          .catch((storeError) => {
            this.logger.warn({ error: storeError, promptName }, 'Prompt cache store failed');
          });
      }

      try {
        // Log response
        await this.sessionLogger.logClientRequest({
          action: MCPEventLogType.ResponsePrompt,
          serverId: targetServerContext.serverEntity.serverId,
          upstreamRequestId: String(extra.requestId),
          uniformRequestId: uniformRequestId,
          requestParams: request.params,
          responseResult: result,
          duration: Date.now() - startTime,
          statusCode: 200,
        });
      } catch (error) {
        this.logger.error({ error }, 'Error logging prompt get response');
      }

      return result;
    } catch (error) {
      this.logger.error({ error }, 'Error handling prompt get');
      isReconnected = await targetServerContext.recordTimeout(error);
      const errorMsg = String(error);

      await this.sessionLogger.logClientRequest({
        action: MCPEventLogType.ResponsePrompt,
        serverId: targetServerContext.serverEntity.serverId,
        upstreamRequestId: String(extra.requestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: errorMsg,
        duration: Date.now() - startTime,
        statusCode: 500,
      });
      if (isReconnected === false && retryCount < 2) {
        return await this.handlePromptGet(request, extra, retryCount + 1);
      }
      throw error;
    } finally {
      // Clean up request mapping
      this.requestIdMapper.removeMapping(proxyRequestId);
    }
  }

  /**
   * Handle completion/complete request
   */
  private async handleComplete(
    request: CompleteRequest,
    extra: RequestHandlerExtra<any, any>,
    retryCount: number = 0,
  ): Promise<CompleteResult> {
    this.logger.debug('Handling completion');
    const startTime = Date.now();
    const uniformRequestId = LogService.getInstance().generateUniformRequestId(this.sessionId);
    const originalRequestId = extra.requestId;

    let promptName: string;
    let action: MCPEventLogType;
    switch (request.params.ref.type) {
      case 'ref/prompt':
        promptName = request.params.ref.name;
        action = MCPEventLogType.RequestPrompt;
        break;
      case 'ref/resource':
        promptName = request.params.ref.uri;
        action = MCPEventLogType.RequestResource;
        break;
      default:
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid completion reference: ${request.params.ref}`,
        );
    }

    this.logger.debug({ promptName }, 'Handling prompt get');
    const result = this.clientSession.parseName(promptName);

    if (!result) {
      const errorTime = Date.now();
      const errorMsg = `Completio ${promptName} not found`;

      // Log failed request (forward failure)
      await this.sessionLogger.logClientRequest({
        action: action,
        serverId: 'unknown',
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `Error: ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 404,
      });
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid completion reference: ${request.params.ref}`,
      );
    }

    // Ensure server is available (lazy start)
    await ServerManager.instance.ensureServerAvailable(result.serverID, this.clientSession.userId);

    // Routing decision
    const targetServerContext = ServerManager.instance.getServerContext(
      result.serverID,
      this.clientSession.userId,
    );

    if (!targetServerContext) {
      const errorTime = Date.now();
      const errorMsg = `No server available for completion: ${promptName}`;
      await this.sessionLogger.logClientRequest({
        action: action,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `Error: ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 503,
      });
      throw new McpError(ErrorCode.InvalidParams, `No server available for prompt: ${promptName}`);
    }

    // Get downstream connection
    const client = targetServerContext.connection;

    if (!client) {
      const errorTime = Date.now();
      const errorMsg = `No client available for completion: ${promptName}`;
      await this.sessionLogger.logClientRequest({
        action: action,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: `Error: ErrorRouting: ${errorMsg}`,
        duration: errorTime - startTime,
        statusCode: 503,
      });
      throw new McpError(ErrorCode.InvalidParams, `No client available for prompt: ${promptName}`);
    }

    // Deep copy request
    const requestCopy = JSON.parse(JSON.stringify(request)) as CompleteRequest;
    switch (request.params.ref.type) {
      case 'ref/prompt':
        if ('name' in requestCopy.params.ref) {
          requestCopy.params.ref.name = result.originalName;
        }
        break;
      case 'ref/resource':
        if ('uri' in requestCopy.params.ref) {
          requestCopy.params.ref.uri = result.originalName;
        }
        break;
    }

    const proxyRequestId = this.requestIdMapper.registerClientRequest(
      originalRequestId,
      request.method,
      result.serverID,
    );

    let isReconnected: boolean | undefined;

    try {
      const result = await client.complete(requestCopy.params, {
        signal: extra.signal,
        relatedRequestId: proxyRequestId,
      });
      targetServerContext.clearTimeout();

      try {
        // Log response
        await this.sessionLogger.logClientRequest({
          action: action,
          serverId: targetServerContext.serverEntity.serverId,
          upstreamRequestId: String(extra.requestId),
          uniformRequestId: uniformRequestId,
          requestParams: request.params,
          responseResult: result,
          duration: Date.now() - startTime,
          statusCode: 200,
        });
      } catch (error) {
        this.logger.error({ error }, 'Error logging complete response');
      }

      return result;
    } catch (error) {
      this.logger.error({ error }, 'Error handling complete');
      isReconnected = await targetServerContext.recordTimeout(error);

      const errorMsg = String(error);
      this.sessionLogger.logClientRequest({
        action: action,
        serverId: result.serverID,
        upstreamRequestId: String(originalRequestId),
        uniformRequestId: uniformRequestId,
        requestParams: request.params,
        error: errorMsg,
        duration: Date.now() - startTime,
        statusCode: 500,
      });

      if (isReconnected === false && retryCount < 2) {
        return await this.handleComplete(request, extra, retryCount + 1);
      }
      throw error;
    } finally {
      this.requestIdMapper.removeMapping(proxyRequestId);
    }
  }

  /**
   * Handle logging/setLevel request
   */
  private async handleSetLoggingLevel(
    request: SetLevelRequest,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<EmptyResult> {
    this.logger.debug({ level: request.params.level }, 'Setting logging level');

    // Can propagate logging level setting to all downstream servers
    // for (const [serverName, client] of this.downstreamClients) {
    //   try {
    //     await client.setLoggingLevel(request.params.level);
    //   } catch (error) {
    //     console.error(`Failed to set logging level for server ${serverName}:`, error);
    //   }
    // }

    return {};
  }

  /**
   * Handle ping request
   */
  private async handlePing(
    request: PingRequest,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<EmptyResult> {
    this.logger.debug('Ping received');
    return await this.upstreamServer.ping();
  }

  /**
   * Handle client reconnection request
   * @param lastEventId Last received event ID
   * @param res HTTP response object
   */
  async handleReconnection(lastEventId: string, res: Response): Promise<void> {
    try {
      if (!this.eventStore) {
        throw new Error('EventStore not available for this session');
      }

      this.logger.info({ lastEventId }, 'Handling reconnection');

      // Set SSE response headers
      const headers: Record<string, string> = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      };

      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
        headers['mcp-session-id'] = this.sessionId;
      }

      res.writeHead(200, headers).flushHeaders();

      // Replay events using EventStore
      await this.eventStore.replayEventsAfter(lastEventId, {
        send: async (eventId: string, message: any) => {
          const eventData = this.formatSSEEvent(message, eventId);
          if (!res.write(eventData)) {
            throw new Error('Failed to write SSE event');
          }
        },
      });

      this.logger.info('Reconnection completed');
    } catch (error) {
      this.logger.error({ error }, 'Failed to handle reconnection');
      // Log error
      await this.sessionLogger.logError({
        action: MCPEventLogType.ErrorInternal,
        upstreamRequestId: lastEventId,
        uniformRequestId: LogService.getInstance().generateUniformRequestId(this.sessionId),
        error: String(error),
      });
      res.end();
    }
  }

  /**
   * Format SSE event
   */
  private formatSSEEvent(message: any, eventId?: string): string {
    let eventData = `event: message\n`;
    if (eventId) {
      eventData += `id: ${eventId}\n`;
    }
    eventData += `data: ${JSON.stringify(message)}\n\n`;
    return eventData;
  }

  /**
   * Get EventStore instance
   */
  getEventStore(): PersistentEventStore | undefined {
    return this.eventStore;
  }

  /**
   * Clean up session resources
   */
  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up proxy session');
    this.closeTriggered = true;

    // Disconnect upstream transport
    if (this.upstreamTransport) {
      await this.upstreamServer.close();
    }

    // Clear downstream connection references (don't close connections as they are shared)
    this.downstreamClients.clear();

    // Clean up all resource subscriptions for this session
    try {
      await ServerManager.instance.cleanupSessionSubscriptions(this.sessionId, this.userId);
    } catch (error) {
      this.logger.error({ error }, 'Error cleaning up subscriptions');
    }

    // Clean up request mappings and trackers
    this.requestIdMapper.destroy();
    this.progressTrackers.clear();
    this.notificationSubscriptions.clear();
  }

  private triggerOnClose(sessionId: string): void {
    if (this.closeTriggered) {
      return;
    }
    this.closeTriggered = true;
    void this.onclose(sessionId).catch((error) => {
      this.logger.error({ error, sessionId }, 'onclose callback failed');
    });
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(serverId: string): string {
    return `${serverId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Check if server can request Sampling
   */
  public canServerRequestSampling(): boolean {
    // Check if server has sampling permission
    return this.clientSession.canRequestSampling();
  }

  /**
   * Check if server can request Elicitation
   */
  public canServerRequestElicitation(): boolean {
    // Check if server has elicitation permission
    return this.clientSession.canRequestElicitation();
  }

  /**
   * Forward Sampling request to client
   */
  public async forwardSamplingToClient(
    request: CreateMessageRequest,
    options?: RequestOptions,
  ): Promise<CreateMessageResult> {
    this.logger.debug({
      relatedRequestId: options?.relatedRequestId,
      messageRole: request.params.messages?.[0]?.role,
      messageContent: (() => {
        const firstMessage = request.params.messages?.[0];
        if (!firstMessage?.content) return undefined;
        const content: any = firstMessage.content;
        if (typeof content === 'string') {
          return content.slice(0, 100);
        }
        return JSON.stringify(content).slice(0, 100);
      })(),
    });

    // Handle relatedRequestId mapping
    if (options?.relatedRequestId) {
      const proxyRequestId = String(options.relatedRequestId);
      const originalRequestId = this.requestIdMapper.getOriginalRequestId(proxyRequestId);

      if (originalRequestId) {
        // Replace with original requestId
        options = {
          ...options,
          relatedRequestId: originalRequestId,
        };
        this.logger.debug(
          { proxyRequestId, originalRequestId },
          '[Sampling] Successfully mapped relatedRequestId',
        );
      } else {
        this.logger.warn(
          { proxyRequestId, stats: this.requestIdMapper.getStats() },
          '[Sampling] CRITICAL: No original requestId found',
        );
      }
    } else {
      this.logger.warn('[Sampling] WARNING: No relatedRequestId provided in options');
    }

    // Add timeout control
    const timeout = getReverseRequestTimeout('sampling');
    let timeoutReject: ((reason: ReverseRequestTimeoutError) => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutReject = reject;
    });
    const timeoutId = setTimeout(() => {
      timeoutReject?.(new ReverseRequestTimeoutError('sampling', timeout));
    }, timeout);
    try {
      return await Promise.race([
        this.upstreamServer.createMessage(request.params, options),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof ReverseRequestTimeoutError) {
        this.logger.error({ timeout }, '[Sampling] Request timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Forward Roots List request to client
   */
  public async forwardRootsListToClient(
    request: ListRootsRequest,
    options?: RequestOptions,
  ): Promise<ListRootsResult> {
    this.logger.debug(
      { relatedRequestId: options?.relatedRequestId },
      'Forwarding roots list request to client',
    );

    // Handle relatedRequestId mapping
    if (options?.relatedRequestId) {
      const proxyRequestId = String(options.relatedRequestId);
      const originalRequestId = this.requestIdMapper.getOriginalRequestId(proxyRequestId);

      if (originalRequestId) {
        // Replace with original requestId
        options = {
          ...options,
          relatedRequestId: originalRequestId,
        };
        this.logger.debug(
          { proxyRequestId, originalRequestId },
          '[ListRoots] Successfully mapped relatedRequestId',
        );
      } else {
        this.logger.warn(
          { proxyRequestId, stats: this.requestIdMapper.getStats() },
          '[ListRoots] CRITICAL: No original requestId found',
        );
      }
    } else {
      this.logger.warn('[ListRoots] WARNING: No relatedRequestId provided in options');
    }

    // Add timeout control
    const timeout = getReverseRequestTimeout('roots');
    let timeoutReject: ((reason: ReverseRequestTimeoutError) => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutReject = reject;
    });
    const timeoutId = setTimeout(() => {
      timeoutReject?.(new ReverseRequestTimeoutError('roots', timeout));
    }, timeout);
    try {
      return await Promise.race([
        this.upstreamServer.listRoots(request.params, options),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof ReverseRequestTimeoutError) {
        this.logger.error({ timeout }, '[ListRoots] Request timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Forward Elicitation request to client
   */
  public async forwardElicitationToClient(
    request: ElicitRequest,
    options?: RequestOptions,
  ): Promise<ElicitResult> {
    this.logger.debug({
      relatedRequestId: options?.relatedRequestId,
      requestedSchema: request.params,
    });

    // Handle relatedRequestId mapping
    if (options?.relatedRequestId) {
      const proxyRequestId = String(options.relatedRequestId);
      const originalRequestId = this.requestIdMapper.getOriginalRequestId(proxyRequestId);

      if (originalRequestId) {
        // Replace with original requestId
        options = {
          ...options,
          relatedRequestId: originalRequestId,
        };
        this.logger.debug(
          { proxyRequestId, originalRequestId },
          '[Elicitation] Successfully mapped relatedRequestId',
        );
      } else {
        this.logger.warn(
          { proxyRequestId, stats: this.requestIdMapper.getStats() },
          '[Elicitation] CRITICAL: No original requestId found',
        );
      }
    } else {
      this.logger.warn('[Elicitation] WARNING: No relatedRequestId provided in options');
    }

    // Add timeout control
    const timeout = getReverseRequestTimeout('elicitation');
    let timeoutReject: ((reason: ReverseRequestTimeoutError) => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutReject = reject;
    });
    const timeoutId = setTimeout(() => {
      timeoutReject?.(new ReverseRequestTimeoutError('elicitation', timeout));
    }, timeout);
    try {
      return await Promise.race([
        this.upstreamServer.elicitInput(request.params, options),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof ReverseRequestTimeoutError) {
        this.logger.error({ timeout }, '[Elicitation] Request timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Send resource list changed notification to client
   */
  public async sendResourcesListChangedToClient(): Promise<void> {
    this.clientSession.sendResourceListChanged();
  }

  /**
   * Send prompt list changed notification to client
   */
  public async sendPromptsListChangedToClient(): Promise<void> {
    this.clientSession.sendPromptListChanged();
  }

  /**
   * Check if client supports Roots
   */
  public clientSupportsRoots(): boolean {
    return this.clientSession.canRequestRoots();
  }

  /**
   * Handle Roots list changed notification
   */
  private async handleRootsListChanged(notification: RootsListChangedNotification): Promise<void> {
    for (const server of this.clientSession.getAvailableServers()) {
      server.connection?.sendRootsListChanged();
    }
  }

  /**
   * Handle cancellation notification - forward from client to server
   */
  private async handleCancelledNotification(notification: CancelledNotification): Promise<void> {
    const requestId = notification.params.requestId;
    this.logger.debug({ requestId }, 'Handling cancellation');

    // Get original requestId
    const proxyRequestId = this.requestIdMapper.getProxyRequestId(String(requestId));
    if (!proxyRequestId) {
      this.logger.warn({ requestId }, 'No proxy requestId found');
      return;
    }

    // Get mapping entry from RequestIdMapper (includes serverId)
    const mappingEntry = this.requestIdMapper.getMappingEntry(proxyRequestId);
    if (!mappingEntry || !mappingEntry.serverId) {
      // Request may have completed or doesn't exist
      this.logger.debug({ requestId }, 'No mapping entry found for cancelled request');
      return;
    }

    // Get target server connection
    const serverContext = ServerManager.instance.getServerContext(
      mappingEntry.serverId,
      this.clientSession.userId,
    );
    const client = serverContext?.connection;

    if (client) {
      try {
        // Deep copy notification
        const notificationCopy = JSON.parse(JSON.stringify(notification)) as CancelledNotification;
        notificationCopy.params.requestId = proxyRequestId;

        // Forward cancellation notification to downstream server
        await client.notification(notificationCopy, {
          relatedRequestId: proxyRequestId,
        });
        this.logger.debug(
          { requestId, serverId: mappingEntry.serverId },
          'Forwarded cancellation to server',
        );
      } catch (error) {
        this.logger.error(
          { error, serverId: mappingEntry.serverId },
          'Failed to forward cancellation to server',
        );
      }
    }
  }

  /**
   * Handle progress notification - forward from server to client
   */
  private async handleProgressNotification(notification: ProgressNotification): Promise<void> {
    const { progressToken, progress, total } = notification.params;
    this.logger.debug({ progress, total, progressToken }, 'Handling progress notification');

    // Progress notifications are usually sent from server to client
    // If this comes from client (unlikely), it needs to be forwarded to the corresponding server
    // If this comes from server (via reverse channel), it's already in the correct position
    // Note: Progress notifications usually don't need additional forwarding as they are automatically
    // handled through the onprogress callback in RequestHandlerExtra
  }

  /**
   * Forward cancellation notification to client
   * Used to handle cancellations initiated by server
   */
  public async forwardCancellationToClient(notification: CancelledNotification): Promise<void> {
    try {
      // Convert proxyRequestId back to original requestId
      const proxyRequestId = String(notification.params.requestId);
      const originalRequestId = this.requestIdMapper.getOriginalRequestId(proxyRequestId);

      if (!originalRequestId) {
        this.logger.warn({ proxyRequestId }, 'No original requestId found for proxy requestId');
        return;
      }

      // Modify requestId in notification to original value
      const modifiedNotification = {
        ...notification,
        params: {
          ...notification.params,
          requestId: originalRequestId,
        },
      };

      await this.upstreamServer.notification(modifiedNotification, {
        relatedRequestId: originalRequestId,
      });
      this.logger.debug({ proxyRequestId, originalRequestId }, 'Forwarded cancellation to client');
    } catch (error) {
      this.logger.error({ error }, 'Failed to forward cancellation to client');
      throw error;
    }
  }

  /**
   * Forward progress notification to client
   */
  public async forwardProgressToClient(notification: ProgressNotification): Promise<void> {
    try {
      // progressToken is actually the proxyRequestId
      const proxyRequestId = String(notification.params.progressToken);
      const originalRequestId = this.requestIdMapper.getOriginalRequestId(proxyRequestId);

      if (!originalRequestId) {
        this.logger.warn({ proxyRequestId }, 'No original requestId found for progress token');
        return;
      }

      // Modify progressToken in notification to original value
      const modifiedNotification = {
        ...notification,
        params: {
          ...notification.params,
          progressToken: originalRequestId,
        },
      };

      await this.upstreamServer.notification(modifiedNotification, {
        relatedRequestId: originalRequestId,
      });
      this.logger.debug({ proxyRequestId, originalRequestId }, 'Forwarded progress to client');
    } catch (error) {
      this.logger.error({ error }, 'Failed to forward progress to client');
      throw error;
    }
  }
}
