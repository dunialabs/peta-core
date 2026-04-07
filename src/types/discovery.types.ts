export enum DiscoveryMode {
  FLAT = 'FLAT',
  HYBRID = 'HYBRID',
  STRICT = 'STRICT',
}

export const CATALOG_TOOL_NAMES = {
  SEARCH: 'peta.catalog.search',
  DESCRIBE: 'peta.catalog.describe',
  EXECUTE: 'peta.catalog.execute',
} as const;

export const RESERVED_CATALOG_TOOLS: ReadonlySet<string> = new Set(
  Object.values(CATALOG_TOOL_NAMES),
);

export type CatalogRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type DirectExposureRiskLevel = 'low' | 'high';

export interface CatalogSearchInput {
  query: string;
  profileId?: string;
  serverIds?: string[];
  riskMax?: CatalogRiskLevel;
  directCallableOnly?: boolean;
  detail?: 'summary';
  limit?: number;
  cursor?: string | null;
}

export interface CatalogSearchResultItem {
  actionId: string;
  displayName: string;
  title: string;
  summary: string;
  serverId: string;
  riskLevel: string | null;
  directCallable: boolean;
  schemaHash: string;
}

export interface CatalogSearchResult {
  results: CatalogSearchResultItem[];
  nextCursor: string | null;
  totalCount: number;
}

export interface CatalogDescribeInput {
  actionIds: string[];
  detail?: 'full';
  profileId?: string;
}

export interface CatalogDescribeResultItem {
  actionId: string;
  displayName: string;
  title: string;
  summary: string;
  description: string | null;
  serverId: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  examples: unknown[] | null;
  riskLevel: string | null;
  directCallable: boolean;
  catalogRefName: string | null;
  schemaHash: string;
}

export interface CatalogDescribeResult {
  results: CatalogDescribeResultItem[];
}

export interface CatalogExecuteInput {
  actionId: string;
  arguments: Record<string, unknown>;
  expectedSchemaHash?: string | null;
}

export interface DiscoveryExposureRuleMatch {
  serverIds?: string[];
  riskLevels?: DirectExposureRiskLevel[];
}

export interface DiscoveryExposureRule {
  match: DiscoveryExposureRuleMatch;
  directCallable: boolean;
}

export interface DiscoveryProfileConfig {
  directExposureRules?: DiscoveryExposureRule[];
}

export type ExposureRule = NonNullable<DiscoveryProfileConfig['directExposureRules']>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function isDirectExposureRiskLevel(value: unknown): value is DirectExposureRiskLevel {
  return value === 'low' || value === 'high';
}

function isDirectExposureRiskLevelArray(value: unknown): value is DirectExposureRiskLevel[] {
  return Array.isArray(value) && value.every(isDirectExposureRiskLevel);
}

export function validateDiscoveryProfileConfig(config: unknown): string | null {
  if (!isRecord(config)) {
    return 'config must be a JSON object';
  }

  const { directExposureRules } = config;
  if (directExposureRules === undefined) {
    return null;
  }

  if (!Array.isArray(directExposureRules)) {
    return 'config.directExposureRules must be an array';
  }

  for (let index = 0; index < directExposureRules.length; index += 1) {
    const rawRule = directExposureRules[index];
    const path = `config.directExposureRules[${index}]`;
    if (!isRecord(rawRule)) {
      return `${path} must be an object`;
    }

    if (!isRecord(rawRule.match)) {
      return `${path}.match must be an object`;
    }

    if (typeof rawRule.directCallable !== 'boolean') {
      return `${path}.directCallable must be a boolean`;
    }

    const { serverIds, riskLevels } = rawRule.match;
    if (serverIds !== undefined && !isNonEmptyStringArray(serverIds)) {
      return `${path}.match.serverIds must be a non-empty array of strings`;
    }

    if (riskLevels !== undefined && !isDirectExposureRiskLevelArray(riskLevels)) {
      return `${path}.match.riskLevels must contain only "low" or "high"`;
    }

    const hasServerIds = Array.isArray(serverIds) && serverIds.length > 0;
    const hasRiskLevels = Array.isArray(riskLevels) && riskLevels.length > 0;
    if (!hasServerIds && !hasRiskLevels) {
      return `${path}.match must include a non-empty serverIds or riskLevels array`;
    }
  }

  return null;
}

/**
 * Evaluate exposure rules to determine if an action is directly callable.
 * Returns the `directCallable` value of the first matching rule,
 * or `defaultValue` if no rule matches.
 */
export function evaluateExposureRules(
  rules: ExposureRule[] | null | undefined,
  action: {
    serverId: string;
    riskLevel?: string | null;
  },
  defaultValue: boolean,
): boolean {
  if (!rules || !Array.isArray(rules) || rules.length === 0) return defaultValue;

  for (const rule of rules) {
    const m = rule.match;
    if (!m || typeof m !== 'object') continue;

    const serverIds = isNonEmptyStringArray(m.serverIds) ? m.serverIds : undefined;
    const riskLevels = isDirectExposureRiskLevelArray(m.riskLevels) ? m.riskLevels : undefined;

    let hasCondition = false;
    let matched = true;

    if (serverIds?.length) {
      hasCondition = true;
      matched = matched && serverIds.includes(action.serverId);
    }
    if (riskLevels?.length) {
      hasCondition = true;
      matched =
        matched &&
        isDirectExposureRiskLevel(action.riskLevel) &&
        riskLevels.includes(action.riskLevel);
    }

    if (hasCondition && matched && typeof rule.directCallable === 'boolean') return rule.directCallable;
  }

  return defaultValue;
}

export function inferDiscoveryRiskLevel(
  annotations: Record<string, unknown> | null | undefined,
): DirectExposureRiskLevel | null {
  if (annotations?.destructiveHint === true) {
    return 'high';
  }

  if (annotations?.readOnlyHint === true) {
    return 'low';
  }

  return null;
}

export interface DiscoveryGlobalConfig {
  enabled: boolean;
  defaultProfileId?: string | null;
}

export interface DiscoveryProfileCreateInput {
  name: string;
  description?: string;
  mode: DiscoveryMode;
  enabled?: boolean;
  isDefault?: boolean;
  config?: DiscoveryProfileConfig;
  instructionText?: string;
}

export interface DiscoveryProfileUpdateInput {
  id: string;
  name?: string;
  description?: string;
  mode?: DiscoveryMode;
  enabled?: boolean;
  isDefault?: boolean;
  config?: DiscoveryProfileConfig;
  instructionText?: string;
}

export interface DiscoveryPreviewResult {
  mode: DiscoveryMode;
  directTools: Array<{ name: string; serverId: string }>;
  hiddenTools: Array<{ actionId: string; displayName: string; serverId: string }>;
  catalogToolsIncluded: string[];
  totalDirectCount: number;
  totalHiddenCount: number;
}
