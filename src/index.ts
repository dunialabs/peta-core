import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';
import http from 'http';
import fs from 'fs';
import { TokenValidator } from './security/TokenValidator.js';
import { AuthMiddleware } from './middleware/AuthMiddleware.js';
import { AdminAuthMiddleware } from './middleware/AdminAuthMiddleware.js';
import { RateLimitMiddleware } from './middleware/RateLimitMiddleware.js';
import { IpWhitelistMiddleware } from './middleware/IpWhitelistMiddleware.js';
import { IpWhitelistService } from './security/IpWhitelistService.js';
import { ConfigController } from './controllers/ConfigController.js';
import { ServerManager } from './mcp/core/ServerManager.js';
import { SessionStore } from './mcp/core/SessionStore.js';
import { LogService } from './log/LogService.js';
import { LogSyncService } from './log/LogSyncService.js';
import { RateLimitService } from './security/RateLimitService.js';
import { EventCleanupService } from './mcp/core/EventCleanupService.js';
import { prisma } from './config/prisma.js';
import * as urlUtils from './utils/urlUtils.js';
import { OAuthRouter } from './oauth/OAuthRouter.js';
import { MCPRouter } from './mcp/MCPRouter.js';
import { SocketService } from './socket/SocketService.js';
import { socketNotifier } from './socket/SocketNotifier.js';
import { UserAuthMiddleware } from './user/UserAuthMiddleware.js';
import { UserController } from './user/UserController.js';
import { UserRequestHandler } from './user/UserRequestHandler.js';

import cors from 'cors';
import { LATEST_PROTOCOL_VERSION }  from "@modelcontextprotocol/sdk/types.js";
import { CapabilitiesService } from './mcp/services/CapabilitiesService.js';
import { APP_INFO } from './config/config.js';
import { createLogger } from './logger/index.js';
import { CloudflaredService } from './services/CloudflaredService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NODE_ENV = process.env.NODE_ENV || 'development';
const isDevelopment = NODE_ENV === 'development';

// Create loggers for different functional modules to improve log distinction
const appLogger = createLogger('App'); // Application startup/initialization
const requestLogger = createLogger('Request'); // HTTP request debugging
const serverLogger = createLogger('Server'); // Server startup/shutdown

/**
 * Global shutdown function reference for external application shutdown triggering
 */
let shutdownFunction: ((signal: string) => Promise<void>) | null = null;

/**
 * Shutdown flag - prevents duplicate shutdown process triggering
 */
let isShuttingDown = false;

/**
 * Get shutdown function reference (for ProxyHandler)
 */
export function getShutdownFunction(): ((signal: string) => Promise<void>) | null {
  return shutdownFunction;
}

/**
 * Initialize authentication and session management module
 */
export async function initializeAuthModule() {
  appLogger.info('Initializing Peta Core auth module...');

  // 1. Initialize data access layer
  const logService = LogService.getInstance();

  // 2. Create token validator
  const tokenValidator = new TokenValidator();
  
  // 3. Create session store
  const sessionStore = SessionStore.instance;
  
  // 5. Create rate limit service
  const rateLimitService = new RateLimitService();
  
  // 6. Create rate limit middleware
  const rateLimitMiddleware = new RateLimitMiddleware(rateLimitService);
  
  // 7. Create IP whitelist service
  const ipWhitelistService = new IpWhitelistService();
  
  // 8. Create IP whitelist middleware
  const ipWhitelistMiddleware = new IpWhitelistMiddleware(ipWhitelistService);
  
  // 9. Create authentication middleware
  const authMiddleware = new AuthMiddleware(
    tokenValidator
  );
  
  // 9.1. Create admin authentication middleware
  const adminAuthMiddleware = new AdminAuthMiddleware(tokenValidator);
  
  // 6. Create global server manager
  const serverManager = ServerManager.instance;
  
  CapabilitiesService.getInstance();
  
  // 10. Create configuration management interface
  const configController = new ConfigController(
    ipWhitelistService
  );

  // 10.1. Initialize User module (transport-agnostic business logic layer)
  const userRequestHandler = UserRequestHandler.instance;

  // 10.2. Create user authentication middleware
  const userAuthMiddleware = new UserAuthMiddleware(tokenValidator);

  // 10.3. Create user controller
  const userController = UserController.instance;

  appLogger.info('User module initialized successfully');

  // 9. Initialize event cleanup service
  const eventCleanupService = new EventCleanupService();
  appLogger.info('Event cleanup service initialized');

  // 10. Initialize log sync service
  const logSyncService = LogSyncService.getInstance();
  await logSyncService.initialize();
  appLogger.info('Log sync service initialized');

  // 11. Register admin routes (will be registered in Express app)
  appLogger.info('Config controller created successfully');

  // 12. Start session cleanup timer
  sessionStore.startCleanupTimer();

  appLogger.info('Auth module initialized successfully');

  return {
    tokenValidator,
    authMiddleware,
    adminAuthMiddleware,
    rateLimitService,
    rateLimitMiddleware,
    ipWhitelistService,
    ipWhitelistMiddleware,
    sessionStore,
    serverManager,
    configController,
    userRequestHandler,
    userAuthMiddleware,
    userController,
    logService,
    logSyncService,
    eventCleanupService,
    urlUtils,
    socketService: null as SocketService | null  // Will be initialized after server starts
  };
}

