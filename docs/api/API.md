# Peta Core API Overview

This document provides an overview and navigation for all APIs in Peta Core.

## Table of Contents

- [Authentication](#authentication)
- [API Categories](#api-categories)
  - [MCP Protocol Interface](#1-mcp-protocol-interface)
  - [OAuth 2.0 Authentication](#2-oauth-20-authentication)
  - [Admin API](#3-admin-api)
  - [User API](#4-user-api)
  - [Socket.IO Real-time Communication](#5-socketio-real-time-communication)
- [Error Handling](#error-handling)
- [Complete Examples](#complete-examples)

---

## Authentication

Peta Core uses two kinds of bearer tokens:

- **OAuth 2.0 access tokens (JWT)** issued by Peta Core: accepted by `/mcp`.
- **Peta access tokens (opaque)** associated with a user: used by `/admin` and `/socket.io`, and also accepted by `/mcp`.

### MCP Initialization

For the initial `initialize` call to `POST /mcp`, provide a token via:

```http
Authorization: Bearer <token>
```

Or (for `POST /mcp` only):

```http
POST /mcp?token=<token>
POST /mcp?api_key=<token>
```

After initialization, Peta Core returns `Mcp-Session-Id`; include it for subsequent `/mcp` requests and SSE stream connections.

**Get an OAuth token**: Obtain an OAuth 2.0 access token through the OAuth endpoints. See [OAuth 2.0 Authentication](#2-oauth-20-authentication) for details.

### Anonymous Access

Peta Core supports anonymous (token-less) access to MCP servers that have been explicitly configured with `anonymousAccess: true` by an administrator.

To use anonymous access, clients connect to the **`/mcp/public`** endpoint path instead of `/mcp`:

```
POST /mcp/public
```

The standard `/mcp` endpoint always returns `401 + WWW-Authenticate` for tokenless requests, preserving the OAuth discovery flow.

#### Anonymous Access Behavior

| Request | Behavior |
|---------|----------|
| `POST /mcp` (no token) | `401 + WWW-Authenticate` — triggers OAuth flow |
| `POST /mcp/public` (no token) | Anonymous session if anonymous servers exist, otherwise `401` |
| `POST /mcp` (with valid token) | Normal authenticated session |
| `POST /mcp/public` (with valid token) | Normal authenticated session (same as `/mcp`) |
| `HEAD /mcp` (no token) | `401 + WWW-Authenticate` — OAuth discovery probe |
| `HEAD /mcp/public` (no token) | `200` — indicates anonymous access is available |

#### Anonymous Rate Limiting

> **Important**: Anonymous rate limiting is **per-source-IP**, not per-user.
>
> Multiple users behind the same NAT, corporate proxy, or platform IP (e.g., Claude platform fixed IPs) share the same rate limit bucket. The `anonymousRateLimit` configured on each server defines the maximum requests per minute from a single source IP.
>
> Without a login state or trusted upstream identity header, the server cannot distinguish individual anonymous users. This is an inherent limitation of anonymous access.

#### Configuration

Anonymous access is configured per-server via the Admin API:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `anonymousAccess` | `boolean` | `false` | Enable anonymous access for this server |
| `anonymousRateLimit` | `integer` | `10` | Per-source-IP requests per minute (1–1000) |
---

## API Categories

### 1. MCP Protocol Interface

Peta Core fully implements the **Model Context Protocol (MCP)** standard protocol.

#### Core Endpoints

| Method | Endpoint | Description |
|------|------|------|
| `GET` | `/mcp` | Establish SSE (Server-Sent Events) connection |
| `POST` | `/mcp` | Send MCP JSON-RPC 2.0 request |
| `DELETE` | `/mcp` | Close current session |

#### Main MCP Methods

- `initialize` - Initialize session
- `tools/list` - List available tools
- `tools/call` - Call tool
- `resources/list` - List resources
- `resources/read` - Read resource
- `prompts/list` - List prompts
- `prompts/get` - Get prompt

#### Resource Namespace

Peta Gateway uses namespaces to isolate resources from different servers:

```
Format: {serverId}::{resourceName}

Examples:
- filesystem::read_file
- database::users
- web-search::search
```

#### Official Documentation

For complete MCP protocol specifications and examples, please refer to:

📚 **[MCP Official Documentation](https://modelcontextprotocol.io/docs/)**

- [Quick Start](https://modelcontextprotocol.io/docs/getting-started/intro)
- [Protocol Specification](https://modelcontextprotocol.io/docs/specification/)
- [Client Implementations](https://modelcontextprotocol.io/docs/tools/clients)

---

### 2. OAuth 2.0 Authentication

Peta Core exposes an OAuth 2.0 authorization server for obtaining access tokens used to authenticate to the `/mcp` gateway.

These endpoints are separate from downstream connector OAuth tokens used by downstream MCP servers to access third-party APIs. Those credentials are brokered internally by Peta Core and are not exposed here.

#### Endpoint List

| Endpoint | Description |
|------|------|
| `POST /register` | Dynamic client registration |
| `POST /token` | Get or refresh access token |
| `GET /authorize` | User authorization page for authorization code flow |
| `POST /introspect` | Check token validity |
| `POST /revoke` | Revoke token |

#### Dynamic Client Registration

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

#### Supported Grant Types

##### 1. Authorization Code Grant with PKCE (Web/Mobile Apps)

**Step 1**: Generate PKCE parameters

```bash
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-43)
CODE_CHALLENGE=$(echo -n $CODE_VERIFIER | openssl dgst -sha256 -binary | base64 | tr -d "=+/" | cut -c1-43)
```

**Step 2**: Get authorization code (open in browser)

```
http://localhost:3002/authorize?
  client_id=your_client_id&
  response_type=code&
  redirect_uri=http://localhost:3000/callback&
  code_challenge=$CODE_CHALLENGE&
  code_challenge_method=S256
```

**Step 3**: Exchange authorization code for token

```bash
curl -X POST http://localhost:3002/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "authorization_code",
    "client_id": "your_client_id",
    "redirect_uri": "http://localhost:3000/callback",
    "code_verifier": "'$CODE_VERIFIER'"
  }'
```

##### 2. Refresh Token

```bash
curl -X POST http://localhost:3002/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "refresh_token",
    "refresh_token": "your_refresh_token",
    "client_id": "your_client_id",
    "client_secret": "your_client_secret"
  }'
```

#### Token Introspection

```bash
curl -X POST http://localhost:3002/introspect \
  -H "Content-Type: application/json" \
  -d '{
    "token": "YOUR_OAUTH_ACCESS_TOKEN",
    "token_type_hint": "access_token"
  }'
```

---

### 3. Admin API

Admin API provides user management, server configuration, IP whitelist, log querying, and other functions.

**Complete Documentation**: 📚 **[ADMIN_API.md](./ADMIN_API.md)**

#### Core Features

| Category | Operations | Permission Required |
|------|---------|---------|
| **User Management** | Create, query, update, delete users | Owner/Admin |
| **Server Management** | Configure downstream MCP servers | Owner/Admin |
| **Capability Configuration** | Manage tool/resource/prompt permissions | Owner/Admin |
| **IP Whitelist** | IP access control | Owner/Admin |
| **Proxy Management** | Proxy configuration and control | Owner/Admin |
| **Backup & Restore** | Database backup and restore | Owner/Admin |
| **Log Management** | Query audit logs | Owner |
| **Cloudflared** | Manage Cloudflare Tunnel | Owner/Admin |

#### Unified Request Format

All admin requests use a **single endpoint** `POST /admin`, distinguished by the `action` field:

```typescript
interface AdminRequest<T = any> {
  action: AdminActionType;  // Operation type (numeric enum)
  data: T;                  // Operation data
}
```

**Example**:
```bash
curl -X POST http://localhost:3002/admin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PETA_ACCESS_TOKEN" \
  -d '{
    "action": 1011,
    "data": { "proxyId": 0 }
  }'
```

#### Quick Reference

| Operation | Action | Description |
|------|--------|------|
| Get User List | `1011` | GET_USERS |
| Create User | `1010` | CREATE_USER |
| Update User Permissions | `1002` | UPDATE_USER_PERMISSIONS |
| Disable User | `1001` | DISABLE_USER |
| Get Server List | `2011` | GET_SERVERS |
| Start Server | `2001` | START_SERVER |
| Get Server Status | `3004` | GET_SERVERS_STATUS |
| Get IP Whitelist | `4002` | GET_IP_WHITELIST |
| Update IP Whitelist | `4001` | UPDATE_IP_WHITELIST |

**Detailed Documentation**: See [ADMIN_API.md](./ADMIN_API.md) for all 80+ admin operations.

---

### 4. User API

User API provides user-facing operations for capability management, server configuration, and session queries.

**Complete Documentation**: 📚 **[USER_API.md](./USER_API.md)**

#### Core Features

| Category | Operations | Permission Required |
|------|---------|---------|
| **Capability Management** | Get/Set user capability preferences | Valid User Token |
| **Server Configuration** | Configure/Unconfigure user-specific servers | Valid User Token |
| **Session Queries** | Get online sessions | Valid User Token |

**Key Features**:
- ✅ Action-based routing (same pattern as Admin API)
- ✅ Transport-agnostic (HTTP + Socket.IO)
- ✅ No role checking (any valid user can access)
- ✅ Shared business logic with Socket.IO layer
- ✅ Real-time capability updates

#### Unified Request Format

All user requests use a **single endpoint** `POST /user`, distinguished by the `action` field:

```typescript
interface UserRequest<T = any> {
  action: UserActionType;  // Operation type (numeric enum)
  data?: T;                // Operation data (optional)
}
```

**Example**:
```bash
curl -X POST http://localhost:3002/user \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "action": 1001
  }'
```

#### Quick Reference

| Operation | Action | Description |
|------|--------|------|
| Get Capabilities | `1001` | GET_CAPABILITIES |
| Set Capabilities | `1002` | SET_CAPABILITIES |
| Configure Server | `2001` | CONFIGURE_SERVER |
| Unconfigure Server | `2002` | UNCONFIGURE_SERVER |
| Get Online Sessions | `3001` | GET_ONLINE_SESSIONS |

**Detailed Documentation**: See [USER_API.md](./USER_API.md) for all 5 user operations.

---

### 5. Socket.IO Real-time Communication

Socket.IO provides bidirectional real-time communication between server and clients.

**Complete Documentation**: 📚 **[SOCKET_USAGE.md](./SOCKET_USAGE.md)**

#### Core Features

- ✅ Server-initiated push notifications
- ✅ Multi-device login support
- ✅ Request-response pattern (similar to RPC)
- ✅ User capability configuration management
- ✅ Online session list synchronization
- ✅ Token authentication
- ✅ Auto-reconnection

#### Connection Example

```typescript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3002', {
  auth: {
    token: 'YOUR_PETA_ACCESS_TOKEN'
  }
});

// Listen for successful connection
socket.on('connect', () => {
  console.log('Connected:', socket.id);
});

// Listen for server notifications
socket.on('notification', (data) => {
  console.log('Notification received:', data);
  // { type: 'system_message', message: '...', timestamp: ... }
});
```

#### Main Events

**Server → Client**:
- `notification` - Notification push
- `ask_user_confirm` - Request user confirmation
- `get_capabilities` - Get capability configuration
- `get_client_status` - Get client status

**Client → Server**:
- `client-info` - Send device information
- `set_capabilities` - Set capability configuration
- `socket_response` - Respond to server request

**Detailed Documentation**: See [SOCKET_USAGE.md](./SOCKET_USAGE.md) for complete API and examples.

---

## Error Handling

### HTTP Status Codes

| Status Code | Description |
|--------|------|
| `200` | Success |
| `400` | Bad Request |
| `401` | Unauthorized (Token invalid or expired) |
| `403` | Forbidden |
| `404` | Not Found |
| `429` | Too Many Requests (Rate limit) |
| `500` | Internal Server Error |

### Standard Error Responses

#### MCP Protocol Error (JSON-RPC 2.0)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "Invalid Request",
    "data": {
      "details": "Missing required parameter"
    }
  }
}
```

**Error Codes**:
- `-32700` - Parse error
- `-32600` - Invalid Request
- `-32601` - Method not found
- `-32602` - Invalid params
- `-32603` - Internal error

#### Admin/User API Error

Admin API and User API both use the same error response format:

```json
{
  "success": false,
  "error": {
    "code": 2001,
    "message": "Server notion not found"
  }
}
```

**Common Error Codes**:
- `1001` - Invalid request
- `1002` - Unauthorized
- `1003` - User disabled / Insufficient permissions
- `2001` - User/Server not found
- `3001` - Server not found / Invalid capabilities
- `5102` - Invalid IP format

See [ADMIN_API.md - Error Code Reference](./ADMIN_API.md#appendix-error-code-reference) for admin error codes.
See [USER_API.md - Error Code Reference](./USER_API.md#appendix-error-code-reference) for user error codes.

#### Authentication Error

```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired token",
  "code": "AUTH_INVALID_TOKEN"
}
```

#### Rate Limit Error

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded",
  "retryAfter": 60,
  "code": "RATE_LIMIT_EXCEEDED"
}
```

---

## Complete Examples

### OAuth + MCP Complete Workflow

```bash
#!/bin/bash

# 1. Obtain an access token
# - OAuth (authorization_code + PKCE): see the OAuth section above
# - Or use a Peta access token (opaque bearer token)
TOKEN="YOUR_OAUTH_ACCESS_TOKEN_OR_PETA_ACCESS_TOKEN"

echo "Token: $TOKEN"

# 2. Initialize MCP session
curl -X POST http://localhost:3002/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "1.0.0",
      "capabilities": {},
      "clientInfo": {
        "name": "cli-client",
        "version": "1.0.0"
      }
    }
  }'

# 3. List available tools
curl -X POST http://localhost:3002/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }'

# 4. Call tool (with namespace)
curl -X POST http://localhost:3002/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "filesystem::read_file",
      "arguments": {
        "path": "/path/to/file.txt"
      }
    }
  }'

# 5. Close session
curl -X DELETE http://localhost:3002/mcp \
  -H "Authorization: Bearer $TOKEN"
```

### Admin API Example

```bash
# Get all users
curl -X POST http://localhost:3002/admin \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": 1011,
    "data": { "proxyId": 0 }
  }'

# Get all server status
curl -X POST http://localhost:3002/admin \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": 3004,
    "data": {}
  }'
```

### User API Example

```bash
# Get user's capability configuration
curl -X POST http://localhost:3002/user \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": 1001
  }'

# Configure a user-specific server
curl -X POST http://localhost:3002/user \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": 2001,
    "data": {
      "serverId": "notion",
      "authConf": [
        {
          "key": "{{NOTION_API_KEY}}",
          "value": "secret_xxx",
          "dataType": 1
        }
      ]
    }
  }'
```

### Socket.IO Example

```typescript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3002', {
  auth: { token: 'YOUR_TOKEN' }
});

socket.on('connect', () => {
  console.log('✅ Connected');
});

socket.on('notification', (data) => {
  if (data.type === 'online_sessions') {
    console.log(`Currently have ${data.data.sessions.length} active sessions`);
  }
});
```

---

## Related Documentation

- **[ADMIN_API.md](./ADMIN_API.md)** - Complete Admin API protocol documentation
- **[USER_API.md](./USER_API.md)** - Complete User API protocol documentation
- **[SOCKET_USAGE.md](./SOCKET_USAGE.md)** - Socket.IO real-time communication documentation
- **[MCP Official Documentation](https://modelcontextprotocol.io/docs/)** - Model Context Protocol standard
- **[OAuth 2.0 RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)** - OAuth 2.0 Authorization Framework
- **[CLAUDE.md](../CLAUDE.md)** - Project architecture and development guide

---

**Version**: 2.0
**Last Updated**: 2025-01-15
**Change Notes**: Refactored into navigation index document, detailed content separated into specialized documents
