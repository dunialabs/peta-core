# Reference

## Usage Examples

### Admin API (Peta Console)

Peta Console uses a single `/admin` endpoint to perform administrative operations.

**Example: create a user**

```bash
curl -X POST http://localhost:3002/admin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{
    "action": 1010,
    "data": {
      "userId": "user123",
      "status": 1,
      "role": 0
    }
  }'
```

The exact action codes and payloads are defined in `api/ADMIN_API.md`.

### Socket.IO (Peta Desk)

Peta Desk uses Socket.IO for real-time communication with Peta Core.

**Example: connect and fetch capabilities**

```ts
import { io } from "socket.io-client";

const socket = io("http://localhost:3002", {
  auth: { token: "USER_ACCESS_TOKEN" },
});

socket.on("connect", () => {
  console.log("connected", socket.id);

  socket.emit("get_capabilities", { requestId: "req-123" });
});

socket.on("socket_response", (response) => {
  if (response.requestId === "req-123" && response.success) {
    console.log("capabilities", response.data);
  }
});

socket.on("notification", (payload) => {
  // handle capability changes, approval requests, etc.
});
```

See `api/SOCKET_USAGE.md` for the full event list and payload schemas.

### OAuth 2.0

Peta Core exposes an OAuth 2.0 service for obtaining access tokens that can be used with MCP clients.

These OAuth endpoints issue access tokens for authenticating to Peta Core. They are separate from downstream connector OAuth credentials (for example Google/Notion/Figma) which are stored encrypted and refreshed internally by Peta Core.

**Dynamic Client Registration (optional)**

```bash
curl -X POST http://localhost:3002/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "my-client",
    "redirect_uris": ["http://localhost:3000/callback"],
    "token_endpoint_auth_method": "none"
  }'
```

If you provide `grant_types` in client metadata, Peta Core accepts `authorization_code`, `refresh_token`, and `client_credentials` (for compatibility). The `/token` endpoint currently supports `authorization_code` and `refresh_token` grants only.

**Authorization Code + PKCE (user-interactive)**

```bash
# 1. Create code_verifier and code_challenge
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-43)
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr -d "=+/" | cut -c1-43)

# 2. Open the authorization URL in a browser
echo "http://localhost:3002/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=YOUR_CALLBACK&response_type=code&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"

# 3. After the user authorizes, exchange the code for a token
curl -X POST http://localhost:3002/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "AUTHORIZATION_CODE_FROM_CALLBACK",
    "client_id": "YOUR_CLIENT_ID",
    "code_verifier": "'"$CODE_VERIFIER"'"
  }'
```

See `api/API.md` for full OAuth 2.0 details.

**Token Introspection**

```bash
curl -X POST http://localhost:3002/introspect \
  -H "Content-Type: application/json" \
  -d '{ "token": "YOUR_OAUTH_ACCESS_TOKEN", "token_type_hint": "access_token" }'
```

---

## API & Documentation

### API Surfaces

Peta Core exposes different APIs for different roles:

- **MCP protocol interface** (`/mcp`)
  Standard MCP endpoints for MCP-compatible clients such as Claude Desktop, ChatGPT MCP, or Cursor.
  Authentication: bearer token (OAuth access token (JWT) or Peta access token (opaque)).
  Transport: HTTP/SSE depending on your MCP host.

- **Admin API** (`/admin`)
  Used by Peta Console and automation scripts to manage users, servers, permissions, and quotas.
  Authentication: bearer token (Peta access token (opaque)).

- **Socket.IO channel** (`/socket.io`)
  Used by Peta Desk for real-time notifications, capability configuration, and approval workflows.
  Authentication: bearer token (Peta access token (opaque)).

- **OAuth 2.0 endpoints** (`/.well-known/*`, `/register`, `/authorize`, `/token`, `/introspect`, `/revoke`)
  Used by clients to obtain access tokens (dynamic client registration, authorization code with PKCE, refresh tokens) and check token validity.

### Reference Docs

