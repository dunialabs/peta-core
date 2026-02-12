import { Request, Response } from 'express';
import { UserRequestHandler } from './UserRequestHandler.js';
import {
  UserActionType,
  UserRequest,
  UserResponse,
  UserError,
  UserErrorCode
} from './types.js';
import { createLogger } from '../logger/index.js';

/**
 * User request controller
 *
 * Provides HTTP API interface for user operations, routing requests to UserRequestHandler.
 * Follows the same pattern as ConfigController for /admin endpoints.
 */
export class UserController {
  private logger = createLogger('UserController');

  static instance: UserController = new UserController();
  static getInstance(): UserController {
    return UserController.instance;
  }

  private constructor() {}

  /**
   * Register unified user routes
   */
  registerRoutes(app: any): void {
    // Unified user interface - distinguish operation types by action field in request body
    // Note: UserAuthMiddleware must be applied before this route
    app.post('/user', this.handleUserRequest.bind(this));

    this.logger.info('User routes registered at POST /user');
  }

  /**
   * Unified handling of user requests
   *
   * Pattern matches ConfigController.handleAdminRequest
   */
  private async handleUserRequest(req: Request, res: Response): Promise<void> {
    try {
      const userRequest: UserRequest<any> = req.body;

      // 1. Validate request format
      if (!this.validateUserRequest(userRequest)) {
        const errorResponse: UserResponse = {
          success: false,
          error: {
            code: UserErrorCode.INVALID_REQUEST,
            message: 'Invalid user request format'
          }
        };
        res.status(400).json(errorResponse);
        return;
      }

      // 2. Get userId and token from authContext (attached by UserAuthMiddleware)
      const userId = req.authContext!.userId;
      const token = req.headers['authorization']!.substring(7); // Extract token from 'Bearer <token>'

      // 3. Route to corresponding handler method based on action type
      let result: any;

      switch (userRequest.action) {
        // ==================== Capability Operations (1000-1999) ====================
        case UserActionType.GET_CAPABILITIES:
          result = await UserRequestHandler.instance.handleGetCapabilities(userId);
          break;

        case UserActionType.SET_CAPABILITIES:
          await UserRequestHandler.instance.handleSetCapabilities(userId, userRequest.data);
          result = { message: 'Capabilities updated successfully' };
          break;

        // ==================== Server Configuration Operations (2000-2999) ====================
        case UserActionType.CONFIGURE_SERVER:
          result = await UserRequestHandler.instance.handleConfigureServer(
            userId,
            token,
            userRequest.data
          );
          break;

        case UserActionType.UNCONFIGURE_SERVER:
          result = await UserRequestHandler.instance.handleUnconfigureServer(userId, userRequest.data);
          break;

        // ==================== Session Query Operations (3000-3999) ====================
        case UserActionType.GET_ONLINE_SESSIONS:
          result = await UserRequestHandler.instance.handleGetOnlineSessions(userId);
          break;

        default:
          const errorResponse: UserResponse = {
            success: false,
            error: {
              code: UserErrorCode.INVALID_REQUEST,
              message: `Unknown action type: ${userRequest.action}`
            }
          };
          res.status(400).json(errorResponse);
          return;
      }

      // 4. Return success response
      const successResponse: UserResponse = {
        success: true,
        data: result
      };
      res.json(successResponse);

    } catch (error) {
      // 5. Error handling
      const action = req.body.action;
      this.logger.error({ action, error }, 'User request error');

      const errorCode = error instanceof UserError
        ? error.code
        : UserErrorCode.INTERNAL_ERROR;

      const errorResponse: UserResponse = {
        success: false,
        error: {
          code: errorCode,
          message: error instanceof Error ? error.message : 'Internal server error'
        }
      };
      res.status(500).json(errorResponse);
    }
  }

  /**
   * Validate user request format
   */
  private validateUserRequest(request: UserRequest<any>): boolean {
    // 1. Check required fields
    if (!request || request.action === undefined) {
      return false;
    }

    // 2. Validate action type
    if (!Object.values(UserActionType).includes(request.action)) {
      return false;
    }

    return true;
  }
}
