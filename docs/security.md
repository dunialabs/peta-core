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
- Some providers do not issue refresh tokens. Intercom is handled as a long-lived access token plus provider metadata (`intercomRegion`), with runtime validity checks against Intercom's `/me` endpoint instead of refresh-token rotation.

The Admin API (`/admin`) and Socket.IO (`/socket.io`) currently authenticate using Peta access tokens (opaque bearer tokens) validated against the user database.

Administrative authentication rejects missing credentials on protected operations and rejects a present malformed or invalid authorization header on every operation. OAuth client administration (`/oauth/admin/clients`, including list, read, update, and delete) requires an authenticated Owner or Admin. User and server counts also require this role check. The `/admin` exceptions are limited to public owner/proxy lookup for Console login and discovery. First-owner and first-proxy creation are separate local bootstrap operations: each requires a high-entropy `PETA_BOOTSTRAP_SECRET` (at least 32 characters), the matching `X-Peta-Bootstrap-Secret` header, and a loopback TCP peer. Database restore always requires an authenticated Owner or Admin and retains its empty-state transaction guard. Anonymous callers cannot claim the Owner account or invoke setup mutations remotely.

Anonymous Owner lookup is limited to the login fields `userId`, `encryptedToken`, `role`, `status`, `expiresAt`, and `createdAt`; the encrypted envelope supports Console master-password login. Anonymous proxy lookup returns only `id`, `name`, `proxyKey`, `startPort`, and `addtime`; `proxyKey` is a public identifier. Private Owner metadata and proxy webhook/synchronization fields are returned only to authenticated Owner/Admin callers.

Ordinary user-management actions cannot delete or deactivate the system Owner, including batch deletion by proxy. A batch containing the Owner is rejected before changing any user or disconnecting sessions. The existing Owner-only full proxy reset remains an intentional destructive reset operation.

**Security properties**:

