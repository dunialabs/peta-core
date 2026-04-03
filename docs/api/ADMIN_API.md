# Peta Core Admin API Protocol Documentation

## Overview

This document describes the complete protocol specification for Peta Core Admin API. All admin operations are provided through a unified `/admin` endpoint using an action-based request routing mechanism.

## Basic Information

- **Endpoint**: `POST /admin`
- **Authentication**: Bearer Token (Peta access token; opaque bearer token)
- **Content Type**: `application/json`
- **Character Encoding**: UTF-8

## Unified Request Format

All admin requests use a unified `AdminRequest` structure:

```typescript
interface AdminRequest<T = any> {
  action: AdminActionType; // Operation type (numeric enum)
  data: T; // Operation data (specific type depends on action)
}
```

_Admin operation type enum - uses numeric values for performance_

export enum AdminActionType {
// User operations (1000-1999)
DISABLE_USER = 1001, // Disable access for specified user
UPDATE_USER_PERMISSIONS = 1002, // Update user permissions
CREATE_USER = 1010, // Create user
GET_USERS = 1011, // Query user list
UPDATE_USER = 1012, // Update user
DELETE_USER = 1013, // Delete user
DELETE_USERS_BY_PROXY = 1014, // Batch delete users by proxy
COUNT_USERS = 1015, // Count users
GET_OWNER = 1016, // Get Owner information

// Server operations (2000-2999)
START_SERVER = 2001, // Start specified server
STOP_SERVER = 2002, // Stop specified server
UPDATE_SERVER_CAPABILITIES = 2003, // Update server capability configuration
UPDATE_SERVER_LAUNCH_CMD = 2004, // Update launch command
CONNECT_ALL_SERVERS = 2005, // Connect all servers
CREATE_SERVER = 2010, // Create server
GET_SERVERS = 2011, // Query server list
UPDATE_SERVER = 2012, // Update server
DELETE_SERVER = 2013, // Delete server
DELETE_SERVERS_BY_PROXY = 2014, // Batch delete servers by proxy
COUNT_SERVERS = 2015, // Count servers

// Query operations (3000-3999)
GET_AVAILABLE_SERVERS_CAPABILITIES = 3002, // Get all server capability configurations
GET_USER_AVAILABLE_SERVERS_CAPABILITIES = 3003, // Get user accessible server capability configurations
GET_SERVERS_STATUS = 3004, // Get all server status
GET_SERVERS_CAPABILITIES = 3005, // Get specified server capability configuration

// IP whitelist operations (4000-4999)
UPDATE_IP_WHITELIST = 4001, // Replace mode: delete all existing IPs, save new IP list to database and load to memory
GET_IP_WHITELIST = 4002, // Query IP whitelist
DELETE_IP_WHITELIST = 4003, // Delete specified IP whitelist
ADD_IP_WHITELIST = 4004, // Append mode: add IPs to whitelist (without deleting existing IPs)
SPECIAL_IP_WHITELIST_OPERATION = 4005, // IP filter switch: allow-all disable filter/deny-all enable filter

// Proxy operations (5000-5099)
GET_PROXY = 5001, // Query proxy information
CREATE_PROXY = 5002, // Create proxy
UPDATE_PROXY = 5003, // Update proxy
DELETE_PROXY = 5004, // Delete proxy
STOP_PROXY = 5005, // Stop all proxy servers

// Backup and restore (6000-6099)
BACKUP_DATABASE = 6001, // Full database backup
RESTORE_DATABASE = 6002, // Full database restore

// Log operations (7000-7099)
SET_LOG_WEBHOOK_URL = 7001, // Set log sync webhook URL
GET_LOGS = 7002, // Get log records

// Cloudflared operations (8000-8099)
UPDATE_CLOUDFLARED_CONFIG = 8001, // Update cloudflared configuration
GET_CLOUDFLARED_CONFIGS = 8002, // Query cloudflared configuration list
DELETE_CLOUDFLARED_CONFIG = 8003, // Delete cloudflared configuration
RESTART_CLOUDFLARED = 8004, // Restart cloudflared
STOP_CLOUDFLARED = 8005, // Stop cloudflared

// Result cache operations (11000-11099)
CACHE_GET_HEALTH = 11001,
CACHE_GET_POLICY = 11002,
CACHE_PURGE_GLOBAL = 11010,
CACHE_PURGE_SERVER = 11011,
CACHE_PURGE_TOOL = 11012,
CACHE_PURGE_PROMPT = 11013,
CACHE_PURGE_RESOURCE = 11014,
CACHE_PURGE_EXACT = 11015,

// Policy operations (9100-9199)
CREATE_POLICY_SET = 9101, // Create policy set
GET_POLICY_SETS = 9102, // Get policy sets
UPDATE_POLICY_SET = 9103, // Update policy set
DELETE_POLICY_SET = 9104, // Delete policy set
GET_EFFECTIVE_POLICY = 9105, // Get effective policy

// Approval operations (9200-9299)
LIST_APPROVAL_REQUESTS = 9201, // List approval requests
GET_APPROVAL_REQUEST = 9202, // Get approval request
DECIDE_APPROVAL_REQUEST = 9203, // Decide approval request
COUNT_PENDING_APPROVALS = 9204 // Count pending approvals

// Discovery / Progressive Disclosure operations (9300-9399)
GET_DISCOVERY_CONFIG = 9301, // Get global discovery enablement + default profile
SET_DISCOVERY_CONFIG = 9302, // Update global discovery enablement + default profile
CREATE_DISCOVERY_PROFILE = 9310, // Create a discovery profile
GET_DISCOVERY_PROFILES = 9311, // List discovery profiles
GET_DISCOVERY_PROFILE = 9312, // Get one discovery profile
UPDATE_DISCOVERY_PROFILE = 9313, // Update a discovery profile
DELETE_DISCOVERY_PROFILE = 9314, // Delete a discovery profile
PREVIEW_DISCOVERY = 9320, // Preview direct vs catalog-only tools for a profile
REINDEX_CATALOG = 9330, // Rebuild the persistent catalog index from live managed servers
GET_CATALOG_STATS = 9331, // Get catalog row / server count / last-indexed stats
}

### Request Examples

**curl example:**

```bash
curl -X POST http://localhost:3002/admin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PETA_ACCESS_TOKEN" \
  -d '{
    "action": 1011,
    "data": {
      "proxyId": 0
    }
  }'
```

**TypeScript example:**

```typescript
const response = await fetch('http://localhost:3002/admin', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    action: 1011, // GET_USERS
    data: {
      proxyId: 0,
    },
  }),
});

const result = await response.json();
if (!result.success) {
  console.error('Operation failed:', result.error);
}
```

## Unified Response Format

All admin requests return a unified `AdminResponse` structure:

```typescript
interface AdminResponse<T = any> {
  success: boolean; // Whether operation succeeded
  data?: T; // Return data on success
  error?: {
    // Error information on failure
    code: AdminErrorCode; // Error code (numeric)
    message: string; // Error message
  };
}
```

**Success response example:**

```json
{
  "success": true,
  "data": {
    "users": [...]
  }
}
```

**Error response example:**

```json
{
  "success": false,
  "error": {
    "code": 2001,
    "message": "User user123 not found"
  }
}
```

## Data Structures Overview

### Enum Reference

**UserStatus**

- `0` Disabled
- `1` Enabled
- `2` Pending
- `3` Suspended

**UserRole**

- `1` Owner
- `2` Admin
- `3` User

**ServerCategory**

- `1` Template
- `2` CustomRemote
- `3` RestApi
- `4` Skills
- `5` CustomStdio

**ServerAuthType**

- `1` ApiKey
- `2` GoogleAuth
- `3` NotionAuth
- `4` FigmaAuth
- `5` GoogleCalendarAuth
- `6` GithubAuth
- `7` ZendeskAuth
- `8` CanvasAuth
- `9` CanvaAuth
- `10` GmailAuth
- `11` GoogleDocsAuth
- `12` GoogleSheetsAuth
- `13` GoogleFormsAuth
- `14` PipedriveAuth


**ServerStatus**

- `0` Online
- `1` Offline
- `2` Connecting
- `3` Error
- `4` Sleeping (lazy start; currently no active connection but can be woken up again)

**DiscoveryMode**

- `FLAT` All tools are directly exposed to the AI client (no catalog overlay)
- `HYBRID` Some tools are directly exposed, others are catalog-only (based on profile directExposureRules)
- `STRICT` All tools are catalog-only; AI must use catalog tools to discover and execute

### Progressive Disclosure Notes

- The discovery catalog is an **index/cache**, not the runtime source of truth for executing tools.
- `PREVIEW_DISCOVERY`, `REINDEX_CATALOG`, and `GET_CATALOG_STATS` operate on that catalog/index layer.
- Runtime execution still resolves through the live MCP session and the current `ServerContext`.
- Temporary or user-scoped server contexts are excluded from the global catalog index.

### DiscoveryProfileConfig (used by CREATE/UPDATE_DISCOVERY_PROFILE)

```typescript
type DiscoveryProfileConfig = {
  directExposureRules?: Array<{
    match: {
      serverIds?: string[];
      riskLevels?: string[];  // 'low' | 'medium' | 'high' | 'critical'
    };
    directCallable: boolean;
  }>;
};
```

**directExposureRules evaluation**:

- Rules are evaluated in order; the first matching rule wins
- A rule matches when all non-empty `match` fields match the action
- Rules with an empty or missing `match` object are skipped (they do not act as catch-all)
- If no rule matches, the action defaults to catalog-only (not directly callable)
- Only used in `HYBRID` mode; `FLAT` exposes everything, `STRICT` hides everything
- **Risk level inference**: Currently only `low` (from `readOnlyHint`) and `high` (from `destructiveHint`) are auto-inferred from MCP annotations. `medium` and `critical` rules will not match unless a custom source populates them.

**DangerLevel**

- `0` Silent
- `1` Notification
- `2` Approval

### Permissions (used by UPDATE_USER_PERMISSIONS / CREATE_USER / UPDATE_USER)

