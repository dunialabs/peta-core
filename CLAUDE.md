# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Peta Core is a standalone backend service that implements a transparent proxy for the Model Context Protocol (MCP). It acts as an intelligent intermediary between MCP clients (like Claude Desktop) and downstream MCP servers, providing authentication, rate limiting, session management, event persistence, and OAuth 2.0 support.

## Core Architecture

### Socket.IO Real-time Communication

Peta Core includes a Socket.IO server for bidirectional real-time communication between the server and Electron clients. This is **independent** from the MCP SSE (Server-Sent Events) mechanism.

**Key Features:**
- Token-based authentication (reuses existing `TokenValidator`)
- Multi-device support via Room mechanism
- Server-initiated push notifications
- Auto-reconnection support
- Completely isolated from MCP protocol

**Architecture:**
- Socket.IO server attached to the same HTTP/HTTPS server (port 3002)
- `SocketService` - Core Socket.IO server management (src/socket/SocketService.ts)
- `SocketNotifier` - Utility functions for sending notifications (src/socket/SocketNotifier.ts)
- Client example available in `examples/electron-client/`
- **Transport-agnostic design**: Business logic (UserRequestHandler) is shared between Socket.IO and HTTP API layers

**Usage:**
```typescript
import { socketNotifier } from './socket/SocketNotifier.js';

// Notify specific user (all devices)
socketNotifier.notifyUser('userId', 'notification', {
  type: 'user_disabled',
  message: 'Your account has been disabled',
  timestamp: Date.now()
});

// Broadcast to all online users
socketNotifier.notifyAll('notification', { ... });

// Check user status
const isOnline = socketNotifier.isUserOnline('userId');
```

See `docs/SOCKET_USAGE.md` for complete documentation.

### User API Endpoints

The gateway provides a unified `/user` endpoint for user-facing operations. This endpoint uses the same action-based routing pattern as `/admin` endpoints.

**Key Features:**
- Single endpoint: `POST /user`
- Action-based routing (UserActionType enum)
- Shares business logic with Socket.IO layer (transport-agnostic architecture)
- No role checking (any valid user can access)

**Operations:**
- GET_CAPABILITIES (1001) - Get capability configuration
- SET_CAPABILITIES (1002) - Update capability preferences
- CONFIGURE_SERVER (2001) - Configure user-specific servers (with personal credentials)
- UNCONFIGURE_SERVER (2002) - Remove server configuration
- GET_ONLINE_SESSIONS (3001) - Query active sessions

**Architecture:**
- Layer 1 (UserRequestHandler): Business logic (transport-agnostic)
- Layer 2a (Socket.IO): Real-time communication layer
- Layer 2b (HTTP API): RESTful API layer (`POST /user`)

Both Socket and HTTP protocols execute identical business logic in UserRequestHandler.

See `docs/api/USER_API.md` for complete API documentation.

### Multi-Role Proxy Pattern

The gateway implements a sophisticated proxy architecture where each client session creates a **ProxySession** that simultaneously acts as:
- **MCP Server** (upstream) - Exposes MCP protocol to clients
- **MCP Client** (downstream) - Connects to multiple MCP servers

Key architectural files:
- `src/mcp/core/ProxySession.ts` - Core proxy session implementation
- `src/mcp/core/ServerManager.ts` - Global singleton managing downstream server connections
- `src/mcp/core/SessionStore.ts` - Client session lifecycle management
- `src/mcp/core/GlobalRequestRouter.ts` - Broadcasts downstream list/resource update notifications to eligible client sessions

### Request ID Mapping System

**Critical concept**: The proxy must handle requestId conflicts when multiple clients use the same IDs. The system maintains three-level mapping:

1. **Client → Proxy**: Maps original client requestId to unique proxy requestId (format: `{sessionId}:{originalId}:{timestamp}`)
2. **Proxy → Server**: Proxy requestId sent to downstream servers
3. **Server → Client notifications**: Proxy requestId is reused for cancellation/progress correlation on supported notification paths

