import { ENV } from './config.js';

/**
 * Peta Auth service configuration
 */
const isInDocker = ENV.PETA_CORE_IN_DOCKER === 'true';

export const PETA_AUTH_CONFIG = {
  /**
   * Whether peta-core is running inside Docker container
   */
  IN_DOCKER: isInDocker,

  /**
   * Peta Auth base URL
   * - Docker deployment: http://peta-auth:7788
   * - Host deployment: http://localhost:7788
   */
  BASE_URL: isInDocker ? 'http://peta-auth:7788' : 'http://localhost:7788'
} as const;

export type PetaAuthConfig = typeof PETA_AUTH_CONFIG;