```typescript
type Permissions = {
  [serverId: string]: {
    enabled: boolean; // required
    serverName?: string;
    allowUserInput?: boolean;
    authType?: number; // ServerAuthType
    category?: number; // ServerCategory
    configTemplate?: string; // JSON string
    configured?: boolean;
    status?: number; // ServerStatus
    tools?: {
      [toolName: string]: { enabled: boolean; description?: string; dangerLevel?: 0 | 1 | 2 };
    };
    resources?: {
      [resourceName: string]: { enabled: boolean; description?: string };
    };
    prompts?: {
      [promptName: string]: { enabled: boolean; description?: string };
    };
  };
};
```

**Minimum valid structure**:

- `enabled` must be boolean
- `tools/resources/prompts` must be objects when present
- Invalid structure will fail authentication (`INVALID_PERMISSIONS`)

### ServerConfigCapabilities (used by UPDATE_SERVER_CAPABILITIES)

```typescript
type ServerConfigCapabilities = {
  tools: { [name: string]: { enabled: boolean; description?: string; dangerLevel?: 0 | 1 | 2 } };
  resources: { [name: string]: { enabled: boolean; description?: string } };
  prompts: { [name: string]: { enabled: boolean; description?: string } };
};
```

### EncryptedData (common encrypted field format)

`encryptedToken` / `launchConfig` are JSON strings with this structure:

```typescript
type EncryptedData = {
  data: string; // Base64
  iv: string; // Base64
  salt: string; // Base64
  tag: string; // Base64
};
```

### Decrypted launchConfig Structure (used internally when connecting)

**stdio**

```json
{ "type": "stdio", "command": "node", "args": ["server.js"], "env": { "A": "B" }, "cwd": "/path" }
```

**http**

```json
{ "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer xxx" } }
```

**sse**

```json
{ "type": "sse", "url": "https://example.com/sse" }
```

**custom-stdio** (category=5; `type` field is optional — auto-detected when `command` is present)

```json
{
  "command": "/usr/local/bin/my-mcp-server",
  "args": ["--config", "/etc/config.json"],
  "env": { "API_KEY": "xxx" }
}
```

## Permission Description

Admin API supports two role permissions:

- **Owner + Admin**: Most operations allow Owner and Admin roles to execute
- **Owner only**: Some sensitive operations only allow Owner role to execute (specially marked in API list)

Permission verification is performed in ConfigController. Requests that do not meet permission requirements will return `FORBIDDEN (1003)` error.

**publicAccess and permissions merge logic**:

- If `permissions` does not include a `serverId`, availability falls back to `server.publicAccess` (true allows access)
- If `permissions` includes a `serverId`, `permissions[serverId].enabled` takes precedence over `publicAccess`
- Final tool/resource/prompt visibility is the merge of server capabilities and admin permissions; you can only override `enabled` for existing capability items

---

## API List

### User Operations (1000-1999)

#### 1001 DISABLE_USER

**Permission**: Owner + Admin
**Function**: Disable access for specified user, disconnect all active sessions for that user

**Request Parameters** (data):

- `targetId` (string, required): User ID

**Return Result** (data):

```json
null
```

**Function Description**:

- Update user status to `Disabled`
- Disconnect all active MCP sessions for that user
- User can no longer establish new connections

---

#### 1002 UPDATE_USER_PERMISSIONS

**Permission**: Owner + Admin
**Function**: Update server permission configuration for specified user

**Request Parameters** (data):

- `targetId` (string, required): User ID
- `permissions` (string or object, required): Permission configuration (Permissions object or its JSON string)

**Return Result** (data):

```json
null
```

**Function Description**:

- **Replace semantics**: `permissions` replaces the user's existing permissions (not a patch)
- If only some serverIds are provided, others are removed and fall back to `publicAccess`
- Update permissions field in user database
- If user has active sessions, push permission change notifications in real-time:
  - Send `tools/list_changed` when tools change
  - Send `resources/list_changed` when resources change
  - Send `prompts/list_changed` when prompts change

**Minimal example** (disable a single server):

```json
{
  "targetId": "user123",
  "permissions": {
    "filesystem": {
      "enabled": false,
      "tools": {},
      "resources": {},
      "prompts": {}
    }
  }
}
```

---

#### 1010 CREATE_USER

**Permission**: **Owner only** No verification when creating owner for the first time, database is empty at this time
**Function**: Create new user

**Request Parameters** (data):

- `userId` (string, required): User ID (unique identifier)
- `status` (number, optional): User status, defaults to `UserStatus.Enabled (1)`
- `role` (number, optional): User role, defaults to `UserRole.User (3)`
- `permissions` (string or object, optional): Permission configuration, defaults to `{}`
- `expiresAt` (number, optional): Expiration time (Unix timestamp, seconds), defaults to `0` (never expires)
- `createdAt` (number, optional): Creation time (Unix timestamp, seconds), defaults to current time
- `updatedAt` (number, optional): Update time (Unix timestamp, seconds), defaults to current time
- `ratelimit` (number, optional): Rate limit, defaults to `100`
- `name` (string, optional): User name, defaults to empty string
- `encryptedToken` (string, required): Encrypted token
- `proxyId` (number, optional): Associated proxy ID, defaults to `0`
- `notes` (string, optional): Notes, defaults to `null`

**Return Result** (data):

```json
{
  "user": {
    "userId": "user123",
    "status": 1,
    "role": 3,
    "permissions": "{}",
    ...
  }
}
```

**Important Notes**:

- `encryptedToken` must be an `EncryptedData` JSON string (see Data Structures Overview)
- For non-Owner creation, the admin token is used to decrypt `encryptedToken`, and `userId` must equal the first 32 chars of `SHA-256(token)`
- Owner can be created only once, and must be the first user (empty database)

---

#### 1011 GET_USERS

**Permission**: Owner + Admin
**Function**: Query user list, supports multiple filter conditions

**Request Parameters** (data):

- `userId` (string, optional): Exact query for specified user ID
- `proxyId` (number, optional): Filter by proxyId
- `role` (number, optional): Filter by role
- `excludeRole` (number, optional): Exclude specified role

**Return Result** (data):

```json
{
  "users": [
    {
      "userId": "user123",
      "status": 1,
      "role": 3,
      "permissions": "{}",
      "serverApiKeys": "[]",
      ...
    }
  ]
}
```

**Function Description**:

- If `userId` is provided, returns single user (in array form) or empty array
- Other filter conditions can be combined
- Returns all users if no filter conditions provided

---

#### 1012 UPDATE_USER

**Permission**: Owner + Admin
**Function**: Update user information

**Request Parameters** (data):

- `userId` (string, required): User ID
- `name` (string, optional): User name
- `notes` (string, optional): Notes
- `permissions` (string or object, optional): Permission configuration
- `status` (number, optional): User status
- `encryptedToken` (string, optional): Encrypted user access token

**Return Result** (data):

```json
{
  "user": {
    "userId": "user123",
    ...
  }
}
```

**Function Description**:

- If `permissions` is updated, will push to user's active sessions in real-time
- If `status` changes to `Disabled`, will disable user first (disconnect sessions)

---

#### 1013 DELETE_USER

**Permission**: Owner + Admin
**Function**: Delete specified user

**Request Parameters** (data):

- `userId` (string, required): User ID

**Return Result** (data):

```json
{
  "message": "User deleted successfully"
}
```

**Function Description**:

- Disable user before deletion (disconnect all sessions)
- Permanently delete user record from database

---

#### 1014 DELETE_USERS_BY_PROXY

**Permission**: Owner + Admin
**Function**: Batch delete users by proxyId

**Request Parameters** (data):

- `proxyId` (number, required): Proxy ID

**Return Result** (data):

```json
{
  "deletedCount": 10
}
```

**Function Description**:

- Disable all matching users before deletion (disconnect sessions)
- Returns actual number of deleted users

---

#### 1015 COUNT_USERS

**Permission**: Owner + Admin
**Function**: Count users

**Request Parameters** (data):

- `excludeRole` (number, optional): Exclude specified role

**Return Result** (data):

```json
{
  "count": 50
}
```

---

#### 1016 GET_OWNER

**Permission**: Public (no authentication required)
**Function**: Get complete information of system Owner user

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "owner": {
    "userId": "owner123",
    "status": 1,
    "role": 1,
    "permissions": "{}",
    "serverApiKeys": "[]",
    "expiresAt": 0,
    "createdAt": 1729431234,
    "updatedAt": 1729431234,
    "ratelimit": 100,
    "name": "System Owner",
    "encryptedToken": "...",
    "proxyId": 0,
    "notes": null
  }
}
```

**Function Description**:

- Returns complete information of the unique Owner role user in the system
- If no Owner user exists in the system, returns error (code: 2001, USER_NOT_FOUND)
- This endpoint requires no authentication and is publicly accessible
- Returns all user fields, including sensitive information

---

### Server Operations (2000-2999)

#### 2001 START_SERVER

**Permission**: **Owner only**
**Function**: Start specified MCP server

**Request Parameters** (data):

- `targetId` (string, required): Server ID

**Return Result** (data):

```json
null
```

**Function Description**:

- Set server's `enabled` field to `true`
- Start MCP server process and establish connection
- Notify all active user sessions using this server of capability changes

---

#### 2002 STOP_SERVER

**Permission**: Owner + Admin
**Function**: Stop specified MCP server

**Request Parameters** (data):

- `targetId` (string, required): Server ID

**Return Result** (data):

```json
null
```

**Function Description**:

- Disconnect MCP server connection
- Set server's `enabled` field to `false`
- Notify all active user sessions using this server of capability changes

---

#### 2003 UPDATE_SERVER_CAPABILITIES

**Permission**: Owner + Admin
**Function**: Update server capability configuration (tools/resources/prompts)

**Request Parameters** (data):

- `targetId` (string, required): Server ID
- `capabilities` (string or object, required): Capability configuration (ServerConfigCapabilities object or its JSON string)

**Return Result** (data):

```json
null
```

**Function Description**:

- Update server capability configuration in database
- If server is running, reload configuration and notify related user sessions

---

#### 2004 UPDATE_SERVER_LAUNCH_CMD

**Permission**: **Owner only**
**Function**: Update server launch command configuration

**Request Parameters** (data):

- `targetId` (string, required): Server ID
- `launchConfig` (string, required): Launch configuration (contains command/args/env, etc.), string encrypted with owner token

**Return Result** (data):

```json
null
```

**Function Description**:

- Update launchConfig in database
- If server is running, reconnect server (restart)
- Notify related user sessions of capability changes

---

#### 2005 CONNECT_ALL_SERVERS

**Permission**: **Owner only**
**Function**: Connect all enabled MCP servers

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "successServers": [
    {
      "serverId": "server1",
      "serverName": "Server 1",
      ...
    }
  ],
  "failedServers": [
    {
      "serverId": "server2",
      "serverName": "Server 2",
      ...
    }
  ]
}
```

