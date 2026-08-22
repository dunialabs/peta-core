/**
 * MCP Router
 * Responsible for registering MCP endpoint middleware and routes
 */

import type { Express, NextFunction, Request, Response } from 'express';
import { AuthMiddleware } from '../middleware/AuthMiddleware.js';
import { IpWhitelistMiddleware } from '../middleware/IpWhitelistMiddleware.js';
import { RateLimitMiddleware } from '../middleware/RateLimitMiddleware.js';
import { MCPController } from './controllers/MCPController.js';
import { createLogger } from '../logger/index.js';
import { TokenValidator } from '../security/TokenValidator.js';
import { ModernMcpController } from './modern/ModernMcpController.js';
import { ModernMcpAuthMiddleware } from './modern/ModernMcpAuthMiddleware.js';
import { getPublicUrl } from '../utils/urlUtils.js';
import { ModernErrorCodes, ModernMcpError, modernErrorResponse } from './modern/ModernMcpErrors.js';

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
  private modernMcpController: ModernMcpController;
  private modernMcpAuthMiddleware: ModernMcpAuthMiddleware;
  
  // Logger for MCPRouter
  private logger = createLogger('MCPRouter');

  constructor() {
    // Instantiate MCP controller
    this.mcpController = new MCPController();
    this.modernMcpController = new ModernMcpController();
    this.modernMcpAuthMiddleware = new ModernMcpAuthMiddleware(new TokenValidator());
  }

  /**
   * Register MCP routes and middleware
   * @param app Express application instance
   * @param middlewares Middleware required by MCP
   */
  registerRoutes(app: Express, middlewares: MCPMiddlewares): void {
    const { ipWhitelistMiddleware, authMiddleware, rateLimitMiddleware } = middlewares;

    // ==================== MCP Endpoint Middleware (Authenticated + Anonymous) ====================

    // IP whitelist middleware - applied before authentication
    app.use(['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'], ipWhitelistMiddleware.checkIpWhitelist);

    app.use(['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'], this.rejectInvalidModernOrigin);

    app.use(['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'], this.modernMcpController.rejectMixedEra);

    app.use(['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'], (req, res, next) => {
      if (!this.modernMcpController.shouldHandle(req)) {
        return next();
      }
      if (req.method === 'POST') {
        return next();
      }
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Modern MCP uses POST-only Streamable HTTP' },
        id: null,
      });
    });

    app.post(
      ['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'],
      (req, res, next) => {
        if (!this.modernMcpController.shouldHandle(req)) {
          return next();
        }
        return this.modernMcpAuthMiddleware.authenticate(req, res, next);
      },
      (req, res, next) => {
        if (!this.modernMcpController.shouldHandle(req)) {
          return next();
        }
        return rateLimitMiddleware.checkRateLimit(req, res, next);
      },
      (req, res, next) => {
        if (!this.modernMcpController.shouldHandle(req)) {
          return next();
        }
        void this.modernMcpController.handlePost(req, res);
      },
    );

    // Authentication middleware
    app.use(['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'], authMiddleware.authenticate);

    // Rate limit middleware - applied after authentication
    app.use(['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'], rateLimitMiddleware.checkRateLimit);

    // ==================== MCP Main Endpoints (Authenticated + Anonymous) ====================

    // POST /mcp - Handle MCP request
    app.post(['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'], this.mcpController.handlePost);

    // GET /mcp - Handle SSE stream
    app.get(['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'], this.mcpController.handleGet);

    // DELETE /mcp - Handle session termination
    app.delete(['/mcp', '/mcp/', '/mcp/public', '/mcp/public/'], this.mcpController.handleDelete);


    this.logger.info('MCP routes registered successfully');
  }

  private rejectInvalidModernOrigin = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST' || !this.modernMcpController.shouldHandle(req) || this.isAllowedModernOrigin(req)) {
      return next();
    }
    res.status(403).json(modernErrorResponse(undefined, new ModernMcpError(403, ModernErrorCodes.InvalidRequest, 'Invalid Origin header')));
  };

  private isAllowedModernOrigin(req: Request): boolean {
    const rawOrigin = req.headers.origin;
    if (rawOrigin === undefined) {
      return true;
    }
    if (Array.isArray(rawOrigin) || rawOrigin.trim() !== rawOrigin || rawOrigin === 'null') {
      return false;
    }

    let origin: URL;
    try {
      origin = new URL(rawOrigin);
    } catch {
      return false;
    }
    const isHttpOrigin = origin.protocol === 'http:' || origin.protocol === 'https:';
    const hasOriginPath = origin.pathname !== '/' || rawOrigin.endsWith('/') || rawOrigin.includes('?') || rawOrigin.includes('#');
    if (!isHttpOrigin || hasOriginPath || origin.username || origin.password) {
      return false;
    }

    const allowedHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
    for (const hostname of (process.env.MCP_2026_ALLOWED_ORIGIN_HOSTNAMES ?? '').split(',')) {
      const trimmedHostname = hostname.trim().toLowerCase();
      if (trimmedHostname) {
        allowedHostnames.add(trimmedHostname);
      }
    }
    const canonicalHostname = this.getCanonicalHostname(req);
    if (canonicalHostname) {
      allowedHostnames.add(canonicalHostname);
    }
    return allowedHostnames.has(origin.hostname);
  }

  private getCanonicalHostname(req: Request): string | undefined {
    try {
      return new URL(getPublicUrl(req)).hostname;
    } catch {
      return undefined;
    }
  }
}
