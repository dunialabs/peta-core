# Architecture

## System Architecture

![Architecture Overview](overview.png)

### High-Level Overview

Peta Core implements a gateway pattern and plays two roles at the same time:

1. **MCP Server (to upstream clients)**  
   Exposes a standard MCP interface so agents and MCP-compatible clients can connect without custom plugins.

2. **MCP Client (to downstream servers)**  
   Manages connections to multiple MCP servers, multiplexing requests and applying policies before forwarding them.

Between those two sides the gateway adds:

- Authentication and session management.
- Permission evaluation (including human-in-the-loop checks).
- Credential injection from encrypted storage (the MCP vault).
- Rate limiting and IP filtering.
- Event persistence and reconnection support.
- Logging and audit trails.

From the agent’s perspective there is only one MCP server. Behind that interface Peta Core handles the operational, security, and governance concerns.

### Gateway Responsibilities

Typical responsibilities inside the gateway include:

- Validating Peta access tokens (OAuth JWT or opaque) and resolving user/agent identity.
- Applying RBAC/ABAC policies, quotas, and network restrictions.
- Determining whether a request is allowed, blocked, or requires human approval.
- Injecting encrypted credentials into downstream MCP servers at execution time.
- Streaming responses back to clients via MCP and/or Socket.IO.
- Emitting structured logs and audit records for each operation.

For downstream OAuth-backed Template servers, the gateway also acts as a token broker: it exchanges authorization codes, stores the full OAuth state encrypted at rest, refreshes or validates access tokens server-side, removes `launchConfig.oauth` before process launch, and injects only the runtime values the downstream MCP server environment needs. For owner-managed servers, dynamic OAuth fields are persisted back through the same server-context token that successfully decrypted the stored `launchConfig`, with the cached owner token used only as a lazy-start fallback when no context token is available.

Intercom is a provider-specific exception to the refresh-token model. Core stores the Intercom access token plus the `app.region` value discovered from Intercom's `/me` endpoint, injects `accessToken` and `intercomRegion` into the downstream runtime, and re-validates the token on startup and on a synthetic recheck schedule. If Intercom reports that the token has been revoked, blocked, expired, or is otherwise invalid, Core unconfigures user-managed temporary servers so the stale OAuth payload is removed from the user's saved launch config, and it clears the persisted dynamic OAuth state, closes the server context, and disables owner-managed servers.

---

## Project Structure

A simplified structure of this repository:

```text
.
├─ src/
│  ├─ mcp/           # MCP proxy core (core/, services/, controllers/)
│  ├─ oauth/         # OAuth 2.0 implementation
│  ├─ socket/        # Socket.IO real-time channel
│  ├─ security/      # Authentication & authorization helpers
│  ├─ middleware/    # Express middleware
│  ├─ repositories/  # Data access layer
│  ├─ logger/        # Pino logger factory
│  ├─ config/        # Configuration and environment loading
│  └─ utils/         # Shared utilities and types
├─ docs/
│  ├─ api/                    # Admin API, MCP API, and Socket.IO docs
│  ├─ DOCKER_DEPLOYMENT.md    # Docker deployment guide
│  ├─ docker-deploy.sh        # Helper script for Docker deploys
│  └─ overview.png            # Architecture diagram
├─ prisma/           # Prisma schema and migrations
└─ package.json
```

See the `docs/` directory for API references and deployment guides. Architecture notes live in `../CLAUDE.md` and the `overview.png` diagram (there is no `docs/architecture/` directory in this repository).

### Data Flow Description

#### 1. Legacy Forward Request Flow (Client → Downstream)

```text
Client Initiates Request
  ↓
HTTP/HTTPS Server (Express)
  ↓
Middleware Chain (IP Check → Auth → Rate Limit)
  ↓
SessionStore (Get/Create ClientSession)
  ↓
ProxySession (Acts as MCP Server to receive request)
  ↓
RequestIdMapper (Map RequestID: client-id → proxy-id)
  ↓
Resource Namespace Parsing (filesystem::read_file → serverId + name)
  ↓
ServerManager (Get downstream server connection)
  ↓
Downstream MCP Server (ProxySession acts as MCP Client to send request)
  ↓
Response returns along the same path
```

For forward requests, Peta keeps three IDs separate: the upstream client's
`originalRequestId`, Peta's internal `proxyRequestId`, and the downstream SDK
client's actual JSON-RPC `downstreamRequestId`. When an upstream request includes
`_meta.progressToken`, the proxy preserves the client's original token internally,
rewrites the downstream payload to use `proxyRequestId` for routing, and restores the
original token before sending progress notifications back upstream. Upstream
`notifications/cancelled` are translated to the captured `downstreamRequestId` so the
downstream SDK cancels the real in-flight request instead of a proxy-only ID.