Implementation:
- `src/mcp/core/RequestIdMapper.ts` - Per-session ID mapping
- `src/mcp/core/GlobalRequestRouter.ts` - Notification fan-out and deduplication for list/resource update broadcasts

### Event Store for Reconnection

Implements persistent event storage to support client reconnection with Last-Event-ID headers:
- `src/mcp/core/PersistentEventStore.ts` - Main event storage with dual cache/database
- `src/mcp/core/EventCacheManager.ts` - LRU memory cache
- `src/mcp/core/EventCleanupService.ts` - Automatic cleanup of expired events
- See `EVENTSTORE_README.md` for architecture details

### Resource Naming & Routing

Resources, tools, and prompts are namespaced by server ID to prevent conflicts:
- Format: `{serverId}::{resourceName}`
- `ClientSession.parseName()` handles parsing and routing
- Permissions are checked per-server basis before forwarding

### OAuth 2.0 Implementation

Full OAuth 2.0 authorization server supporting:
- Authorization Code Grant with PKCE
- Refresh Token grant
- Token introspection and revocation
- RFC 8707 Resource Indicators
- Dynamic client registration

Key files:
- `src/oauth/OAuthRouter.ts` - Route registration
- `src/oauth/services/OAuthService.ts` - Core OAuth logic
- `src/oauth/controllers/*.ts` - Endpoint handlers
- Database models in `prisma/schema.prisma` - OAuthClient, OAuthToken, OAuthAuthorizationCode

## Database Architecture

Uses **PostgreSQL** with Prisma ORM (migrated from dual SQLite+PostgreSQL setup):

Key models:
- `User` - Authentication and permissions
- `Server` - Downstream MCP server configurations (encrypted launch configs)
- `Log` - Request/response audit trail
- `Event` - MCP event storage for reconnection
- `OAuthClient`, `OAuthToken`, `OAuthAuthorizationCode` - OAuth 2.0

See `DATABASE_MIGRATION_SUMMARY.md` for migration history.

## Logging System

The project uses **Pino** for structured, high-performance logging. Pino replaces all `console.log/error/warn` calls with a unified logging system that supports:

- **Structured JSON logging** for production (machine-readable)
- **Pretty-printed output** for development (human-readable)
- **Configurable log levels** via environment variables
- **Child loggers** with contextual information per module

### Logger Setup

Logger configuration is centralized in `src/logger/`:
- `src/logger/LoggerConfig.ts` - Pino configuration based on NODE_ENV and env vars
- `src/logger/index.ts` - Root logger and `createLogger()` factory function

### Usage

**Creating a logger in a new file:**
```typescript
import { createLogger } from '../logger/index.js';  // Adjust path as needed

const logger = createLogger('ModuleName');

// Log levels (trace < debug < info < warn < error < fatal)
logger.trace('Very detailed debugging info');
logger.debug({ userId, sessionId }, 'Session created');
logger.info('Server started successfully');
logger.warn({ reason }, 'Deprecated API usage detected');
logger.error({ error }, 'Failed to connect to database');
logger.fatal({ error }, 'Unrecoverable error');
```

**Creating contextual child loggers:**
```typescript
const logger = createLogger('ProxySession', {
  sessionId: 'abc123',
  userId: 'user456'
});

// All logs from this logger will include sessionId and userId
logger.info('Processing request');
// → {"level":"info","name":"ProxySession","sessionId":"abc123","userId":"user456","msg":"Processing request"}
```

### Environment Variables

Configure logging behavior via `.env`:
```bash
# Log level (default: development=trace, production=info)
LOG_LEVEL=info  # trace|debug|info|warn|error|fatal

# Pretty printing (default: development=true, production=false)
LOG_PRETTY=true
```

### Best Practices

