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

export interface CatalogSearchInput {
  query: string;
  profileId?: string;
  serverIds?: string[];
  riskMax?: 'low' | 'medium' | 'high' | 'critical';
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
  category: string | null;
  tags: string[];
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
  category: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  examples: unknown[] | null;
  riskLevel: string | null;
  requiredScopes: string[] | null;
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

export interface DiscoveryProfileConfig {
  directExposureRules?: Array<{
    match: {
      serverIds?: string[];
      categories?: string[];
      riskLevels?: string[];
      tags?: string[];
    };
    directCallable: boolean;
  }>;
}

export type ExposureRule = NonNullable<DiscoveryProfileConfig['directExposureRules']>[number];

/**
 * Evaluate exposure rules to determine if an action is directly callable.
 * Returns the `directCallable` value of the first matching rule,
 * or `defaultValue` if no rule matches.
 */
export function evaluateExposureRules(
  rules: ExposureRule[] | null | undefined,
  action: {
    serverId: string;
    category?: string | null;
    riskLevel?: string | null;
    tags?: string[];
  },
  defaultValue: boolean,
): boolean {
  if (!rules || !Array.isArray(rules) || rules.length === 0) return defaultValue;

  for (const rule of rules) {
    const m = rule.match;
    if (!m || typeof m !== 'object') continue;
    let hasCondition = false;
    let matched = true;

    if (m.serverIds?.length) {
      hasCondition = true;
      matched = matched && m.serverIds.includes(action.serverId);
    }
    if (m.categories?.length) {
      hasCondition = true;
      matched = matched && !!action.category && m.categories.includes(action.category);
    }
    if (m.riskLevels?.length) {
      hasCondition = true;
      matched = matched && !!action.riskLevel && m.riskLevels.includes(action.riskLevel);
    }
    if (m.tags?.length) {
      hasCondition = true;
      matched = matched && !!action.tags?.length && m.tags.some((t) => action.tags!.includes(t));
    }

    if (hasCondition && matched) return rule.directCallable;
  }

  return defaultValue;
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
