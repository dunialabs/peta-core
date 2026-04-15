/**
 * OAuth Provider Registry
 *
 * Central registry for all OAuth provider adapters.
 */

import type { ProviderAdapter } from '../types.js';
import { OAuthExchangeError } from '../errors.js';

import { googleAdapter } from './google.js';
import { notionAdapter } from './notion.js';
import { figmaAdapter } from './figma.js';
import { githubAdapter } from './github.js';
import { stripeAdapter } from './stripe.js';
import { zendeskAdapter } from './zendesk.js';
import { canvasAdapter } from './canvas.js';
import { canvaAdapter } from './canva.js';
import { pipedriveAdapter } from './pipedrive.js';
import { hubspotAdapter } from './hubspot.js';
import { intercomAdapter } from './intercom.js';
import { slackAdapter } from './slack.js';
import { teamsAdapter } from './teams.js';

/**
 * Map of provider names to their adapters
 */
const providers: Map<string, ProviderAdapter> = new Map([
  ['google', googleAdapter],
  ['notion', notionAdapter],
  ['figma', figmaAdapter],
  ['github', githubAdapter],
  ['stripe', stripeAdapter],
  ['zendesk', zendeskAdapter],
  ['canvas', canvasAdapter],
  ['canva', canvaAdapter],
  ['pipedrive', pipedriveAdapter],
  ['hubspot', hubspotAdapter],
  ['intercom', intercomAdapter],
  ['slack', slackAdapter],
  ['teams', teamsAdapter],
]);

/**
 * Get the provider adapter for a given provider name
 *
 * @param provider - Provider name (case-insensitive)
 * @returns The provider adapter
 * @throws OAuthExchangeError if provider is unknown
 */
export function getProviderAdapter(provider: string): ProviderAdapter {
  const normalizedProvider = provider.toLowerCase();
  const adapter = providers.get(normalizedProvider);

  if (!adapter) {
    throw OAuthExchangeError.unknownProvider(provider);
  }

  return adapter;
}

/**
 * Get list of supported provider names
 */
export function getSupportedProviders(): string[] {
  return Array.from(providers.keys());
}