1. **Use appropriate log levels:**
   - `trace` - Extremely verbose, function entry/exit
   - `debug` - Debugging information (e.g., request/response details)
   - `info` - Normal operations (e.g., "Server started", "Request processed")
   - `warn` - Warning conditions (e.g., deprecated usage, fallbacks)
   - `error` - Error conditions (e.g., failed operations that are handled)
   - `fatal` - Fatal errors causing application exit

2. **Include context objects:**
   ```typescript
   // Good: Structured logging with context
   logger.error({ error, userId, requestId }, 'Failed to process request');

   // Avoid: Plain string logging without context
   logger.error('Failed to process request for user ' + userId);
   ```

3. **Create module-specific loggers:**
   Each class/service should have its own logger with a descriptive name:
   ```typescript
   const logger = createLogger('ServerManager');
   const logger = createLogger('ProxySession');
   const logger = createLogger('OAuth');
   ```

### Migration from console.*

When migrating from `console.*` to Pino:
- `console.log()` → `logger.info()`
- `console.error()` → `logger.error()`
- `console.warn()` → `logger.warn()`
- Development-only debug logs → `logger.debug()` or `logger.trace()`

A migration script is available: `scripts/migrate-to-pino-v2.cjs`

### Relationship with LogService

Note the distinction between two logging systems:
- **Pino (operational logs)**: Real-time application logs for monitoring and debugging
- **LogService (audit logs)**: Business event logs persisted to database (`log` table) for audit trail

Both systems coexist and serve different purposes.

## Development Commands

### Database Management
```bash
# Start PostgreSQL container
npm run db:start

# Initialize database (run migrations + generate Prisma client)
npm run db:init

# View/edit data
npm run db:studio

# Create new migration
npm run db:migrate:create

# Reset database (WARNING: data loss)
npm run db:reset
```

### Development
```bash
# Start dev server (auto-starts DB, builds, assigns port 3002+)
npm run dev

# Start backend only (assumes DB running)
npm run dev:backend-only

# Build TypeScript
npm run build

# Clean and rebuild
npm run rebuild
```

### Testing
```bash
# Run all tests
npm test

# Run specific test file
npm test -- --testPathPattern=PersistentEventStore.test.ts
```

### Production
```bash
# Start production server (initializes DB + starts app)
npm start
```

### Docker
```bash
# Publish the package.json semver to Docker Hub after enabling server-side
# immutable semantic-version tags
PETA_RELEASE_PUSH=1 DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled \\
PETA_RELEASE_GIT_SHA="$(git rev-parse HEAD)" \\
./docker-build-push.sh --non-interactive

# With verbose output
./docker-build-push.sh -v

# Show help
./docker-build-push.sh -h
```

**Docker Hub Images:**
- Repository: https://hub.docker.com/r/petaio/peta-core
- Tags: only the immutable current `package.json` semver; `latest`, date, and custom aliases are rejected
- Publication requires `timeout`, `gtimeout`, or Perl alarm support and fails closed after a 15-minute Buildx timeout

### Release Automation
```bash
# Prepare a patch release from origin/main
node scripts/release-main.js prepare

# Prepare a specific version
node scripts/release-main.js prepare --version 1.2.3

# Clean up a prepared release workspace
node scripts/release-main.js cleanup --manifest /tmp/.../manifest.json
```

`scripts/release-main.js` always prepares releases from `origin/main` in a detached temporary worktree so it does not disturb the current branch. It writes:
- `manifest.json` - release metadata and paths needed for publish/cleanup
- `release-context.md` - structured commit/PR context for English release notes
- `release-notes.md` - target file for the final GitHub release notes

The `publish` subcommand is deliberately disabled. It never pushes source,
Docker images, Git tags, or GitHub Releases. Use the reviewed Git flow and
immutable semver Docker publication command separately; public tags and GitHub
Releases require an independently approved operator process.

