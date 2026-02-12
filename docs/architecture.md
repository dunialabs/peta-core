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

#### 1. Forward Request Flow (Client → Downstream)

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

#### 2. Reverse Request Flow (Downstream → Client)

```text
Downstream MCP Server Initiates Request (Sampling/Elicitation)
  ↓
ServerManager Receives (with relatedRequestId)
  ↓
GlobalRequestRouter (Lookup RequestContextRegistry)
  ↓
Locate Correct ProxySession
  ↓
RequestIdMapper (Reverse mapping: proxy-id → client-id)
  ↓
Forward to Client (via SSE)
  ↓
Client responds along the same path
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
MCP Event Generated
  ↓
PersistentEventStore
  ↓
Dual-layer Storage:
  - EventCacheManager (In-memory LRU)
  - PostgreSQL (Persistent)
  ↓
Client Disconnects and Reconnects
  ↓
Request with Last-Event-ID
  ↓
Restore Historical Events from EventStore
  ↓
Continue Session
```

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

4. **Reverse Request Routing**
   - Via GlobalRequestRouter + RequestContextRegistry
   - Downstream servers route back to correct client session via relatedRequestId

5. **Dual Logging Architecture**
   - Pino: Structured operational logs (real-time monitoring)
   - LogService: Audit logs (database persistence)

6. **Resource Namespace Isolation**
   - Format: `{serverId}::{resourceName}`
   - Examples: `filesystem::read_file`, `database::users`
   - Prevents resource name conflicts between different servers

---