| Document | Target Users | Description | Link |
|----------|-------------|-------------|------|
| **API.md** | End Users | API overview, authentication, MCP protocol, OAuth 2.0 | [View](./api/API.md) |
| **ADMIN_API.md** | Administrators | Complete admin API protocol (80+ operations) | [View](./api/ADMIN_API.md) |
| **SOCKET_USAGE.md** | Peta Desk Users | Complete Socket.IO real-time communication guide | [View](./api/SOCKET_USAGE.md) |
| **MCP Official Docs** | Developers | Model Context Protocol standard | [View](https://modelcontextprotocol.io/docs/) |

### Quick Links

- **[OAuth 2.0 Authentication](./api/API.md#2-oauth-20-authentication)** - Get access tokens for MCP connections
- **[MCP Protocol](./api/API.md#1-mcp-protocol-interface)** - MCP endpoints and namespaces
- **[Admin API](./api/ADMIN_API.md)** - User, server, permission management (for Peta Console)
- **[Socket.IO](./api/SOCKET_USAGE.md)** - Real-time notifications and request-response (for Peta Desk)
- **[Complete Examples](./api/API.md#complete-examples)** - OAuth + MCP workflow

---

## Progressive Disclosure Catalog

Peta Core's Progressive Disclosure feature controls which tools are directly exposed to AI clients and which are discoverable only through a catalog search interface. Three discovery modes are supported:

| Mode | Behavior |
|------|----------|
| **FLAT** | All tools are directly exposed (default, no catalog overlay) |
| **HYBRID** | Some tools are direct, others are catalog-only (based on profile `directExposureRules`) |
| **STRICT** | All tools are catalog-only; AI must use `peta.catalog.search`, `peta.catalog.describe`, and `peta.catalog.execute` |

**Admin API**: Discovery operations live under actions 9301-9331. See [ADMIN_API.md](./api/ADMIN_API.md#discovery--progressive-disclosure-operations-9300-9399) for the full reference.

### Catalog Architecture

The catalog is a **persistent search index**, not the runtime source of truth for callable tools.

- `catalog.search` and `catalog.describe` read from indexed `CatalogAction` rows for discovery and preview.
- `catalog.execute` always resolves the live `ServerContext` for the current user and rebuilds the callable alias from the runtime context ID before dispatch.
- The global catalog excludes temporary or user-scoped server contexts; those tools remain discoverable to the current user through the live runtime surface.
- HYBRID direct-exposure rules evaluate against live runtime data (`serverId` plus risk inferred from standard MCP hints) so initial startup does not depend on catalog rows already existing.
- Indexed catalog rows intentionally store only stable metadata that survives the SDK-parsed runtime path. Placeholder fields such as catalog-level approval/public visibility are not treated as authoritative runtime facts.

When you need the exact executable surface for a user, trust the live session/runtime state. When you need cross-server discovery, search, preview counts, or admin reindex/statistics, use the catalog index.

### Discovery Profiles

Discovery profiles are named configurations that control tool visibility:

- **Profile fields**: `name`, `description`, `mode`, `enabled`, `isDefault`, `config`, `instructionText`
- **directExposureRules** (in `config`): Ordered rules evaluated against each tool's `serverId` and `riskLevel`. First match wins. Unmatched tools default to catalog-only.
- **instructionText**: Optional text injected into the AI client's context to explain the catalog workflow.

Profiles are managed through the Admin API (9310-9314) and the Console UI (Progressive Disclosure page).

---

## Tech Stack

- **Runtime**: Node.js (v18+) and TypeScript
- **Framework**: Express
- **Database**: PostgreSQL with Prisma ORM
- **Real-time**: Socket.IO
- **Logging**: Structured logging and database audit logs
- **Containerization**: Docker and Docker Compose

---

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- --testPathPattern=PersistentEventStore.test.ts

# Run tests with coverage
npm test -- --coverage

# Watch mode (recommended for development)
npm test -- --watch
```

### Test Structure

Test files follow these naming conventions:
- Unit tests: `*.test.ts` (same directory as source file or `__tests__` directory)
- Integration tests: `*.integration.test.ts`
- E2E tests: `*.e2e.test.ts`

### Testing Best Practices

1. **Mock Singleton Services**:

   ```ts
   // Mock ServerManager in tests
   jest.mock('./ServerManager', () => ({
     instance: {
       createServerConnection: jest.fn(),
       // ...
     }
   }));
   ```

2. **Use In-Memory EventStore**:

   ```ts
   const eventStore = new PersistentEventStore({
     useInMemory: true  // Speeds up tests
   });
   ```

3. **Clean Up Resources**:

   ```ts
   afterEach(async () => {
     await proxySession.cleanup();
     jest.clearAllMocks();
   });
   ```

4. **Test RequestId Mapping**:

   ```ts
   it('should map client requestId to proxy requestId', () => {
     const mapper = new RequestIdMapper('session123');
     const proxyId = mapper.mapToProxy('client-req-1');
     expect(proxyId).toMatch(/^session123:client-req-1:\d+$/);
   });
   ```

### Current Test Status

- Automated test coverage is being added; no test files are currently committed.
- Integration and end-to-end scenarios are especially valuable.

Additional test contributions are especially useful for:

- Complete `ProxySession` lifecycle tests.
- `RequestIdMapper` edge-case coverage.
- `GlobalRequestRouter` routing behavior.
- Concurrency tests for the persistent event store.
- OAuth 2.0 flows.
- Socket.IO connection and notification scenarios.

See `../CONTRIBUTING.md` for details.
