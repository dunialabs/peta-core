/**
 * Skills directory configuration
 */
export const SKILLS_CONFIG = {
  /**
   * Skills storage directory path
   * Default: ./skills (relative to project root)
   * In Docker: /data/skills (configured via environment variable)
   */
  SKILLS_DIR: process.env.SKILLS_DIR || './skills',

  /**
   * Maximum ZIP file size in bytes (10MB)
   */
  MAX_ZIP_SIZE: 10 * 1024 * 1024,

  /**
   * Maximum total uncompressed size in bytes (50MB)
   * Prevents ZIP bomb attacks
   */
  MAX_UNCOMPRESSED_SIZE: 50 * 1024 * 1024,

  /**
   * Maximum number of entries (files + directories) in ZIP
   * Prevents resource exhaustion attacks
   */
  MAX_ENTRY_COUNT: 1000,

  /**
   * Required metadata file name
   */
  SKILL_METADATA_FILE: 'SKILL.md',
} as const;