/**
 * Application main entry point
 */
export async function startApplication() {
  try {
    // Initialize database connection
    appLogger.info('Initializing database connection...');
    await prisma.$connect();
    appLogger.info('Database connected successfully');

    // Initialize authentication module
    const authModule = await initializeAuthModule();

    // Create Express application
    const app = express();

    // CORS configuration constants - centralized management of all CORS-related settings
    const CORS_CONFIG = {
      ALLOW_ORIGIN: '*',
      ALLOW_METHODS: 'GET, POST, DELETE',
      // Basic exposed headers required for HEAD/OPTIONS
      EXPOSE_HEADERS_BASIC: 'Mcp-Session-Id,mcp-session-id,www-authenticate',
      // Full exposed headers (for CORS middleware, including rate limiting headers)
      EXPOSE_HEADERS_FULL: [
        'mcp-session-id',
        'Mcp-Session-Id',
        'www-authenticate',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'Retry-After'
      ],
      // Allowed request headers (for OPTIONS preflight)
      ALLOW_HEADERS_DEFAULT: 'Content-Type, Authorization, Mcp-Session-Id, mcp-session-id, mcp-protocol-version,Accept,last-event-id',
      MAX_AGE: '86400', // Preflight cache time: 24 hours
    };
    // ==================== Special request handlers - must be before all middleware ====================

    app.put(['/mcp', '/mcp/'], (req, res) => {
      if (isDevelopment) {
        requestLogger.debug({
          headers: req.headers,
          method: req.method,
          url: req.url,
        }, 'Received PUT request');
      }
      res.writeHead(405, {
        Allow: 'GET, POST, DELETE'
    }).end(
        JSON.stringify({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Method not allowed.'
            },
            id: null
        })
    );
    });

    app.patch(['/mcp', '/mcp/'], (req, res) => {
      if (isDevelopment) {
        requestLogger.debug({
          headers: req.headers,
          method: req.method,
          url: req.url,
        }, 'Received PATCH request');
      }
      res.writeHead(405, {
        Allow: 'GET, POST, DELETE'
      }).end(
        JSON.stringify({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Method not allowed.'
            },
            id: null
        })
      );
    });

    // Handle HEAD requests - for health checks and availability probes
    app.head(['/mcp', '/mcp/'], (req, res) => {
      if (isDevelopment) {
        requestLogger.debug({
          headers: req.headers,
          method: req.method,
          url: req.url,
        }, 'Received HEAD request');
      }
      // Check if token is present (Authorization header or query parameter)
      const hasAuthHeader = req.headers['authorization']?.startsWith('Bearer ');
      const hasTokenParam = typeof req.query.token === 'string' && req.query.token.length > 0;
      const hasApiKeyParam = typeof req.query.api_key === 'string' && req.query.api_key.length > 0;
      const hasToken = hasAuthHeader || hasTokenParam || hasApiKeyParam;

      // Get base URL (supports local development and production environments)
      const protocol = req.headers['x-forwarded-proto'] as string || 'https';
      const host = req.headers['x-forwarded-host'] as string || req.headers.host;
      const baseUrl = `${protocol}://${host}`;
      const metadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
      if (isDevelopment) {
        requestLogger.debug({
          hasToken,
          hasAuthHeader,
          hasTokenParam,
          hasApiKeyParam,
          metadataUrl,
        }, 'HEAD request auth check');
      }
      if (!hasToken) {
        // Return 401 Unauthorized + WWW-Authenticate with resource_metadata (Smithery style)
        // This is the response format expected by Claude Web
        res.status(401).set({
          'X-Powered-By': 'Express',
          'Access-Control-Allow-Origin': CORS_CONFIG.ALLOW_ORIGIN,
          'Access-Control-Expose-Headers': CORS_CONFIG.EXPOSE_HEADERS_BASIC,
          'WWW-Authenticate': `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${metadataUrl}"`,
          'Allow': CORS_CONFIG.ALLOW_METHODS,
          'Content-Type': 'application/json',
          'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
          connection: 'keep-alive',
        }).end(
          JSON.stringify({
              jsonrpc: '2.0',
              error: {
                  code: -32000,
                  message: 'Method not allowed.'
              },
              id: null
          })
      );
      } else {
        res.status(405 ).set({
          'X-Powered-By': 'Express',
          'Access-Control-Allow-Origin': CORS_CONFIG.ALLOW_ORIGIN,
          'Access-Control-Expose-Headers': CORS_CONFIG.EXPOSE_HEADERS_BASIC,
          'Allow': CORS_CONFIG.ALLOW_METHODS,
          'Content-Type': 'application/json',
          'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
          connection: 'keep-alive',
        }).end(
          JSON.stringify({
              jsonrpc: '2.0',
              error: {
                  code: -32000,
                  message: 'Method not allowed.'
              },
              id: null
          })
      );
      }
    });

    app.options(['/mcp', '/mcp/'], (req, res) => {
      if (isDevelopment) {
        requestLogger.debug({
          headers: req.headers,
          method: req.method,
          url: req.url,
        }, 'Received OPTIONS request');
      }
      res.status(204).set({
        'Access-Control-Allow-Origin': CORS_CONFIG.ALLOW_ORIGIN,
        'Access-Control-Allow-Methods': CORS_CONFIG.ALLOW_METHODS,
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || CORS_CONFIG.ALLOW_HEADERS_DEFAULT,
        'Access-Control-Expose-Headers': CORS_CONFIG.EXPOSE_HEADERS_BASIC,
        'Access-Control-Max-Age': CORS_CONFIG.MAX_AGE,
        'Vary': 'Access-Control-Request-Headers',
        'X-Powered-By': 'Express',
      }).end();
    });

    // ==================== General middleware ====================

    // Body parser middleware - must be before middleware that needs to access req.body
    // Increased limit for Skills ZIP file uploads (max 10MB + JSON overhead)
    app.use(express.json({ limit: '15mb' }));
    // Add URL-encoded form parsing (required for OAuth)
    app.use(express.urlencoded({ extended: true, limit: '15mb' }));

    // Commented out in production, can be enabled in development for debugging
    app.use((req, res, next) => {
      if (isDevelopment) {
        requestLogger.debug({
          method: req.method,
          url: req.url,
          body: req.body,
        }, 'Received request');
      }
      next();
    });

    // CORS middleware - handles CORS for other non-HEAD/OPTIONS requests
    app.use(cors({
      origin: CORS_CONFIG.ALLOW_ORIGIN,
      exposedHeaders: CORS_CONFIG.EXPOSE_HEADERS_FULL,
      allowedHeaders: CORS_CONFIG.ALLOW_HEADERS_DEFAULT
    }));

    // ==================== OAuth route registration ====================

    // Create and register OAuth routes
    const oauthRouter = new OAuthRouter();
    oauthRouter.registerRoutes(app, authModule.adminAuthMiddleware);

    // ==================== MCP route registration ====================

    // Create and register MCP routes
    const mcpRouter = new MCPRouter();
    mcpRouter.registerRoutes(app, {
      ipWhitelistMiddleware: authModule.ipWhitelistMiddleware,
      authMiddleware: authModule.authMiddleware,
      rateLimitMiddleware: authModule.rateLimitMiddleware
    });

    // ==================== Admin route registration ====================

    // Register admin routes (requires Owner/Admin permissions)
    // Apply admin authentication middleware to /admin routes
    app.use('/admin', authModule.adminAuthMiddleware.authenticate);

    // Register configuration management routes
    authModule.configController.registerRoutes(app);

    // ==================== User route registration ====================

    // Register user routes (requires valid user token, no role check)
    // Apply user authentication middleware to /user routes
    app.use('/user', authModule.userAuthMiddleware.authenticate);

    // Register user routes
    authModule.userController.registerRoutes(app);

    // Root path handler - returns basic service information
    app.get('/', (req, res) => {
      res.json({
        service: 'Peta Core',
        version: APP_INFO.version,
        status: 'running',
        endpoints: {
          health: '/health',
          mcp: '/mcp',
          admin: '/admin',
          socketio: '/socket.io',
          oauth: {
            metadata: {
              authorization_server: '/.well-known/oauth-authorization-server',
              protected_resource: '/.well-known/oauth-protected-resource'
            },
            register: '/register',
            authorize: '/authorize',
            token: '/token',
            introspect: '/introspect',
            revoke: '/revoke',
            admin: '/oauth/admin/clients'
          }
        }
      });
    });
    
    // Root path POST request handler - returns error message
    app.post('/', (req, res) => {
      res.status(400).json({
        error: 'Invalid endpoint. Please use /mcp for MCP requests or /admin for admin operations.'
      });
    });

    // Health check endpoint
    app.get('/health', async (req, res) => {
      try {
        const serverStatus = await authModule.serverManager.getAllServersStatus();
        const sessionCount = authModule.sessionStore.getActiveSessionCount();

        res.status(200).json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          sessions: {
            active: sessionCount,
            total: authModule.sessionStore.getTotalSessionCount()
          },
          socketio: {
            onlineUsers: authModule.socketService?.getOnlineUserIds().length || 0,
            totalConnections: authModule.socketService?.getTotalConnections() || 0
          },
          servers: serverStatus,
          memory: process.memoryUsage()
        });
      } catch (error) {
        appLogger.error({ error }, 'Health check error');
        res.status(500).json({
          status: 'unhealthy',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    // Start server - supports HTTPS first, falls back to HTTP on failure
    const port = parseInt(process.env.BACKEND_PORT || "3002");
    const httpsPort = parseInt(process.env.BACKEND_HTTPS_PORT || String(port));
    const enableHttps = process.env.ENABLE_HTTPS === 'true'; // Control HTTPS enablement via environment variable

    let httpsServer: https.Server | undefined;
    let httpServer: http.Server | undefined;

    // If HTTPS is enabled, try to start HTTPS server first
    if (enableHttps) {
      try {
        // Get certificate paths - supports environment variable configuration or uses default paths
        const certPath = process.env.SSL_CERT_PATH || '/Users/tataufo/cert/localhost+2.pem';
        const keyPath = process.env.SSL_KEY_PATH || '/Users/tataufo/cert/localhost+2-key.pem';

        // Check if certificate files exist
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
          serverLogger.warn({ certPath, keyPath }, 'SSL certificates not found, falling back to HTTP mode');
        } else {
          // Read SSL certificates
          const httpsOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
          };

          // Create HTTPS server
          httpsServer = https.createServer(httpsOptions, app);
          httpsServer.listen(httpsPort, () => {
            serverLogger.info({ port: httpsPort, protocol: 'https' }, 'Peta Core HTTPS server listening');
          });
        }
      } catch (error) {
        serverLogger.error({ error }, 'Failed to start HTTPS server, falling back to HTTP mode');
      }
    }

    // If HTTPS server did not start successfully (either not enabled or startup failed), start HTTP server
    if (!httpsServer) {
      httpServer = http.createServer(app);
      httpServer.listen(port, () => {
        serverLogger.info({ port, protocol: 'http' }, 'Peta Core HTTP server listening');
      });
    }

    // Ensure at least one server is running
    const server = httpsServer || httpServer;
    if (!server) {
      serverLogger.error('Failed to start any server (neither HTTPS nor HTTP)');
      process.exit(1);
    }

    // Increase EventEmitter listener limit to prevent warnings during rapid shutdown
    server.setMaxListeners(20);

    // ==================== Initialize Socket.IO ====================

    // Create and initialize SocketService
    const socketService = new SocketService();
    socketService.initialize(server);

    // Set SocketNotifier
    socketNotifier.setSocketService(socketService);

    // Update socketService reference in authModule
    authModule.socketService = socketService;

    // Update socketService reference in ConfigController
    authModule.configController.setSocketService(socketService);

    appLogger.info('Socket.IO service initialized and ready for use');

    // ==================== Auto-start Cloudflared ====================
    try {
      appLogger.info('Checking cloudflared auto-start...');
      const cloudflaredService = CloudflaredService.getInstance();
      await cloudflaredService.autoStartIfConfigExists();
    } catch (error) {
      appLogger.error({ error }, 'Failed to auto-start cloudflared (non-fatal, continuing...)');
      // Don't block application startup if cloudflared fails
    }
    
    // Graceful shutdown handling
    let sigtermHandler: (() => void) | null = null;
    let sigintHandler: (() => void) | null = null;

    const shutdown = async (signal: string) => {
      const exitCode = (signal === 'UNCAUGHT_EXCEPTION' || signal === 'UNHANDLED_REJECTION') ? 1 : 0;

      // Prevent duplicate shutdown process execution
      if (isShuttingDown) {
        // Use debug level to reduce console noise in production
        // Users can enable with LOG_LEVEL=debug if needed
        console.debug({ signal }, 'Shutdown already in progress, ignoring duplicate signal');
        return;
      }

      isShuttingDown = true;
      // Prevent subsequent SIGINT/SIGTERM from interrupting child processes (e.g., docker stop)
      if (sigintHandler) {
        process.off('SIGINT', sigintHandler);
      }
      if (sigtermHandler) {
        process.off('SIGTERM', sigtermHandler);
      }
      process.on('SIGINT', () => {
        console.log('SIGINT received during shutdown, ignored');
      });
      process.on('SIGTERM', () => {
        console.log('SIGTERM received during shutdown, ignored');
      });
      console.log(`Received ${signal}, shutting down gracefully...`);

      // Set forced exit timeout (10 seconds)
      const forceExitTimer = setTimeout(() => {
        console.error('⚠️ Shutdown timeout exceeded, forcing exit...');
        process.exit(1);
      }, 10000);

      try {
        // 1. Disconnect all Socket.IO client connections first (so HTTP server can close properly)
        if (authModule.socketService) {
          console.log('Disconnecting all Socket.IO clients...');
          authModule.socketService.disconnectAll();
          console.log('✅ All Socket.IO clients disconnected');
        }

        // 2. Close HTTP server and Socket.IO concurrently
        console.log('Closing HTTP/HTTPS server and Socket.IO...');

        const closePromises: Promise<void>[] = [];

        // 2.1 Close HTTP/HTTPS server
        const httpClosePromise = new Promise<void>((resolve) => {
          let closedCount = 0;
          const totalServers = (httpsServer ? 1 : 0) + (httpServer ? 1 : 0);

          if (totalServers === 0) {
            resolve();
            return;
          }

          const onServerClosed = () => {
            closedCount++;
            if (closedCount === totalServers) {
              console.log('✅ HTTP/HTTPS server closed');
              resolve();
            }
          };

          // Close server, stop accepting new connections
          if (httpsServer) {
            httpsServer.close(onServerClosed);

            // Force destroy all existing connections (ensure quick shutdown)
            httpsServer.closeAllConnections?.();
          }
          if (httpServer) {
            httpServer.close(onServerClosed);

            // Force destroy all existing connections (ensure quick shutdown)
            httpServer.closeAllConnections?.();
          }

          // Timeout protection
          setTimeout(() => {
            if (closedCount < totalServers) {
              console.warn('⚠️ HTTP server close timeout, forcing closure...');
              resolve();
            }
          }, 5000);
        });

        closePromises.push(httpClosePromise);

        // 2.2 Close Socket.IO
        if (authModule.socketService) {
          const socketService = authModule.socketService; // Save reference to avoid TypeScript null check issues
          const socketClosePromise = (async () => {
            try {
              await Promise.race([
                socketService.shutdown(),
                new Promise<void>((resolve) => setTimeout(() => {
                  console.warn('⚠️ Socket.IO shutdown timeout, continuing...');
                  resolve();
                }, 3000))
              ]);
              console.log('✅ Socket.IO service stopped');
            } catch (error) {
              console.error('Error shutting down Socket.IO:', error);
            }
          })();

          closePromises.push(socketClosePromise);
        }

        // Wait for all close operations to complete
        await Promise.all(closePromises);

        // 3. Stop event cleanup service
        try {
          console.log('Stopping event cleanup service...');
          authModule.eventCleanupService.stop();
          console.log('✅ Event cleanup service stopped');
        } catch (error) {
          console.error('Error stopping event cleanup service:', error);
        }

        // 4. Shutdown log sync service (attempt to flush remaining logs)
        try {
          console.log('Shutting down log sync service...');
          await authModule.logSyncService.shutdown();
          console.log('✅ Log sync service stopped');
        } catch (error) {
          console.error('Error shutting down log sync service:', error);
        }

        // 5. Clean up all sessions (including ProxySession)
        try {
          console.log('Removing all sessions...');
          await authModule.sessionStore.removeAllSessions();
          console.log('✅ All sessions removed');
        } catch (error) {
          console.error('Error removing sessions:', error);
        }

        // 6. Close all downstream server connections
        try {
          console.log('Shutting down server manager...');
          await authModule.serverManager.shutdown();
          console.log('✅ Server manager stopped');
        } catch (error) {
          console.error('Error shutting down server manager:', error);
        }

        // 7. Stop cloudflared container
        try {
          console.log('Stopping cloudflared container...');
          const cloudflaredService = CloudflaredService.getInstance();
          await cloudflaredService.stopCloudflared();
          console.log('✅ Cloudflared stopped');
        } catch (error) {
          console.error('Error stopping cloudflared:', error);
          // Don't block shutdown if cloudflared stop fails
        }

        // 8. Disconnect Prisma database connection
        try {
          console.log('Disconnecting from database...');
          await prisma.$disconnect();
          console.log('✅ Database disconnected');
        } catch (error) {
          console.error('Error disconnecting from database:', error);
        }
        // Clear forced exit timer
        clearTimeout(forceExitTimer);
      } catch (error) {
        console.error('Error during shutdown:', error);
        clearTimeout(forceExitTimer);
      } finally {
        console.log('✅ Shutdown complete');
        // Ensure exit regardless of circumstances
        process.exit(exitCode);
      }
    };

    // Save shutdown function to global reference for ProxyHandler use
    shutdownFunction = shutdown;

    sigtermHandler = () => {
      shutdown('SIGTERM');
    };
    sigintHandler = () => {
      shutdown('SIGINT');
    };
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);
    
    // Unhandled exception capture
    process.on('uncaughtException', (error) => {
      appLogger.error({ error }, 'Uncaught Exception');
      shutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', (reason, promise) => {
      appLogger.error({ reason, promise }, 'Unhandled Rejection');
      shutdown('UNHANDLED_REJECTION');
    });
    
  } catch (error) {
    appLogger.error({ error }, 'Failed to start application');
    process.exit(1);
  }
}

process.title = 'peta-core';
// If this file is run directly
// Check if this module is the main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  startApplication();
}