**Quick Docker Operations:**
```bash
# Pull the current immutable release
docker pull petaio/peta-core:1.3.0

# Run container
docker run -d -p 3002:3002 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  petaio/peta-core:1.3.0

# Check health
curl http://localhost:3002/health

# View logs
docker logs <container-id>

# Stop container
docker stop <container-id>
```

**Production Deployment:**
```bash
# Quick deployment using docker-deploy.sh
curl -O https://raw.githubusercontent.com/dunialabs/peta-core/main/docs/docker-deploy.sh
chmod +x docker-deploy.sh
./docker-deploy.sh

# The script will:
# 1. Validate Docker environment
# 2. Generate random secrets (JWT_SECRET, DB password)
# 3. Create docker-compose.yml and .env
# 4. Start all services (PostgreSQL, Peta Core, optional Cloudflared)
# 5. Print connection info and next steps
```

### PM2 (Production)
```bash
# Install dependencies and build
npm install
npm run build

# Start with PM2
pm2 start ecosystem.config.js

# Monitor
pm2 status
pm2 logs peta-core

# Restart
pm2 restart peta-core
```

**Example ecosystem.config.js:**
```js
module.exports = {
  apps: [
    {
      name: 'peta-core',
      script: './dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        BACKEND_PORT: 3002,
      },
      max_memory_restart: '500M',
      autorestart: true,
      watch: false,
    },
  ],
};
```

## Key Environment Variables

Required in `.env`:
```bash
DATABASE_URL=postgresql://peta:peta123@localhost:5432/peta_mcp_gateway?schema=public
BACKEND_PORT=3002
```

Optional:
- `ENABLE_HTTPS=true` - Enable HTTPS server
- `SSL_CERT_PATH`, `SSL_KEY_PATH` - Custom certificate paths
- `SKIP_CLOUDFLARED=true` - Skip Cloudflared setup in dev
- `LAZY_START_ENABLED` - Enable lazy loading for MCP servers (default: true)
- `LOG_LEVEL` - Log level (trace, debug, info, warn, error, fatal)
- `LOG_PRETTY` - Pretty-print logs in development

## Health Check

The gateway exposes a health check endpoint for monitoring:

```bash
# Check if service is running
curl http://localhost:3002/health

# Returns: 200 OK with health status
```

Use this endpoint for:
- Docker health checks
- Load balancer health probes
- Monitoring systems (Prometheus, Datadog, etc.)
- Deployment verification

## Application Lifecycle

### Startup Sequence

The application follows a strict initialization order in `src/index.ts`:

1. **Database Connection** - `prisma.$connect()`
2. **Auth Module Initialization** (`initializeAuthModule()`):
   - LogService singleton
   - TokenValidator
   - SessionStore
   - RateLimitService
   - IpWhitelistService
   - AuthMiddleware, AdminAuthMiddleware
   - ServerManager.instance (with all dependencies)
   - CapabilitiesService
   - ConfigController
   - EventCleanupService
   - LogSyncService
3. **Express App Setup** - Middleware registration
4. **Route Registration** - OAuth, MCP, Admin routes
5. **HTTP/HTTPS Server Startup** - Port binding
6. **Socket.IO Initialization** - Real-time communication layer
7. **Graceful Shutdown Handlers** - SIGTERM, SIGINT

**Critical**: The order matters - dependencies must be initialized before dependent services.

### Shutdown Sequence

Graceful shutdown follows this order (timeout: 10 seconds):

1. **Disconnect Socket.IO clients** (parallel with step 2)
2. **Close HTTP/HTTPS servers**
3. **Stop EventCleanupService** - Halt background cleanup
4. **Flush LogSyncService** - Sync remaining logs to database
5. **Remove all sessions** - `SessionStore.removeAllSessions()` triggers `ProxySession` cleanup
6. **Shutdown ServerManager** - Close all downstream MCP server connections
7. **Disconnect Prisma** - Close database connection
8. **Force exit** - If cleanup exceeds 10 seconds

**Critical**: Sessions must be removed before ServerManager shutdown to prevent connection leaks.