**Function Description**:

- Attempt to connect all servers with `enabled = true`
- Returns lists of successful and failed servers

---

#### 2010 CREATE_SERVER

**Permission**: **Owner only**
**Function**: Create new MCP server configuration

**Request Parameters** (data):

- `serverId` (string, required): Server ID (unique identifier)
- `serverName` (string, optional): Server name, defaults to empty string
- `enabled` (boolean, optional): Whether enabled, defaults to `true`
- `launchConfig` (string, **required**): Encrypted launch configuration JSON (EncryptedData); must be non-empty and not `{}`; encrypted with Owner token
- `capabilities` (string or object, optional): **ignored on create**; use `UPDATE_SERVER_CAPABILITIES (2003)` to set capabilities
- `createdAt` (number, optional): Creation time (Unix timestamp, seconds), defaults to current time
- `updatedAt` (number, optional): Update time (Unix timestamp, seconds), defaults to current time
- `allowUserInput` (boolean, optional): Whether to allow user input, defaults to `false`
- `proxyId` (number, optional): Associated proxy ID, defaults to `0`
- `toolTmplId` (string, optional): Tool template ID, defaults to `null`
- `authType` (number, required): Server authorization type, defaults to `1` (`ApiKey`); see `ServerAuthType` enum above for all supported values
- `configTemplate` (string, **required**): JSON config template string; must be non-empty and not `{}` (validated regardless of allowUserInput)
- `category` (number, required): Server category. `1`: Template, `2`: CustomRemote, `3`: RestApi, `4`: Skills, `5`: CustomStdio
- `lazyStartEnabled` (boolean, optional): Enable lazy loading for this server. When true, server stays managed in memory, delays startup until first use, and idle/unexpected closes can return it to `Sleeping` so it can be started again later. Defaults to `true`
- `publicAccess` (boolean, optional): Whether public access is enabled. If true, users without explicit permissions can still access this server. Defaults to `false`
- `anonymousAccess` (boolean, optional): Whether anonymous access (no authentication token) is enabled. Defaults to `false`
- `anonymousRateLimit` (number, optional): Rate limit for anonymous access (requests per minute per source IP). Must be an integer between 1 and 1000. Defaults to `10`

**Return Result** (data):

```json
{
  "server": {
    "serverId": "server123",
    "serverName": "My Server",
    "enabled": true,
    ...
  }
}
```

**ConfigTemplate notes (by category)**

- **Template (1)**: must include `mcpJsonConf` and `credentials`, optional `oAuthConfig`
- **CustomRemote (2)**: must include base URL info (used to assemble launchConfig for user config)
- **RestApi (3)**: must include `apis[0].auth`; system injects `launchConfig.auth`
- **Skills (4)**: must include `type` and `serverName`
- **CustomStdio (5)**: must include `command`; optional `args` (array) and `env` (object). When `allowUserInput=true`, users override env via `stdioEnv` in User API
  - Docker deployment behavior: if `PETA_CORE_IN_DOCKER=true` and `command` is not `docker`, peta-core wraps execution into `docker run ... petaio/mcp-runner:latest ...` internally. Stored configuration format remains unchanged.

**OAuth Template note**:

- If `configTemplate.oAuthConfig.clientId` exists, the decrypted `launchConfig` must include `oauth` fields (`clientId`, `clientSecret`, `code`, `redirectUri`, etc.); system exchanges and persists tokens

**Input examples (by category)**:

**Template (1) - ApiKey (Postgres)**:

```json
{
  "action": 2010,
  "data": {
    "serverId": "postgres",
    "serverName": "Postgres",
    "category": 1,
    "authType": 1,
    "allowUserInput": true,
    "configTemplate": "{\"toolId\":\"5f2504e04f8911d39a0c0331222c312\",\"name\":\"Postgres\",\"description\":\"PostgreSQL MCP server running in Docker with full read-write access.\",\"credentials\":\"[{\\\"name\\\":\\\"POSTGRES URL\\\",\\\"description\\\":\\\"\\\",\\\"dataType\\\":1,\\\"key\\\":\\\"YOUR_POSTGRES_URL\\\"}]\",\"mcpJsonConf\":\"{\\\"command\\\":\\\"docker\\\",\\\"args\\\":[\\\"run\\\",\\\"-i\\\",\\\"--rm\\\",\\\"--pull=always\\\",\\\"-e\\\",\\\"POSTGRES_URL\\\",\\\"-e\\\",\\\"ACCESS_MODE\\\",\\\"ghcr.io/dunialabs/mcp-servers/postgres:latest\\\"],\\\"env\\\":{\\\"POSTGRES_URL\\\":\\\"YOUR_POSTGRES_URL\\\",\\\"ACCESS_MODE\\\":\\\"readwrite\\\"}}\",\"authType\":1,\"authConfig\":\"\",\"toolDefaultConfig\":\"{\\\"postgresListSchemas\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"postgresListTables\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"postgresDescribeTable\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"postgresGetTableStats\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"postgresExecuteQuery\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":1},\\\"postgresExecuteWrite\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":2},\\\"postgresExplainQuery\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":2}}\"}",
    "launchConfig": "{\"data\":\"...\",\"iv\":\"...\",\"salt\":\"...\",\"tag\":\"...\"}"
  }
}
```

**Template (1) - OAuth (Notion)**:

```json
{
  "action": 2010,
  "data": {
    "serverId": "notion",
    "serverName": "Notion",
    "category": 1,
    "authType": 3,
    "allowUserInput": true,
    "configTemplate": "{\"toolId\":\"a7c3f8e9b2d64a5891f3c7b0e4d2a8f6\",\"name\":\"Notion\",\"description\":\"Model Context Protocol (MCP) server for Notion integration.\",\"credentials\":\"[{\\\"name\\\":\\\"ClientId\\\",\\\"description\\\":\\\"An identifier for your integration, found in the integration settings.\\\",\\\"dataType\\\":1,\\\"key\\\":\\\"YOUR_CLIENT_ID\\\"},{\\\"name\\\":\\\"ClientSecret\\\",\\\"description\\\":\\\"Client Secret\\\",\\\"dataType\\\":1,\\\"key\\\":\\\"YOUR_CLIENT_SECRET\\\"},{\\\"name\\\":\\\"OAuth Code\\\",\\\"description\\\":\\\"OAuth Authorization Code\\\",\\\"dataType\\\":1,\\\"key\\\":\\\"YOUR_OAUTH_CODE\\\"},{\\\"name\\\":\\\"OAuth Redirect URI\\\",\\\"description\\\":\\\"OAuth Redirect URI\\\",\\\"dataType\\\":1,\\\"key\\\":\\\"YOUR_OAUTH_REDIRECT_URL\\\"}]\",\"mcpJsonConf\":\"{\\\"command\\\":\\\"docker\\\",\\\"args\\\":[\\\"run\\\",\\\"--pull=always\\\",\\\"-i\\\",\\\"--rm\\\",\\\"-e\\\",\\\"notionToken\\\",\\\"ghcr.io/dunialabs/mcp-servers/notion:latest\\\"],\\\"oauth\\\":{\\\"clientId\\\":\\\"YOUR_CLIENT_ID\\\",\\\"clientSecret\\\":\\\"YOUR_CLIENT_SECRET\\\",\\\"accessToken\\\":\\\"YOUR_ACCESS_TOKEN\\\",\\\"code\\\":\\\"YOUR_OAUTH_CODE\\\",\\\"redirectUri\\\":\\\"YOUR_OAUTH_REDIRECT_URL\\\"}}\",\"authType\":3,\"authConfig\":\"\",\"oAuthConfig\":{\"authorizationUrl\":\"https://api.notion.com/v1/oauth/authorize\",\"tokenUrl\":\"https://api.notion.com/v1/oauth/token\",\"clientId\":\"2b1d872b-594c-80c7-a98e-0037f2066ebe\",\"userClientId\":\"2ced872b-594c-80d5-a0c5-0037f162006c\",\"responseType\":\"code\",\"extraParams\":{\"owner\":\"user\"}},\"toolDefaultConfig\":\"{\\\"notionGetPage\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"notionCreatePage\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":1},\\\"notionUpdatePage\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":1},\\\"notionGetPageProperties\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"notionGetDatabase\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"notionQueryDatabase\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"notionCreateDatabase\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":1},\\\"notionUpdateDatabase\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":1},\\\"notionGetBlockChildren\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"notionAppendBlocks\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":1},\\\"notionGetBlock\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"notionUpdateBlock\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":1},\\\"notionDeleteBlock\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":2},\\\"notionSearch\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0},\\\"notionCreateComment\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":1},\\\"notionGetComments\\\":{\\\"enabled\\\":true,\\\"dangerLevel\\\":0}}\"}",
    "launchConfig": "{\"data\":\"...\",\"iv\":\"...\",\"salt\":\"...\",\"tag\":\"...\"}"
  }
}
```

**CustomRemote (2)**:

```json
{
  "action": 2010,
  "data": {
    "serverId": "custom-remote",
    "serverName": "Custom Remote",
    "category": 2,
    "authType": 1,
    "allowUserInput": true,
    "configTemplate": "{\"url\":\"https://example.com/mcp\"}",
    "launchConfig": "{\"data\":\"...\",\"iv\":\"...\",\"salt\":\"...\",\"tag\":\"...\"}"
  }
}
```

**RestApi (3)**:

```json
{
  "action": 2010,
  "data": {
    "serverId": "rest-api",
    "serverName": "REST API",
    "category": 3,
    "authType": 1,
    "allowUserInput": true,
    "configTemplate": "{\"baseUrl\":\"https://api.example.com\",\"apis\":[{\"path\":\"/\",\"auth\":{}}]}",
    "launchConfig": "{\"data\":\"...\",\"iv\":\"...\",\"salt\":\"...\",\"tag\":\"...\"}"
  }
}
```

