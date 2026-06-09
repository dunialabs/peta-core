/**
 * OAuth Router
 * Responsible for registering all OAuth-related routes
 */

import { Express } from 'express';
import { AdminAuthMiddleware } from '../middleware/AdminAuthMiddleware.js';
import { OAuthController } from './controllers/OAuthController.js';
import { OAuthMetadataController } from './controllers/OAuthMetadataController.js';
import { OAuthClientController } from './controllers/OAuthClientController.js';
import { createLogger } from '../logger/index.js';

export class OAuthRouter {
  private oauthController: OAuthController;
  private oauthMetadataController: OAuthMetadataController;
  private oauthClientController: OAuthClientController;
  
  // Logger for OAuthRouter
  private logger = createLogger('OAuthRouter');

  constructor() {
    // Instantiate all OAuth controllers
    this.oauthController = new OAuthController();
    this.oauthMetadataController = new OAuthMetadataController();
    this.oauthClientController = new OAuthClientController();
  }

  /**
   * Register all OAuth routes
   * @param app Express application instance
   * @param adminAuthMiddleware Admin authentication middleware (for client management endpoints)
   */
  registerRoutes(app: Express, adminAuthMiddleware: AdminAuthMiddleware): void {
    // 1. OAuth metadata endpoints (.well-known) - No authentication required
    app.get('/.well-known/oauth-authorization-server', this.oauthMetadataController.authorizationServerMetadata);
    app.get('/.well-known/oauth-protected-resource', this.oauthMetadataController.protectedResourceMetadata);
    app.get('/.well-known/oauth-protected-resource/mcp', this.oauthMetadataController.protectedResourceMetadata);
    app.options('/.well-known/oauth-authorization-server', this.oauthMetadataController.handleOptions);
    app.options('/.well-known/oauth-protected-resource', this.oauthMetadataController.handleOptions);
    app.options('/.well-known/oauth-protected-resource/mcp', this.oauthMetadataController.handleOptions);

    // 2. OAuth core endpoints - No authentication required
    app.post('/register', this.oauthController.register);
    app.get('/register/:clientId', this.oauthController.getClientInfo);
    app.get('/authorize', this.oauthController.showAuthorizePage);
    app.post('/authorize', this.oauthController.authorize);
    app.get('/authorize/desk/status', this.oauthController.deskAuthorizationStatus);
    app.post('/authorize/desk/callback', this.oauthController.deskAuthorizationCallback);
    app.options('/authorize/desk/status', this.oauthController.handleOptions);
    app.options('/authorize/desk/callback', this.oauthController.handleOptions);
    app.post('/token', this.oauthController.token);
    app.post('/introspect', this.oauthController.introspect);
    app.post('/revoke', this.oauthController.revoke);

    // 3. OAuth client management endpoints - Requires admin permissions
    app.use('/oauth/admin', adminAuthMiddleware.authenticate);
    app.get('/oauth/admin/clients', this.oauthClientController.listClients);
    app.get('/oauth/admin/clients/:clientId', this.oauthClientController.getClient);
    app.put('/oauth/admin/clients/:clientId', this.oauthClientController.updateClient);
    app.delete('/oauth/admin/clients/:clientId', this.oauthClientController.deleteClient);

    this.logger.info('OAuth routes registered successfully');
  }
}
