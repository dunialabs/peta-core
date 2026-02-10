/**
 * MCP Controller
 * Handles MCP protocol core endpoints: POST, GET, DELETE
 */

import { Request, Response } from 'express';
import { SessionStore } from '../core/SessionStore.js';
import { AuthError, AuthErrorType } from '../../types/auth.types.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../../logger/index.js';
import type { ClientSession } from '../core/ClientSession.js';

export class MCPController {
  
  // Logger for MCPController
  private logger = createLogger('MCPController');

  constructor() {}

  private trackGetSseConnection(clientSession: ClientSession | undefined, res: Response): void {
    if (!clientSession) {
      return;
    }

    let connected = false;

    const markConnectedIfSse = () => {
      if (connected || !res.headersSent) {
        return;
      }
      const ctHeader = res.getHeader('Content-Type') ?? res.getHeader('content-type');
      const ct = Array.isArray(ctHeader) ? ctHeader.join(';') : String(ctHeader ?? '');
      if (res.statusCode >= 200 && res.statusCode < 300 && ct.includes('text/event-stream')) {
        connected = true;
        clientSession.markSseConnected();
      }
    };

    const markDisconnected = () => {
      if (connected) {
        connected = false;
        clientSession.markSseDisconnected();
      }
    };

    const originalWriteHead = res.writeHead;
    res.writeHead = ((...args: any[]) => {
      const ret = originalWriteHead.apply(res, args as any);
      markConnectedIfSse();
      return ret;
    }) as any;

    res.on('close', markDisconnected);
    res.on('finish', markDisconnected);

    setImmediate(markConnectedIfSse);
  }

  /**
   * POST /mcp - Handle MCP request
   */
  handlePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const clientSession = req.clientSession!;
      const sessionId = req.headers['Mcp-Session-Id'] as string || req.headers['mcp-session-id'] as string || clientSession.sessionId;

      // Get ProxySession directly from SessionStore
      let proxySession = SessionStore.instance.getProxySession(sessionId);

      if (!proxySession) {
        throw new AuthError(
          AuthErrorType.INVALID_SESSION,
          'Invalid or missing session ID'
        );
      } else {
        // Handle request
        await proxySession.handleRequest(req, res, req.body);
      }

    } catch (error) {
      this.logger.error({ error }, 'MCP request error');
      if (error instanceof AuthError) {
        res.status(403).json({
          error: {
            code: ErrorCode.InternalError,
            message: error.message
          }
        });
      } else {
        res.status(500).json({
          error: {
            code: ErrorCode.InternalError,
            message: String(error)
          }
        });
      }
    }
  };

  /**
   * GET /mcp - Handle SSE stream
   */
  handleGet = async (req: Request, res: Response): Promise<void> => {
    try {
      const clientSession = req.clientSession;
      const sessionId = req.headers['mcp-session-id'] as string || req.headers['Mcp-Session-Id'] as string || clientSession?.sessionId ;

      const proxySession = SessionStore.instance.getProxySession(sessionId ?? 'xx');

      if (!sessionId || !proxySession) {
        const errorMessage = 'Invalid or missing session ID';
        this.logger.error({ sessionId }, 'MCP request error: Invalid or missing session ID');
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: ErrorCode.InvalidRequest,
            message: errorMessage
          },
          id: null
        });

        return;
      }

      this.trackGetSseConnection(clientSession, res);

      // Check Last-Event-ID header to support resumability
      const lastEventId = req.headers['last-event-id'] as string | undefined;
      if (lastEventId) {
        this.logger.debug({ sessionId, lastEventId }, 'Client reconnecting with Last-Event-ID');
        // Handle reconnection request
        await proxySession.handleReconnection(lastEventId, res);
        return;
      }

      this.logger.info({ sessionId }, 'Establishing new SSE stream for session');
      await proxySession.handleRequest(req, res, req.body);
    } catch (error) {
      const sessionId = req.headers['mcp-session-id'] as string || req.headers['Mcp-Session-Id'] as string || req.clientSession?.sessionId;
      this.logger.error({ error, sessionId }, 'MCP request error');
      res.status(500).json({
        error: {
          code: ErrorCode.InternalError,
          message: String(error)
        }
      });
    }
  };

  /**
   * DELETE /mcp - Handle session termination
   */
  handleDelete = async (req: Request, res: Response): Promise<void> => {

    const sessionId = req.headers['Mcp-Session-Id'] as string || req.headers['mcp-session-id'] as string;
    if (!sessionId || sessionId.length === 0) {
      this.logger.error({ sessionId }, 'MCP request error: Invalid or missing session ID');
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: ErrorCode.ConnectionClosed,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    this.logger.info({ sessionId }, 'Received session termination request for session');

    try {
      // Get ProxySession
      const proxySession = SessionStore.instance.getProxySession(sessionId);

      if (!proxySession) {
        // If session doesn't exist, return 200 (according to MCP protocol)
        this.logger.debug({ sessionId }, 'Session not found, returning 200 as per MCP spec');
        res.status(200).json({
          jsonrpc: '2.0',
          result: { message: 'Session terminated or not found' },
          id: null
        });
        return;
      }

      await proxySession.handleRequest(req, res, req.body);

    } catch (error) {
      this.logger.error({ error, sessionId }, 'Error handling session termination');

      // According to MCP protocol, return 200 status code even if error occurs
      res.status(200).json({
        jsonrpc: '2.0',
        result: {
          message: 'Session termination completed',
          warning: error instanceof Error ? error.message : 'Unknown error occurred'
        },
        id: null
      });
    }
  };
}