**CustomStdio (5)** — admin defines command/args/default env; user overrides env at configure time:

```json
{
  "action": 2010,
  "data": {
    "serverId": "custom-stdio-server",
    "serverName": "Custom Stdio MCP",
    "category": 5,
    "authType": 1,
    "allowUserInput": true,
    "configTemplate": "{\"command\":\"/usr/local/bin/my-mcp-server\",\"args\":[\"--verbose\"],\"env\":{\"LOG_LEVEL\":\"info\"}}",
    "launchConfig": "{\"data\":\"...\",\"iv\":\"...\",\"salt\":\"...\",\"tag\":\"...\"}"
  }
}
```

---

#### 2011 GET_SERVERS

**Permission**: Owner + Admin
**Function**: Query server list, supports multiple filter conditions

**Request Parameters** (data):

- `serverId` (string, optional): Exact query for specified server ID
- `proxyId` (number, optional): Filter by proxyId
- `enabled` (boolean, optional): Filter by enabled status

**Return Result** (data):

```json
{
  "servers": [
    {
      "serverId": "server123",
      "serverName": "My Server",
      "enabled": true,
      "launchConfig": "{}",
      "capabilities": "{}",
      ...
    }
  ]
}
```

---

#### 2012 UPDATE_SERVER

**Permission**: **Owner only**
**Function**: Update server configuration

**Request Parameters** (data):

- `serverId` (string, required): Server ID
- `serverName` (string, optional): Server name
- `launchConfig` (string or object, optional): Launch configuration encrypted with owner token. **Not updatable for Template with allowUserInput=true**
- `capabilities` (string or object, optional): Capability configuration. **Merge semantics; omitted fields are not removed**
- `enabled` (boolean, optional): Whether enabled
- `configTemplate` (string, optional): Only RestApi/CustomRemote/CustomStdio can update
- `lazyStartEnabled` (boolean, optional): Enable lazy loading for this server. When true, server stays managed in memory, delays startup until first use, and idle/unexpected closes can return it to `Sleeping` so it can be started again later
- `publicAccess` (boolean, optional): Public access flag
- `anonymousAccess` (boolean, optional): Anonymous access flag
- `anonymousRateLimit` (number, optional): Rate limit for anonymous access (requests per minute per source IP). Must be an integer between 1 and 1000

**Return Result** (data):

```json
{
  "server": {
    "serverId": "server123",
    ...
  }
}
```

**Function Description**:

- `allowUserInput` is immutable after creation
- `configTemplate` is only updatable for RestApi/CustomRemote/CustomStdio; Template updates will error
- `capabilities` uses **merge semantics**; explicitly set `enabled=false` to disable
- If server is running and `capabilities` or `launchConfig` is updated, will trigger reload or restart
- If `enabled` changes to `false`, will stop server

**Input examples (by category)**:

**Template (1) - update name/enable only**:

```json
{
  "action": 2012,
  "data": {
    "serverId": "notion",
    "serverName": "Notion Personal",
    "enabled": true
  }
}
```

**CustomRemote (2) - update configTemplate and launchConfig**:

```json
{
  "action": 2012,
  "data": {
    "serverId": "custom-remote",
    "configTemplate": "{\"url\":\"https://example.com/mcp\"}",
    "launchConfig": "{\"data\":\"...\",\"iv\":\"...\",\"salt\":\"...\",\"tag\":\"...\"}"
  }
}
```

**RestApi (3) - update capabilities (merge)**:

```json
{
  "action": 2012,
  "data": {
    "serverId": "rest-api",
    "capabilities": {
      "tools": {
        "write_record": { "enabled": false, "description": "Disable write" }
      },
      "resources": {},
      "prompts": {}
    }
  }
}
```

**CustomStdio (5) - update configTemplate and launchConfig**:

```json
{
  "action": 2012,
  "data": {
    "serverId": "custom-stdio",
    "configTemplate": "{\"command\":\"/usr/local/bin/my-mcp-server\",\"args\":[\"--verbose\"],\"env\":{\"LOG_LEVEL\":\"debug\"}}",
    "launchConfig": "{\"data\":\"...\",\"iv\":\"...\",\"salt\":\"...\",\"tag\":\"...\"}"
  }
}
```

> **Note**: `command` and `args` in `configTemplate` define the base server binary. When `allowUserInput=true`, users can only override `env` via `stdioEnv` in CONFIGURE_SERVER; the `command` and `args` remain immutable to users. Admin edits do not automatically reconfigure existing user instances — users must reconfigure to pick up changes.

---

#### 2013 DELETE_SERVER

**Permission**: Owner + Admin
**Function**: Delete specified server

**Request Parameters** (data):

- `serverId` (string, required): Server ID

**Return Result** (data):

```json
{
  "message": "Server deleted successfully"
}
```

**Function Description**:

- Remove server from ServerManager (stop connection)
- Permanently delete server record from database

---

#### 2014 DELETE_SERVERS_BY_PROXY

**Permission**: Owner + Admin
**Function**: Batch delete servers by proxyId

**Request Parameters** (data):

- `proxyId` (number, required): Proxy ID

**Return Result** (data):

```json
{
  "deletedCount": 5
}
```

**Function Description**:

- Stop connections for all matching servers
- Returns actual number of deleted servers

---

#### 2015 COUNT_SERVERS

**Permission**: Owner + Admin
**Function**: Count servers

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "count": 10
}
```

---

### Query Operations (3000-3999)

#### 3002 GET_AVAILABLE_SERVERS_CAPABILITIES

**Permission**: Owner + Admin
**Function**: Get capability configurations of all available servers

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "capabilities": {
    "server1": {
      "enabled": true,
      "tools": {
        "toolName": {
          "enabled": true,
          "description": "Tool description",
          "dangerLevel": 0
        }
      },
      "resources": {
        "resourceName": {
          "enabled": true,
          "description": "Resource description"
        }
      },
      "prompts": {
        "promptName": {
          "enabled": true,
          "description": "Prompt description"
        }
      }
    }
  }
}
```

**Function Description**:

- Returns capability configurations of all running servers

---

#### 3003 GET_USER_AVAILABLE_SERVERS_CAPABILITIES

**Permission**: Owner + Admin
**Function**: Get capability configurations of servers accessible to specified user

**Request Parameters** (data):

- `targetId` (string, required): User ID

**Return Result** (data):

```json
{
  "capabilities": {
    "server1": {
      "enabled": true,
      "tools": { ... },
      "resources": { ... },
      "prompts": { ... }
    }
  }
}
```

**Function Description**:

- Prioritizes getting capability configuration from user's active sessions
- If user has no active sessions, calculates capabilities based on user permission configuration
- The returned `enabled` field reflects user's permission for that server

---

#### 3004 GET_SERVERS_STATUS

**Permission**: Owner + Admin
**Function**: Get current status of all servers

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "serversStatus": {
    "server1": 0,
    "server2": 1,
    "server3": 2
  }
}
```

**ServerStatus Enum**:

- `0`: Online
- `1`: Offline
- `2`: Connecting
- `3`: Error

---

#### 3005 GET_SERVERS_CAPABILITIES

**Permission**: Owner + Admin
**Function**: Get capability configuration of specified server

**Request Parameters** (data):

- `targetId` (string, required): Server ID

**Return Result** (data):

```json
{
  "capabilities": {
    "tools": {
      "toolName": {
        "enabled": true,
        "description": "Tool description",
        "dangerLevel": 0
      }
    },
    "resources": { ... },
    "prompts": { ... }
  }
}
```

**Function Description**:

- If server is running, returns real-time capability configuration
- If server is not running, returns configuration stored in database

---

### IP Whitelist Operations (4000-4999)

#### 4001 UPDATE_IP_WHITELIST

**Permission**: Owner + Admin
**Function**: Replace mode update IP whitelist (delete all existing IPs, save new IP list to database and load to memory)

**Request Parameters** (data):

- `whitelist` (array, required): IP address array (supports single IP or CIDR format)

**Return Result** (data):

```json
{
  "whitelist": ["192.168.1.0/24", "10.0.0.1"],
  "message": "IP whitelist updated successfully. 2 IPs loaded."
}
```

**Function Description**:

- Delete all existing IP records and insert new records in database transaction
- Automatically reload from database to memory, takes effect immediately
- Supported IP formats:
  - Single IP: `"192.168.1.100"`
  - CIDR: `"192.168.1.0/24"`
  - Special value: `"0.0.0.0/0"` means allow all IPs (disable filtering)

---

#### 4002 GET_IP_WHITELIST

**Permission**: Owner + Admin
**Function**: Query current IP whitelist

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "whitelist": ["192.168.1.0/24", "10.0.0.1"],
  "count": 2
}
```

---

#### 4003 DELETE_IP_WHITELIST

**Permission**: Owner + Admin
**Function**: Delete specified IP whitelist records

**Request Parameters** (data):

- `ips` (array, required): Array of IP addresses to delete

**Return Result** (data):

```json
{
  "deletedCount": 2,
  "message": "2 IP(s) deleted from whitelist"
}
```

**Function Description**:

- Delete specified IPs from database
- Automatically reload to memory, takes effect immediately
- If specified IPs don't exist, returns `deletedCount: 0`

---

#### 4004 ADD_IP_WHITELIST

**Permission**: Owner + Admin
**Function**: Append mode add IPs to whitelist (without deleting existing IPs)

**Request Parameters** (data):

- `ips` (array, required): Array of IP addresses to add

**Return Result** (data):

```json
{
  "addedIds": [10, 11, 12],
  "addedCount": 3,
  "skippedCount": 1,
  "message": "3 IP(s) added to whitelist, 1 skipped (duplicates)"
}
```

**Function Description**:

- Validates IP format (invalid format returns `INVALID_IP_FORMAT (5102)` error)
- Automatically skips duplicate IPs that already exist
- Automatically reloads to memory, takes effect immediately

---

#### 4005 SPECIAL_IP_WHITELIST_OPERATION

**Permission**: Owner + Admin
**Function**: IP filter switch operation (allow-all disable filter / deny-all enable filter)

