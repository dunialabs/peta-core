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
Protocol-era classifier selects modern unless an active legacy session owns the request
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

The modern adapter is side-by-side with `ProxySession`. It preserves legacy behavior while adding stateless modern requests, `server/discover`, POST-based `subscriptions/listen`, and modern OAuth enforcement. `initialize` remains legacy-only; a modern-signaled `initialize` is rejected before legacy authentication. Active legacy sessions remain on the sessionful path even if a client sends extra modern-looking headers. Before those requests are handed to the SDK-backed legacy upstream transport, `ProxySession` removes non-authoritative modern-only headers that the installed 2025-era SDK would otherwise reject, while preserving supported legacy protocol-version headers.

Downstream connections remain managed by `ServerManager`; downstream session details are not exposed upstream. `ServerManager` talks to downstream servers through a `DownstreamMcpClient` abstraction. The existing SDK-backed client handles legacy stdio, SSE, and Streamable HTTP. A modern HTTP client handles stateless downstream MCP `2026-07-28` when enabled and selected by `launchConfig.mcpProtocol`. In `auto` mode, transport or legacy-compatible probe failures fall back to that SDK-backed path, but recognized modern protocol errors received from a downstream (`-32020`, `-32021`, or `-32022`) fail closed. A URL configured with `mcpProtocol: "modern"` selects Streamable HTTP regardless of its path; only an explicit `type: "sse"` takes precedence and is rejected for modern mode. Stdio and SSE downstream transports remain legacy-compatible in this phase.

Modern resource update subscriptions preserve downstream scope isolation. `GlobalRequestRouter` publishes resource update events with the originating server context id, and the modern subscription adapter resolves that scope before rewriting gateway URIs so temporary per-user downstream resource updates cannot be delivered through a managed-server modern subscription. Subscription filters are request-scoped rather than advertised through a custom capability field. Server-initiated teardown writes the final correlated `subscriptions/listen` result; abrupt client close only releases listeners and downstream reference counts.

The modern `server/discover` response puts Peta Core's `serverInfo` under `_meta["io.modelcontextprotocol/serverInfo"]` and advertises only capabilities backed by an accessible downstream or a sleeping server's corresponding cached catalog. Cached catalogs preserve list-method availability without synthesizing push flags. MCP Apps metadata and HTML reference rewriting are enabled only when the client negotiates `extensions["io.modelcontextprotocol/ui"].mimeTypes` with `text/html;profile=mcp-app`; otherwise tools remain available as text-only tools with UI metadata removed. Peta advertises that server extension only when a matching accessible UI resource is available. Tool, resource, and prompt list-change support is advertised and acknowledged only for accessible legacy downstreams that explicitly declare `listChanged: true`; modern HTTP downstream notification streams are not bridged. The adapter advertises resource subscription capability only for accessible legacy downstreams that actually declare `resources.subscribe`; subscription setup is reference-counted and rolls back earlier downstream subscriptions if a later setup fails. Modern HTTP downstream connections are stateless request/response clients: SSE replies are selected by matching JSON-RPC id (including errors), a mutually supported version advertised through `-32022` is retried once, a token-update notification refreshes the authorization header for subsequent requests, and valid `x-mcp-header` annotations are mirrored through `Mcp-Param-*` request headers.

Each complete or incomplete modern downstream SSE event is limited to 64 KiB so an unterminated or oversized event fails closed instead of growing the response buffer until timeout.

The installed `@modelcontextprotocol/sdk` currently reports `LATEST_PROTOCOL_VERSION: 2025-11-25` and supported versions through `2025-11-25`, so Peta Core does not depend on SDK latest-version constants for MCP `2026-07-28` ingress or modern HTTP downstream calls. Local modern validation/error/request types live under `src/mcp/modern/`; SDK-backed downstream connections remain available for legacy servers.

Modern downstream stdio is intentionally not supported: it needs an SDK/client-process lifecycle that can negotiate `2026-07-28`. Persistent modern downstream `subscriptions/listen`, downstream progress, and cancellation are also deferred because they require an incremental shared SSE listener, fanout, and downstream request-id lifecycle. The modern gateway does not advertise those unavailable downstream resource subscriptions.

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

Result-cache request identity includes every business argument by default, including `timestamp`, `requestId`, `nonce`, and tool-owned `_meta`. An operator may explicitly exclude fields through an entity's `cache.key.denyFields` or select fields through `cache.key.allowFields`; these settings must only ignore values that cannot affect the result. Result and admission keys use the `rc:v2` and `rcadm:v2` namespaces, so older entries are not reused after upgrade and expire under their original TTLs. No database migration is required. A rolling deployment must drain old workers to remove the old cache and approval identity behavior completely.

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
   - Pino: Structured operational logs (real-time monitoring), recursively sanitized before serialization
   - LogService: Audit logs (database persistence), independently sanitized before persistence

6. **Resource Namespace Isolation**
   - Format: `{serverId}::{resourceName}`
   - Examples: `filesystem::read_file`, `database::users`
   - Prevents resource name conflicts between different servers

7. **Stable Downstream Identity**
   - `serverId` is the unique key for runtime registries, permissions, namespaces, and health output
   - `serverName` is an operator-managed display label and may be duplicated
   - Custom downstream `serverInfo.name` only fills an empty configured label; reconnects do not overwrite an operator-supplied name

---
