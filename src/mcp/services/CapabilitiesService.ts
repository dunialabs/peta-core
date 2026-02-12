/**
 * CapabilitiesService - User capability configuration retrieval service
 *
 * Provides unified user McpServerCapabilities retrieval interface:
 * 1. Get capability configuration from active sessions
 * 2. Get capability configuration from database (when no session)
 * 3. Supports reuse in multiple places (Socket notifications, request-response, API interfaces, etc.)
 */

import { ServerManager } from '../core/ServerManager.js';
import { UserRepository } from '../../repositories/UserRepository.js';
import {
  McpServerCapabilities,
  Permissions,
  ServerConfigCapabilities,
  ServerConfigWithEnabled
} from '../types/mcp.js';
import { DangerLevel, ServerStatus } from '../../types/enums.js';
import { ServerContext } from '../core/ServerContext.js';

export class CapabilitiesService {
  private static instance: CapabilitiesService;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): CapabilitiesService {
    if (!CapabilitiesService.instance) {
      CapabilitiesService.instance = new CapabilitiesService();
    }
    return CapabilitiesService.instance;
  }

  /**
   * Get user's complete McpServerCapabilities
   * Priority: get from active sessions, then from database
   *
   * @param userId User ID
   * @returns Promise<McpServerCapabilities>
   */
  async getUserCapabilities(userId: string): Promise<McpServerCapabilities> {

    // Find user
    const user = await UserRepository.findByUserId(userId);
    if (!user) {
      return {};
    }

    const userPreferences = JSON.parse(user.userPreferences ?? '{}') as McpServerCapabilities;

    const capabilities = await this.getCapabilitiesFromDatabase(userId);

    // Delete servers with capabilities.enabled=false, delete tools/resources/prompts with enabled=false in capabilities.tools, capabilities.resources, capabilities.prompts
    for (const [serverId, serverConfig] of Object.entries(capabilities)) {
      if (serverConfig.enabled === false) {
        delete capabilities[serverId];
      } else {
        if (serverConfig.tools) {
          for (const [toolName, toolConfig] of Object.entries(serverConfig.tools)) {
            if (toolConfig.enabled === false) {
              delete serverConfig.tools[toolName];
            }
          }
        }
        if (serverConfig.resources) {
          for (const [resourceName, resourceConfig] of Object.entries(serverConfig.resources)) {
            if (resourceConfig.enabled === false) {
              delete serverConfig.resources[resourceName];
            }
          }
        }
        if (serverConfig.prompts) {
          for (const [promptName, promptConfig] of Object.entries(serverConfig.prompts)) {
            if (promptConfig.enabled === false) {
              delete serverConfig.prompts[promptName];
            }
          }
        }
      }
    }

    
    if (Object.keys(userPreferences).length === 0) {
      return capabilities;
    }
    for (const [serverId, serverConfig] of Object.entries(userPreferences)) {
      if (capabilities[serverId]) {
        capabilities[serverId].enabled = serverConfig.enabled;
        for (const [toolName, toolConfig] of Object.entries(serverConfig.tools)) {
          if (capabilities[serverId].tools && capabilities[serverId].tools[toolName]) {
            capabilities[serverId].tools[toolName].enabled = toolConfig.enabled;
            capabilities[serverId].tools[toolName].dangerLevel = toolConfig.dangerLevel ?? DangerLevel.Silent;
          }
        }
        for (const [resourceName, resourceConfig] of Object.entries(serverConfig.resources)) {
          if (capabilities[serverId].resources && capabilities[serverId].resources[resourceName]) {
            capabilities[serverId].resources[resourceName].enabled = resourceConfig.enabled;
          }
        }
        for (const [promptName, promptConfig] of Object.entries(serverConfig.prompts)) {
          if (capabilities[serverId].prompts && capabilities[serverId].prompts[promptName]) {
            capabilities[serverId].prompts[promptName].enabled = promptConfig.enabled;
          }
        }
      }
    }

    return capabilities;
  }

  /**
   * Get all server capability configurations for specified user from database
   *
   * @param userId User ID
   * @returns Promise<McpServerCapabilities>
   */
  async getCapabilitiesFromDatabase(userId: string): Promise<McpServerCapabilities> {
    // Find user
    const user = await UserRepository.findByUserId(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    // Parse user permissions
    const permissions = JSON.parse(user.permissions) as Permissions;
    const launchConfigs = JSON.parse(user.launchConfigs ?? '{}') as { [serverId: string]: string };
    const capabilities: McpServerCapabilities = {};

    // Iterate through all servers
    const allServers = await ServerManager.instance.getAllEnabledServers();
    for (const server of allServers) {
      const configTemplate = server.allowUserInput ? server.configTemplate ?? '{}' : '{}';

      const serverId = server.serverId;
      const enabled = permissions[serverId]?.enabled ?? server.publicAccess;

      // Get server capability configuration
      let serverContext: ServerContext | undefined;
      if (server.allowUserInput) {
        serverContext = ServerManager.instance.getTemporaryServer(serverId, userId);
      } else {
        serverContext = ServerManager.instance.getServerContext(serverId);
      }
      let mcpCapabilities: ServerConfigWithEnabled;
      let status: ServerStatus;
      if (serverContext) {
        // Get from active server connection
        mcpCapabilities = serverContext.getMcpCapabilities();
        status = serverContext.status;
      } else {
        // Get from database
        const capabilities = JSON.parse(server.capabilities) as ServerConfigCapabilities;
        mcpCapabilities = {
          tools: capabilities.tools ?? {},
          resources: capabilities.resources ?? {},
          prompts: capabilities.prompts ?? {},
          enabled: enabled,
          serverName: server.serverName,
          allowUserInput: server.allowUserInput,
          authType: server.authType,
          category: server.category,
          configTemplate: configTemplate,
          configured: true,
        };
        status = ServerStatus.Offline;
      }

      // Server's own configuration, when unavailable, do not expose to user
      // Filter out tools/resources/prompts with enabled=false in mcpCapabilities.tools, mcpCapabilities.resources, mcpCapabilities.prompts
      if (mcpCapabilities.tools) {
        for (const [toolName, toolValue] of Object.entries(mcpCapabilities.tools)) {
          if (toolValue.enabled === false) {
            delete mcpCapabilities.tools[toolName];
          }
        }
      }
      if (mcpCapabilities.resources) {
        for (const [resourceName, resourceValue] of Object.entries(mcpCapabilities.resources)) {
          if (resourceValue.enabled === false) {
            delete mcpCapabilities.resources[resourceName];
          }
        }
      }
      if (mcpCapabilities.prompts) {
        for (const [promptName, promptValue] of Object.entries(mcpCapabilities.prompts)) {
          if (promptValue.enabled === false) {
            delete mcpCapabilities.prompts[promptName];
          }
        }
      }

      // Merge admin-assigned user permissions and server capabilities
      const userPerms = permissions[serverId] ?? {};

      // Apply user permission overrides
      if (userPerms.tools) {
        for (const [toolName, toolPerms] of Object.entries(userPerms.tools)) {
          if (typeof toolPerms.enabled === 'boolean' && mcpCapabilities.tools[toolName]) {
            mcpCapabilities.tools[toolName].enabled = toolPerms.enabled;
            mcpCapabilities.tools[toolName].dangerLevel = toolPerms.dangerLevel ?? DangerLevel.Silent;
          }
        }
      }

      if (userPerms.resources) {
        for (const [resourceName, resourcePerms] of Object.entries(userPerms.resources)) {
          if (typeof resourcePerms.enabled === 'boolean' && mcpCapabilities.resources[resourceName]) {
            mcpCapabilities.resources[resourceName].enabled = resourcePerms.enabled;
          }
        }
      }

      if (userPerms.prompts) {
        for (const [promptName, promptPerms] of Object.entries(userPerms.prompts)) {
          if (typeof promptPerms.enabled === 'boolean' && mcpCapabilities.prompts[promptName]) {
            mcpCapabilities.prompts[promptName].enabled = promptPerms.enabled;
          }
        }
      }

      // Construct complete server capability configuration
      // Determine if it's a user-configured Server
      const userConfigured = launchConfigs[serverId] !== undefined ;

      capabilities[serverId] = {
        ...mcpCapabilities,
        enabled: enabled,
        serverName: server.serverName,
        allowUserInput: server.allowUserInput,
        authType: server.authType,
        category: server.category,
        configTemplate: configTemplate,
        configured: server.allowUserInput ? userConfigured : true,
        status: status
      } as ServerConfigWithEnabled;
    }

    return capabilities;
  }

  // ==================== Static Utility Methods ====================

  /**
   * Compare old and new permission configurations to determine if there are substantive changes
   *
   * @param oldPermissions Old permission configuration
   * @param newPermissions New permission configuration
   * @returns {toolsChanged, resourcesChanged, promptsChanged} Whether each type of capability has changed
   */
  static comparePermissions(
    oldPermissions: Permissions,
    newPermissions: Permissions
  ): { toolsChanged: boolean, resourcesChanged: boolean, promptsChanged: boolean } {
    // Handle null/undefined cases
    const oldPerms = oldPermissions || {};
    const newPerms = newPermissions || {};

    const oldKeys = Object.keys(oldPerms);
    const newKeys = Object.keys(newPerms);

    let toolsChanged = false;
    let resourcesChanged = false;
    let promptsChanged = false;

    // 1. Check for Server additions
    for (const serverId of newKeys) {
      if (!oldPerms.hasOwnProperty(serverId)) {
        // Server added: if enabled=true, same as rule 1
        if (newPerms[serverId].enabled === true) {
          if (!toolsChanged) {
            toolsChanged = this.hasAnyCapabilityEnabled(newPerms[serverId].tools);
          }
          if (!resourcesChanged) {
            resourcesChanged = this.hasAnyCapabilityEnabled(newPerms[serverId].resources);
          }
          if (!promptsChanged) {
            promptsChanged = this.hasAnyCapabilityEnabled(newPerms[serverId].prompts);
          }

          if (toolsChanged && resourcesChanged && promptsChanged) {
            return { toolsChanged, resourcesChanged, promptsChanged };
          }
        }
      }
    }

    // 2. Check for Server deletions
    for (const serverId of oldKeys) {
      if (!newPerms.hasOwnProperty(serverId)) {
        // Server deleted: if originally enabled=true, same as rule 2
        if (oldPerms[serverId].enabled === true) {
          if (!toolsChanged) {
            toolsChanged = this.hasAnyCapabilityEnabled(oldPerms[serverId].tools);
          }
          if (!resourcesChanged) {
            resourcesChanged = this.hasAnyCapabilityEnabled(oldPerms[serverId].resources);
          }
          if (!promptsChanged) {
            promptsChanged = this.hasAnyCapabilityEnabled(oldPerms[serverId].prompts);
          }
          if (toolsChanged && resourcesChanged && promptsChanged) {
            return { toolsChanged, resourcesChanged, promptsChanged };
          }
        }
      }
    }

    // 3. Check Server enabled status changes
    for (const serverId of newKeys) {
      if (oldPerms.hasOwnProperty(serverId)) {
        const oldServer = oldPerms[serverId];
        const newServer = newPerms[serverId];

        if (oldServer.enabled !== newServer.enabled) {
          if (oldServer.enabled === false && newServer.enabled === true) {
            // Rule 1: Changed from enabled=false to enabled=true, check newPermissions
            if (!toolsChanged) {
              toolsChanged = this.hasAnyCapabilityEnabled(newServer.tools);
            }
            if (!resourcesChanged) {
              resourcesChanged = this.hasAnyCapabilityEnabled(newServer.resources);
            }
            if (!promptsChanged) {
              promptsChanged = this.hasAnyCapabilityEnabled(newServer.prompts);
            }
          } else if (oldServer.enabled === true && newServer.enabled === false) {
            // Rule 2: Changed from enabled=true to enabled=false, check oldPermissions
            if (!toolsChanged) {
              toolsChanged = this.hasAnyCapabilityEnabled(oldServer.tools);
            }
            if (!resourcesChanged) {
              resourcesChanged = this.hasAnyCapabilityEnabled(oldServer.resources);
            }
            if (!promptsChanged) {
              promptsChanged = this.hasAnyCapabilityEnabled(oldServer.prompts);
            }
          }
          if (toolsChanged && resourcesChanged && promptsChanged) {
            return { toolsChanged, resourcesChanged, promptsChanged };
          }
        }
      }
    }

    // 4. Check Server internal detailed changes (when server.enabled status is the same)
    for (const serverId of newKeys) {
      if (oldPerms.hasOwnProperty(serverId)) {
        const oldServer = oldPerms[serverId];
        const newServer = newPerms[serverId];

        // Only check internal changes when server.enabled status is the same
        if (oldServer.enabled === newServer.enabled) {
          if (!toolsChanged) {
            toolsChanged = this.isCapabilityListChanged(oldServer.tools, newServer.tools);
          }
          if (!resourcesChanged) {
            resourcesChanged = this.isCapabilityListChanged(oldServer.resources, newServer.resources);
          }
          if (!promptsChanged) {
            promptsChanged = this.isCapabilityListChanged(oldServer.prompts, newServer.prompts);
          }
          if (toolsChanged && resourcesChanged && promptsChanged) {
            return { toolsChanged, resourcesChanged, promptsChanged };
          }
        }
      }
    }

    return { toolsChanged, resourcesChanged, promptsChanged };
  }

  /**
   * Check if any item has enabled=true
   *
   * @param capabilities Capability configuration object
   * @returns Whether any item is enabled
   */
  static hasAnyCapabilityEnabled(capabilities: { [name: string]: { enabled: boolean } }): boolean {
    if (!capabilities) return false;

    for (const item of Object.values(capabilities)) {
      if (item.enabled === true) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if capability configuration has changes that actually affect user available functionality
   *
   * @param oldCapabilities Old capability configuration
   * @param newCapabilities New capability configuration
   * @returns Whether there are substantive changes
   */
  static isCapabilityListChanged(
    oldCapabilities: { [name: string]: { enabled: boolean, dangerLevel?: DangerLevel } },
    newCapabilities: { [name: string]: { enabled: boolean, dangerLevel?: DangerLevel } }
  ): boolean {
    const oldKeys = Object.keys(oldCapabilities || {});
    const newKeys = Object.keys(newCapabilities || {});

    // Check for added items (only count as change if added and enabled=true)
    for (const key of newKeys) {
      if (!oldCapabilities.hasOwnProperty(key)) {
        if (newCapabilities[key].enabled === true) {
          return true;
        }
      }
    }

    // Check for deleted items (only count as change if deleted and originally enabled=true)
    for (const key of oldKeys) {
      if (!newCapabilities.hasOwnProperty(key)) {
        if (oldCapabilities[key].enabled === true) {
          return true;
        }
      }
    }

    // Check status changes of existing items
    for (const key of newKeys) {
      const oldConfig = oldCapabilities[key];
      const newConfig = newCapabilities[key];

      if (oldConfig && oldConfig.enabled !== newConfig.enabled) {
        return true;
      } else if (oldConfig?.dangerLevel !== newConfig?.dangerLevel) {
        return true;
      }
    }

    return false;
  }
}