**Request Parameters** (data):

- `operation` (string, required): Operation type, optional values `"allow-all"` or `"deny-all"`

**Return Result** (data):

```json
null
```

**Function Description**:

**allow-all operation (disable IP filtering)**:

- Add `"0.0.0.0/0"` record to database (if already exists, don't add duplicate)
- Effect: Allow all IP access

**deny-all operation (enable IP filtering)**:

- Delete all `"0.0.0.0/0"` records from database
- Prerequisite: Database must have other IP configurations, otherwise returns error
- Effect: Enable strict IP whitelist filtering

**Usage Recommendations**:

1. First use ADD_IP_WHITELIST (4004) to add allowed IPs
2. Then use deny-all operation to enable IP filtering
3. Use allow-all operation when temporarily disabling filtering

---

### Proxy Operations (5000-5099)

#### 5001 GET_PROXY

**Function**: Query proxy information (system only supports single proxy)

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "proxy": {
    "id": 1,
    "name": "My MCP Server",
    "proxyKey": "xxx",
    "addtime": 1234567890,
    "startPort": 3002
  }
}
```

**Function Description**:

- If no proxy exists, returns `proxy: null`

---

#### 5002 CREATE_PROXY

**Function**: Create proxy (system only allows one proxy)

**Request Parameters** (data):

- `name` (string, required): Proxy name
- `proxyKey` (string, required): Proxy key

**Return Result** (data):

```json
{
  "proxy": {
    "id": 1,
    "name": "My MCP Server",
    "proxyKey": "xxx",
    "startPort": 3002,
    "addtime": 1234567890
  }
}
```

**Function Description**:

- System only allows one proxy to exist
- If proxy already exists, returns `PROXY_ALREADY_EXISTS (5002)` error
- `startPort` automatically reads environment variable `BACKEND_PORT`

---

#### 5003 UPDATE_PROXY

**Permission**: Owner + Admin
**Function**: Update proxy information

**Request Parameters** (data):

- `proxyId` (string, required): Current Proxy key (for lookup)
- `name` (string, required): New Proxy name

**Return Result** (data):

```json
{
  "proxy": {
    "id": 1,
    "name": "Updated Name",
    ...
  }
}
```

---

#### 5004 DELETE_PROXY

**Permission**: **Owner only**
**Function**: Delete proxy (will clear all related data)

**Request Parameters** (data):

- `proxyId` (number, required): proxy Key

**Return Result** (data):

```json
{
  "message": "Proxy deleted successfully"
}
```

**Function Description**:

- Delete proxy record
- Clear all users, servers, IP whitelist, logs
- Disconnect all active sessions
- Stop all MCP servers

---

#### 5005 STOP_PROXY

**Permission**: **Owner only**
**Function**: Stop proxy application (completely shut down application process)

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "message": "Proxy shutdown initiated successfully"
}
```

**Function Description**:

- Triggers complete application shutdown process (equivalent to SIGTERM/SIGINT signal)
- Stop HTTP/HTTPS server from accepting new connections
- Stop event cleanup service
- Close log sync service (flush remaining logs)
- Clean up all client sessions
- Close all downstream MCP server connections
- Call `process.exit(0)` to exit application process

**Important Notes**:

- ⚠️ After executing this operation, the application will completely stop and requires manual service restart
- Response will be sent to client before application closes
- Recommend notifying all users and saving important data before execution

---

### Backup and Restore Operations (6000-6099)

#### 6001 BACKUP_DATABASE

**Permission**: Owner + Admin
**Function**: Full database backup

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "backup": {
    "version": "1.0",
    "timestamp": 1729431234,
    "tables": {
      "users": [ ... ],
      "servers": [ ... ],
      "proxies": [ ... ],
      "ipWhitelist": [ ... ]
    }
  },
  "stats": {
    "usersCount": 50,
    "serversCount": 10,
    "proxiesCount": 1,
    "ipWhitelistCount": 5
  }
}
```

**Function Description**:

- Export all user, server, proxy, IP whitelist data
- Returned backup data can be used for restore operations

---

#### 6002 RESTORE_DATABASE

**Permission**: Owner + Admin
**Function**: Full database restore

**Request Parameters** (data):

- `backup` (object, required): Backup data object (format returned by BACKUP_DATABASE)

**Return Result** (data):

```json
{
  "message": "Database restored successfully",
  "stats": {
    "usersRestored": 50,
    "serversRestored": 10,
    "proxiesRestored": 1,
    "ipWhitelistRestored": 5,
    "serversStarted": 8,
    "serversFailed": 2
  }
}
```

**Restore Process**:

1. Stop all MCP server connections
2. Disconnect all user sessions
3. In database transaction: delete all existing data → insert backup data
4. Reload IP whitelist to memory
5. Reinitialize enabled MCP servers

---

### Log Operations (7000-7099)

#### 7001 SET_LOG_WEBHOOK_URL

**Permission**: **Owner only**
**Function**: Set log sync webhook URL

**Request Parameters** (data):

- `proxyKey` (string, required): Proxy key
- `webhookUrl` (string or null, required): Webhook URL (`null` means disable sync)

**Return Result** (data):

```json
{
  "proxyId": 1,
  "proxyName": "My MCP Server",
  "webhookUrl": "https://example.com/webhook",
  "message": "Log webhook URL set successfully"
}
```

**Function Description**:

- After setting webhook URL, logs will automatically sync to specified URL
- Set to `null` to disable log sync
- URL must use http or https protocol

---

#### 7002 GET_LOGS

**Permission**: **Owner only**
**Function**: Get log records

**Request Parameters** (data):

- `id` (number, optional): Starting log ID (defaults to 0, starts from first record)
- `limit` (number, optional): Number of records to return (default 1000, max 5000)

**Return Result** (data):

```json
{
  "logs": [
    {
      "id": 1,
      "action": 1,
      "userid": "user123",
      "serverId": null,
      "createdAt": 1729431234,
      "sessionId": "",
      "upstreamRequestId": "",
      "uniformRequestId": null,
      ...
    }
  ],
  "count": 1,
  "startId": 1,
  "limit": 1000
}
```

**Function Description**:

- When `id` is 0, starts from first log
- `limit` exceeding 5000 will be automatically limited to 5000
- `createdAt` field is Unix timestamp (seconds, Int type)

---

### Cloudflared Operations (8000-8099)

#### 8001 UPDATE_CLOUDFLARED_CONFIG

**Permission**: Owner + Admin
**Function**: Update or create cloudflared configuration and immediately restart container to apply configuration

**Request Parameters** (data):

- `proxyKey` (string, required): Proxy key (for finding proxyId)
- `tunnelId` (string, required): Cloudflare Tunnel ID
- `subdomain` (string, required): Subdomain (e.g., `xxx.trycloudflare.com`)
- `credentials` (object or string, required): Tunnel credentials (object or JSON string, must contain `TunnelSecret` field)
- `publicIp` (string, optional): Public IP address (for record only), defaults to empty string

**Return Result** (data):

```json
{
  "dnsConf": {
    "id": 1,
    "tunnelId": "abc123",
    "subdomain": "my-app.trycloudflare.com",
    "type": 1,
    "proxyId": 1,
    "publicIp": "1.2.3.4",
    "createdBy": 1,
    "addtime": 1729431234,
    "updateTime": 1729431235
  },
  "restarted": true,
  "message": "Cloudflared config updated and restarted successfully",
  "publicUrl": "https://my-app.trycloudflare.com"
}
```

**Function Description**:

- If no configuration exists for this proxy in database, automatically creates new record
- If configuration already exists, updates existing record
- If old configuration was locally created (`createdBy = 0`), automatically calls Cloud API to delete old tunnel
- Externally created configurations (`createdBy = 1`) will not delete old tunnel
- Automatically writes credential files to `./cloudflared/{tunnelId}.json` and `./cloudflared/credentials.json`
- Calls `start-cloudflared-auto.cjs` script to restart cloudflared container
- If restart fails, still returns success (data saved), but `restarted: false` and includes error information

**credentials object example**:

```json
{
  "AccountTag": "xxx",
  "TunnelSecret": "xxx",
  "TunnelID": "abc123",
  "TunnelName": "my-tunnel"
}
```

---

#### 8002 GET_CLOUDFLARED_CONFIGS

**Permission**: Owner + Admin
**Function**: Query cloudflared configuration list (supports multi-condition filtering, AND relationship), and returns Docker container running status

**Request Parameters** (data, all parameters optional, AND relationship):

- `proxyKey` (string, optional): Filter by Proxy key
- `tunnelId` (string, optional): Filter by Tunnel ID
- `subdomain` (string, optional): Filter by subdomain
- `type` (number, optional): Filter by type (usually 1)

**Return Result** (data):

```json
{
  "dnsConfs": [
    {
      "id": 1,
      "tunnelId": "abc123",
      "subdomain": "my-app.trycloudflare.com",
      "type": 1,
      "proxyId": 1,
      "publicIp": "1.2.3.4",
      "createdBy": 1,
      "addtime": 1729431234,
      "updateTime": 1729431235,
      "status": "running"
    }
  ]
}
```

**Function Description**:

- All provided parameters must match simultaneously (AND relationship)
- Returns all configurations if no parameters provided
- Return result is an array, may be empty array
- Each record includes Docker container's real-time running status

**Field Description**:

- `type`: Configuration type (`1` = Cloudflare Tunnel)
- `createdBy`: Creation source (`0` = locally auto-created, `1` = externally API created)
- `proxyId`: Associated Proxy ID
- `addtime`: Creation time (Unix timestamp, seconds)
- `updateTime`: Last update time (Unix timestamp, seconds)
- `status`: Docker container status (`"running"` = running, `"stopped"` = stopped, `"not_exist"` = not exist)

---

#### 8003 DELETE_CLOUDFLARED_CONFIG

**Permission**: Owner + Admin
**Function**: Delete cloudflared configuration, stop and delete Docker container, clean up local files and database records

**Request Parameters** (data, at least one required):

- `id` (number, optional): DNS configuration record ID
- `tunnelId` (string, optional): Tunnel ID

**Return Result** (data):

```json
{
  "success": true,
  "message": "Cloudflared configuration deleted successfully",
  "deletedConfig": {
    "id": 1,
    "tunnelId": "abc123",
    "subdomain": "my-app.trycloudflare.com"
  }
}
```

**Function Description**:

- Stop Docker container (`docker stop peta-core-cloudflared`)
- Delete Docker container (`docker rm peta-core-cloudflared`)
- Delete local credential files:
  - `cloudflared/{tunnelId}.json`
  - `cloudflared/credentials.json`
  - `cloudflared/config.yml`
- Delete configuration record from database
- **Will not call Cloud API to delete remote tunnel** (remote tunnel remains in Cloudflare account)
- If container or files don't exist, doesn't affect deletion process (ignore errors and continue)

**Error Cases**:

- If corresponding configuration not found in database, returns `CLOUDFLARED_CONFIG_NOT_FOUND (8001)` error
- If container operation fails (and container actually exists), returns `TUNNEL_DELETE_FAILED (8004)` error

---

#### 8004 RESTART_CLOUDFLARED

**Permission**: Owner + Admin
**Function**: Restart cloudflared service, verify configuration completeness then restart Docker container

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "success": true,
  "message": "Cloudflared restarted successfully",
  "containerStatus": "running",
  "config": {
    "tunnelId": "abc123",
    "subdomain": "my-app.trycloudflare.com",
    "publicUrl": "https://my-app.trycloudflare.com"
  }
}
```

