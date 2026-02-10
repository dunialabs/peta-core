# Security

## Vault Encryption Model

Peta Core is designed for environments where secret material and control must stay inside your own infrastructure. The MCP vault in Core uses a password-based key derivation + authenticated encryption scheme.

### Key derivation (PBKDF2)

- Encryption keys are derived from a secret value (for example, a Peta access token) using PBKDF2 (HMAC-SHA-256) with a per-record random salt.
- The salt is at least 128 bits of randomness and is stored alongside the ciphertext.
- A high iteration count (on the order of 100k+ iterations) is used to make brute-force attempts significantly more expensive.
- The result is a 256-bit key suitable for AES-256-GCM.

### Authenticated encryption (AES-GCM)

- Secret values are encrypted with AES-256-GCM using a fresh IV/nonce for each encryption operation.
- AES-GCM produces both ciphertext and a 16-byte authentication tag.
- On decryption, the authentication tag is verified; if any part of the stored data has been modified, decryption fails and the value is rejected.

### What is stored at rest

For each encrypted secret, the database only stores:

- `salt` (for PBKDF2)
- `iv` / `nonce` (for AES-GCM)
- `ciphertext`
- `authTag`

The input secret and the derived AES keys never leave process memory and are not written to disk. In production, treat any secrets that can decrypt stored configuration blobs as high-value keys: provision them securely, avoid source control, and rotate them according to your organization’s security policies.

---

## OAuth & Token Brokerage

Peta Core handles two distinct OAuth-related concerns:

- **Gateway OAuth 2.0 access tokens (JWT).** Used by MCP clients to authenticate to the `/mcp` gateway. These are issued by Peta Core and can be revoked server-side.
- **Downstream connector OAuth credentials (third-party providers).** Used by downstream MCP servers to call external APIs. Peta Core stores the full OAuth configuration encrypted at rest (including refresh tokens where applicable), refreshes access tokens server-side, and injects only access tokens into the downstream runtime.

The Admin API (`/admin`) and Socket.IO (`/socket.io`) currently authenticate using Peta access tokens (opaque bearer tokens) validated against the user database.

**Security properties**:

- Refresh tokens and client secrets for downstream providers are never forwarded to upstream MCP clients.
- Long-lived credentials remain inside Peta Core; downstream runtimes receive only short-lived access tokens.

---

## Permission Control System

The permission system is the core of Peta Core’s role as an operations and permissions layer for agents.

Instead of baking access rules into each MCP server, you express policy in the gateway and let Peta Core filter what each client can see and do. MCP clients only see the subset of tools, resources, and prompts that are allowed for their identity and context, and every tool invocation is evaluated against those same rules.

### Three-Layer Model

```text
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: MCP Server Level (Global Configuration)            │
│ - Enable/disable entire MCP servers                         │
│ - Configure which tools/resources/prompts are available      │
│ - Set default access permissions for all users               │
└─────────────────────────────────────────────────────────────┘
                          ↓ (filters)
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Admin Level (Per-User Permissions)                 │
│ - Configure which servers a specific user can access         │
│ - Set per-user tools/resources/prompts permissions           │
│ - Further restrict capabilities beyond server-level config   │
└─────────────────────────────────────────────────────────────┘
                          ↓ (filters)
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: User Level (Client-Specific Configuration)         │
│ - User configures which clients can access which servers     │
│ - User can disable specific tools/resources/prompts          │
│ - Final layer of restriction (can only restrict, not expand) │
└─────────────────────────────────────────────────────────────┘
                          ↓ (final filter)
┌─────────────────────────────────────────────────────────────┐
│ Upstream MCP Clients (Claude Desktop, Cursor, etc.)          │
│ - Only see filtered tools/resources/prompts lists            │
│ - Cannot access capabilities not in their filtered list      │
└─────────────────────────────────────────────────────────────┘
```

Peta Core supports a three-layer permission model:

1. **MCP server level (global configuration)**  
   Configured via Peta Console.
   - Enable or disable entire MCP servers.
   - Decide which tools, resources, and prompts are exposed from each server.
   - Set default permissions that apply to all users.

2. **Admin level (per-user permissions)**  
   Configured via Peta Console.
   - Grant or revoke access to individual servers for specific users or workspaces.
   - Grant or revoke specific tools, resources, and prompts within those servers.
   - Further restrict the default server-level configuration.

3. **User level (per-client configuration)**  
   Configured via Peta Desk.
   - Let users choose which MCP clients (for example Claude Desktop or Cursor) can access which servers.
   - Allow users to disable tools, resources, or prompts for their own usage.
   - Users can only narrow permissions; they cannot exceed what administrators have granted.

If any layer disables a capability, it will not appear in capability discovery and direct calls to that capability are rejected.

### How Filtering Works

When an upstream MCP client requests capability lists:

1. **Tools List** (`tools/list`): Gateway returns only tools that pass all three permission layers
2. **Resources List** (`resources/list`): Gateway returns only resources that pass all three permission layers
3. **Prompts List** (`prompts/list`): Gateway returns only prompts that pass all three permission layers

**Result**: Upstream clients only see and can access capabilities they are permitted to use. Any attempt to call a tool or access a resource not in the filtered list will be rejected by the gateway.

### Advanced Tool Call Control

Beyond the three-layer permission system, Peta Core provides additional control mechanisms for tool execution:

#### 1. Client-Side Confirmation

**Configuration**: Set tool `dangerLevel` to `Approval` in server capability configuration.

**Behavior**: When a client attempts to call a tool with `dangerLevel: Approval`, the gateway:

- Pauses the tool call execution
- Sends a confirmation request to Peta Desk via Socket.IO
- Waits for user approval or rejection
- Proceeds with execution only if user confirms

**Use Case**: Tools that modify data or perform sensitive operations.

#### 2. Password-Protected Execution

**Configuration**: Configure stricter control for critical tools (roadmap feature).

**Behavior**: For highly sensitive tools, the gateway can require:

- User to enter a password in Peta Desk
- Additional authentication before tool execution
- Multi-factor confirmation

**Use Case**: Critical operations like deleting data, modifying system configurations, or accessing sensitive resources.

### Permission Merge Logic

The final permission for any capability is calculated as:

```text
Final Permission = Server-Level Enabled
                && Admin-Level User Permission
                && User-Level Client Preference
```

**Key Rules**:

- Each layer can only restrict, not expand permissions
- If any layer disables a capability, it is unavailable to the client
- User preferences are merged with admin permissions (intersection, not union)
- Real-time updates: Changes at any layer immediately affect active sessions

### Human-in-the-Loop Controls

On top of static permissions, Peta Core supports tool-level approvals:

- Mark tools as **approval required** based on risk or context.
- Pause execution and route an approval request to Peta Desk via Socket.IO.
- Let humans approve, reject, or request changes before the tool proceeds.
- Optionally require stronger controls (for example additional authentication) for particularly sensitive operations.

This allows agents to run autonomously for routine tasks while keeping humans in control of operations that carry more risk.

---
