import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import matter from 'gray-matter';
import { SKILLS_CONFIG } from '../config/skillsConfig.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('SkillsService');

/**
 * Skill metadata information
 */
export interface SkillInfo {
  name: string;
  description: string;
  version: string;
  updatedAt: string;
}

/**
 * Upload skill response
 */
export interface UploadSkillResult {
  success: boolean;
  message: string;
  skillName: string;  // Comma-separated list if multiple skills uploaded
}

/**
 * Delete skill response
 */
export interface DeleteSkillResult {
  success: boolean;
  message: string;
}

/**
 * Delete server skills response
 */
export interface DeleteServerSkillsResult {
  success: boolean;
  message: string;
}

/**
 * Skills management service
 * Handles skill listing, uploading (ZIP), and deletion
 * Skills are isolated by serverId: skills/{serverId}/{skillName}/
 *
 * Smart upload feature:
 * - Automatically finds directories containing SKILL.md
 * - Flattens any ZIP structure to skills/{serverId}/{skillName}/
 */
export class SkillsService {
  private skillsDir: string;

  constructor() {
    // Resolve to absolute path at initialization to prevent issues if CWD changes
    this.skillsDir = path.resolve(SKILLS_CONFIG.SKILLS_DIR);
    logger.info({ skillsDir: this.skillsDir }, 'Skills service initialized');
  }

  /**
   * Get server-specific skills directory
   * @param serverId - Server ID to isolate skills
   */
  private getServerSkillsDir(serverId: string): string {
    const sanitizedServerId = this.validateServerId(serverId);
    return path.join(this.skillsDir, sanitizedServerId);
  }

  /**
   * Ensure server-specific skills directory exists
   * @param serverId - Server ID
   */
  private async ensureServerSkillsDir(serverId: string): Promise<string> {
    const serverSkillsDir = this.getServerSkillsDir(serverId);
    await fs.mkdir(serverSkillsDir, { recursive: true });
    return serverSkillsDir;
  }

  /**
   * Validate server ID - must only contain alphanumeric characters, hyphens, and underscores
   * Throws error if invalid characters are present (no silent sanitization)
   */
  private validateServerId(serverId: string): string {
    if (!serverId || typeof serverId !== 'string') {
      throw new Error('Invalid serverId: must be a non-empty string');
    }
    // Check if serverId contains only allowed characters
    if (!/^[a-zA-Z0-9\-_]+$/.test(serverId)) {
      throw new Error('Invalid serverId: contains invalid characters (only alphanumeric, hyphens, and underscores allowed)');
    }
    return serverId;
  }

  /**
   * Validate skill name - must only contain alphanumeric characters, hyphens, and underscores
   * Throws error if invalid characters are present (no silent sanitization)
   */
  private validateSkillName(name: string): string {
    if (!name || typeof name !== 'string') {
      throw new Error('Invalid skill name: must be a non-empty string');
    }
    // Check if name contains only allowed characters
    if (!/^[a-zA-Z0-9\-_]+$/.test(name)) {
      throw new Error('Invalid skill name: contains invalid characters (only alphanumeric, hyphens, and underscores allowed)');
    }
    return name;
  }

  /**
   * Validate that a path is within the skills directory
   */
  private isPathSafe(targetPath: string): boolean {
    const resolvedPath = path.resolve(targetPath);
    const resolvedSkillsDir = path.resolve(this.skillsDir);
    return resolvedPath.startsWith(resolvedSkillsDir + path.sep);
  }

  /**
   * Promisify AdmZip entry.getDataAsync
   */
  private getEntryDataAsync(entry: AdmZip.IZipEntry): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      entry.getDataAsync((data, err) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }

  /**
   * Safely extract ZIP file to target directory with Zip Slip and ZIP bomb protection
   * Validates each entry path to prevent directory traversal attacks
   * Limits total uncompressed size and entry count to prevent resource exhaustion
   * Uses async IO to avoid blocking the event loop
   * @param zip - AdmZip instance
   * @param targetDir - Target extraction directory
   */
  private async safeExtractZipAsync(zip: AdmZip, targetDir: string): Promise<void> {
    const resolvedTargetDir = path.resolve(targetDir);
    const entries = zip.getEntries();

    // Check entry count limit (ZIP bomb protection)
    if (entries.length > SKILLS_CONFIG.MAX_ENTRY_COUNT) {
      logger.warn({ entryCount: entries.length, limit: SKILLS_CONFIG.MAX_ENTRY_COUNT }, 'ZIP bomb detected: too many entries');
      throw new Error(`ZIP file contains too many entries: ${entries.length} (limit: ${SKILLS_CONFIG.MAX_ENTRY_COUNT})`);
    }

    // Calculate total uncompressed size before extraction (ZIP bomb protection)
    let totalUncompressedSize = 0;
    for (const entry of entries) {
      // Use header's uncompressed size for pre-check
      const entrySize = entry.header.size;
      totalUncompressedSize += entrySize;

      // Early termination if limit exceeded
      if (totalUncompressedSize > SKILLS_CONFIG.MAX_UNCOMPRESSED_SIZE) {
        logger.warn({
          totalSize: totalUncompressedSize,
          limit: SKILLS_CONFIG.MAX_UNCOMPRESSED_SIZE
        }, 'ZIP bomb detected: uncompressed size exceeds limit');
        throw new Error(`ZIP file uncompressed size exceeds limit: ${Math.round(totalUncompressedSize / 1024 / 1024)}MB (limit: ${SKILLS_CONFIG.MAX_UNCOMPRESSED_SIZE / 1024 / 1024}MB)`);
      }
    }

    // Pre-validate all entries before extraction
    const validEntries: Array<{ entry: AdmZip.IZipEntry; resolvedTargetPath: string }> = [];

    for (const entry of entries) {
      const entryName = entry.entryName;

      // Skip directory entries (they will be created when extracting files)
      if (entry.isDirectory) {
        continue;
      }

      // Reject absolute paths
      if (path.isAbsolute(entryName)) {
        logger.warn({ entryName }, 'Zip Slip attack detected: absolute path in ZIP entry');
        throw new Error(`Invalid ZIP entry: absolute path not allowed: ${entryName}`);
      }

      // Normalize the path and check for path traversal
      const normalizedPath = path.normalize(entryName);

      // Reject paths with '..' as a path segment (not just substring)
      // This allows legitimate filenames like 'foo..bar' while blocking '../etc/passwd'
      const pathSegments = normalizedPath.split(path.sep);
      if (pathSegments.some(segment => segment === '..')) {
        logger.warn({ entryName, normalizedPath }, 'Zip Slip attack detected: path traversal in ZIP entry');
        throw new Error(`Invalid ZIP entry: path traversal not allowed: ${entryName}`);
      }

      // Construct target path and verify it's within target directory
      const targetPath = path.join(resolvedTargetDir, normalizedPath);
      const resolvedTargetPath = path.resolve(targetPath);

      if (!resolvedTargetPath.startsWith(resolvedTargetDir + path.sep)) {
        logger.warn({ entryName, targetPath: resolvedTargetPath }, 'Zip Slip attack detected: entry would extract outside target directory');
        throw new Error(`Invalid ZIP entry: would extract outside target directory: ${entryName}`);
      }

      validEntries.push({ entry, resolvedTargetPath });
    }

    // Track actual extracted size during extraction
    let extractedSize = 0;

    // Extract files asynchronously
    for (const { entry, resolvedTargetPath } of validEntries) {
      // Create parent directory if needed (async)
      const parentDir = path.dirname(resolvedTargetPath);
      await fs.mkdir(parentDir, { recursive: true });

      // Extract the file data asynchronously
      const content = await this.getEntryDataAsync(entry);
      extractedSize += content.length;

      // Double-check actual extracted size (in case header was spoofed)
      if (extractedSize > SKILLS_CONFIG.MAX_UNCOMPRESSED_SIZE) {
        logger.warn({
          extractedSize,
          limit: SKILLS_CONFIG.MAX_UNCOMPRESSED_SIZE
        }, 'ZIP bomb detected during extraction: actual size exceeds limit');
        throw new Error(`ZIP file actual uncompressed size exceeds limit during extraction`);
      }

      // Write file asynchronously
      await fs.writeFile(resolvedTargetPath, content);
    }

    logger.debug({
      targetDir,
      entryCount: entries.length,
      extractedSize: Math.round(extractedSize / 1024) + 'KB'
    }, 'ZIP safely extracted');
  }