- Refresh tokens and client secrets for downstream providers are never forwarded to upstream MCP clients.
- Long-lived credentials remain inside Peta Core; downstream runtimes receive only short-lived access tokens.
- Modern MCP `2025-11-25` accepts bearer tokens only from the `Authorization` header. Query `token` and `api_key` authentication are legacy-only and rejected before modern request handling.
- Modern MCP `2025-11-25` validates a present `Origin` header before authentication to mitigate DNS rebinding. It must exactly match the canonical `PETA_PUBLIC_URL` origin or an `MCP_2026_ALLOWED_ORIGINS` entry, including scheme, host, and effective port. `localhost`, `127.0.0.1`, and `[::1]` remain allowed on any HTTP(S) port; absent `Origin` remains valid for non-browser MCP clients. Malformed, `null`, and non-allowlisted origins receive HTTP 403, and malformed allowlist entries are ignored.
- OAuth access tokens used for modern MCP must carry an audience matching the canonical `/mcp` protected resource. Tokens with the wrong `aud` or persisted resource are rejected.
- OAuth scopes are enforced by modern MCP method family: tools, resources, and prompts require their corresponding `mcp:*` scope.
- Legacy MCP handlers enforce the same OAuth scopes when an OAuth token is used; opaque legacy tokens retain their existing behavior. Legacy server access defaults deny when an administrator has not explicitly granted the server; explicit capability denies are enforced while omitted capability entries inherit the server configuration. Completion requests perform the same server/capability authorization before lazy startup.
- OAuth authorization responses include `iss`, and dynamic client registrations persist `issuer` and `application_type` metadata for auditability and client compatibility.
- Dynamic registration returns a generated secret only for a newly created confidential traditional client. Reused URL-based client registrations and client-information reads expose no stored secret.
- Authorization-code OAuth always requires PKCE `S256`; Peta Core rejects absent or plain challenges and rejects exchanges without the matching verifier.
- Public deployments require `PETA_PUBLIC_URL` to pin OAuth issuer and MCP protected-resource URLs. Forwarded client IP headers are consumed only when the immediate peer is listed in `TRUSTED_PROXY_IPS`; `TRUST_PROXY=true` is rejected at startup. Whitelist lookup failures fail closed with HTTP 503, and the same admission check protects `/user` and Socket.IO.
- URL-based MCP client metadata documents that omit `scope` are registered with the full advertised MCP scope set so OAuth authorization and modern MCP runtime scope checks remain aligned.
- Operational Pino logs and database-backed audit logs apply recursive secret redaction at their respective serialization boundaries. Credential-shaped fields and Bearer or Basic authorization credentials are replaced before output while non-secret error type, message, and stack diagnostics remain available.
- Client-facing MCP, Socket.IO, user, admin, health, and modern authentication error responses keep detailed exception text in server logs and return stable generic messages for internal failures. Expected validation and authorization errors remain actionable without exposing downstream URLs, filesystem paths, provider responses, or command details.
- Permission and server capability records tolerate omitted `tools`, `resources`, and `prompts` maps as empty maps at runtime. Missing maps cannot widen access and are handled as no explicit capability overrides.
- Custom stdio startup failures omit the original command and redact stderr before error responses, audit records, and structured logs. Cloudflared configuration read/update responses omit stored tunnel credentials.
- Cloudflared tunnel IDs are restricted to filename-safe ASCII identifiers (1-128 characters) and resolved credential paths are kept inside the configured cloudflared directory before any file read, write, or delete.
- Log webhooks are restricted to public HTTP(S) hosts without URL credentials or non-default ports. Delivery revalidates the destination, pins each request to a validated address, does not follow redirects, and refuses private, loopback, link-local, reserved, and fake-IP targets.
- Durable MCP replay payloads in `mcp_events` are protocol state rather than audit logs and remain unchanged so `Last-Event-ID` replay is exact; protect database access and retention accordingly.
- Native OAuth clients may register loopback redirect URIs without a port; during authorization, Peta Core accepts the same loopback callback path with an ephemeral local port.
- URL-based OAuth Client ID metadata fetches reject localhost, private, link-local, other SSRF-sensitive addresses, and oversized responses before client metadata is persisted. Hostname-based metadata URLs may resolve to `198.18.0.0/15` in VPN/TUN fake-IP environments, so Core allows that range by default only for resolved hostnames, never for direct IP metadata URLs. Set `OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP=false` to require strictly public DNS results. When DNS returns multiple validated addresses, Core pins each request to one resolved address and tries the next validated address only if the previous connection fails.
- URL-based OAuth Client ID metadata fetches accept only HTTPS port 443, reject redirects, and pin requests to validated public DNS addresses. Local, private, link-local, mapped, and reserved address ranges are rejected before any request is sent.
- URL-based OAuth Client ID fetch failures return a stable public error description; detailed DNS, TLS, and transport diagnostics remain server-side only.
- MCP session reuse requires the original bearer token on every authenticated request. OAuth sessions revalidate signature, expiry, revocation, and user binding; sessions have a bounded absolute lifetime and per-user/global admission caps. Rate limiting occurs before session state is allocated, while `/user` configuration operations and Socket.IO connections/events are also capped.
- Rate-limit bucket tracking has a bounded cardinality and clamps invalid database limits to a safe positive range. When the in-memory bucket cap is exhausted, new identities fail closed until expired buckets are reclaimed.
- Consent pages use a per-response CSP nonce and never accept bearer tokens from URL query parameters. Peta Desk delivers the user credential only through the server-side callback flow. Public OAuth client-information and admin read responses omit stored confidential client secrets; only a newly-created confidential registration returns its secret.
- All HTTP responses set `Referrer-Policy: no-referrer`, reducing accidental propagation of legacy query-token URLs through browser navigation. Legacy MCP query-token authentication remains documented for compatibility; modern MCP rejects it.
- Custom remote MCP server URLs are a separate Owner/operator trust boundary. Peta intentionally allows an Owner to register HTTP(S) targets on loopback or private networks and forwards the configured downstream headers, which supports self-hosted infrastructure but is not safe as an untrusted tenant-controlled URL fetch primitive. Before allowing non-Owner tenants to register or change these URLs, add deployment-appropriate SSRF controls such as destination and egress allowlists, canonical DNS/IP and redirect-hop validation, private/link-local/metadata blocking, and restrictions on forwarded headers.

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

Approval identity preserves all JSON tool arguments, including `null`, empty collections, array positions, and any `_meta` key inside tool-owned data. Object key order alone is normalized. Hash version 2 separates new approval requests from hashes created by the previous lossy normalization: old pending or approved requests cannot authorize a new call and expire on their existing schedule. Clients must request a fresh approval after upgrading. Complete the rollout and restart old workers before relying on this boundary; mixed versions still contain the old behavior on old workers.

On top of static permissions, Peta Core supports tool-level approvals:

- Mark tools as **approval required** based on risk or context.
- Pause execution and route an approval request to Peta Desk via Socket.IO.
- Let humans approve, reject, or request changes before the tool proceeds.
- Optionally require stronger controls (for example additional authentication) for particularly sensitive operations.

This allows agents to run autonomously for routine tasks while keeping humans in control of operations that carry more risk.

---