#### 1a. Modern MCP 2026-07-28 Request Flow

```text
Modern Client POSTs to /mcp
  ↓
Protocol-era classifier rejects mixed modern/legacy signals
  ↓
Modern auth validates Authorization bearer without creating SessionStore entries
  ↓
Modern HTTP validator checks _meta and MCP headers
  ↓
Modern request context carries user, tenant, scopes, client info, and request id
  ↓
Gateway lists or resolves namespaced tools/resources/prompts
  ↓
Policy, approval, cache, and audit services run with request-scoped context
  ↓
ServerManager forwards to downstream MCP clients internally
  ↓
Response returns without Mcp-Session-Id
```

The modern adapter is side-by-side with `ProxySession`. It preserves legacy behavior while adding stateless modern requests, `server/discover`, POST-based `subscriptions/listen`, and modern OAuth enforcement. Downstream connections remain managed by `ServerManager`; downstream session details are not exposed upstream.

The installed `@modelcontextprotocol/sdk` currently reports `LATEST_PROTOCOL_VERSION: 2025-11-25` and supported versions through `2025-11-25`, so Peta Core does not depend on SDK latest-version constants for MCP `2026-07-28` ingress. The compatibility spike is recorded in `.omo/spikes/mcp-2026-sdk-compatibility.md`; local modern validation/error/request types live under `src/mcp/modern/`, while downstream and legacy connections continue using the SDK-backed flow.

#### 2. Reverse Request Flow (Downstream → Client)

```text
Shared managed connection mode:
  - Multiple upstream clients share one downstream session
  - Standard MCP reverse requests cannot be routed reliably
  - `sampling` / `roots` / `elicitation` are therefore not exposed

Dedicated per-session downstream connections would be required to support
standards-compliant reverse requests without private routing metadata.
```

#### 3. Socket.IO Real-time Communication

```text
Electron Client Connects
  ↓
Socket.IO Server (Token Authentication)
  ↓
Join Room (userId-based)
  ↓
Server Push Notifications
  - User Enabled/Disabled
  - Online Session List Updates
  - Capability Configuration Changes
  ↓
Supports Multi-device Synchronization
```

#### 4. Event Persistence and Reconnection

```text
MCP Event Generated by SDK Transport
  ↓
PersistentEventStore
  ↓
Durable Storage:
- PostgreSQL first; event ID is returned only after persistence succeeds
- In-memory cache is populated after durable persistence
  ↓
Client Disconnects and Reconnects
  ↓
Request with Last-Event-ID
  ↓
Upstream StreamableHTTPServerTransport
- resolves stream via EventStore for the same session only
- replays missed events in persisted insertion order
  - rebinds live SSE stream
  ↓
Continue Session
```

Explicit `DELETE /mcp` termination records a short-lived in-memory reconnect tombstone for the server-issued session ID. A new `initialize` request may reuse that ID only once, only within the grace window, and only when the authenticated identity matches the terminated session. Unknown client-provided session IDs are ignored during initialization and replaced with a fresh server-generated ID.

### Core Design Patterns

1. **Multi-Role Proxy Pattern**
   - ProxySession acts as both MCP Server (upstream) and MCP Client (downstream)
   - Transparently forwards MCP protocol without client awareness of the middleware

2. **Singleton Shared Connections**
   - ServerManager as global singleton manages all downstream server connections
   - Multiple client sessions share the same set of downstream connections, avoiding duplicate establishment

3. **Three-Layer RequestID Mapping**
   - Client RequestID → Proxy RequestID → Server RequestID
   - Format: `{sessionId}:{originalId}:{timestamp}`
   - Prevents multi-client ID conflicts

4. **Reverse Request Boundary**
   - Shared managed downstream connections intentionally do not expose standard reverse-request capabilities
   - Reverse requests only become viable with dedicated downstream session ownership
   - Modern upstream responses do not advertise MRTR or reverse-request support until a real continuation flow is proven

5. **Dual Logging Architecture**
   - Pino: Structured operational logs (real-time monitoring)
   - LogService: Audit logs (database persistence)

6. **Resource Namespace Isolation**
   - Format: `{serverId}::{resourceName}`
   - Examples: `filesystem::read_file`, `database::users`
   - Prevents resource name conflicts between different servers

---