### Middleware Chain

MCP endpoint requests flow through middleware in this order:

1. **Special Handling** - HEAD/OPTIONS requests (before middleware)
2. **Body Parser** - `express.json()`
3. **CORS Middleware** - Cross-origin headers
4. **IP Whitelist Check** - `IpWhitelistMiddleware.checkIpWhitelist`
5. **Authentication** - `AuthMiddleware.authenticate` (extracts userId, creates AuthContext)
6. **Rate Limiting** - `RateLimitMiddleware.checkRateLimit` (requires userId from step 5)
7. **Route Handler** - `MCPController`

**Critical**: Auth must precede rate limiting since rate limits are per-user.

## Important Implementation Patterns

### 1. Reverse Request Handling

Standard MCP reverse requests (`sampling`, `elicitation`, `roots/list`) are intentionally unsupported
under Peta's shared downstream connection model, including the current per-user temporary server mode.

Supported server-to-client correlation is limited to notifications tied to an existing proxied request:
1. Client request is assigned a proxy requestId by `RequestIdMapper`
2. Proxy requestId is sent downstream as `relatedRequestId`
3. Downstream may emit cancellation/progress notifications referencing that proxy requestId
4. `ProxySession` maps the proxy requestId back to the original upstream requestId
5. Notification is forwarded to the correct upstream session

Critical: Always preserve `relatedRequestId` through the entire chain.

### 2. Server Configuration Encryption

Launch configs are encrypted using per-user tokens:
- User token serves as encryption key
- `CryptoService.encryptDataToString()` / `decryptDataFromString()`
- Decryption happens at `ServerManager.createServerConnection()`

### 3. Authentication Flow

Complete token-to-session flow:

1. **Token Extraction** - `AuthMiddleware` extracts token from:
   - `Authorization: Bearer <token>` header, OR
   - `?token=<token>` query parameter
2. **Token Validation** - `TokenValidator.validateToken()`:
   - Verifies token signature
   - Checks expiration
   - Extracts userId
3. **User Lookup** - `UserRepository.findById()`:
   - Fetches user from database
   - Loads `permissions` JSON field
   - Merges with `user_preferences`
4. **Session Creation** - `SessionStore.getOrCreateSession()`:
   - Creates `ClientSession` with `AuthContext`
   - Stores IP address and User-Agent from request
   - Associates with userId for multi-device tracking
5. **ProxySession Creation** - On first MCP initialize request:
   - `SessionStore.getOrCreateProxySession()`
   - Initializes `ProxySession` with downstream server connections

**Permission Structure**: User permissions stored as JSON in database:
```typescript
{
  "servers": ["server1", "server2"],  // Allowed server IDs
  "admin": true,                       // Admin privileges
  "rate_limit": 100                    // Custom rate limit
}
```

### 4. Session Lifecycle

Client sessions flow:
1. HTTP GET/POST to `/mcp` with Authorization header
2. `AuthMiddleware` validates token → creates/retrieves `ClientSession`
3. `SessionStore` creates `ProxySession` on first MCP initialize request
4. `ProxySession` handles all MCP protocol operations
5. DELETE to `/mcp` or timeout triggers cleanup

**Session Cleanup**:
- `SessionStore.startCleanupTimer()` runs every 5 minutes
- Checks `lastActive` timestamp against timeout
- Calls `removeSingleSession()` for expired sessions
- Removes from maps: `sessions`, `proxySessions`, `userSessions`
- Triggers `ProxySession.cleanup()` and clears `GlobalRequestRouter` notification dedupe state for the session

### 5. Dual Logging Architecture

The system maintains two separate logging systems:

**Pino (Operational Logs)** - `src/logger/`:
- Real-time structured logs for monitoring and debugging
- JSON format in production, pretty-print in development
- Per-module loggers via `createLogger('ModuleName')`
- Levels: trace, debug, info, warn, error, fatal
- Output to console (can be piped to log aggregation services)

