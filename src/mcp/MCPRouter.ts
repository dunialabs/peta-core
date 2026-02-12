/**
 * MCP Router
 * Responsible for registering MCP endpoint middleware and routes
 */

import { Express } from 'express';
import { SessionStore } from './core/SessionStore.js';
import { AuthMiddleware } from '../middleware/AuthMiddleware.js';
import { IpWhitelistMiddleware } from '../middleware/IpWhitelistMiddleware.js';
import { RateLimitMiddleware } from '../middleware/RateLimitMiddleware.js';
import { MCPController } from './controllers/MCPController.js';
import { createLogger } from '../logger/index.js';

/**
 * MCP middleware configuration interface
 */
export interface MCPMiddlewares {
  ipWhitelistMiddleware: IpWhitelistMiddleware;
  authMiddleware: AuthMiddleware;
  rateLimitMiddleware: RateLimitMiddleware;
}

export class MCPRouter {
  private mcpController: MCPController;
  
  // Logger for MCPRouter
  private logger = createLogger('MCPRouter');

  constructor() {
    // Instantiate MCP controller
    this.mcpController = new MCPController();
  }

  /**
   * Register MCP routes and middleware
   * @param app Express application instance
   * @param middlewares Middleware required by MCP
   */
  registerRoutes(app: Express, middlewares: MCPMiddlewares): void {
    const { ipWhitelistMiddleware, authMiddleware, rateLimitMiddleware } = middlewares;

    // ==================== MCP Endpoint Middleware ====================

    // IP whitelist middleware - applied before authentication
    app.use(['/mcp', '/mcp/'], ipWhitelistMiddleware.checkIpWhitelist);

    // Authentication middleware
    app.use(['/mcp', '/mcp/'], authMiddleware.authenticate);

    // Rate limit middleware - applied after authentication
    app.use(['/mcp', '/mcp/'], rateLimitMiddleware.checkRateLimit);

    // ==================== MCP Main Endpoints ====================

    // POST /mcp - Handle MCP request
    app.post(['/mcp', '/mcp/'], this.mcpController.handlePost);

    // GET /mcp - Handle SSE stream
    app.get(['/mcp', '/mcp/'], this.mcpController.handleGet);

    // DELETE /mcp - Handle session termination
    app.delete(['/mcp', '/mcp/'], this.mcpController.handleDelete);

    this.logger.info('MCP routes registered successfully');
  }
}