**Function Description**:

1. **Strictly verify local settings**:
   - Check if database has configuration record with `type=1`
   - Check if local credential file `cloudflared/{tunnelId}.json` exists
   - Verify credential file contains required `TunnelSecret` field
2. **Execute restart**:
   - Call `start-cloudflared-auto.cjs` script to restart container
   - Verify container started successfully (status is `running`)
3. **Return configuration information**:
   - Includes Tunnel ID, subdomain, and public access URL

**Error Cases**:

- If no configuration in database, returns `CLOUDFLARED_DATABASE_CONFIG_NOT_FOUND (8005)` error
- If local file missing or format error, returns `CLOUDFLARED_LOCAL_FILE_NOT_FOUND (8006)` error
- If restart script execution fails, returns `CLOUDFLARED_RESTART_FAILED (8003)` error
- If container status after startup is not `running`, returns `CLOUDFLARED_RESTART_FAILED (8003)` error

**Important Notes**:

- This operation will not automatically fix missing data or files
- If data is incomplete, please use `UPDATE_CLOUDFLARED_CONFIG (8001)` to reconfigure first

---

#### 8005 STOP_CLOUDFLARED

**Permission**: Owner + Admin
**Function**: Stop cloudflared service (stop Docker container, do not delete container and configuration)

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "success": true,
  "message": "Cloudflared stopped successfully",
  "containerStatus": "stopped",
  "alreadyStopped": false
}
```

**If container already stopped**:

```json
{
  "success": true,
  "message": "Cloudflared container is already stopped",
  "containerStatus": "stopped",
  "alreadyStopped": true
}
```

**Function Description**:

1. Check container current running status
2. If container is not running (`stopped` or `not_exist`), directly return success
3. If container is running, execute `docker stop peta-core-cloudflared`
4. Verify container has stopped
5. **Preserved**:
   - Docker container (stopped state)
   - Local configuration files
   - Database configuration records

**Error Cases**:

- If container stop command execution fails, returns `CLOUDFLARED_STOP_FAILED (8007)` error
- If container still running after executing stop command, returns `CLOUDFLARED_STOP_FAILED (8007)` error

**Important Notes**:

- After stopping, can use `RESTART_CLOUDFLARED (8004)` to quickly restore service
- For complete cleanup, use `DELETE_CLOUDFLARED_CONFIG (8003)`

---

---

### Result Cache Operations (11000-11099)

Result-cache APIs are admin-facing controls used to inspect cache status/policies and purge cache entries by scope.

#### 11001 CACHE_GET_HEALTH

**Permission**: Owner + Admin
**Function**: Get result-cache health and metric snapshot.

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "enabled": true,
  "health": {
    "ok": true,
    "backend": "db",
    "details": "healthy"
  },
  "metrics": {
    "lookup": 10,
    "hit": 7,
    "miss": 3,
    "purge": 1
  }
}
```

---

#### 11002 CACHE_GET_POLICY

**Permission**: Owner + Admin
**Function**: Get cache policy configuration.

**Request Parameters** (data):

- `serverId` (string, optional):
  - omitted → return global cache config only
  - provided → return global config + server-level policy projection

**Return Result** (data):

```json
{
  "serverId": "github",
  "globalConfig": {
    "enabled": true,
    "backend": "db",
    "defaultTtlSeconds": 30,
    "defaultAdmissionPolicy": "immediate",
    "defaultAdmissionWindowSeconds": 300,
    "maxEntryBytes": 262144
  },
  "tools": {
    "create_issue": { "enabled": true, "ttlSeconds": 30 }
  },
  "prompts": {
    "summarize": { "enabled": true, "ttlSeconds": 30 }
  },
  "resources": {
    "exact": {
      "repo://owner/repo": { "enabled": true, "ttlSeconds": 30 }
    },
    "inline": {
      "repo://owner/repo": { "enabled": true, "ttlSeconds": 30 }
    },
    "patterns": [
      {
        "pattern": "repo://owner/*",
        "enabled": true,
        "cache": { "enabled": true, "ttlSeconds": 30 }
      }
    ]
  }
}
```

**Resource policy layers**:

- `tools`, `prompts`, and `resources` are projected fields and may be omitted when Core cannot load/parse stored capabilities for `serverId`.
- `resources.exact`: normalized projection of `resourceCachePolicies.exact` (highest-priority exact match), returned as cache-policy objects (`{ ...cache, enabled }`) rather than raw `{ enabled?, cache? }` entries.
- `resources.inline`: from `capabilities.resources[uri].cache` (fallback per-resource cache)
- `resources.patterns`: from `resourceCachePolicies.patterns` (pattern-based fallback)

---

#### 11010 CACHE_PURGE_GLOBAL

**Permission**: Owner + Admin
**Function**: Purge all cache entries.

**Request Parameters** (data):

- `reason` (string, optional): optional audit context

**Return Result** (data):

```json
{
  "purged": true,
  "scope": "global"
}
```

---

#### 11011 CACHE_PURGE_SERVER

**Permission**: Owner + Admin
**Function**: Purge all cache entries for a server.

**Request Parameters** (data):

- `serverId` (string, required)
- `reason` (string, optional)

**Return Result** (data):

```json
{
  "purged": true,
  "scope": "server",
  "serverId": "github"
}
```

---

#### 11012 CACHE_PURGE_TOOL

**Permission**: Owner + Admin
**Function**: Purge cache for one tool on a server.

**Request Parameters** (data):

- `serverId` (string, required)
- `toolName` (string, required)
- `reason` (string, optional)

**Return Result** (data):

```json
{
  "purged": true,
  "scope": "tool",
  "serverId": "github",
  "toolName": "create_issue"
}
```

---

#### 11013 CACHE_PURGE_PROMPT

**Permission**: Owner + Admin
**Function**: Purge cache for one prompt on a server.

**Request Parameters** (data):

- `serverId` (string, required)
- `promptName` (string, required)
- `reason` (string, optional)

**Return Result** (data):

```json
{
  "purged": true,
  "scope": "prompt",
  "serverId": "github",
  "promptName": "summarize"
}
```

---

#### 11014 CACHE_PURGE_RESOURCE

**Permission**: Owner + Admin
**Function**: Purge cache for one resource URI on a server.

**Request Parameters** (data):

- `serverId` (string, required)
- `uri` (string, required)
- `reason` (string, optional)

**Return Result** (data):

```json
{
  "purged": true,
  "scope": "resource",
  "serverId": "github",
  "uri": "repo://owner/repo"
}
```

---

#### 11015 CACHE_PURGE_EXACT

**Permission**: Owner + Admin
**Function**: Purge a single exact cache key computed from operation/server/entity/scope/request params.

**Request Parameters** (data):

- `operation` (string, required): one of `tool`, `resource`, `prompt`
- `serverId` (string, required)
- `entityId` (string, required):
  - `tool` operation → tool name
  - `prompt` operation → prompt name
  - `resource` operation → resource URI
- `policy` (object, optional): resolved cache policy object.
  - if omitted, server resolves effective policy from stored `server.capabilities` in Core
  - explicit `policy` must follow `ResolvedCachePolicy` shape:
    - `enabled` (boolean)
    - `ttlSeconds` (number)
    - `scope` (`global` | `user` | `tenant`)
    - `admissionPolicy` (`immediate` | `second_hit`)
    - `admissionWindowSeconds` (number)
    - `denyFields` (string[])
    - `allowFields` (string[], optional)
    - `maxEntryBytes` (number)
  - this shape is different from `CACHE_GET_POLICY` entity configs (`CachePolicyConfig`, including nested `key.denyFields` / `key.allowFields`)
- `scopeContext` (object, optional): `{ userId?: string, tenantId?: string }`
- `requestParams` (unknown, optional): request payload used in cache-key canonicalization
- `reason` (string, optional)

**Scope validation rules**:

- if resolved scope is `user`, `scopeContext.userId` is required
- if resolved scope is `tenant`, `scopeContext.tenantId` is required
- if `policy` is omitted and server/policy cannot be resolved for the target entity, the request fails

**Return Result** (data):

```json
{
  "purged": true,
  "scope": "exact",
  "operation": "tool",
  "serverId": "github",
  "entityId": "create_issue"
}
```

---

### Policy Operations (9100-9199)

#### 9101 CREATE_POLICY_SET

**Permission**: Owner + Admin
**Function**: Create a new tool policy set. If `serverId` is omitted, the policy set is global (applies to all servers).

**Request Parameters** (data):

- `serverId` (string, optional): Server ID to scope this policy set. Omit for a global policy set.
- `dsl` (object, required): Policy DSL object defining the rules for this policy set.

**Return Result** (data):