**LogService (Audit Logs)** - `src/log/LogService.ts`:
- Business event logs persisted to database (`log` table)
- Batch queue with periodic flush (every 5 seconds or 100 logs)
- Tracks MCP events: ToolCall, ResourceRead, PromptGet, etc.
- Uses `MCPEventLogType` enum from `src/types/enums.ts`
- **SessionLogger** (`src/log/SessionLogger.ts`):
  - Per-session wrapper around LogService
  - Automatically includes sessionId and userId
  - Dynamically updates IP and User-Agent from HTTP context
- Correlation via:
  - `uniformRequestId` - Generated per-session for correlation
  - `upstreamRequestId` - Original client request ID

**When to use which**:
- Pino: Application flow, errors, performance metrics
- LogService: User actions, MCP protocol events, audit trail

### 6. Resource Namespacing Details

Resources, tools, and prompts from different servers are namespaced to prevent conflicts:

**Format**: `{serverId}::{resourceName}`

**Examples**:
- `filesystem::read_file` - Tool from "filesystem" server
- `web-search::search` - Tool from "web-search" server
- `database::users` - Resource from "database" server

**Routing Flow**:
1. Client sends request: `tools/call` with name `filesystem::read_file`
2. `ProxySession.handleToolsCall()` calls `parseName('filesystem::read_file')`
3. Returns `{ serverId: 'filesystem', name: 'read_file' }`
4. Permission check: Does user have access to 'filesystem' server?
5. Route to downstream server connection via `ServerManager`
6. Forward request with original name `read_file` (namespace stripped)

**Implementation**: `ClientSession.parseName()` in `src/mcp/core/ClientSession.ts`

### 7. Configuration System

Configuration is distributed across multiple files:

- **`src/config/config.ts`** - App metadata from package.json (APP_INFO)
- **`src/config/auth.config.ts`** - Token expiration, cookie settings
- **`.env`** - Runtime environment variables (DATABASE_URL, ports, SSL)

Note: EventStore configuration (cache sizes, retention) is hardcoded in `PersistentEventStore` class.

### 8. Repository Pattern

Data access layer in `src/repositories/`:

- **`UserRepository`** - User CRUD, permission management
- **`ServerRepository`** - Server configs with encryption/decryption
- **`LogRepository`** - Batch log inserts, cleanup
- **`EventRepository`** - Event storage, Last-Event-ID queries, cleanup
- **`IpWhitelistRepository`** - IP whitelist CRUD
- **`ProxyRepository`** - Proxy configuration management

All repositories use Prisma client for database operations.

### 9. Capabilities Management

**`CapabilitiesService`** (`src/mcp/services/CapabilitiesService.ts`):
- Singleton managing user capabilities
- Merges admin permissions with `user_preferences` JSON field
- Provides per-user capability overrides
- Integration with Socket.IO for real-time capability updates
- Used by `AuthMiddleware` to construct `AuthContext`

### 10. Error Handling Patterns

Structured error types across the codebase:

- **`AuthError`** - Authentication failures with `AuthErrorType` enum
- **`McpError`** - MCP protocol errors from SDK
- **`ReverseRequestTimeoutError`** - Reverse request timeouts
- **`SocketErrorCode`** - Socket.IO errors (authentication, connection)

All errors logged with structured context (userId, sessionId, error details).

### 11. Admin vs User Routes

- `/mcp` - Requires valid user token (any role)
- `/user` - Requires valid user token (any role) - User operations API
- `/admin/*` - Requires Owner/Admin role (enforced by `AdminAuthMiddleware`)
- OAuth endpoints - Public or admin-only depending on endpoint

### 12. URL-based Client ID Support (SEP-991)

**New Feature** (Added in MCP SDK 1.23.0 upgrade): The OAuth authorization server now supports URL-based client identifiers per SEP-991.