  /**
   * Recursively find all directories containing SKILL.md
   * @param dir - Directory to search
   * @returns Array of { dirPath, skillName } objects
   */
  private async findSkillDirectories(dir: string): Promise<Array<{ dirPath: string; skillName: string }>> {
    const results: Array<{ dirPath: string; skillName: string }> = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      // Check if current directory contains SKILL.md
      const hasSkillMd = entries.some(
        (entry) => entry.isFile() && entry.name === SKILLS_CONFIG.SKILL_METADATA_FILE
      );

      if (hasSkillMd) {
        // Use directory name as skill name
        const skillName = path.basename(dir);
        results.push({ dirPath: dir, skillName });
        // Don't recurse into subdirectories if this is a skill directory
        return results;
      }

      // Recurse into subdirectories
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(dir, entry.name);
          const subResults = await this.findSkillDirectories(subDir);
          results.push(...subResults);
        }
      }
    } catch (error) {
      logger.debug({ dir, error }, 'Error scanning directory');
    }

    return results;
  }

  /**
   * Copy directory recursively
   * @param src - Source directory
   * @param dest - Destination directory
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * List all skills for a specific server
   * Reads SKILL.md from each subdirectory to extract metadata
   *
   * @param serverId - Server ID to list skills for
   */
  async listSkills(serverId: string): Promise<{ skills: SkillInfo[] }> {
    // validateServerId throws on invalid input
    this.validateServerId(serverId);

    const serverSkillsDir = await this.ensureServerSkillsDir(serverId);

    const entries = await fs.readdir(serverSkillsDir, { withFileTypes: true });
    const skills: SkillInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(serverSkillsDir, entry.name);
      const skillPath = path.join(skillDir, SKILLS_CONFIG.SKILL_METADATA_FILE);
      try {
        const content = await fs.readFile(skillPath, 'utf-8');
        const { data } = matter(content);

        // Get directory modification time
        const stats = await fs.stat(skillDir);
        const updatedAt = stats.mtime.toISOString();

        skills.push({
          name: data.name || entry.name,
          description: data.description || '',
          version: data.version || '1.0.0',
          updatedAt,
        });
      } catch {
        // Skip directories without valid SKILL.md
        logger.debug({ skillDir: entry.name, serverId }, 'Skipping directory without SKILL.md');
      }
    }

    logger.info({ count: skills.length, serverId }, 'Listed skills');
    return { skills };
  }

  /**
   * Upload skills from ZIP buffer to a specific server
   * Smart extraction: finds all directories containing SKILL.md and flattens to skills/{serverId}/
   *
   * Supported ZIP structures:
   * - Direct: skill-name/SKILL.md
   * - Nested: any/path/skill-name/SKILL.md
   * - Multiple: multiple skill directories in one ZIP
   *
   * @param serverId - Server ID to upload skill to
   * @param zipBuffer - ZIP file content as Buffer
   */
  async uploadSkill(serverId: string, zipBuffer: Buffer): Promise<UploadSkillResult> {
    // validateServerId throws on invalid input
    this.validateServerId(serverId);

    const serverSkillsDir = await this.ensureServerSkillsDir(serverId);

    // Validate file size
    if (zipBuffer.length > SKILLS_CONFIG.MAX_ZIP_SIZE) {
      throw new Error(`ZIP file exceeds maximum size of ${SKILLS_CONFIG.MAX_ZIP_SIZE / 1024 / 1024}MB`);
    }

    // Create temporary directory for extraction
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-upload-'));
    const uploadedSkills: string[] = [];

    try {
      // Extract ZIP to temporary directory with Zip Slip protection (async)
      const zip = new AdmZip(zipBuffer);
      await this.safeExtractZipAsync(zip, tempDir);

      // Find all directories containing SKILL.md
      const skillDirs = await this.findSkillDirectories(tempDir);

      if (skillDirs.length === 0) {
        throw new Error(`No valid skills found: ${SKILLS_CONFIG.SKILL_METADATA_FILE} not found in any directory`);
      }

      // Move each skill directory to server skills directory
      for (const { dirPath, skillName } of skillDirs) {
        // Validate skill name - skip if invalid
        let validatedName: string;
        try {
          validatedName = this.validateSkillName(skillName);
        } catch {
          logger.warn({ skillName }, 'Skipping skill with invalid name');
          continue;
        }

        const targetDir = path.join(serverSkillsDir, validatedName);

        // Validate target path is safe
        if (!this.isPathSafe(targetDir)) {
          logger.warn({ skillName: validatedName }, 'Skipping skill due to path safety check');
          continue;
        }

        // Remove existing skill directory if exists
        try {
          await fs.rm(targetDir, { recursive: true, force: true });
        } catch {
          // Ignore if doesn't exist
        }

        // Copy skill directory to target
        await this.copyDirectory(dirPath, targetDir);
        uploadedSkills.push(validatedName);

        logger.debug({ skillName: validatedName, serverId }, 'Skill copied');
      }

      if (uploadedSkills.length === 0) {
        throw new Error('No valid skills could be uploaded');
      }

      logger.info(
        { skillNames: uploadedSkills, count: uploadedSkills.length, serverId },
        'Skills uploaded successfully'
      );

      return {
        success: true,
        skillName: uploadedSkills.join(', '),
        message: `Successfully uploaded ${uploadedSkills.length} skill(s)`,
      };
    } finally {
      // Clean up temporary directory
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn({ tempDir, error }, 'Failed to clean up temporary directory');
      }
    }
  }

  /**
   * Delete a skill by name from a specific server
   * Removes the entire skill directory
   *
   * @param serverId - Server ID to delete skill from
   * @param skillName - Name of the skill to delete
   */
  async deleteSkill(serverId: string, skillName: string): Promise<DeleteSkillResult> {
    // validateServerId/validateSkillName throw on invalid input
    this.validateServerId(serverId);
    this.validateSkillName(skillName);

    const serverSkillsDir = this.getServerSkillsDir(serverId);
    const targetDir = path.join(serverSkillsDir, skillName);

    // Validate target path is safe (defense in depth)
    if (!this.isPathSafe(targetDir)) {
      throw new Error('Invalid skill name: path traversal detected');
    }

    try {
      // Check if directory exists
      await fs.access(targetDir);

      // Remove directory
      await fs.rm(targetDir, { recursive: true, force: true });

      logger.info({ skillName, serverId }, 'Skill deleted successfully');
      return {
        success: true,
        message: 'Skill deleted successfully',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Skill not found: ${skillName}`);
      }
      throw new Error(`Failed to delete skill: ${skillName}`);
    }
  }

  /**
   * Delete all skills for a server
   * Removes the entire server skills directory
   *
   * @param serverId - Server ID to delete all skills for
   */
  async deleteServerSkills(serverId: string): Promise<DeleteServerSkillsResult> {
    // validateServerId throws on invalid input
    this.validateServerId(serverId);

    const serverSkillsDir = this.getServerSkillsDir(serverId);

    // Validate path is safe (defense in depth)
    if (!this.isPathSafe(serverSkillsDir)) {
      throw new Error('Invalid serverId: path traversal detected');
    }

    try {
      // Check if directory exists
      await fs.access(serverSkillsDir);

      // Remove entire server skills directory
      await fs.rm(serverSkillsDir, { recursive: true, force: true });

      logger.info({ serverId }, 'Server skills directory deleted successfully');
      return {
        success: true,
        message: 'Server skills deleted successfully',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Directory doesn't exist, consider it success
        logger.info({ serverId }, 'Server skills directory does not exist, nothing to delete');
        return {
          success: true,
          message: 'No skills directory found',
        };
      }
      throw new Error(`Failed to delete server skills: ${serverId}`);
    }
  }
}

/**
 * Singleton instance of SkillsService
 */
let skillsServiceInstance: SkillsService | null = null;

export function getSkillsService(): SkillsService {
  if (!skillsServiceInstance) {
    skillsServiceInstance = new SkillsService();
  }
  return skillsServiceInstance;
}
