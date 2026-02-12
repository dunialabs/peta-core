import { ServerManager } from '../../mcp/core/ServerManager.js';
import { ServerRepository } from '../../repositories/ServerRepository.js';
import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { McpServerCapabilities, ServerConfigCapabilities } from '../../mcp/types/mcp.js';
import { ServerStatus } from '../../types/enums.js';
import { CapabilitiesService } from '../../mcp/services/CapabilitiesService.js';
import { createLogger } from '../../logger/index.js';

/**
 * Query operation handler (3000-3999)
 */
export class QueryHandler {
  // Logger for QueryHandler
  private logger = createLogger('QueryHandler');

  constructor() {}

  /**
   * Get all server capabilities configuration (3002)
   */
  async handleGetAvailableServersCapabilities(request: AdminRequest<any>): Promise<{ capabilities: McpServerCapabilities }> {
    const capabilities = ServerManager.instance.getAvailableServersCapabilities();
    const servers = await ServerManager.instance.getAllServers();
    for (const server of servers) {

      if (!server.enabled) {
        continue;
      }

      if (capabilities[server.serverId]) {
        capabilities[server.serverId].enabled = server.publicAccess;
        continue;
      }

      const serverCapabilities = JSON.parse(server.capabilities ?? '{}');
      capabilities[server.serverId] = {
        enabled: server.publicAccess,
        serverName: server.serverName,
        allowUserInput: server.allowUserInput,
        authType: server.authType,
        configTemplate: '{}',
        configured: true,
        tools: serverCapabilities.tools ?? {},
        resources: serverCapabilities.resources ?? {},
        prompts: serverCapabilities.prompts ?? {}
      }; 
    }
    return {
      capabilities: capabilities
    };
  }

  /**
   * Get user available server capabilities configuration (3003)
   */
  async handleGetUserAvailableServersCapabilities(request: AdminRequest<any>): Promise<{ capabilities: McpServerCapabilities }> {
    const { targetId } = request.data;

    const capabilities = await CapabilitiesService.getInstance().getCapabilitiesFromDatabase(targetId);
    for (const [serverId, serverConfig] of Object.entries(capabilities)) {
      if (serverConfig.allowUserInput) {
        serverConfig.tools = {};
        serverConfig.resources = {};
        serverConfig.prompts = {};
      }
    }
    return {
      capabilities: capabilities
    };
  }

  /**
   * Get all server status (3004)
   */
  async handleGetServersStatus(request: AdminRequest<any>): Promise<{ serversStatus: { [serverID: string]: ServerStatus } }> {
    const results = await ServerManager.instance.healthCheck();
    return {
      serversStatus: results
    };
  }

  /**
   * Get specified server capabilities configuration (3005)
   */
  async handleGetServersCapabilities(request: AdminRequest<any>): Promise<{ capabilities: ServerConfigCapabilities }> {
    const { targetId } = request.data;

    let capabilities: ServerConfigCapabilities
    let serverName: string;
    let serverId: string;
    const serverContext = ServerManager.instance.getServerContext(targetId);
    if (serverContext) {
      const serverCapabilities = serverContext.getMcpCapabilities();
      capabilities = {
        tools: serverCapabilities.tools ?? {},
        resources: serverCapabilities.resources ?? {},
        prompts: serverCapabilities.prompts ?? {}
      }
      serverName = serverContext.serverEntity.serverName;
      serverId = serverContext.serverEntity.serverId;
    } else {
      const serverEntity = await ServerRepository.findByServerId(targetId);
      if (!serverEntity) {
        throw new AdminError(`Server ${targetId} not found`, AdminErrorCode.SERVER_NOT_FOUND);
      }
      capabilities = JSON.parse(serverEntity.capabilities);
      serverName = serverEntity.serverName;
      serverId = serverEntity.serverId;
    }

    this.logger.debug({
      serverId: serverId,
      serverName: serverName,
      capabilities: capabilities
    }, 'Server capabilities retrieved');

    return {
      capabilities: capabilities
    };
  }
}