**How it works**:
1. Client hosts their metadata document at their own domain (e.g., `https://client.com/.well-known/oauth-client`)
2. Client registers using the URL as `client_id`
3. Gateway fetches and validates the metadata from the URL
4. No `client_secret` needed - client proves identity by controlling the URL content

**Implementation files**:
- `src/oauth/services/ClientMetadataFetcher.ts` (340 lines) - Core metadata fetching service
  - URL validation (HTTPS required, no root paths)
  - HTTP fetch with 5-second timeout
  - LRU cache (1-hour TTL)
  - Metadata validation per RFC 7591
- `src/oauth/services/OAuthClientService.ts:registerClient()` - Registration logic with URL detection
- `src/oauth/controllers/OAuthController.ts:register()` - Validation that allows URL-based registration
- `src/oauth/types/oauth.types.ts:OAuthClientMetadata` - Type definition with optional `client_id`

**Usage examples**:

```bash
# Traditional registration (still supported)
POST /register
{
  "client_name": "My App",
  "redirect_uris": ["http://localhost:3000/callback"]
}
# Returns: { client_id: "generated-id", client_secret: "secret", ... }

# URL-based registration (new)
POST /register
{
  "client_id": "https://myapp.com/.well-known/oauth-client"
}
# Gateway fetches metadata from URL
# Returns: { client_id: "https://myapp.com/.well-known/oauth-client", ... }
# (no client_secret for URL-based clients)
```

**Metadata URL requirements** (SEP-991):
- MUST use HTTPS protocol
- MUST have non-root pathname (e.g., `/client`, `/.well-known/oauth-client`)
- MUST return `application/json` content type
- MUST include required field: `redirect_uris` (non-empty array)
- MAY include: `client_name`, `grant_types`, `response_types`, `scope`, `token_endpoint_auth_method`

**Error handling**:
- Invalid URL format → `invalid_client_metadata: "URL must use HTTPS protocol"`
- Root path URL → `invalid_client_metadata: "URL pathname cannot be root (/)"`
- Fetch timeout (>5s) → `invalid_client_metadata: "Client metadata fetch timeout"`
- Invalid metadata → `invalid_client_metadata: "redirect_uris is required and must be a non-empty array"`

**Caching**:
- Metadata cached for 1 hour per URL
- Cache invalidation via `ClientMetadataFetcher.clearCache(url)`
- Automatic cleanup of expired cache entries

**OAuth Metadata Declaration**:
The authorization server metadata at `/.well-known/oauth-authorization-server` now includes:
```json
{
  "client_id_metadata_document_supported": true,
  ...
}
```

**Backward Compatibility**: ✅ Fully compatible - traditional registration unchanged.

## Testing Infrastructure

**Current Status**: Test infrastructure is not yet set up in `src/` directory.

When implementing tests in the future:
1. Mock `ServerManager.instance` since it's a singleton
2. Use in-memory event store for speed
3. Mock Prisma client for unit tests
4. Test requestId mapping in isolation from full proxy flow
5. Verify cleanup methods to avoid memory leaks
6. Create `jest.config.cjs` for Jest configuration
7. Add test scripts to `package.json`

**Note**: Some test files exist in `typescript-sdk-main/` directory for the MCP SDK itself.

## Common Pitfalls

1. **RequestId mapping**: Always use `RequestIdMapper` when forwarding requests. Never use raw client requestIds with downstream servers.

2. **Notification cleanup**: `GlobalRequestRouter` keeps per-session dedupe state for downstream notifications. Clear it during session cleanup to avoid leaks.

3. **Server connection sharing**: Downstream server connections are shared across all client sessions via `ServerManager` singleton. Never close connections from `ProxySession`.

4. **Async cleanup**: Always await cleanup operations in shutdown handlers. Use `Promise.all()` for parallel cleanup.

5. **CORS headers**: HEAD/OPTIONS requests have special handling for Claude Web compatibility. Don't modify without testing.

6. **Prisma client generation**: Run `npm run db:generate` after schema changes, automatically runs in postinstall.

