import type { Request, Response } from 'express';
import {
  type CallToolResult,
  type CompleteResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { APP_INFO } from '../../config/config.js';
import { MODERN_MCP_CONFIG, MODERN_MCP_PROTOCOL_VERSION } from '../../config/modernMcp.config.js';
import type { AuthContext } from '../../types/auth.types.js';
import { ApprovalStatus, DangerLevel, MCPEventLogType, PolicyDecision, ServerStatus } from '../../types/enums.js';
import { LogService } from '../../log/LogService.js';
import { createLogger } from '../../logger/index.js';
import { ServerManager } from '../core/ServerManager.js';
import type { ServerContext } from '../core/ServerContext.js';
import { policyEngine } from '../services/PolicyEngine.js';
import { approvalService, ApprovalRateLimitError } from '../services/ApprovalService.js';
import { socketNotifier } from '../../socket/SocketNotifier.js';
import { ResultCacheService } from '../core/cache/ResultCacheService.js';
import type { CacheScopeContext } from '../core/cache/types.js';
import { SessionStore } from '../core/SessionStore.js';
import { getPublicUrl } from '../../utils/urlUtils.js';
import { maskToken } from '../../utils/tokenMask.js';
import { ModernErrorCodes, ModernMcpError, modernErrorResponse } from './ModernMcpErrors.js';
import { modernSubscriptionBus, type ModernSubscriptionEvent } from './ModernSubscriptionBus.js';
import type {
  JsonObject,
  JsonRpcId,
  JsonValue,
  ModernClientInfo,
  ModernJsonRpcRequest,
  ModernRequestContext,
  ModernRequestMeta,
  ModernSubscriptionFilter,
  ModernValidationResult,
} from './ModernMcpTypes.js';

type ListResult = ListToolsResult | ListResourcesResult | ListResourceTemplatesResult | ListPromptsResult;
type GatewayRoute = { serverID: string; originalName: string; resourceName?: string };
type ModernOAuthScope = 'mcp:tools' | 'mcp:resources' | 'mcp:prompts';
type ModernCallToolResult = JsonObject & { isError?: boolean };
type ModernCacheableResult = JsonObject & { resultType?: string; ttlMs?: number; cacheScope?: string };
type ModernResourceSubscription = { serverId: string; resourceUri: string; requestedUri: string };

const MODERN_META_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const MODERN_META_CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
const MODERN_META_CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const MODERN_SUBSCRIPTION_METHODS = [
  'notifications/tools/list_changed',
  'notifications/resources/list_changed',
  'notifications/resources/updated',
  'notifications/prompts/list_changed',
] as const;
export class ModernMcpController {
  private logger = createLogger('ModernMcpController');

  shouldHandle(req: Request): boolean {
    if (!this.isMcpEndpoint(req)) {
      return false;
    }

    if (this.shouldPreferLegacy(req)) {
      return false;
    }

    return this.hasModernSignal(req);
  }

  private hasModernSignal(req: Request): boolean {
    if (!this.isMcpEndpoint(req)) {
      return false;
    }

    const protocolHeader = this.getHeader(req, 'mcp-protocol-version');
    const method = this.getBodyMethod(req.body);
    const bodyMeta = this.getRequestMetaFromUnknown(req.body);
    const hasMetaKey = this.hasRequestMetaKeyFromUnknown(req.body);

    return Boolean(
      this.isModernProtocolHeader(protocolHeader) ||
        bodyMeta ||
        hasMetaKey ||
        this.getHeader(req, 'mcp-method') ||
        this.getHeader(req, 'mcp-name') ||
        this.hasMcpParamHeader(req) ||
        method === 'server/discover' ||
        method === 'subscriptions/listen',
    );
  }

  rejectMixedEra = (req: Request, res: Response, next: () => void): void => {
    if (!this.isMcpEndpoint(req)) {
      return next();
    }

    const sessionId = this.getHeader(req, 'mcp-session-id');
    const method = this.getBodyMethod(req.body);
    const lastEventId = this.getHeader(req, 'last-event-id');

    const hasModernSignal = this.hasModernSignal(req);

    if (method === 'initialize' && hasModernSignal) {
      return this.sendModernError(res, req.body, new ModernMcpError(400, ModernErrorCodes.InvalidRequest, 'Mixed protocol-era signals: initialize is not part of modern MCP'), req);
    }

    if (this.shouldPreferLegacy(req)) {
      if (hasModernSignal && sessionId) {
        this.logger.warn(
          { sessionId, method, protocolVersion: this.getHeader(req, 'mcp-protocol-version') },
          'Routing mixed-era request through existing legacy session',
        );
      }
      return next();
    }

    if (hasModernSignal && sessionId) {
      return this.sendModernError(res, req.body, new ModernMcpError(400, ModernErrorCodes.InvalidRequest, 'Mixed protocol-era signals: modern requests must not include Mcp-Session-Id'), req);
    }
    if (hasModernSignal && lastEventId) {
      return this.sendModernError(res, req.body, new ModernMcpError(400, ModernErrorCodes.InvalidRequest, 'Mixed protocol-era signals: modern POST requests must not include Last-Event-ID'), req);
    }
    return next();
  };

  private shouldPreferLegacy(req: Request): boolean {
    const method = this.getBodyMethod(req.body);
    if (method === 'initialize') {
      return !this.hasModernSignal(req);
    }

    const sessionId = this.getHeader(req, 'mcp-session-id');
    if (!sessionId || this.isModernOnlyMethod(method)) {
      return false;
    }

    return Boolean(SessionStore.instance.getSession(sessionId));
  }

  private isModernOnlyMethod(method: string | undefined): boolean {
    return method === 'server/discover' || method === 'subscriptions/listen';
  }

  handlePost = async (req: Request, res: Response): Promise<void> => {
    const started = Date.now();
    const requestId = this.extractId(req.body);
    try {
      if (!MODERN_MCP_CONFIG.enabled) {
        throw new ModernMcpError(400, ModernErrorCodes.UnsupportedProtocolVersion, 'MCP 2026-07-28 support is disabled', {
          supported: MODERN_MCP_CONFIG.supportedVersions,
          requested: this.getHeader(req, 'mcp-protocol-version') ?? null,
        });
      }

      if (req.method !== 'POST') {
        throw new ModernMcpError(405, ModernErrorCodes.InvalidRequest, 'Modern MCP uses POST-only Streamable HTTP');
      }

      const validation = this.validateRequest(req);
      const context = this.buildContext(req, res, validation);

      if (validation.notification) {
        await this.handleNotification(context, validation.request);
        res.status(202).end();
        return;
      }

      if (validation.request.method === 'subscriptions/listen') {
        await this.handleSubscriptionListen(context, validation.request);
        return;
      }

      const result = await this.dispatch(context, validation.request, started);
      this.writeJsonResult(res, validation.request.id, result);
    } catch (error) {
      const modernError = this.toModernError(error);
      this.logger.error({
        error,
        method: this.getBodyMethod(req.body),
        protocolEra: 'modern',
        protocolVersion: this.getHeader(req, 'mcp-protocol-version'),
        modernValidationErrorType: modernError.rpcCode,
        downstreamBridgeFailure: !(error instanceof ModernMcpError),
        mrtrResultCount: 0,
      }, 'Modern MCP request failed');
      this.sendModernError(res, { id: requestId }, modernError, req);
    }
  };

  private validateRequest(req: Request): ModernValidationResult {
    const body = req.body;
    if (!this.isJsonObject(body)) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidRequest, 'Modern MCP request body must be a single JSON-RPC object');
    }
    if ('result' in body || 'error' in body) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidRequest, 'JSON-RPC responses are not valid client requests');
    }
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidRequest, 'Invalid JSON-RPC request');
    }
    if ('id' in body && !this.isJsonRpcId(body.id)) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidRequest, 'Invalid JSON-RPC id');
    }
    if ('params' in body && body.params !== undefined && !this.isJsonObject(body.params)) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'JSON-RPC params must be an object when present');
    }

    const id = 'id' in body && this.isJsonRpcId(body.id) ? body.id : undefined;
    const params = this.isJsonObject(body.params) ? body.params : undefined;
    const request: ModernJsonRpcRequest = {
      jsonrpc: '2.0',
      method: body.method,
      ...(id !== undefined ? { id } : {}),
      ...(params ? { params } : {}),
    };

    const accept = this.getHeader(req, 'accept') ?? '';
    if (!this.acceptsModernResponse(accept)) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidRequest, 'Accept must include application/json and text/event-stream');
    }

    const meta = this.requireModernMeta(request);
    const protocolHeader = this.getHeader(req, 'mcp-protocol-version');
    if (!protocolHeader) {
      throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, 'MCP-Protocol-Version header is required');
    }
    if (protocolHeader !== meta[MODERN_META_VERSION_KEY]) {
      throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, 'MCP-Protocol-Version does not match request _meta protocolVersion');
    }
    if (!MODERN_MCP_CONFIG.supportedVersions.includes(protocolHeader)) {
      throw new ModernMcpError(400, ModernErrorCodes.UnsupportedProtocolVersion, 'Unsupported MCP protocol version', {
        supported: MODERN_MCP_CONFIG.supportedVersions,
        requested: protocolHeader,
      });
    }

    const methodHeader = this.getHeader(req, 'mcp-method');
    if (!methodHeader) {
      throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, 'Mcp-Method header is required');
    }
    if (methodHeader !== request.method) {
      throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, 'Mcp-Method does not match JSON-RPC method');
    }
    this.validateNameHeader(req, request);
    this.validateHeaderMirrors(req, request);

    return { request, meta, notification: !('id' in request) };
  }

  private requireModernMeta(request: ModernJsonRpcRequest): ModernRequestMeta {
    const meta = this.getRequestMeta(request);
    if (!meta) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'Missing required modern MCP request _meta');
    }
    const version = meta[MODERN_META_VERSION_KEY];
    const clientInfo = meta[MODERN_META_CLIENT_INFO_KEY];
    const clientCapabilities = meta[MODERN_META_CLIENT_CAPABILITIES_KEY];
    if (typeof version !== 'string' || version.length === 0) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Missing ${MODERN_META_VERSION_KEY}`);
    }
    if (clientInfo !== undefined && !this.isModernClientInfo(clientInfo)) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Missing ${MODERN_META_CLIENT_INFO_KEY}`);
    }
    if (!this.isJsonObject(clientCapabilities)) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Missing ${MODERN_META_CLIENT_CAPABILITIES_KEY}`);
    }
    return {
      ...meta,
      [MODERN_META_VERSION_KEY]: version,
      [MODERN_META_CLIENT_CAPABILITIES_KEY]: clientCapabilities,
      ...(clientInfo === undefined ? {} : { [MODERN_META_CLIENT_INFO_KEY]: clientInfo }),
    };
  }

  private async dispatch(context: ModernRequestContext, request: ModernJsonRpcRequest, started: number): Promise<JsonValue> {
    this.enforceModernScopes(context, request);

    switch (request.method) {
      case 'server/discover':
        this.validateServerDiscoverParams(request);
        return this.cacheable(this.serverDiscover(context));
      case 'tools/list':
        return this.cacheable(this.listTools(context));
      case 'resources/list':
        return this.cacheable(this.listResources(context));
      case 'resources/templates/list':
        return this.cacheable(this.listResourceTemplates(context));
      case 'prompts/list':
        return this.cacheable(this.listPrompts(context));
      case 'tools/call':
        return this.cacheable(await this.callTool(context, request, started));
      case 'resources/read':
        return this.cacheable(await this.readResource(context, request, started));
      case 'prompts/get':
        return this.cacheable(await this.getPrompt(context, request, started));
      case 'completion/complete':
        return this.cacheable(await this.complete(context, request, started));
      default:
        throw new ModernMcpError(404, ModernErrorCodes.MethodNotFound, `Unknown modern MCP method: ${request.method}`);
    }
  }

  private serverDiscover(context: ModernRequestContext): JsonObject {
    const capabilities = this.buildServerCapabilities(context);
    return {
      supportedVersions: MODERN_MCP_CONFIG.supportedVersions,
      capabilities,
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: APP_INFO.name,
          version: APP_INFO.version,
        },
        peta: {
          protocolEra: 'modern',
          protocolVersion: MODERN_MCP_PROTOCOL_VERSION,
          stateless: true,
          legacySessionHeaders: false,
          reverseRequests: false,
          anonymousPublicEndpoint: false,
        },
      },
    };
  }

  private validateServerDiscoverParams(request: ModernJsonRpcRequest): void {
    const params = this.requireParams(request);
    const extraKeys = Object.keys(params).filter((key) => key !== '_meta');
    if (extraKeys.length > 0) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'server/discover params may only include _meta');
    }
  }

  private listTools(context: ModernRequestContext): ListToolsResult {
    const tools: Tool[] = [];
    const supportsMcpApps = this.supportsMcpApps(context.clientCapabilities);
    for (const serverContext of this.getAvailableServers(context.authContext)) {
      const sourceTools = serverContext.tools?.tools ?? serverContext.cachedTools?.tools ?? [];
      for (const tool of sourceTools) {
        if (!this.canUseTool(context.authContext, serverContext, tool.name)) {
          continue;
        }
        if (!this.hasValidHeaderAnnotations(tool)) {
          this.logger.warn({ serverId: serverContext.serverID, toolName: tool.name }, 'Skipping tool with invalid x-mcp-header annotations');
          continue;
        }
        const userDangerLevel = this.getUserToolDangerLevel(context.authContext, serverContext.serverID, tool.name);
        const dangerLevel = userDangerLevel ?? serverContext.getDangerLevel(tool.name);
        const originalResourceUri = supportsMcpApps ? this.getToolUiResourceUri(tool) : undefined;
        const proxiedResourceUri = originalResourceUri
          ? this.generateGatewayName(serverContext.id, originalResourceUri)
          : undefined;
        const nextMeta = supportsMcpApps
          ? this.buildToolMetaWithProxiedResourceUri(tool, proxiedResourceUri)
          : this.stripUiToolMeta(tool);
        tools.push({
          ...tool,
          name: this.generateGatewayName(serverContext.id, tool.name),
          _meta: nextMeta,
          annotations: {
            ...(tool.annotations ?? {}),
            readOnlyHint: tool.annotations?.readOnlyHint === true || dangerLevel === DangerLevel.Silent,
            destructiveHint: tool.annotations?.destructiveHint === true || dangerLevel === DangerLevel.Notification,
          },
        });
      }
    }
    tools.sort((left, right) => left.name.localeCompare(right.name));
    return { tools, _meta: { totalCount: tools.length } };
  }

  private listResources(context: ModernRequestContext): ListResourcesResult {
    const resources: Resource[] = [];
    for (const serverContext of this.getAvailableServers(context.authContext)) {
      const sourceResources = serverContext.resources?.resources ?? serverContext.cachedResources?.resources ?? [];
      for (const resource of sourceResources) {
        if (!this.canAccessResource(context.authContext, serverContext, resource.name)) {
          continue;
        }
        resources.push({ ...resource, uri: this.generateGatewayName(serverContext.id, resource.uri) });
      }
    }
    resources.sort((left, right) => left.uri.localeCompare(right.uri));
    return { resources, _meta: { totalCount: resources.length } };
  }

  private listResourceTemplates(context: ModernRequestContext): ListResourceTemplatesResult {
    const resourceTemplates: ResourceTemplate[] = [];
    for (const serverContext of this.getAvailableServers(context.authContext)) {
      const sourceTemplates = serverContext.resourceTemplates?.resourceTemplates ?? serverContext.cachedResourceTemplates?.resourceTemplates ?? [];
      for (const template of sourceTemplates) {
        if (!this.canAccessResource(context.authContext, serverContext, template.name)) {
          continue;
        }
        resourceTemplates.push({ ...template, uriTemplate: this.generateGatewayName(serverContext.id, template.uriTemplate) });
      }
    }
    resourceTemplates.sort((left, right) => left.uriTemplate.localeCompare(right.uriTemplate));
    return { resourceTemplates, _meta: { totalCount: resourceTemplates.length } };
  }

  private listPrompts(context: ModernRequestContext): ListPromptsResult {
    const prompts = [];
    for (const serverContext of this.getAvailableServers(context.authContext)) {
      const sourcePrompts = serverContext.prompts?.prompts ?? serverContext.cachedPrompts?.prompts ?? [];
      for (const prompt of sourcePrompts) {
        if (!this.canUsePrompt(context.authContext, serverContext, prompt.name)) {
          continue;
        }
        prompts.push({ ...prompt, name: this.generateGatewayName(serverContext.id, prompt.name) });
      }
    }
    prompts.sort((left, right) => left.name.localeCompare(right.name));
    return { prompts, _meta: { totalCount: prompts.length } };
  }

  private async callTool(context: ModernRequestContext, request: ModernJsonRpcRequest, started: number): Promise<ModernCallToolResult> {
    const params = this.requireParams(request);
    const toolName = this.requireString(params.name, 'params.name');
    const args = this.isJsonObject(params.arguments) ? params.arguments : {};
    const route = this.resolveToolName(context.authContext, toolName);
    if (!route) {
      throw new ModernMcpError(404, ModernErrorCodes.InvalidParams, `Tool ${toolName} not found`);
    }
    if (!this.canUseToolById(context.authContext, route.serverID, route.originalName)) {
      throw new ModernMcpError(403, ModernErrorCodes.InvalidParams, `Permission denied for tool: ${toolName}`);
    }

    const serverContext = await this.ensureRoutableServer(route, context.authContext.userId, 'tool');
    const tool = this.findTool(serverContext, route.originalName);
    if (tool) {
      this.validateToolHeaderAnnotations(context.req, tool, args);
    }
    const dangerLevel = this.getUserToolDangerLevel(context.authContext, route.serverID, route.originalName) ?? serverContext.getDangerLevel(route.originalName) ?? DangerLevel.Silent;
    const policyResult = await policyEngine.evaluate({ userId: context.authContext.userId, serverId: route.serverID, toolName: route.originalName, args, dangerLevel });

    if (policyResult.decision === PolicyDecision.Deny) {
      await this.logRequest(context, MCPEventLogType.RequestTool, route.serverID, request, undefined, `PolicyDenied: ${policyResult.reason ?? 'policy rule'}`, started, 403);
      throw new ModernMcpError(403, ModernErrorCodes.InvalidRequest, `Tool execution denied by policy: ${policyResult.reason ?? 'policy rule'}`);
    }

    let approvalRequestId: string | null = null;
    if (policyResult.decision === PolicyDecision.RequireApproval) {
      let approvalCheck: Awaited<ReturnType<typeof approvalService.checkOrCreateApproval>>;
      try {
        approvalCheck = await approvalService.checkOrCreateApproval({ userId: context.authContext.userId, serverId: route.serverID, toolName: route.originalName, args, policyVersion: policyResult.policyVersion, uniformRequestId: context.uniformRequestId });
      } catch (error) {
        if (error instanceof ApprovalRateLimitError) {
          return {
            content: [{ type: 'text', text: `Approval request rate limited: ${error.message}` }],
            isError: false,
            _meta: { approval: { kind: 'approval_rate_limited', status: 'rate_limited' }, retryAfterSeconds: 60 },
          };
        }
        throw error;
      }
      if (approvalCheck.needsApproval) {
        return await this.buildPendingApprovalResult(context, route.serverID, route.originalName, approvalCheck, policyResult.policyVersion, request, started);
      }
      if (approvalCheck.request?.id) {
        const claim = await approvalService.claimForExecutionById(approvalCheck.request.id);
        if (!claim.claimed) {
          return {
            content: [{ type: 'text', text: `Approval for ${route.originalName} is already executing or completed. Request ID: ${approvalCheck.request.id}` }],
            isError: false,
            _meta: { approval: { kind: 'approval_pending', status: claim.request?.status ?? 'executing', approvalRequestId: approvalCheck.request.id } },
          };
        }
        approvalRequestId = claim.request?.id ?? approvalCheck.request.id;
      }
    }

    const cacheService = ResultCacheService.instance;
    const cachePolicy = policyResult.decision === PolicyDecision.Allow && dangerLevel < DangerLevel.Approval
      ? cacheService.resolveToolPolicy(serverContext.capabilitiesConfig, route.originalName)
      : null;
    const scopeContext = this.cacheScopeContext(context.authContext);
    const callParams = { ...params, name: route.originalName, _meta: this.downstreamMeta(params) };
    const execute = async (): Promise<ModernCallToolResult> => {
      const client = this.requireClient(serverContext, 'tool');
      const rawResult = await client.callTool(callParams);
      serverContext.clearTimeout();
      return this.validateModernCallToolResult(rawResult);
    };

    try {
      const result = cachePolicy
        ? (await cacheService.executeWithCache('tool', route.serverID, route.originalName, scopeContext, cachePolicy, args, execute)).result
        : await execute();
      await this.logRequest(context, MCPEventLogType.ResponseTool, route.serverID, request, result, undefined, started, result.isError ? 500 : 200);
      if (approvalRequestId) {
        await approvalService.markExecuted(approvalRequestId, result).catch(() => null);
      }
      return result;
    } catch (error) {
      if (approvalRequestId) {
        await approvalService.markFailed(approvalRequestId, String(error)).catch(() => null);
      }
      await this.logRequest(context, MCPEventLogType.ResponseTool, route.serverID, request, undefined, String(error), started, 500);
      throw error;
    }
  }

  private async readResource(context: ModernRequestContext, request: ModernJsonRpcRequest, started: number): Promise<ReadResourceResult> {
    const params = this.requireParams(request);
    const uri = this.requireString(params.uri, 'params.uri');
    const route = this.resolveResourceUri(context.authContext, uri);
    if (!route) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Invalid resource URI: ${uri}`);
    }
    if (!this.canAccessResourceById(context.authContext, route.serverID, route.resourceName ?? route.originalName)) {
      throw new ModernMcpError(403, ModernErrorCodes.InvalidParams, `Permission denied for resource: ${uri}`);
    }
    const serverContext = await this.ensureRoutableServer(route, context.authContext.userId, 'resource');
    const cacheService = ResultCacheService.instance;
    const cachePolicy = cacheService.resolveResourcePolicy(serverContext.capabilitiesConfig, route.originalName, route.resourceName);
    const callParams = { ...params, uri: route.originalName, _meta: this.downstreamMeta(params) };
    const execute = async (): Promise<ReadResourceResult> => {
      const client = this.requireClient(serverContext, 'resource');
      const result = await client.readResource(callParams);
      serverContext.clearTimeout();
      return result;
    };
    const rawResult = cachePolicy
      ? (await cacheService.executeWithCache('resource', route.serverID, route.originalName, this.cacheScopeContext(context.authContext), cachePolicy, params, execute)).result
      : await execute();
    const result = this.rewriteResourceResult(
      rawResult,
      route.serverID,
      context.authContext.userId,
      this.supportsMcpApps(context.clientCapabilities),
    );
    await this.logRequest(context, MCPEventLogType.ResponseResource, route.serverID, request, result, undefined, started, 200);
    return result;
  }

  private async getPrompt(context: ModernRequestContext, request: ModernJsonRpcRequest, started: number): Promise<GetPromptResult> {
    const params = this.requireParams(request);
    const promptName = this.requireString(params.name, 'params.name');
    const route = this.resolvePromptName(context.authContext, promptName);
    if (!route) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Invalid prompt name: ${promptName}`);
    }
    if (!this.canUsePromptById(context.authContext, route.serverID, route.originalName)) {
      throw new ModernMcpError(403, ModernErrorCodes.InvalidParams, `Permission denied for prompt: ${promptName}`);
    }
    const serverContext = await this.ensureRoutableServer(route, context.authContext.userId, 'prompt');
    const cacheService = ResultCacheService.instance;
    const cachePolicy = cacheService.resolvePromptPolicy(serverContext.capabilitiesConfig, route.originalName);
    const callParams = { ...params, name: route.originalName, _meta: this.downstreamMeta(params) };
    const execute = async (): Promise<GetPromptResult> => {
      const client = this.requireClient(serverContext, 'prompt');
      const result = await client.getPrompt(callParams);
      serverContext.clearTimeout();
      return result;
    };
    const result = cachePolicy
      ? (await cacheService.executeWithCache('prompt', route.serverID, route.originalName, this.cacheScopeContext(context.authContext), cachePolicy, params.arguments, execute)).result
      : await execute();
    await this.logRequest(context, MCPEventLogType.ResponsePrompt, route.serverID, request, result, undefined, started, 200);
    return result;
  }

  private async complete(context: ModernRequestContext, request: ModernJsonRpcRequest, started: number): Promise<CompleteResult> {
    const params = this.requireParams(request);
    const ref = params.ref;
    if (!this.isJsonObject(ref) || typeof ref.type !== 'string') {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'params.ref is required');
    }
    const name = ref.type === 'ref/prompt' ? this.requireString(ref.name, 'params.ref.name') : this.requireString(ref.uri, 'params.ref.uri');
    const route = ref.type === 'ref/prompt'
      ? this.resolvePromptName(context.authContext, name)
      : this.resolveResourceUri(context.authContext, name);
    if (!route) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Invalid completion reference: ${name}`);
    }
    if (ref.type === 'ref/prompt' && !this.canUsePromptById(context.authContext, route.serverID, route.originalName)) {
      throw new ModernMcpError(403, ModernErrorCodes.InvalidParams, `Permission denied for prompt completion: ${name}`);
    }
    if (ref.type === 'ref/resource' && !this.canAccessResourceById(context.authContext, route.serverID, route.resourceName ?? route.originalName)) {
      throw new ModernMcpError(403, ModernErrorCodes.InvalidParams, `Permission denied for resource completion: ${name}`);
    }
    const serverContext = await this.ensureRoutableServer(route, context.authContext.userId, 'completion');
    const client = this.requireClient(serverContext, 'completion');
    const argument = this.isJsonObject(params.argument)
      ? {
          name: this.requireString(params.argument.name, 'params.argument.name'),
          value: this.requireString(params.argument.value, 'params.argument.value'),
        }
      : undefined;
    if (!argument) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'params.argument is required');
    }
    const result = ref.type === 'ref/prompt'
      ? await client.complete({ ...params, ref: { type: 'ref/prompt', name: route.originalName }, argument, _meta: this.downstreamMeta(params) })
      : await client.complete({ ...params, ref: { type: 'ref/resource', uri: route.originalName }, argument, _meta: this.downstreamMeta(params) });
    serverContext.clearTimeout();
    await this.logRequest(context, ref.type === 'ref/prompt' ? MCPEventLogType.ResponsePrompt : MCPEventLogType.ResponseResource, route.serverID, request, result, undefined, started, 200);
    return result;
  }

  private async buildPendingApprovalResult(
    context: ModernRequestContext,
    serverId: string,
    toolName: string,
    approvalCheck: Awaited<ReturnType<typeof approvalService.checkOrCreateApproval>>,
    policyVersion: number,
    request: ModernJsonRpcRequest,
    started: number,
  ): Promise<ModernCallToolResult> {
    try {
      if (approvalCheck.created && approvalCheck.request) {
        socketNotifier.notifyApprovalCreated(context.authContext.userId, {
          id: approvalCheck.request.id,
          toolName,
          serverId,
          redactedArgs: approvalCheck.request.redactedArgs,
          expiresAt: approvalCheck.request.expiresAt,
          createdAt: approvalCheck.request.createdAt,
          status: approvalCheck.request.status,
          uniformRequestId: context.uniformRequestId,
          policyVersion,
          matchedRuleId: null,
          reason: 'Policy requires approval',
          resumeToken: approvalCheck.request.id,
        });
      }
      await this.logRequest(context, MCPEventLogType.RequestTool, serverId, request, undefined, `ApprovalPending: ${approvalCheck.request?.id ?? 'pending'}`, started, 202);
      return {
        content: [{ type: 'text', text: `Approval required before executing ${toolName}. Request ID: ${approvalCheck.request?.id ?? 'pending'}` }],
        isError: false,
        _meta: {
          approval: {
            kind: 'approval_pending',
            approvalRequestId: approvalCheck.request?.id ?? null,
            requestHash: approvalCheck.requestHash,
            status: approvalCheck.request?.status ?? ApprovalStatus.Pending,
            policyVersion,
          },
        },
      };
    } catch (error) {
      if (error instanceof ApprovalRateLimitError) {
        return {
          content: [{ type: 'text', text: `Approval request rate limited: ${error.message}` }],
          isError: false,
          _meta: { approval: { kind: 'approval_rate_limited', status: 'rate_limited' }, retryAfterSeconds: 60 },
        };
      }
      throw error;
    }
  }

  private async handleSubscriptionListen(context: ModernRequestContext, request: ModernJsonRpcRequest): Promise<void> {
    const params = this.requireParams(request);
    if (request.id === undefined) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidRequest, 'subscriptions/listen requires a JSON-RPC id');
    }
    const filter = this.buildSubscriptionFilter(params);
    this.enforceSubscriptionScopes(context, filter);
    const subscriptionId = request.id;
    const downstreamSubscriptionId = `${context.uniformRequestId}:${String(subscriptionId)}`;
    const downstreamSubscriptions = await this.subscribeModernResources(context, filter, downstreamSubscriptionId);
    const capabilities = this.buildServerCapabilities(context);
    const acknowledgedNotifications: JsonObject = {};
    if (filter.notifications.toolsListChanged === true
      && this.isJsonObject(capabilities.tools)
      && capabilities.tools.listChanged === true) {
      acknowledgedNotifications.toolsListChanged = true;
    }
    if (filter.notifications.promptsListChanged === true
      && this.isJsonObject(capabilities.prompts)
      && capabilities.prompts.listChanged === true) {
      acknowledgedNotifications.promptsListChanged = true;
    }
    if (filter.notifications.resourcesListChanged === true
      && this.isJsonObject(capabilities.resources)
      && capabilities.resources.listChanged === true) {
      acknowledgedNotifications.resourcesListChanged = true;
    }
    if (downstreamSubscriptions.length > 0) {
      acknowledgedNotifications.resourceSubscriptions = downstreamSubscriptions.map((subscription) => subscription.requestedUri);
    }
    const res = context.res;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    this.writeSse(res, {
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { notifications: acknowledgedNotifications, _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId } },
    });

    const heartbeat = setInterval(() => {
      this.writeRawSse(res, ': heartbeat\n\n');
    }, 30_000);
    const subscriptionStarted = Date.now();
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      void this.cleanupModernResourceSubscriptions(context, downstreamSubscriptionId, downstreamSubscriptions);
    };
    const listener = (event: ModernSubscriptionEvent) => {
      if (!this.subscriptionMatches(context, filter, event)) {
        return;
      }
      if (!this.canReceiveSubscriptionEvent(context, event)) {
        return;
      }
      const eventParams = this.rewriteSubscriptionParams(context, event);
      this.writeSse(res, {
        jsonrpc: '2.0',
        method: event.method,
        params: {
          ...eventParams,
          _meta: {
            ...(this.isJsonObject(eventParams._meta) ? eventParams._meta : {}),
            'io.modelcontextprotocol/subscriptionId': subscriptionId,
          },
        },
      });
    };
    let closed = false;
    let authExpiryTimer: ReturnType<typeof setTimeout> | null = null;
    const closeSubscription = (reason: 'auth_expired' | 'client_closed') => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      if (authExpiryTimer) {
        clearTimeout(authExpiryTimer);
      }
      modernSubscriptionBus.offEvent(listener);
      cleanup();
      if (reason === 'auth_expired') {
        this.writeSse(res, {
          jsonrpc: '2.0',
          id: subscriptionId,
          result: {
            resultType: 'complete',
            _meta: {
              'io.modelcontextprotocol/subscriptionId': subscriptionId,
              'io.modelcontextprotocol/serverInfo': {
                name: APP_INFO.name,
                version: APP_INFO.version,
              },
            },
          },
        });
      }
      this.logger.info({
        protocolEra: 'modern',
        protocolVersion: context.protocolVersion,
        subscriptionDurationMs: Date.now() - subscriptionStarted,
        subscriptionDropReason: reason,
        subscriptionId,
      }, reason === 'auth_expired' ? 'Modern MCP subscription closed by auth expiry' : 'Modern MCP subscription closed');
      res.end();
    };
    const authExpiry = this.authExpirationMs(context.authContext);
    authExpiryTimer = authExpiry === null ? null : setTimeout(() => closeSubscription('auth_expired'), authExpiry);

    modernSubscriptionBus.onEvent(listener);
    context.req.on('close', () => closeSubscription('client_closed'));
  }

  private async handleNotification(context: ModernRequestContext, request: ModernJsonRpcRequest): Promise<void> {
    await LogService.getInstance().enqueueLog({
      action: MCPEventLogType.ServerNotification,
      userId: context.authContext.userId,
      sessionId: undefined,
      upstreamRequestId: undefined,
      uniformRequestId: context.uniformRequestId,
      requestParams: JSON.stringify({ method: request.method, params: request.params ?? {} }),
      statusCode: 202,
    });
  }

  private buildContext(req: Request, res: Response, validation: ModernValidationResult): ModernRequestContext {
    const authContext = req.authContext;
    if (!authContext) {
      throw new ModernMcpError(401, ModernErrorCodes.InvalidRequest, 'Modern MCP authentication context is missing');
    }
    return {
      req,
      res,
      authContext,
      protocolVersion: validation.meta[MODERN_META_VERSION_KEY],
      clientInfo: validation.meta[MODERN_META_CLIENT_INFO_KEY],
      clientCapabilities: validation.meta[MODERN_META_CLIENT_CAPABILITIES_KEY],
      requestId: validation.request.id,
      uniformRequestId: LogService.getInstance().generateUniformRequestId(`modern:${authContext.userId}`),
      isPublicEndpoint: this.isPublicEndpoint(req),
    };
  }

  private getAvailableServers(authContext: AuthContext): ServerContext[] {
    return ServerManager.instance.getAvailableServers().filter((serverContext) => this.canAccessServer(authContext, serverContext));
  }

  private canAccessServer(authContext: AuthContext, serverContext: ServerContext): boolean {
    if (!serverContext.serverEntity.enabled) {
      return false;
    }
    if (serverContext.status !== ServerStatus.Online && serverContext.status !== ServerStatus.Sleeping) {
      return false;
    }
    if (serverContext.serverEntity.allowUserInput) {
      return false;
    }
    const isAnonymous = authContext.kind === 'anonymous';
    if (isAnonymous && !serverContext.serverEntity.anonymousAccess) {
      return false;
    }
    const serverPermsEnabled = authContext.permissions[serverContext.serverID]?.enabled ?? (isAnonymous ? serverContext.serverEntity.anonymousAccess : serverContext.serverEntity.publicAccess);
    const userPreferencesEnabled = authContext.userPreferences[serverContext.serverID]?.enabled ?? true;
    return serverPermsEnabled && userPreferencesEnabled;
  }

  private canUseTool(authContext: AuthContext, serverContext: ServerContext, toolName: string): boolean {
    if (!this.canAccessCapability(authContext, serverContext, 'tool', toolName)) {
      return false;
    }
    if (!serverContext.serverEntity.allowUserInput && authContext.permissions[serverContext.serverID]?.tools[toolName]?.enabled === false) {
      return false;
    }
    return authContext.userPreferences[serverContext.serverID]?.tools[toolName]?.enabled ?? true;
  }

  private canAccessResource(authContext: AuthContext, serverContext: ServerContext, resourceName: string): boolean {
    if (!this.canAccessCapability(authContext, serverContext, 'resource', resourceName)) {
      return false;
    }
    if (!serverContext.serverEntity.allowUserInput && authContext.permissions[serverContext.serverID]?.resources[resourceName]?.enabled === false) {
      return false;
    }
    return authContext.userPreferences[serverContext.serverID]?.resources[resourceName]?.enabled ?? true;
  }

  private canUsePrompt(authContext: AuthContext, serverContext: ServerContext, promptName: string): boolean {
    if (!this.canAccessCapability(authContext, serverContext, 'prompt', promptName)) {
      return false;
    }
    if (!serverContext.serverEntity.allowUserInput && authContext.permissions[serverContext.serverID]?.prompts[promptName]?.enabled === false) {
      return false;
    }
    return authContext.userPreferences[serverContext.serverID]?.prompts[promptName]?.enabled ?? true;
  }

  private canAccessCapability(authContext: AuthContext, serverContext: ServerContext, type: 'tool' | 'resource' | 'prompt', name: string): boolean {
    if (!this.canAccessServer(authContext, serverContext)) {
      return false;
    }
    if (serverContext.serverEntity.allowUserInput && serverContext.userId !== authContext.userId) {
      return false;
    }
    const capabilitiesConfig = serverContext.capabilitiesConfig;
    if (type === 'tool') {
      return capabilitiesConfig.tools[name]?.enabled ?? true;
    }
    if (type === 'resource') {
      return capabilitiesConfig.resources[name]?.enabled ?? true;
    }
    return capabilitiesConfig.prompts[name]?.enabled ?? true;
  }

  private canUseToolById(authContext: AuthContext, serverID: string, toolName: string): boolean {
    const serverContext = ServerManager.instance.getServerContext(serverID, authContext.userId);
    return Boolean(serverContext && this.canUseTool(authContext, serverContext, toolName));
  }

  private canAccessResourceById(authContext: AuthContext, serverID: string, resourceName: string): boolean {
    const serverContext = ServerManager.instance.getServerContext(serverID, authContext.userId);
    return Boolean(serverContext && this.canAccessResource(authContext, serverContext, resourceName));
  }

  private canUsePromptById(authContext: AuthContext, serverID: string, promptName: string): boolean {
    const serverContext = ServerManager.instance.getServerContext(serverID, authContext.userId);
    return Boolean(serverContext && this.canUsePrompt(authContext, serverContext, promptName));
  }

  private resolveToolName(authContext: AuthContext, name: string): GatewayRoute | null {
    const parsed = this.parseGatewayName(name, authContext.userId);
    if (parsed) {
      const serverContext = ServerManager.instance.getServerContext(parsed.serverID, authContext.userId);
      const tool = serverContext ? this.findTool(serverContext, parsed.originalName) : undefined;
      return serverContext && tool && this.canUseTool(authContext, serverContext, tool.name)
        ? { serverID: parsed.serverID, originalName: tool.name }
        : null;
    }
    let match: GatewayRoute | null = null;
    for (const serverContext of this.getAvailableServers(authContext)) {
      const tools = serverContext.tools?.tools ?? serverContext.cachedTools?.tools ?? [];
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool || !this.canUseTool(authContext, serverContext, tool.name)) {
        continue;
      }
      if (match) {
        return null;
      }
      match = { serverID: serverContext.serverID, originalName: tool.name };
    }
    return match;
  }

  private resolveResourceUri(authContext: AuthContext, uri: string): GatewayRoute | null {
    const parsed = this.parseGatewayName(uri, authContext.userId);
    if (parsed) {
      const serverContext = ServerManager.instance.getServerContext(parsed.serverID, authContext.userId);
      const resourceName = serverContext ? this.findResourceName(serverContext, parsed.originalName) : undefined;
      return serverContext && resourceName && this.canAccessResource(authContext, serverContext, resourceName)
        ? { serverID: parsed.serverID, originalName: parsed.originalName, resourceName }
        : null;
    }
    let match: GatewayRoute | null = null;
    for (const serverContext of this.getAvailableServers(authContext)) {
      const resources = serverContext.resources?.resources ?? serverContext.cachedResources?.resources ?? [];
      const resource = resources.find((candidate) => candidate.uri === uri);
      if (!resource || !this.canAccessResource(authContext, serverContext, resource.name)) {
        continue;
      }
      if (match) {
        return null;
      }
      match = { serverID: serverContext.serverID, originalName: resource.uri, resourceName: resource.name };
    }
    return match;
  }

  private resolveResourceUriForSubscription(authContext: AuthContext, uri: string, serverIds: Set<string>): GatewayRoute | null {
    const parsed = this.parseGatewayName(uri, authContext.userId);
    if (parsed) {
      if (serverIds.size > 0 && !serverIds.has(parsed.serverID)) {
        return null;
      }
      return this.resolveResourceUri(authContext, uri);
    }

    const matchingRoutes: GatewayRoute[] = [];
    for (const serverContext of this.getAvailableServers(authContext)) {
      if (serverIds.size > 0 && !serverIds.has(serverContext.serverID)) {
        continue;
      }
      const resources = serverContext.resources?.resources ?? serverContext.cachedResources?.resources ?? [];
      const resource = resources.find((candidate) => candidate.uri === uri);
      if (!resource || !this.canAccessResource(authContext, serverContext, resource.name)) {
        continue;
      }
      matchingRoutes.push({ serverID: serverContext.serverID, originalName: resource.uri, resourceName: resource.name });
    }

    return matchingRoutes.length === 1 ? matchingRoutes[0] : null;
  }

  private resolvePromptName(authContext: AuthContext, name: string): GatewayRoute | null {
    const parsed = this.parseGatewayName(name, authContext.userId);
    if (parsed) {
      const serverContext = ServerManager.instance.getServerContext(parsed.serverID, authContext.userId);
      const prompt = serverContext ? this.findPrompt(serverContext, parsed.originalName) : undefined;
      return serverContext && prompt && this.canUsePrompt(authContext, serverContext, prompt.name)
        ? { serverID: parsed.serverID, originalName: prompt.name }
        : null;
    }
    let match: GatewayRoute | null = null;
    for (const serverContext of this.getAvailableServers(authContext)) {
      const prompts = serverContext.prompts?.prompts ?? serverContext.cachedPrompts?.prompts ?? [];
      const prompt = prompts.find((candidate) => candidate.name === name);
      if (!prompt || !this.canUsePrompt(authContext, serverContext, prompt.name)) {
        continue;
      }
      if (match) {
        return null;
      }
      match = { serverID: serverContext.serverID, originalName: prompt.name };
    }
    return match;
  }

  private async ensureRoutableServer(route: GatewayRoute, userId: string, kind: string): Promise<ServerContext> {
    let serverContext = ServerManager.instance.getServerContext(route.serverID, userId);
    if (serverContext?.serverEntity.allowUserInput) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidRequest, `Server ${route.serverID} requires user input and is not available through sessionless modern MCP`);
    }
    await ServerManager.instance.ensureServerAvailable(route.serverID, userId);
    serverContext = ServerManager.instance.getServerContext(route.serverID, userId);
    if (!serverContext) {
      throw new ModernMcpError(503, ModernErrorCodes.InternalError, `No server available for ${kind}: ${route.serverID}`);
    }
    if (serverContext.serverEntity.allowUserInput) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidRequest, `Server ${route.serverID} requires user input and is not available through sessionless modern MCP`);
    }
    return serverContext;
  }

  private requireClient(serverContext: ServerContext, kind: string) {
    if (!serverContext.connection) {
      throw new ModernMcpError(503, ModernErrorCodes.InternalError, `No downstream client available for ${kind}`);
    }
    return serverContext.connection;
  }

  private buildServerCapabilities(context: ModernRequestContext): JsonObject {
    const availableServers = this.getAvailableServers(context.authContext);
    const capabilities: JsonObject = {};
    if (availableServers.some((serverContext) =>
      serverContext.capabilities?.tools !== undefined
      || serverContext.tools?.tools !== undefined
      || serverContext.cachedTools?.tools !== undefined)) {
      capabilities.tools = availableServers.some((serverContext) =>
        serverContext.connection?.protocolEra === 'legacy'
        && serverContext.capabilities?.tools?.listChanged === true)
        ? { listChanged: true }
        : {};
    }
    for (const serverContext of availableServers) {
      if (serverContext.capabilities?.resources
        || serverContext.resources?.resources !== undefined
        || serverContext.cachedResources?.resources !== undefined
        || serverContext.resourceTemplates?.resourceTemplates !== undefined
        || serverContext.cachedResourceTemplates?.resourceTemplates !== undefined) {
        const alreadySupportsListChanges = this.isJsonObject(capabilities.resources)
          && capabilities.resources.listChanged === true;
        const alreadySupportsSubscriptions = this.isJsonObject(capabilities.resources)
          && capabilities.resources.subscribe === true;
        capabilities.resources = {
          ...(alreadySupportsListChanges
            || (serverContext.connection?.protocolEra === 'legacy' && serverContext.capabilities?.resources?.listChanged === true)
            ? { listChanged: true }
            : {}),
          ...(alreadySupportsSubscriptions
            || (serverContext.connection?.protocolEra === 'legacy' && serverContext.capabilities?.resources?.subscribe === true)
            ? { subscribe: true }
            : {}),
        };
      }
      if (serverContext.capabilities?.prompts
        || serverContext.prompts?.prompts !== undefined
        || serverContext.cachedPrompts?.prompts !== undefined) {
        const alreadySupportsListChanges = this.isJsonObject(capabilities.prompts)
          && capabilities.prompts.listChanged === true;
        capabilities.prompts = alreadySupportsListChanges
          || (serverContext.connection?.protocolEra === 'legacy' && serverContext.capabilities?.prompts?.listChanged === true)
          ? { listChanged: true }
          : {};
      }
      if (serverContext.capabilities?.completions) {
        capabilities.completions = {};
      }
    }
    if (this.supportsMcpApps(context.clientCapabilities) && this.hasAvailableMcpApps(context.authContext, availableServers)) {
      capabilities.extensions = {
        'io.modelcontextprotocol/ui': {
          mimeTypes: ['text/html;profile=mcp-app'],
        },
      };
    }
    return capabilities;
  }

  private cacheable<T extends JsonValue | ListResult | CallToolResult | ReadResourceResult | GetPromptResult | CompleteResult>(result: T): JsonValue {
    if (this.isJsonObject(result)) {
      const cacheableResult = result as ModernCacheableResult;
      return {
        ...result,
        _meta: {
          ...(this.isJsonObject(result._meta) ? result._meta : {}),
          'io.modelcontextprotocol/serverInfo': {
            name: APP_INFO.name,
            version: APP_INFO.version,
          },
        },
        resultType: cacheableResult.resultType ?? 'complete',
        ttlMs: cacheableResult.ttlMs ?? MODERN_MCP_CONFIG.defaultListTtlMs,
        cacheScope: cacheableResult.cacheScope ?? MODERN_MCP_CONFIG.defaultCacheScope,
      };
    }
    return result as JsonValue;
  }

  private writeJsonResult(res: Response, id: JsonRpcId | undefined, result: JsonValue): void {
    res.status(200).json({ jsonrpc: '2.0', result, id: id ?? null });
  }

  private writeSse(res: Response, payload: JsonValue): void {
    this.writeRawSse(res, `event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  private writeRawSse(res: Response, chunk: string): void {
    const accepted = res.write(chunk);
    if (!accepted) {
      this.logger.warn({ protocolEra: 'modern' }, 'Modern MCP subscription stream backpressure detected');
    }
  }

  private sendModernError(res: Response, rawRequest: unknown, error: ModernMcpError, req?: Request): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    const requiredScopes = this.requiredScopesFromError(error);
    if (requiredScopes.length > 0 && req) {
      res.setHeader('WWW-Authenticate', this.buildScopeChallenge(req, requiredScopes));
    }
    const id = this.extractId(rawRequest);
    res.status(error.httpStatus).json(modernErrorResponse(id, error));
  }

  private toModernError(error: unknown): ModernMcpError {
    if (error instanceof ModernMcpError) {
      return error;
    }
    return new ModernMcpError(500, ModernErrorCodes.InternalError, error instanceof Error ? error.message : String(error));
  }

  private acceptsModernResponse(accept: string): boolean {
    const mediaTypes = new Set(
      accept
        .split(',')
        .map((part) => part.trim().split(';', 1)[0]?.toLowerCase())
        .filter((part): part is string => Boolean(part)),
    );
    const hasJson = mediaTypes.has('application/json');
    const hasSse = mediaTypes.has('text/event-stream');
    return hasJson && hasSse;
  }

  private isModernProtocolHeader(protocolHeader: string | undefined): boolean {
    if (!protocolHeader) {
      return false;
    }
    if (MODERN_MCP_CONFIG.supportedVersions.includes(protocolHeader)) {
      return true;
    }
    return !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolHeader);
  }

  private validateNameHeader(req: Request, request: ModernJsonRpcRequest): void {
    if (!['tools/call', 'prompts/get', 'resources/read'].includes(request.method)) {
      return;
    }
    const header = this.getHeader(req, 'mcp-name');
    if (!header) {
      throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, 'Mcp-Name header is required');
    }
    const params = this.requireParams(request);
    const expected = request.method === 'resources/read' ? this.requireString(params.uri, 'params.uri') : this.requireString(params.name, 'params.name');
    if (this.decodeHeaderMirrorValue(header, 'Mcp-Name') !== expected) {
      throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, 'Mcp-Name does not match request params');
    }
  }

  private validateHeaderMirrors(req: Request, request: ModernJsonRpcRequest): void {
    const params = request.params;
    if (!params) {
      return;
    }
    for (const [key, value] of Object.entries(params)) {
      if (!key.startsWith('Mcp-Param-')) {
        continue;
      }
      const headerValue = this.getHeader(req, key.toLowerCase());
      if (headerValue !== String(value)) {
        throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, `${key} does not match request parameter`);
      }
    }
  }

  private buildSubscriptionFilter(params: JsonObject): ModernSubscriptionFilter {
    const notifications = this.buildSubscriptionNotifications(params);
    const methods = this.requireStringArrayFilter(params, 'methods');
    const invalidMethods = methods.filter((method) => !this.isSupportedSubscriptionMethod(method));
    if (invalidMethods.length > 0) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Unsupported subscription methods: ${invalidMethods.join(', ')}`);
    }
    const requestedMethods = new Set(methods);
    if (notifications.toolsListChanged === true) {
      requestedMethods.add('notifications/tools/list_changed');
    }
    if (notifications.promptsListChanged === true) {
      requestedMethods.add('notifications/prompts/list_changed');
    }
    if (notifications.resourcesListChanged === true) {
      requestedMethods.add('notifications/resources/list_changed');
    }
    const resourceSubscriptions = Array.isArray(notifications.resourceSubscriptions)
      ? notifications.resourceSubscriptions.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    if (resourceSubscriptions.length > 0) {
      requestedMethods.add('notifications/resources/updated');
    }
    return {
      methods: requestedMethods,
      serverIds: new Set(this.requireStringArrayFilter(params, 'serverIds')),
      resourceUris: new Set([...this.requireStringArrayFilter(params, 'resourceUris'), ...resourceSubscriptions]),
      notifications,
    };
  }

  private buildSubscriptionNotifications(params: JsonObject): JsonObject {
    const notifications = params.notifications;
    if (notifications === undefined) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'params.notifications is required');
    }
    if (!this.isJsonObject(notifications)) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'notifications must be an object');
    }
    for (const key of ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged']) {
      const value = notifications[key];
      if (value !== undefined && typeof value !== 'boolean') {
        throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `notifications.${key} must be a boolean`);
      }
    }
    const resourceSubscriptions = notifications.resourceSubscriptions;
    if (resourceSubscriptions !== undefined) {
      if (!Array.isArray(resourceSubscriptions) || resourceSubscriptions.some((item) => typeof item !== 'string' || item.length === 0)) {
        throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'notifications.resourceSubscriptions must be an array of non-empty strings');
      }
    }
    return notifications;
  }

  private requireStringArrayFilter(params: JsonObject, key: 'methods' | 'serverIds' | 'resourceUris'): string[] {
    const value = params[key];
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `${key} must be an array of strings`);
    }
    const stringValues = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
    if (stringValues.length !== value.length) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `${key} must contain only non-empty strings`);
    }
    return stringValues;
  }

  private subscriptionMatches(context: ModernRequestContext, filter: ModernSubscriptionFilter, event: ModernSubscriptionEvent): boolean {
    if (filter.methods.size === 0) {
      return false;
    }
    if (!filter.methods.has(event.method)) {
      return false;
    }
    if (filter.serverIds.size > 0 && (!event.serverId || !filter.serverIds.has(event.serverId))) {
      return false;
    }
    if (filter.resourceUris.size > 0 && !this.subscriptionResourceMatches(context, filter, event)) {
      return false;
    }
    return true;
  }

  private subscriptionResourceMatches(context: ModernRequestContext, filter: ModernSubscriptionFilter, event: ModernSubscriptionEvent): boolean {
    if (!event.resourceUri) {
      return false;
    }
    for (const uri of this.subscriptionResourceUris(context, event)) {
      if (filter.resourceUris.has(uri)) {
        return true;
      }
    }
    return false;
  }

  private subscriptionResourceUris(context: ModernRequestContext, event: ModernSubscriptionEvent): string[] {
    if (!event.resourceUri) {
      return [];
    }
    const uris = [event.resourceUri];
    const serverContext = this.resolveSubscriptionEventServerContext(context, event);
    if (serverContext) {
      uris.push(this.generateGatewayName(serverContext.id, event.resourceUri));
    }
    return uris;
  }

  private canReceiveSubscriptionEvent(context: ModernRequestContext, event: ModernSubscriptionEvent): boolean {
    if (!event.serverId) {
      return true;
    }
    const serverContext = this.resolveSubscriptionEventServerContext(context, event);
    if (!serverContext || !this.canAccessServer(context.authContext, serverContext)) {
      return false;
    }
    if (event.resourceUri) {
      const resourceName = this.findResourceName(serverContext, event.resourceUri);
      if (!resourceName) {
        return false;
      }
      return this.canAccessResource(context.authContext, serverContext, resourceName);
    }
    return true;
  }

  private rewriteSubscriptionParams(context: ModernRequestContext, event: ModernSubscriptionEvent): JsonObject {
    if (!event.resourceUri || !event.serverId) {
      return event.params;
    }
    const serverContext = this.resolveSubscriptionEventServerContext(context, event);
    if (!serverContext) {
      return event.params;
    }
    const gatewayUri = this.generateGatewayName(serverContext.id, event.resourceUri);
    return { ...event.params, uri: gatewayUri };
  }

  private resolveSubscriptionEventServerContext(context: ModernRequestContext, event: ModernSubscriptionEvent): ServerContext | undefined {
    if (event.scopeId) {
      return ServerManager.instance.getServerContextByID(event.scopeId)
        ?? ServerManager.instance.getTemporaryServerContextByID(event.scopeId, context.authContext.userId);
    }
    return event.serverId ? ServerManager.instance.getServerContext(event.serverId, context.authContext.userId) : undefined;
  }

  private async subscribeModernResources(
    context: ModernRequestContext,
    filter: ModernSubscriptionFilter,
    subscriptionId: string,
  ): Promise<ModernResourceSubscription[]> {
    if (!filter.methods.has('notifications/resources/updated') || filter.resourceUris.size === 0) {
      return [];
    }
    const subscriptions: ModernResourceSubscription[] = [];
    try {
      for (const uri of filter.resourceUris) {
        const route = this.resolveResourceUriForSubscription(context.authContext, uri, filter.serverIds);
        if (!route) {
          throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Invalid resource subscription URI: ${uri}`);
        }
        if (!this.canAccessResourceById(context.authContext, route.serverID, route.resourceName ?? route.originalName)) {
          throw new ModernMcpError(403, ModernErrorCodes.InvalidRequest, `Permission denied for resource subscription: ${uri}`);
        }
        const serverContext = ServerManager.instance.getServerContext(route.serverID, context.authContext.userId);
        if (serverContext?.connection?.protocolEra !== 'legacy' || serverContext.capabilities?.resources?.subscribe !== true) {
          continue;
        }
        await ServerManager.instance.subscribeResource(route.serverID, route.originalName, subscriptionId, context.authContext.userId);
        subscriptions.push({ serverId: route.serverID, resourceUri: route.originalName, requestedUri: uri });
      }
      return subscriptions;
    } catch (error) {
      await this.cleanupModernResourceSubscriptions(context, subscriptionId, subscriptions);
      throw error;
    }
  }

  private async cleanupModernResourceSubscriptions(
    context: ModernRequestContext,
    subscriptionId: string,
    subscriptions: ModernResourceSubscription[],
  ): Promise<void> {
    await Promise.all(subscriptions.map((subscription) =>
      ServerManager.instance.unsubscribeResource(subscription.serverId, subscription.resourceUri, subscriptionId, context.authContext.userId).catch((error) => {
        this.logger.warn({ error, subscriptionId, ...subscription }, 'Failed to clean up modern resource subscription');
      }),
    ));
  }

  private async logRequest(context: ModernRequestContext, action: MCPEventLogType, serverId: string, request: ModernJsonRpcRequest, responseResult: unknown, error: string | undefined, started: number, statusCode: number): Promise<void> {
    await LogService.getInstance().enqueueLog({
      action,
      userId: context.authContext.userId,
      sessionId: undefined,
      serverId,
      upstreamRequestId: String(context.requestId ?? ''),
      uniformRequestId: context.uniformRequestId,
      ip: context.req.clientIp || context.req.ip,
      userAgent: context.req.headers['user-agent'],
      tokenMask: maskToken(context.authContext.token),
      requestParams: JSON.stringify({
        ...(request.params ?? {}),
        _peta: {
          protocolEra: 'modern',
          protocolVersion: context.protocolVersion,
          clientInfo: context.clientInfo,
          validationErrorType: null,
          authFailureReason: null,
          downstreamBridgeFailure: false,
          mrtrResultCount: 0,
        },
      }),
      responseResult: responseResult === undefined ? undefined : JSON.stringify(responseResult),
      error,
      duration: Date.now() - started,
      statusCode,
    });
  }

  private getRequestMeta(request: ModernJsonRpcRequest): ModernRequestMeta | null {
    const params = request.params;
    if (!params || !this.isJsonObject(params._meta)) {
      return null;
    }
    return params._meta as unknown as ModernRequestMeta;
  }

  private getRequestMetaFromUnknown(body: unknown): JsonObject | null {
    if (!this.isJsonObject(body) || !this.isJsonObject(body.params) || !this.isJsonObject(body.params._meta)) {
      return null;
    }
    return body.params._meta;
  }

  private hasRequestMetaKeyFromUnknown(body: unknown): boolean {
    return this.isJsonObject(body) && this.isJsonObject(body.params) && '_meta' in body.params;
  }

  private enforceModernScopes(context: ModernRequestContext, request: ModernJsonRpcRequest): void {
    const scopes = this.requiredScopesForRequest(request);
    for (const scope of scopes) {
      this.requireOAuthScope(context, scope);
    }
  }

  private enforceSubscriptionScopes(context: ModernRequestContext, filter: ModernSubscriptionFilter): void {
    for (const scope of this.requiredScopesForSubscription(filter)) {
      this.requireOAuthScope(context, scope);
    }
  }

  private requireOAuthScope(context: ModernRequestContext, scope: ModernOAuthScope): void {
    if (!context.authContext.oauthClientId) {
      return;
    }
    if (!context.authContext.oauthScopes?.includes(scope)) {
      throw new ModernMcpError(403, ModernErrorCodes.InvalidRequest, `OAuth scope required: ${scope}`, {
        oauth: { error: 'insufficient_scope', requiredScopes: [scope] },
      });
    }
  }

  private requiredScopesFromError(error: ModernMcpError): string[] {
    const data = error.data;
    if (!this.isJsonObject(data) || !this.isJsonObject(data.oauth)) {
      return [];
    }
    const requiredScopes = data.oauth.requiredScopes;
    if (!Array.isArray(requiredScopes)) {
      return [];
    }
    return requiredScopes.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0);
  }

  private buildScopeChallenge(req: Request, requiredScopes: string[]): string {
    const base = new URL(getPublicUrl(req));
    base.pathname = '';
    const metadataUrl = `${base.toString().replace(/\/$/, '')}/.well-known/oauth-protected-resource/mcp`;
    return `Bearer realm="peta-core", error="insufficient_scope", error_description="Insufficient OAuth scope", resource_metadata="${metadataUrl}", scope="${requiredScopes.join(' ')}"`;
  }

  private requiredScopesForRequest(request: ModernJsonRpcRequest): ModernOAuthScope[] {
    switch (request.method) {
      case 'server/discover':
        return [];
      case 'tools/list':
      case 'tools/call':
        return ['mcp:tools'];
      case 'resources/list':
      case 'resources/templates/list':
      case 'resources/read':
        return ['mcp:resources'];
      case 'prompts/list':
      case 'prompts/get':
        return ['mcp:prompts'];
      case 'completion/complete': {
        const params = this.requireParams(request);
        const ref = params.ref;
        if (!this.isJsonObject(ref) || typeof ref.type !== 'string') {
          throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'params.ref is required');
        }
        if (ref.type === 'ref/prompt') {
          return ['mcp:prompts'];
        }
        if (ref.type === 'ref/resource') {
          return ['mcp:resources'];
        }
        throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Unsupported completion ref type: ${ref.type}`);
      }
      default:
        return [];
    }
  }

  private requiredScopesForSubscription(filter: ModernSubscriptionFilter): ModernOAuthScope[] {
    const methods = Array.from(filter.methods);
    const scopes = new Set<ModernOAuthScope>();
    for (const method of methods) {
      if (method === 'notifications/tools/list_changed') {
        scopes.add('mcp:tools');
      }
      if (method === 'notifications/resources/list_changed' || method === 'notifications/resources/updated') {
        scopes.add('mcp:resources');
      }
      if (method === 'notifications/prompts/list_changed') {
        scopes.add('mcp:prompts');
      }
    }
    return Array.from(scopes);
  }

  private authExpirationMs(authContext: AuthContext): number | null {
    const expirationSeconds = authContext.oauthAccessTokenExpiresAt ?? authContext.expiresAt;
    if (!expirationSeconds) {
      return null;
    }
    return Math.max(0, expirationSeconds * 1000 - Date.now());
  }

  private getBodyMethod(body: unknown): string | undefined {
    return this.isJsonObject(body) && typeof body.method === 'string' ? body.method : undefined;
  }

  private extractId(rawRequest: unknown): JsonRpcId | undefined {
    if (!this.isJsonObject(rawRequest) || !('id' in rawRequest) || !this.isJsonRpcId(rawRequest.id)) {
      return undefined;
    }
    return rawRequest.id;
  }

  private requireParams(request: ModernJsonRpcRequest): JsonObject {
    if (!request.params) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, 'params are required');
    }
    return request.params;
  }

  private requireString(value: JsonValue | undefined, name: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `${name} is required`);
    }
    return value;
  }

  private parseGatewayName(name: string, userId?: string): GatewayRoute | null {
    const index = name.lastIndexOf('_-_');
    if (index === -1) {
      return null;
    }
    const contextId = name.slice(index + 3);
    const serverContext = ServerManager.instance.getServerContextByID(contextId) ?? (userId ? ServerManager.instance.getTemporaryServerContextByID(contextId, userId) : undefined);
    if (!serverContext) {
      return null;
    }
    const originalName = name.slice(0, index);
    return { serverID: serverContext.serverID, originalName, resourceName: this.findResourceName(serverContext, originalName) };
  }

  private findTool(serverContext: ServerContext, toolName: string): Tool | undefined {
    const tools = serverContext.tools?.tools ?? serverContext.cachedTools?.tools ?? [];
    return tools.find((tool) => tool.name === toolName);
  }

  private findPrompt(serverContext: ServerContext, promptName: string) {
    const prompts = serverContext.prompts?.prompts ?? serverContext.cachedPrompts?.prompts ?? [];
    return prompts.find((prompt) => prompt.name === promptName);
  }

  private getToolUiResourceUri(tool: Tool): string | undefined {
    if (
      typeof tool._meta?.ui === 'object' &&
      tool._meta?.ui &&
      'resourceUri' in tool._meta.ui &&
      typeof tool._meta.ui.resourceUri === 'string'
    ) {
      return tool._meta.ui.resourceUri;
    }

    if (typeof tool._meta?.['ui/resourceUri'] === 'string') {
      return tool._meta['ui/resourceUri'];
    }

    return undefined;
  }

  private supportsMcpApps(clientCapabilities: JsonObject | undefined): boolean {
    const extensions = clientCapabilities && this.isJsonObject(clientCapabilities.extensions)
      ? clientCapabilities.extensions
      : undefined;
    const ui = extensions && this.isJsonObject(extensions['io.modelcontextprotocol/ui'])
      ? extensions['io.modelcontextprotocol/ui']
      : undefined;
    return Boolean(ui && Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes('text/html;profile=mcp-app'));
  }

  private hasAvailableMcpApps(authContext: AuthContext, serverContexts: ServerContext[]): boolean {
    return serverContexts.some((serverContext) => {
      const resources = serverContext.resources?.resources ?? serverContext.cachedResources?.resources ?? [];
      const appResourceUris = new Set(
        resources
          .filter((resource) => resource.uri.startsWith('ui://')
            && resource.mimeType === 'text/html;profile=mcp-app'
            && this.canAccessResource(authContext, serverContext, resource.name))
          .map((resource) => resource.uri),
      );
      const tools = serverContext.tools?.tools ?? serverContext.cachedTools?.tools ?? [];
      return tools.some((tool) => {
        if (!this.canUseTool(authContext, serverContext, tool.name)) {
          return false;
        }
        const resourceUri = this.getToolUiResourceUri(tool);
        return resourceUri !== undefined && appResourceUris.has(resourceUri);
      });
    });
  }

  private stripUiToolMeta(tool: Tool): Tool['_meta'] | undefined {
    if (!tool._meta) {
      return undefined;
    }
    const entries = Object.entries(tool._meta).filter(([key]) => key !== 'ui' && key !== 'ui/resourceUri');
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  private buildToolMetaWithProxiedResourceUri(tool: Tool, proxiedResourceUri?: string): Tool['_meta'] | undefined {
    if (!proxiedResourceUri) {
      return tool._meta;
    }

    const nextMeta: NonNullable<Tool['_meta']> = {
      ...(tool._meta ?? {}),
      'ui/resourceUri': proxiedResourceUri,
    };

    if (typeof tool._meta?.ui === 'object' && tool._meta.ui) {
      nextMeta.ui = {
        ...tool._meta.ui,
        resourceUri: proxiedResourceUri,
      };
    } else {
      nextMeta.ui = { resourceUri: proxiedResourceUri };
    }

    return nextMeta;
  }

  private validateToolHeaderAnnotations(req: Request, tool: Tool, args: JsonObject): void {
    const inputSchema = this.isJsonObject(tool.inputSchema) ? tool.inputSchema : undefined;
    if (!inputSchema) {
      return;
    }

    for (const annotation of this.normalizeHeaderAnnotations(tool, this.findHeaderAnnotations(inputSchema))) {
      const { path, headerName } = annotation;
      const propertyName = path.join('.');
      const argumentValue = this.getArgumentAtPath(args, path);
      const mirroredHeaderValue = this.getHeader(req, headerName.toLowerCase());
      if (argumentValue === undefined || argumentValue === null) {
        if (mirroredHeaderValue !== undefined) {
          throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, `${headerName} must be omitted when tool argument ${propertyName} is null or missing`);
        }
        continue;
      }
      if (!this.isHeaderMirrorValue(argumentValue)) {
        throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `x-mcp-header argument ${propertyName} must be a string, integer, or boolean`);
      }
      if (mirroredHeaderValue === undefined || this.decodeHeaderMirrorValue(mirroredHeaderValue) !== String(argumentValue)) {
        throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, `${headerName} does not match tool argument ${propertyName}`);
      }
    }
  }

  private hasValidHeaderAnnotations(tool: Tool): boolean {
    try {
      const inputSchema = this.isJsonObject(tool.inputSchema) ? tool.inputSchema : undefined;
      if (inputSchema) {
        this.normalizeHeaderAnnotations(tool, this.findHeaderAnnotations(inputSchema));
      }
      return true;
    } catch (error) {
      if (error instanceof ModernMcpError) {
        return false;
      }
      throw error;
    }
  }

  private normalizeHeaderAnnotations(tool: Tool, annotations: Array<{ path: string[]; headerName: string }>): Array<{ path: string[]; headerName: string }> {
    const seenHeaders = new Set<string>();
    return annotations.map((annotation) => {
      const propertyName = annotation.path.join('.');
      const headerName = `Mcp-Param-${annotation.headerName}`;
      if (!/^Mcp-Param-[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(headerName)) {
        throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Invalid x-mcp-header annotation for ${tool.name}.${propertyName}`);
      }
      const normalizedHeaderName = headerName.toLowerCase();
      if (seenHeaders.has(normalizedHeaderName)) {
        throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Duplicate x-mcp-header annotation for ${headerName}`);
      }
      seenHeaders.add(normalizedHeaderName);
      return { path: annotation.path, headerName };
    });
  }

  private findHeaderAnnotations(schema: JsonObject, path: string[] = []): Array<{ path: string[]; headerName: string }> {
    const annotations: Array<{ path: string[]; headerName: string }> = [];
    const properties = this.isJsonObject(schema.properties) ? schema.properties : undefined;
    if (!properties) {
      return annotations;
    }
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (!this.isJsonObject(propertySchema)) {
        continue;
      }
      const childPath = [...path, propertyName];
      const headerName = propertySchema['x-mcp-header'];
      if (headerName !== undefined) {
        if (typeof headerName !== 'string' || headerName.length === 0) {
          throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `Invalid x-mcp-header annotation for ${childPath.join('.')}`);
        }
        const schemaType = propertySchema.type;
        if (schemaType !== 'string' && schemaType !== 'integer' && schemaType !== 'boolean') {
          throw new ModernMcpError(400, ModernErrorCodes.InvalidParams, `x-mcp-header annotation for ${childPath.join('.')} requires string, integer, or boolean schema type`);
        }
        annotations.push({ path: childPath, headerName });
      }
      annotations.push(...this.findHeaderAnnotations(propertySchema, childPath));
    }
    return annotations;
  }

  private getArgumentAtPath(args: JsonObject, path: string[]): JsonValue | undefined {
    let current: JsonValue | undefined = args;
    for (const segment of path) {
      if (!this.isJsonObject(current)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  }

  private decodeHeaderMirrorValue(value: string, headerName = 'Mcp-Param'): string {
    const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
    if (!match) {
      return value;
    }
    if (match[1].length === 0 || match[1].length % 4 !== 0 || /=[^=]/.test(match[1])) {
      throw new ModernMcpError(400, ModernErrorCodes.HeaderMismatch, `Invalid base64 ${headerName} header value`);
    }
    return Buffer.from(match[1], 'base64').toString('utf8');
  }

  private findResourceName(serverContext: ServerContext, uri: string): string | undefined {
    const resources = serverContext.resources?.resources ?? serverContext.cachedResources?.resources ?? [];
    const resourceName = resources.find((resource) => resource.uri === uri)?.name;
    if (resourceName) {
      return resourceName;
    }
    const templates = serverContext.resourceTemplates?.resourceTemplates ?? serverContext.cachedResourceTemplates?.resourceTemplates ?? [];
    return templates.find((template) => template.uriTemplate === uri)?.name;
  }

  private generateGatewayName(contextId: string, name: string): string {
    return `${name}_-_${contextId}`;
  }

  private getUserToolDangerLevel(authContext: AuthContext, serverID: string, toolName: string): DangerLevel | undefined {
    return authContext.userPreferences[serverID]?.tools[toolName]?.dangerLevel;
  }

  private cacheScopeContext(authContext: AuthContext): CacheScopeContext {
    return { userId: authContext.userId, tenantId: authContext.tenantId };
  }

  private downstreamMeta(params: JsonObject): JsonObject {
    return {
      ...(this.isJsonObject(params._meta) ? params._meta : {}),
      petaModern: { reverseRequests: 'unsupported' },
    };
  }

  private rewriteResourceResult(result: ReadResourceResult, serverID: string, userId: string, supportsMcpApps: boolean): ReadResourceResult {
    const serverContext = ServerManager.instance.getServerContext(serverID, userId);
    const replacements = serverContext ? this.buildAppResourceReplacements(serverContext) : [];
    return {
      ...result,
      contents: result.contents.map((content) => {
        const rewrittenUri = serverContext && 'uri' in content && typeof content.uri === 'string'
          ? this.generateGatewayName(serverContext.id, content.uri)
          : content.uri;
        if ('text' in content && typeof content.text === 'string') {
          return {
            ...content,
            uri: rewrittenUri,
            text: supportsMcpApps ? this.rewriteAppResourceText(content.text, content.mimeType, replacements) : content.text,
          };
        }
        return { ...content, uri: rewrittenUri };
      }),
    };
  }

  private buildAppResourceReplacements(serverContext: ServerContext): Array<[string, string]> {
    const replaceMap = new Map<string, string>();
    const tools = serverContext.tools?.tools ?? serverContext.cachedTools?.tools ?? [];
    for (const tool of tools) {
      replaceMap.set(tool.name, this.generateGatewayName(serverContext.id, tool.name));
    }
    const resources = serverContext.resources?.resources ?? serverContext.cachedResources?.resources ?? [];
    for (const resource of resources) {
      replaceMap.set(resource.uri, this.generateGatewayName(serverContext.id, resource.uri));
    }
    return Array.from(replaceMap.entries()).sort((left, right) => right[0].length - left[0].length);
  }

  private rewriteAppResourceText(text: string, mimeType: string | undefined, replacements: Array<[string, string]>): string {
    if (!mimeType?.startsWith('text/html')) {
      return text;
    }
    let rewrittenText = text;
    for (const [originalValue, proxiedValue] of replacements) {
      rewrittenText = rewrittenText.split(originalValue).join(proxiedValue);
    }
    return rewrittenText;
  }

  private validateModernCallToolResult(result: unknown): ModernCallToolResult {
    if (!this.isJsonValue(result) || !this.isJsonObject(result)) {
      throw new ModernMcpError(500, ModernErrorCodes.InternalError, 'Downstream tool returned an invalid JSON result');
    }
    if (result.content !== undefined && !Array.isArray(result.content)) {
      throw new ModernMcpError(500, ModernErrorCodes.InternalError, 'Downstream tool result content must be an array when present');
    }
    if (result.isError !== undefined && typeof result.isError !== 'boolean') {
      throw new ModernMcpError(500, ModernErrorCodes.InternalError, 'Downstream tool result isError must be a boolean when present');
    }
    return result as ModernCallToolResult;
  }

  private isMcpEndpoint(req: Request): boolean {
    const path = new URL(req.originalUrl, 'http://localhost').pathname;
    return path === '/mcp' || path === '/mcp/' || path === '/mcp/public' || path === '/mcp/public/';
  }

  private isHeaderMirrorValue(value: JsonValue): value is string | number | boolean {
    return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isInteger(value));
  }

  private isPublicEndpoint(req: Request): boolean {
    const path = new URL(req.originalUrl, 'http://localhost').pathname;
    return path === '/mcp/public' || path === '/mcp/public/';
  }

  private getHeader(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private hasMcpParamHeader(req: Request): boolean {
    return Object.keys(req.headers).some((header) => header.toLowerCase().startsWith('mcp-param-'));
  }

  private isSupportedSubscriptionMethod(method: string): boolean {
    return MODERN_SUBSCRIPTION_METHODS.includes(method as typeof MODERN_SUBSCRIPTION_METHODS[number]);
  }

  private isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return Number.isFinite(value) || typeof value !== 'number';
    }
    if (Array.isArray(value)) {
      return value.every((item) => this.isJsonValue(item));
    }
    if (this.isJsonObject(value)) {
      return Object.values(value).every((item) => this.isJsonValue(item));
    }
    return false;
  }

  private isJsonRpcId(value: unknown): value is JsonRpcId {
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
  }

  private isModernClientInfo(value: JsonValue | undefined): value is ModernClientInfo {
    return this.isJsonObject(value)
      && typeof value.name === 'string'
      && value.name.length > 0
      && typeof value.version === 'string'
      && value.version.length > 0;
  }

}
