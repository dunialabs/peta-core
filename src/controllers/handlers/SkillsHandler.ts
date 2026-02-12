import { AdminRequest, AdminError, AdminErrorCode } from '../../types/admin.types.js';
import { getSkillsService, SkillInfo, UploadSkillResult, DeleteSkillResult, DeleteServerSkillsResult } from '../../services/SkillsService.js';
import { createLogger } from '../../logger/index.js';

const logger = createLogger('SkillsHandler');

/**
 * Skills operation handler (10040-10043)
 * All operations require serverId to isolate skills by server
 */
export class SkillsHandler {
  constructor() {}

  /**
   * Validate serverId field in request
   */
  private validateServerId(data: any): string {
    const { serverId } = data || {};
    if (!serverId || typeof serverId !== 'string') {
      throw new AdminError('Missing required field: serverId', AdminErrorCode.INVALID_REQUEST);
    }
    return serverId;
  }

  /**
   * Determine appropriate error code based on error message
   * @param error - The caught error
   * @param operation - The operation type: 'list', 'upload', 'delete'
   */
  private getSkillsErrorCode(error: unknown, operation: 'list' | 'upload' | 'delete'): AdminErrorCode {
    const message = error instanceof Error ? error.message.toLowerCase() : '';

    // Check for invalid input parameters (serverId, skillName validation failures)
    if (message.includes('invalid serverid') ||
        message.includes('invalid skill name')) {
      return AdminErrorCode.INVALID_REQUEST;
    }

    // Check for specific error patterns
    if (message.includes('not found')) {
      return AdminErrorCode.SKILL_NOT_FOUND;
    }

    if (message.includes('invalid zip') ||
        message.includes('no valid skills') ||
        message.includes('zip file exceeds') ||
        message.includes('zip file contains too many') ||
        message.includes('zip file uncompressed') ||
        message.includes('zip bomb') ||
        message.includes('path traversal') ||
        message.includes('absolute path')) {
      return AdminErrorCode.INVALID_SKILL_FORMAT;
    }

    // Check for permission/IO errors
    if (message.includes('permission') ||
        message.includes('eacces') ||
        message.includes('eperm') ||
        message.includes('enoent') ||
        message.includes('eio')) {
      return AdminErrorCode.DATABASE_OPERATION_FAILED;
    }

    // Default based on operation type
    switch (operation) {
      case 'upload':
        return AdminErrorCode.SKILL_UPLOAD_FAILED;
      case 'delete':
        return AdminErrorCode.SKILL_DELETE_FAILED;
      case 'list':
      default:
        // For list and unknown operations, use generic operation failure
        // since it's likely an IO/system error, not a "not found" situation
        return AdminErrorCode.DATABASE_OPERATION_FAILED;
    }
  }

  /**
   * List all skills for a server (10040)
   * Returns array of skill metadata from server's skills directory
   *
   * Expected request.data:
   * - serverId: string - Skills Server ID
   */
  async handleListSkills(request: AdminRequest<any>): Promise<{ skills: SkillInfo[] }> {
    const serverId = this.validateServerId(request.data);

    logger.debug({ serverId }, 'Listing skills');

    try {
      const skillsService = getSkillsService();
      return await skillsService.listSkills(serverId);
    } catch (error) {
      logger.error({ error, serverId }, 'Failed to list skills');
      throw new AdminError(
        error instanceof Error ? error.message : 'Failed to list skills',
        this.getSkillsErrorCode(error, 'list')
      );
    }
  }

  /**
   * Upload skills to a server (10041)
   * Accepts ZIP file buffer containing skills directory
   * Backend auto-detects and extracts skill directories (those containing SKILL.md)
   *
   * Expected request.data:
   * - serverId: string - Skills Server ID
   * - data: Buffer - ZIP file content (entire skills directory)
   */
  async handleUploadSkill(request: AdminRequest<any>): Promise<UploadSkillResult> {
    const serverId = this.validateServerId(request.data);
    const { data } = request.data || {};

    if (!data) {
      throw new AdminError('Missing required field: data (ZIP file content)', AdminErrorCode.INVALID_REQUEST);
    }

    // Convert to Buffer if necessary (handle various input formats)
    let zipBuffer: Buffer;
    if (Buffer.isBuffer(data)) {
      zipBuffer = data;
    } else if (data instanceof Uint8Array) {
      zipBuffer = Buffer.from(data);
    } else if (Array.isArray(data)) {
      // Number array from JSON (e.g., Array.from(Uint8Array))
      zipBuffer = Buffer.from(data);
    } else if (typeof data === 'string') {
      // Base64 encoded string
      zipBuffer = Buffer.from(data, 'base64');
    } else {
      throw new AdminError('Invalid data format: expected Buffer, Uint8Array, Array, or base64 string', AdminErrorCode.INVALID_REQUEST);
    }

    logger.info({ serverId, size: zipBuffer.length }, 'Uploading skills');

    try {
      const skillsService = getSkillsService();
      return await skillsService.uploadSkill(serverId, zipBuffer);
    } catch (error) {
      logger.error({ error, serverId }, 'Failed to upload skills');
      throw new AdminError(
        error instanceof Error ? error.message : 'Failed to upload skills',
        this.getSkillsErrorCode(error, 'upload')
      );
    }
  }

  /**
   * Delete skill from a server (10042)
   * Removes skill directory by name
   *
   * Expected request.data:
   * - serverId: string - Skills Server ID
   * - skillName: string - Name of skill to delete
   */
  async handleDeleteSkill(request: AdminRequest<any>): Promise<DeleteSkillResult> {
    const serverId = this.validateServerId(request.data);
    const { skillName } = request.data || {};

    if (!skillName || typeof skillName !== 'string') {
      throw new AdminError('Missing required field: skillName', AdminErrorCode.INVALID_REQUEST);
    }

    logger.info({ serverId, skillName }, 'Deleting skill');

    try {
      const skillsService = getSkillsService();
      return await skillsService.deleteSkill(serverId, skillName);
    } catch (error) {
      logger.error({ error, serverId, skillName }, 'Failed to delete skill');
      throw new AdminError(
        error instanceof Error ? error.message : 'Failed to delete skill',
        this.getSkillsErrorCode(error, 'delete')
      );
    }
  }

  /**
   * Delete all skills for a server (10043)
   * Removes entire server skills directory
   *
   * Expected request.data:
   * - serverId: string - Skills Server ID
   */
  async handleDeleteServerSkills(request: AdminRequest<any>): Promise<DeleteServerSkillsResult> {
    const serverId = this.validateServerId(request.data);

    logger.info({ serverId }, 'Deleting all skills for server');

    try {
      const skillsService = getSkillsService();
      return await skillsService.deleteServerSkills(serverId);
    } catch (error) {
      logger.error({ error, serverId }, 'Failed to delete server skills');
      throw new AdminError(
        error instanceof Error ? error.message : 'Failed to delete server skills',
        this.getSkillsErrorCode(error, 'delete')
      );
    }
  }
}