## Entry Points

- `src/index.ts` - Main application entry point
- `scripts/start-with-ports.cjs` - Dev startup script (finds available ports)
- `scripts/unified-db-init.js` - Database initialization

## Additional Documentation

- `examples/electron-client/README.md` - Electron client integration guide

### API Documentation
- `docs/api/API.md` - MCP API endpoints
- `docs/api/ADMIN_API.md` - Admin API endpoints
- `docs/api/USER_API.md` - User API endpoints
- `docs/api/SOCKET_USAGE.md` - Socket.IO usage guide

### Architecture Design
- `docs/architecture/EVENTSTORE_README.md` - EventStore architecture
- `docs/architecture/MCP_PROXY_REQUESTID_SOLUTION.md` - RequestId mapping design
- `docs/architecture/MCP_ADVANCED_FEATURES.md` - MCP advanced features

### Implementation Records
- `docs/implementation/SOCKET_IO_IMPLEMENTATION.md` - Socket.IO implementation
- `docs/implementation/RATE_LIMIT_IMPLEMENTATION.md` - Rate limiting implementation
- `docs/implementation/USER_CUSTOM_SERVER_CONFIG.md` - User custom server configuration
- `docs/implementation/ADMIN_ERROR_IMPROVEMENTS.md` - Admin error handling improvements
- `docs/implementation/ADMIN_TYPES_IMPROVEMENTS.md` - Admin types improvements

### Migration Guides
- `docs/migration/PINO_MIGRATION_GUIDE.md` - Pino logging migration
- `docs/migration/PHASE1_CHANGES.md` - Phase 1 changes

---

## Knowledge Base and Documentation Update Guidelines

### Project Knowledge Base Locations

| Type | Location | Description |
|------|----------|-------------|
| Project Architecture | `CLAUDE.md` | Core architecture, module descriptions (this file) |
| Codex Guidelines | `AGENTS.md` | Codex development guidelines |
| Collaboration Docs | `PROJECT_COLLABORATION.md` | Multi-agent collaboration workflow |
| Database Schema | `prisma/schema.prisma` | Data model definitions |

### Post-Development Update Workflow

1. **Code Changes**
   - If new modules/interfaces are involved, update architecture description in `CLAUDE.md`
   - If API changes are involved, update `docs/api/API.md` or `docs/api/ADMIN_API.md`

2. **Documentation Updates**
   - New features: Create `FeatureName_IMPLEMENTATION.md` in `docs/implementation/` to document design and implementation
   - Existing feature modifications: Update corresponding documentation, note the changes

3. **Knowledge Sharing**
   - Complex implementations: Add to "Important Implementation Patterns" in `CLAUDE.md`
   - Lessons learned: Add to "Common Pitfalls" in `CLAUDE.md`

### Documentation Management Principles

- ❌ Do not create duplicate documents (e.g., `api.md` + `api-v2.md`)
- ✅ Update existing documents, maintain single source of truth
- ✅ Search for existing related documents before modifying

## AI Agent Collaboration Guidelines

When working with multiple AI agents (Claude Code, Codex, etc.):

**Claude Code** - Precise, controllable tasks:
- File search/location (`Glob`, `Grep`)
- Precise code modifications (`Edit`)
- Testing/Build/Git operations (`Bash`)
- Task breakdown (`TodoWrite`)
- Code review (`Task` agent)
- Small-scale modifications, variable renaming
- Running tests, finding code

**Codex** - Complex, large-scale tasks:
- Large-scale code generation
- Cross-file refactoring
- Multi-round reasoning
- New module development
- System-level architectural changes

**Workflow:**
1. Read context: CLAUDE.md (architecture), AGENTS.md (guidelines)
2. Determine task type → assign to appropriate agent
3. Execute task
4. Update knowledge base as needed
5. Continue to next task

See `.cursorrules` and `PROJECT_COLLABORATION.md` for complete collaboration documentation.
