/**
 * OAuth Client Controller
 * Handles OAuth client management endpoints (requires admin permissions)
 */

import { Request, Response } from 'express';
import { OAuthClientService } from '../services/OAuthClientService.js';
import { createLogger } from '../../logger/index.js';

export class OAuthClientController {
  private clientService: OAuthClientService;
  
  // Logger for OAuthClientController
  private logger = createLogger('OAuthClientController');

  constructor() {
    this.clientService = new OAuthClientService();
  }

  /**
   * GET /oauth/admin/clients
   * Get all client list (requires admin permissions)
   */
  listClients = async (req: Request, res: Response): Promise<void> => {
    try {
      const clients = await this.clientService.listClients();

      res.json({ clients });
    } catch (error) {
      this.logger.error({ error }, 'Error fetching OAuth clients');
      res.status(500).json({
        error: 'Internal server error'
      });
    }
  };

  /**
   * GET /oauth/admin/clients/:clientId
   * Get single client information (requires admin permissions)
   */
  getClient = async (req: Request, res: Response): Promise<void> => {
    try {
      const { clientId } = req.params;

      const client = await this.clientService.getClient(clientId);

      if (!client) {
        res.status(404).json({
          error: 'Client not found'
        });
        return;
      }

      res.json(client);
    } catch (error) {
      this.logger.error({ error, clientId: req.params.clientId }, 'Error fetching OAuth client');
      res.status(500).json({
        error: 'Internal server error'
      });
    }
  };

  /**
   * PUT /oauth/admin/clients/:clientId
   * Update client information (requires admin permissions)
   */
  updateClient = async (req: Request, res: Response): Promise<void> => {
    try {
      const { clientId } = req.params;
      const updates = req.body;

      const client = await this.clientService.updateClient(clientId, updates);

      if (!client) {
        res.status(404).json({
          error: 'Client not found'
        });
        return;
      }

      res.json(client);
    } catch (error) {
      this.logger.error({ error, clientId: req.params.clientId }, 'Error updating OAuth client');
      if (error instanceof Error && (error.message.startsWith('invalid_client_metadata:') || error.message.startsWith('invalid_redirect_uri:'))) {
        const separator = error.message.indexOf(': ');
        res.status(400).json({
          error: separator === -1 ? error.message : error.message.slice(0, separator),
          error_description: separator === -1 ? error.message : error.message.slice(separator + 2),
        });
        return;
      }
      res.status(500).json({
        error: 'Internal server error'
      });
    }
  };

  /**
   * DELETE /oauth/admin/clients/:clientId
   * Delete client (requires admin permissions)
   */
  deleteClient = async (req: Request, res: Response): Promise<void> => {
    try {
      const { clientId } = req.params;

      const success = await this.clientService.deleteClient(clientId);

      if (!success) {
        res.status(404).json({
          error: 'Client not found or failed to delete'
        });
        return;
      }

      res.json({ message: 'Client deleted successfully' });
    } catch (error) {
      this.logger.error({ error, clientId: req.params.clientId }, 'Error deleting OAuth client');
      res.status(500).json({
        error: 'Internal server error'
      });
    }
  };
}
