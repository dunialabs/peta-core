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
  categories?: string[];
  tags?: string[];
  riskMax?: 'low' | 'medium' | 'high' | 'critical';
  approvalAllowed?: boolean;
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
  approvalRequired: boolean;
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
  approvalRequired: boolean;
  directCallable: boolean;
  wireName: string | null;
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
  searchDefaults?: {
    preferReadOnly?: boolean;
    rankHotPathHigher?: boolean;
  };
  directExposureRules?: Array<{
    match: {
      serverIds?: string[];
      categories?: string[];
      riskLevels?: string[];
      tags?: string[];
      requireApproval?: boolean;
    };
    directCallable: boolean;
  }>;
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
  publicVisible?: boolean;
  anonymousVisible?: boolean;
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
  publicVisible?: boolean;
  anonymousVisible?: boolean;
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