```json
{
  "id": "clxxx...",
  "serverId": "server-abc",
  "version": 1,
  "status": "active",
  "dsl": { "schemaVersion": 1, "rules": [] },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

**DSL Schema Reference**:
The `dsl` object follows this structure:

- `schemaVersion` (number): Schema version, currently `1`
- `rules` (array): List of policy rules. Each rule contains:
  - `match` (object): Criteria to match a tool call (e.g., `toolName`, `serverId`)
  - `extract` (object, optional): Fields to extract from tool arguments for condition evaluation
  - `when` (object, optional): Conditions that must be true for the rule to apply
  - `effect` (string): Action to take — `"allow"`, `"deny"`, or `"require_approval"`

---

#### 9102 GET_POLICY_SETS

**Permission**: Owner + Admin
**Function**: List policy sets. If `serverId` is provided, returns only policy sets for that server. Otherwise returns all policy sets.

**Request Parameters** (data):

- `serverId` (string, optional): Filter by server ID.

**Return Result** (data):

```json
{
  "policySets": [
    {
      "id": "clxxx...",
      "serverId": "server-abc",
      "version": 1,
      "status": "active",
      "dsl": { "schemaVersion": 1, "rules": [] },
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

---

#### 9103 UPDATE_POLICY_SET

**Permission**: Owner + Admin
**Function**: Update an existing policy set's DSL or status. The `version` field increments when `dsl` is updated.

**Request Parameters** (data):

- `id` (string, required): Policy set ID.
- `dsl` (object, optional): New DSL object to replace the existing one.
- `status` (string, optional): New status — `"active"` or `"archived"`.

**Return Result** (data):

```json
{
  "id": "clxxx...",
  "serverId": "server-abc",
  "version": 2,
  "status": "active",
  "dsl": { "schemaVersion": 1, "rules": [] },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:01:00.000Z"
}
```

---

#### 9104 DELETE_POLICY_SET

**Permission**: Owner + Admin
**Function**: Permanently delete a policy set by ID. Returns the deleted record.

**Request Parameters** (data):

- `id` (string, required): Policy set ID to delete.

**Return Result** (data):

```json
{
  "id": "clxxx...",
  "serverId": "server-abc",
  "version": 2,
  "status": "archived",
  "dsl": { "schemaVersion": 1, "rules": [] },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:01:00.000Z"
}
```

---

#### 9105 GET_EFFECTIVE_POLICY

**Permission**: Owner + Admin
**Function**: Get the effective (active) policy sets for a given server. Returns active server-specific policy sets combined with active global policy sets (where `serverId` is null). If `serverId` is omitted, returns only global active policy sets.

**Request Parameters** (data):

- `serverId` (string, optional): Server ID to resolve effective policy for.

**Return Result** (data):

```json
{
  "policySets": [
    {
      "id": "clxxx...",
      "serverId": "server-abc",
      "version": 1,
      "status": "active",
      "dsl": { "schemaVersion": 1, "rules": [] },
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

**Function Description**:

- Only returns policy sets with `status = "active"`
- Combines server-specific policy sets (matching `serverId`) with global policy sets (`serverId` is null)
- Use this to determine which rules are currently enforced for a given server

---

### Approval Operations (9200-9299)

#### 9201 LIST_APPROVAL_REQUESTS

**Permission**: Owner + Admin
**Function**: List approval requests with optional filtering and pagination. All filter parameters are optional and combined with AND logic.

**Request Parameters** (data):

- `userId` (string, optional): Filter by user ID.
- `serverId` (string, optional): Filter by server ID.
- `toolName` (string, optional): Filter by tool name.
- `status` (string, optional): Filter by approval status.
- `page` (number, optional): 1-based page number. Defaults to `1`.
- `pageSize` (number, optional): Number of items per page. Defaults to `20`, max `100`.

**Return Result** (data):

```json
{
  "page": 1,
  "pageSize": 20,
  "hasMore": true,
  "requests": [
    {
      "id": "clxxx...",
      "userId": "user-abc",
      "serverId": "server-abc",
      "toolName": "send_email",
      "canonicalArgs": {},
      "redactedArgs": {},
      "requestHash": "sha256-hex",
      "resumeToken": "clxxx...",
      "status": "PENDING",
      "decidedAt": null,
      "decisionReason": null,
      "decidedByUserId": null,
      "decidedByRole": null,
      "decisionChannel": null,
      "executedAt": null,
      "executionError": null,
      "uniformRequestId": null,
      "expiresAt": "2026-01-01T01:00:00.000Z",
      "policyVersion": 1,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

---

#### 9202 GET_APPROVAL_REQUEST

**Permission**: Owner + Admin
**Function**: Get a single approval request by ID.

**Request Parameters** (data):

- `id` (string, required): Approval request ID.

**Return Result** (data):

```json
{
  "id": "clxxx...",
  "userId": "user-abc",
  "serverId": "server-abc",
  "toolName": "send_email",
  "canonicalArgs": {},
  "redactedArgs": {},
  "requestHash": "sha256-hex",
  "resumeToken": "clxxx...",
  "status": "PENDING",
  "decidedAt": null,
  "decisionReason": null,
  "decidedByUserId": null,
  "decidedByRole": null,
  "decisionChannel": null,
  "executedAt": null,
  "executionError": null,
  "uniformRequestId": null,
  "expiresAt": "2026-01-01T01:00:00.000Z",
  "policyVersion": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

**Field Description**:

- `status`: Current state — `"PENDING"`, `"APPROVED"`, `"REJECTED"`, `"EXPIRED"`, `"EXECUTING"`, `"EXECUTED"`, or `"FAILED"`
- `resumeToken`: Stable resume handle (currently same value as `id`) for client retries and correlation
- `decidedAt`: Timestamp when the decision was made, or `null`
- `decisionReason`: Optional reason provided when decided, or `null`
- `decidedByUserId`: User ID of the actor who approved/rejected the request, or `null`
- `decidedByRole`: Numeric `UserRole` snapshot of the deciding actor, or `null`
- `decisionChannel`: Decision source, currently `"admin_api"` or `"socket"`
- `canonicalArgs`: Normalized tool arguments used for hashing/comparison
- `redactedArgs`: Redacted arguments safe for logging/display
- `requestHash`: Deterministic hash used for deduplication
- `expiresAt`: Timestamp after which the request automatically expires
- `policyVersion`: The policy set version that triggered this approval request
- `executedAt` / `executionError`: Execution result metadata after approval
- `uniformRequestId`: Optional correlation ID for upstream request mapping

---

#### 9203 DECIDE_APPROVAL_REQUEST

**Permission**: Owner + Admin
**Function**: Approve or reject a pending approval request. The deciding admin's identity is recorded.

**Request Parameters** (data):

- `id` (string, required): Approval request ID.
- `decision` (string, required): Decision to apply — `"APPROVED"` or `"REJECTED"`.
- `reason` (string, optional): Human-readable reason for the decision.

**Return Result** (data):

```json
{
  "id": "clxxx...",
  "userId": "user-abc",
  "serverId": "server-abc",
  "toolName": "send_email",
  "canonicalArgs": {},
  "redactedArgs": {},
  "requestHash": "sha256-hex",
  "resumeToken": "clxxx...",
  "status": "APPROVED",
  "decidedAt": "2026-01-01T00:05:00.000Z",
  "decisionReason": "Reviewed and approved",
  "decidedByUserId": "owner-abc",
  "decidedByRole": 1,
  "decisionChannel": "admin_api",
  "executedAt": null,
  "executionError": null,
  "uniformRequestId": null,
  "expiresAt": "2026-01-01T01:00:00.000Z",
  "policyVersion": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:05:00.000Z"
}
```

**Error Cases**:

- If the request is not in `PENDING` status, the decision cannot be applied

---

#### 9204 COUNT_PENDING_APPROVALS

**Permission**: Owner + Admin
**Function**: Count the number of pending approval requests, optionally scoped to a specific user.

**Request Parameters** (data):

- `userId` (string, optional): User ID to scope the count to. If omitted, counts pending requests across all users.

**Return Result** (data):

```json
{
  "count": 5
}
```

---

### Discovery / Progressive Disclosure Operations (9300-9399)

#### 9301 GET_DISCOVERY_CONFIG

**Permission**: Owner + Admin
**Function**: Get global discovery enablement and default profile

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "enabled": true,
  "defaultProfileId": "clxxx...",
  "mode": "HYBRID"
}
```

**Function Description**:

- Returns the current global discovery configuration
- `enabled` indicates whether progressive disclosure is active
- `defaultProfileId` is the ID of the default profile (or `null` if none)
- `mode` is the mode of the default profile (falls back to `FLAT` if no profile exists)

---

#### 9302 SET_DISCOVERY_CONFIG

**Permission**: Owner + Admin
**Function**: Update global discovery enablement and default profile

**Request Parameters** (data):

- `enabled` (boolean, required): Whether progressive disclosure is enabled
- `defaultProfileId` (string or null, optional): ID of the default discovery profile

**Return Result** (data):

```json
{
  "enabled": true,
  "defaultProfileId": "clxxx..."
}
```

**Function Description**:

- Updates the global discovery configuration
- The response contains `enabled` and `defaultProfileId` only (does not include `mode`)
- If `defaultProfileId` is provided and non-null, the referenced profile is set as default
- If `defaultProfileId` is omitted or `null`, the existing default profile is not cleared
- The `enabled` flag is persisted on the active default profile record

---

#### 9310 CREATE_DISCOVERY_PROFILE

**Permission**: Owner + Admin
**Function**: Create a discovery profile

**Request Parameters** (data):

- `name` (string, required): Profile name (must be non-empty)
- `description` (string, optional): Profile description
- `mode` (string, required): Discovery mode — `FLAT`, `HYBRID`, or `STRICT`
- `enabled` (boolean, optional): Whether profile is active
- `isDefault` (boolean, optional): Whether this is the default profile
- `config` (object, optional): Profile configuration (DiscoveryProfileConfig)
- `instructionText` (string, optional): Instruction text for AI clients

**Return Result** (data):

```json
{
  "id": "clxxx...",
  "name": "Production Profile",
  "description": "Hybrid mode for production",
  "mode": "HYBRID",
  "enabled": true,
  "isDefault": true,
  "config": {
    "directExposureRules": []
  },
  "instructionText": null,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

**Function Description**:

- Creates a new discovery profile
- If `isDefault` is true, all other profiles are set to non-default
- Invalidates the discovery config cache after creation

---

#### 9311 GET_DISCOVERY_PROFILES

**Permission**: Owner + Admin
**Function**: List all discovery profiles

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "profiles": [
    {
      "id": "clxxx...",
      "name": "Production Profile",
      "description": "Hybrid mode for production",
      "mode": "HYBRID",
      "enabled": true,
      "isDefault": true,
      "config": {},
      "instructionText": null,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

**Function Description**:

- Returns all discovery profiles ordered by creation time ascending

---

#### 9312 GET_DISCOVERY_PROFILE

**Permission**: Owner + Admin
**Function**: Get one discovery profile by ID

**Request Parameters** (data):

- `id` (string, required): Discovery profile ID

**Return Result** (data):

Profile object (same shape as items in GET_DISCOVERY_PROFILES response).

**Function Description**:

- Returns a single discovery profile
- Returns error if profile not found

---

#### 9313 UPDATE_DISCOVERY_PROFILE

**Permission**: Owner + Admin
**Function**: Update a discovery profile

**Request Parameters** (data):

- `id` (string, required): Discovery profile ID
- `name` (string, optional): Profile name (cannot be blank)
- `description` (string, optional): Profile description
- `mode` (string, optional): Discovery mode — `FLAT`, `HYBRID`, or `STRICT`
- `enabled` (boolean, optional): Whether profile is active
- `isDefault` (boolean, optional): Whether this is the default profile
- `config` (object, optional): Profile configuration (DiscoveryProfileConfig)
- `instructionText` (string, optional): Instruction text for AI clients

**Return Result** (data):

The updated profile object.

**Function Description**:

- Updates an existing discovery profile
- If `isDefault` is set to true, all other profiles are set to non-default
- Invalidates the discovery config cache after update
- Returns error if profile not found

---

#### 9314 DELETE_DISCOVERY_PROFILE

**Permission**: Owner + Admin
**Function**: Delete a discovery profile

**Request Parameters** (data):

- `id` (string, required): Discovery profile ID

**Return Result** (data):

The deleted profile object.

**Function Description**:

- Permanently deletes a discovery profile
- Returns error if profile not found
- Invalidates the discovery config cache after deletion

---

#### 9320 PREVIEW_DISCOVERY

**Permission**: Owner + Admin
**Function**: Preview which tools are directly exposed vs catalog-only for a given profile

**Request Parameters** (data):

- `profileId` (string, optional): Discovery profile ID. If omitted, uses the default profile. If no profile exists, uses FLAT mode.

**Return Result** (data):

```json
{
  "mode": "HYBRID",
  "directTools": [
    {
      "name": "github::create_issue",
      "serverId": "github"
    }
  ],
  "hiddenTools": [
    {
      "actionId": "act_xxx",
      "displayName": "send_email",
      "serverId": "email"
    }
  ],
  "catalogToolsIncluded": [
    "peta.catalog.search",
    "peta.catalog.describe",
    "peta.catalog.execute"
  ],
  "totalDirectCount": 5,
  "totalHiddenCount": 10
}
```

**Function Description**:

- Reads from the catalog index (not live runtime) to preview how tools would be partitioned
- In `FLAT` mode, all tools are direct and `catalogToolsIncluded` is empty
- In `STRICT` mode, all tools are hidden
- In `HYBRID` mode, `directExposureRules` from the profile config determine the split
- Use `REINDEX_CATALOG (9330)` first to ensure the catalog index is current

---

#### 9330 REINDEX_CATALOG

**Permission**: Owner + Admin
**Function**: Rebuild the persistent catalog index from live managed servers

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

Index build statistics (varies by implementation).

**Function Description**:

- Triggers a full reindex of the discovery catalog
- Scans all live managed server contexts and rebuilds the `CatalogAction` rows
- Temporary or user-scoped server contexts are excluded from the global catalog index

---

#### 9331 GET_CATALOG_STATS

**Permission**: Owner + Admin
**Function**: Get catalog row count, server count, and last-indexed timestamp

**Request Parameters** (data):

```json
{}
```

**Return Result** (data):

```json
{
  "totalActions": 42,
  "serversIndexed": 5,
  "lastIndexedAt": "2026-01-01T00:00:00.000Z"
}
```

**Function Description**:

- Returns aggregate statistics about the discovery catalog index
- `lastIndexedAt` is `null` if no index build has occurred yet

## Appendix: Error Code Reference

### General Errors (1000-1999)

| Error Code | Name            | Trigger Condition                                                               |
| ---------- | --------------- | ------------------------------------------------------------------------------- |
| 1001       | INVALID_REQUEST | Request format error, missing required fields, parameter type error             |
| 1002       | UNAUTHORIZED    | No valid authentication Token provided                                          |
| 1003       | FORBIDDEN       | Insufficient permissions (e.g., non-Owner role attempting Owner-only operation) |

### User Related Errors (2000-2999)

| Error Code | Name                  | Trigger Condition                         |
| ---------- | --------------------- | ----------------------------------------- |
| 2001       | USER_NOT_FOUND        | Specified user ID does not exist          |
| 2002       | USER_ALREADY_DISABLED | User is already disabled                  |
| 2003       | USER_ALREADY_EXISTS   | When creating user, userId already exists |

### Server Related Errors (3000-3999)

| Error Code | Name                   | Trigger Condition                             |
| ---------- | ---------------------- | --------------------------------------------- |
| 3001       | SERVER_NOT_FOUND       | Specified server ID does not exist            |
| 3002       | SERVER_ALREADY_RUNNING | Server is already in running state            |
| 3003       | SERVER_ALREADY_EXISTS  | When creating server, serverId already exists |

### Permission Related Errors (4000-4999)

| Error Code | Name                      | Trigger Condition                                  |
| ---------- | ------------------------- | -------------------------------------------------- |
| 4001       | INSUFFICIENT_PERMISSIONS  | User permissions insufficient to execute operation |
| 4002       | INVALID_PERMISSION_FORMAT | Permission configuration format invalid            |

### Proxy Related Errors (5000-5099)

| Error Code | Name                 | Trigger Condition                           |
| ---------- | -------------------- | ------------------------------------------- |
| 5001       | PROXY_NOT_FOUND      | Specified proxy does not exist              |
| 5002       | PROXY_ALREADY_EXISTS | System already has proxy (only one allowed) |

### IP Whitelist Related Errors (5100-5199)

| Error Code | Name                  | Trigger Condition                            |
| ---------- | --------------------- | -------------------------------------------- |
| 5101       | IPWHITELIST_NOT_FOUND | Specified IP whitelist record does not exist |
| 5102       | INVALID_IP_FORMAT     | IP address or CIDR format invalid            |

### Database Operation Errors (5200-5299)

| Error Code | Name                      | Trigger Condition           |
| ---------- | ------------------------- | --------------------------- |
| 5201       | DATABASE_OPERATION_FAILED | Database operation failed   |
| 5202       | TRANSACTION_FAILED        | Database transaction failed |

### Backup and Restore Errors (5300-5399)

| Error Code | Name                | Trigger Condition          |
| ---------- | ------------------- | -------------------------- |
| 5301       | BACKUP_FAILED       | Database backup failed     |
| 5302       | RESTORE_FAILED      | Database restore failed    |
| 5303       | INVALID_BACKUP_DATA | Backup data format invalid |

### Cloudflared Related Errors (8000-8099)

| Error Code | Name                                  | Trigger Condition                                                             |
| ---------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| 8001       | CLOUDFLARED_CONFIG_NOT_FOUND          | Specified cloudflared configuration not found in database                     |
| 8002       | INVALID_CREDENTIALS_FORMAT            | Tunnel credentials format invalid or missing TunnelSecret field               |
| 8003       | CLOUDFLARED_RESTART_FAILED            | Cloudflared restart failed (script execution failed or container not started) |
| 8004       | TUNNEL_DELETE_FAILED                  | Failed to delete tunnel or container                                          |
| 8005       | CLOUDFLARED_DATABASE_CONFIG_NOT_FOUND | Cloudflared configuration does not exist in database (during restart)         |
| 8006       | CLOUDFLARED_LOCAL_FILE_NOT_FOUND      | Local credential file does not exist or format error                          |
| 8007       | CLOUDFLARED_STOP_FAILED               | Failed to stop cloudflared container                                          |

---

## Version Information

- **Protocol Version**: 2.3
- **Last Updated**: April 3, 2026
- **Update Content**:
  - Added Discovery / Progressive Disclosure operations (9300-9399): GET/SET_DISCOVERY_CONFIG, CRUD for discovery profiles, PREVIEW_DISCOVERY, REINDEX_CATALOG, GET_CATALOG_STATS
  - Added DiscoveryMode enum and DiscoveryProfileConfig data structure to reference sections

**Version History**:

- **2.2** (March 13, 2026):
  - Added ServerCategory `Skills (4)` and `CustomStdio (5)` to enum reference
  - Fixed ServerAuthType enum: `CanvasAuth` is `8`, added `CanvaAuth (9)`
  - Added CustomStdio (category=5) input example for CREATE_SERVER (2010)
  - Added ConfigTemplate notes for Skills and CustomStdio categories
  - Added `anonymousAccess` and `anonymousRateLimit` parameters to CREATE_SERVER (2010) and UPDATE_SERVER (2012)
  - Updated UPDATE_SERVER (2012): `configTemplate` is now also updatable for CustomStdio servers
  - Added custom-stdio launchConfig format to Decrypted launchConfig Structure

- **2.1** (November 7, 2025):
  - Added Cloudflared operation APIs:
    - 8003 DELETE_CLOUDFLARED_CONFIG - Delete cloudflared configuration
    - 8004 RESTART_CLOUDFLARED - Restart cloudflared service
    - 8005 STOP_CLOUDFLARED - Stop cloudflared service
  - Enhanced 8002 GET_CLOUDFLARED_CONFIGS - Added status field to return result (container running status)
  - Added Cloudflared related error codes (8005-8007)
  - Improved error handling and status management descriptions for Cloudflared operations
- **2.0** (October 20, 2025):
  - Complete document rewrite, sorted by AdminActionType numbers (1001-7002)
  - Added detailed request parameters and return result descriptions for each API
  - Marked all Owner-only operations
  - Unified error code reference table
  - Added curl and TypeScript calling examples
