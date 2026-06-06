# MCP 2026-07-28 Support Plan

## Scope

Add support for MCP `2026-07-28` while preserving current MCP `2025-11-25` and earlier clients. This is a dual-era implementation: legacy clients keep using `initialize`, `Mcp-Session-Id`, GET SSE, and the existing `ProxySession` path; modern clients use stateless per-request metadata, POST-only Streamable HTTP, `server/discover`, `subscriptions/listen`, and modern auth requirements.

## Current Evidence

- `package.json` depends on `@modelcontextprotocol/sdk` `^1.25.3`; installed SDK reports `LATEST_PROTOCOL_VERSION` as `2025-11-25`.
- `src/middleware/AuthMiddleware.ts` creates sessions from `initialize` and rejects new non-initialize POSTs.
- `src/mcp/controllers/MCPController.ts` routes POST/GET/DELETE by `Mcp-Session-Id`; GET opens SSE and supports `Last-Event-ID` replay.
- `src/mcp/core/SessionStore.ts` stores `ClientSession`, `ProxySession`, event store, and session logger keyed by session ID.
- `src/mcp/core/ProxySession.ts` uses SDK `Server` plus `StreamableHTTPServerTransport` with `sessionIdGenerator`.
- `src/mcp/core/ServerManager.ts` uses SDK `Client` and initialize-based downstream connections.
- `src/mcp/core/GlobalRequestRouter.ts` forwards downstream sampling/roots/elicitation through session/SSE semantics.
- `src/oauth/services/OAuthService.ts` advertises query bearer support and dynamic registration; modern MCP requires Authorization header bearer use and prefers Client ID Metadata Documents.

## Architectural Decision

Build a new modern protocol adapter beside the legacy adapter. Do not retrofit `ProxySession` into a half-stateless object.

### Rationale

- The legacy path is structurally sessionful and SDK-driven.
- Modern MCP is stateless at the protocol layer; requests must be independently processable.
- Side-by-side adapters make rollback a config flip and avoid breaking existing clients while downstream servers migrate.

## Phase 0: Spec and SDK Verification Spike

### Work

1. Check final MCP `2026-07-28` spec pages and changelog before implementation starts.
2. Upgrade-test `@modelcontextprotocol/sdk` in a throwaway branch or temp workspace.
3. Verify whether SDK exposes final modern schemas/types/transports for:
   - `server/discover`
   - `RequestMetaObject`
   - `HeaderMismatch`
   - `UnsupportedProtocolVersionError`
   - `subscriptions/listen`
   - `InputRequiredResult`
   - `CacheableResult`
4. Decide whether modern ingress should use SDK helpers or hand-rolled HTTP validation.

### Acceptance Criteria

- A short compatibility matrix documents installed SDK behavior versus final spec requirements.
- The chosen implementation path does not depend on SDK `LATEST_PROTOCOL_VERSION` unless it reports `2026-07-28` final.

### Verification

- Run `npm view @modelcontextprotocol/sdk version dist-tags --json` and record latest/dist-tag state.
- Run `node --input-type=module -e "import('@modelcontextprotocol/sdk/types.js').then(m=>console.log(m.LATEST_PROTOCOL_VERSION, m.SUPPORTED_PROTOCOL_VERSIONS))"` and record runtime protocol constants.
- Produce a spike note listing modern schemas usable from SDK and local definitions still required.

### Risk

- SDK `1.29.0` may expose draft-only or split `spec.types` APIs. If unstable, hand-roll the modern HTTP edge and use SDK only for downstream legacy connections.

## Phase 1: Protocol-Era Classifier and Modern Auth Split

### Work

1. Add a strict classifier before `AuthMiddleware` and `MCPController`.
2. Route modern requests when:
   - `MCP-Protocol-Version` is a modern allowlisted version, or
   - method is `server/discover` with modern metadata.
3. Route legacy requests when:
   - request method is `initialize`, or
   - `Mcp-Session-Id` is present, or
   - request is legacy GET/DELETE on `/mcp`.
4. Reject mixed-era signals before either controller runs:
   - modern `MCP-Protocol-Version` plus `Mcp-Session-Id` returns HTTP `400` and JSON-RPC `-32600` with message `Mixed protocol-era signals: modern requests must not include Mcp-Session-Id`.
   - modern `_meta` plus legacy `initialize` returns HTTP `400` and JSON-RPC `-32600`.
   - modern POST plus legacy GET/SSE-only headers such as `Last-Event-ID` returns HTTP `400` and JSON-RPC `-32600`.
5. Fail closed for ambiguous modern-looking malformed requests. Do not silently fall back to legacy.
6. Add `ModernAuthMiddleware` or equivalent that validates principal/scopes without creating `SessionStore` entries.
7. Reject query `token` and `api_key` on modern MCP requests.

### Acceptance Criteria

- Modern requests never create a `ClientSession` or `ProxySession`.
- Malformed modern requests cannot reach the legacy controller.
- Mixed modern/legacy signals fail before auth/session lookup.
- Legacy initialize/session behavior remains unchanged.
- Modern requests with query bearer tokens return an auth error.

### Tests

- `MCP-Protocol-Version: 2026-07-28` with missing `_meta` fails modern with `400`.
- Legacy `initialize` still succeeds and returns `Mcp-Session-Id`.
- Modern request containing `Mcp-Session-Id` returns HTTP `400`, JSON-RPC `-32600`, and does not use that session.
- Missing/ambiguous metadata does not bypass modern validation.

### Manual QA

- `curl -i -X POST /mcp` with modern version plus `Mcp-Session-Id` returns `400` and has no legacy session side effects.
- `curl -i -X POST /mcp` with legacy `initialize` still returns `Mcp-Session-Id` when the modern feature flag is enabled.

## Phase 2: Modern HTTP Validation and Request Context

### Work

1. Implement POST-only modern ingress.
2. Validate request body is a single JSON-RPC request or notification.
3. Validate `Accept` includes `application/json` and `text/event-stream` for requests.
4. Validate required `_meta` fields:
   - `io.modelcontextprotocol/protocolVersion`
   - `io.modelcontextprotocol/clientInfo`
   - `io.modelcontextprotocol/clientCapabilities`
5. Validate headers:
   - `MCP-Protocol-Version` equals `_meta.io.modelcontextprotocol/protocolVersion`
   - `Mcp-Method` equals body `method`
   - `Mcp-Name` equals `params.name` for `tools/call` and `prompts/get`
   - `Mcp-Name` equals `params.uri` for `resources/read`
6. Return correct modern errors:
   - missing required `_meta`: HTTP `400`, JSON-RPC `-32602`
   - header mismatch/missing required header: HTTP `400`, JSON-RPC `-32001`
   - unsupported version: HTTP `400`, JSON-RPC `-32004` with supported/requested data
   - unknown method: HTTP `404`, JSON-RPC `-32601`
7. Build `ModernRequestContext` with principal, tenant, token scopes, client info, client capabilities, protocol version, request id, trace metadata, and audit identifiers.

### Acceptance Criteria

- Modern request validation is complete before any policy, cache, approval, or downstream call executes.
- `_meta` is never trusted for user identity or tenant; token-derived principal is authoritative.
- Notifications return `202 Accepted` when accepted.

### Tests

- Header/body protocol version mismatch returns `-32001`.
- Header/body method mismatch returns `-32001`.
- Missing `Mcp-Name` for `tools/call` returns `-32001`.
- Unsupported version returns `-32004` and supported versions.
- JSON-RPC response body sent by client is rejected.

## Phase 3: Session-Coupling Audit and Service Interfaces

### Work

1. Audit services used by `ProxySession` for assumptions about `ClientSession`, `ProxySession`, `sessionId`, or SSE.
2. Create narrow interfaces so modern flow can reuse:
   - permissions checks
   - user preferences
   - policy evaluation
   - approval service
   - result cache
   - audit logging
   - credential injection
   - discovery index
3. Preserve legacy service behavior. Avoid broad refactors.

### Acceptance Criteria

- Modern tool/resource/prompt operations can be evaluated without a `ClientSession`.
- Audit records include a modern request correlation id even without session id.
- Cache keys do not accidentally share private results across users/tenants.

### Verification

- Add adapter contract tests such as `tests/ModernRequestContextAdapter.test.js` covering permissions, audit correlation, cache key construction, and approval invocation without a `ClientSession`.
- Run a driver that constructs a `ModernRequestContext` directly and calls permission/policy/cache adapters without touching `SessionStore`.
- Assert `SessionStore.getAllSessions()` count is unchanged after read-only modern requests.

### Red Flags

- Any modern code path that calls `SessionStore.createSession`.
- Any permission check that requires `ClientSession` rather than principal/permissions.

## Phase 4: Read-Only Modern MCP Methods

### Work

1. Implement `server/discover`.
2. Implement modern read-only gateway methods:
   - `tools/list`
   - `resources/list`
   - `resources/templates/list`
   - `prompts/list`
3. Return deterministic ordering for lists.
4. Add `ttlMs` and `cacheScope` to all list/template results.
5. Use conservative defaults: `ttlMs: 0`, `cacheScope: "private"`.
6. Filter deprecated/legacy-only capabilities from modern discovery.

### Acceptance Criteria

- `server/discover` advertises supported versions, server info, capabilities, and extensions.
- Modern list methods work without initialize/session.
- Results are stable-sorted and include `ttlMs`/`cacheScope`.
- Legacy `tools/list` behavior is unchanged.

### Tests

- `server/discover` succeeds as first modern request.
- `tools/list` returns no `Mcp-Session-Id` header.
- Lists include `ttlMs` and `cacheScope`.
- Repeated list calls have deterministic order.

## Phase 5: Modern Action Methods Without Reverse-Request Support

### Work

1. Implement modern:
   - `tools/call`
   - `resources/read`
   - `prompts/get`
   - `completion/complete`
2. Bridge to existing downstream `ServerManager` connections internally.
3. Preserve Peta policy, approval, credential injection, audit, and cache behavior.
4. Return `ttlMs`/`cacheScope` on `resources/read` and prompt/resource cacheable outputs as required by spec.
5. Return resource-not-found as JSON-RPC `-32602` in modern path.
6. Reject downstream reverse-request attempts in modern path with a clear modern-incompatible error until MRTR bridge is proven.

### Acceptance Criteria

- Modern clients can call tools/resources/prompts through Peta without session headers.
- Existing downstream legacy MCP servers continue to initialize internally through `ServerManager`.
- Downstream server session details never leak to modern upstream responses.
- Reverse-requesting downstream servers are explicitly blocked or marked incompatible for modern until Phase 8.

### Tests

- Modern `tools/call` happy path against a simple downstream tool.
- Modern denied tool returns policy/audit result correctly.
- Modern `resources/read` missing URI uses `-32602`.
- Modern call does not emit `Mcp-Session-Id`.

## Phase 6: OAuth and Authorization Hardening

### Work

1. Modern MCP accepts bearer tokens only in `Authorization` header.
2. Protected resource metadata uses canonical `/mcp` resource URI.
3. Access tokens include `aud`/resource and validation checks it.
4. `WWW-Authenticate` includes `resource_metadata` and scope guidance.
5. Authorization responses include `iss`; metadata advertises `authorization_response_iss_parameter_supported` when true.
6. Dynamic client registration accepts/stores `application_type`.
7. Persist client registrations keyed by issuer.
8. Add/prefer Client ID Metadata Documents; retain DCR for backward compatibility.
9. Modern protected resource metadata does not advertise query bearer support.
10. Update persistence artifacts for OAuth metadata changes:
   - `prisma/schema.prisma`
   - migrations under `prisma/migrations/`
   - OAuth repositories/services/types
   - token issuance and validation paths
   - generated Prisma client via `npm run db:generate`

### Acceptance Criteria

- Modern token validation rejects wrong-audience tokens.
- Authorization code redirect includes `iss` when enabled.
- DCR `application_type` is stored and surfaced where needed.
- Query token auth remains available only where intentionally legacy/public behavior requires it.
- Existing OAuth clients without new fields remain readable through backward-compatible defaults.

### Tests

- Wrong `aud` token rejected.
- Missing bearer on `/mcp` returns `WWW-Authenticate` with `resource_metadata`.
- Query token modern request rejected.
- Metadata advertises modern bearer methods correctly.
- Migration test confirms old client records can be read after schema change.

### Verification

- Run `npm run db:generate` after schema changes.
- Run migration in a disposable database before canary.
- Add OAuth persistence tests for `application_type`, issuer-keyed lookup, `aud`/resource claim issuance, and backward-compatible reads of pre-migration records.

## Phase 7: Subscriptions

### Work

1. Implement `subscriptions/listen` as long-lived POST response stream.
2. Validate notification filter.
3. Send `notifications/subscriptions/acknowledged` as first SSE event.
4. Include `_meta.io.modelcontextprotocol/subscriptionId` on all subscription notifications.
5. Connect list-changed and resource-updated events to current gateway notification sources.
6. Handle cleanup on stream close, auth expiration, server shutdown, and downstream server removal.
7. Add heartbeat/backpressure behavior appropriate for Express/SSE.
8. Do not support `Last-Event-ID` on modern subscriptions.

### Acceptance Criteria

- Client receives ack first.
- Client receives only requested notification types.
- Closing HTTP response cleans subscription state.
- Legacy GET SSE remains isolated to legacy path.

### Tests

- `subscriptions/listen` ack contains requested supported filters.
- Unrequested event is not sent.
- Resource update includes subscription id.
- Close stream cleans state.

## Phase 8: MRTR Prototype and Optional Enablement

### Work

1. Prototype one downstream reverse-request scenario, preferably elicitation.
2. Determine whether existing downstream SDK calls can be paused and resumed, or whether replay is required.
3. If replay is used, protect `requestState` with HMAC/AEAD and bind to user, method, request digest, and short TTL.
4. If continuation/replay is not reliable, keep modern reverse-requesting downstream servers incompatible and document it.
5. Only advertise MRTR-related capability when proven.

### Acceptance Criteria

- A real downstream reverse-requesting tool can complete through `InputRequiredResult` and retry, or modern path explicitly rejects it and does not advertise support.
- Tampered `requestState` is rejected.
- `requestState` from another user or mismatched method is rejected.

### Verification

- Add a fixture downstream server that triggers `elicitation/create` during `tools/call`.
- Happy path: initial modern `tools/call` returns `resultType: "input_required"`; retry with `inputResponses` returns final tool result.
- Tamper path: modify one byte of `requestState`; retry returns HTTP `400` or JSON-RPC invalid params.
- Cross-user path: replay `requestState` with a different bearer token; retry is rejected.
- If happy path cannot be implemented reliably, add tests proving reverse-requesting downstream servers are rejected and MRTR is not advertised.

### No-Go

- Do not advertise MRTR support if the bridge cannot complete a real flow.
- Do not hold unbounded live continuations waiting for client retry.

## Phase 9: JSON Schema 2020-12 and Tool Metadata

### Work

1. Preserve tool `inputSchema` and `outputSchema` under JSON Schema 2020-12 assumptions.
2. Do not auto-dereference external `$ref` by default.
3. Add validation/resource limits if schemas are validated in-process.
4. Handle `structuredContent` as any JSON value.
5. Validate `x-mcp-header` annotations if modern HTTP clients are expected to mirror tool params into headers through Peta.

### Acceptance Criteria

- Tools with `$defs`, `oneOf`, `anyOf`, `allOf`, and non-object `structuredContent` are preserved or rejected with a documented reason.
- External `$ref` does not trigger network fetch.

### Verification

- Add schema fixture tests such as `tests/ModernJsonSchema202012.test.js` for `$defs`, `oneOf`, `anyOf`, `allOf`, `if/then/else`, and external `$ref`.
- Add a tool-result test where `structuredContent` is a string, number, array, and object.
- Add a test that an external `$ref` URI is not fetched by default.

## Phase 10: Documentation, Observability, and Rollout

### Work

1. Update authoritative docs:
   - `docs/api/API.md`
   - `docs/architecture.md`
   - `docs/security.md`
   - `docs/deployment.md`
2. Add protocol-era matrix and operator config docs.
3. Add metrics/log fields for:
   - protocol era
   - protocol version
   - modern validation error type
   - auth failure reason
   - downstream bridge failure
   - subscription duration/drop reason
   - MRTR result count
4. Add rollout flags:
   - global `MCP_2026_ENABLED`
   - supported modern version allowlist
   - optional tenant/client allowlist
5. Roll out disabled by default until final spec and conformance pass.

### Acceptance Criteria

- Docs explain legacy and modern surfaces without contradiction.
- Operators can disable modern support without schema rollback.
- Dashboards/log queries can distinguish modern and legacy traffic.

### Verification

- Run `npm run docs:check`.
- Add a startup/config test proving `MCP_2026_ENABLED=false` disables modern classifier routing.
- Add a log/metrics assertion in protocol tests that modern requests include protocol era/version fields.
- Manual QA: enable flag, send modern `server/discover`, then disable flag and verify the same request receives disabled/unsupported response while legacy initialize still works.

## Verification Gates

### Automated

1. `npm run docs:check`
2. `npm run build`
3. Targeted protocol tests for modern ingress and legacy compatibility:
   - `tests/ModernProtocolClassifier.test.js`
   - `tests/ModernHttpValidation.test.js`
   - `tests/ModernServerDiscover.test.js`
   - `tests/ModernListCacheableResult.test.js`
   - `tests/LegacyCompatibilityWithModernFlag.test.js`
4. OAuth tests for `iss`, `aud`, resource, and query-token rejection.
5. Subscription tests.
6. MRTR tests only if Phase 8 is enabled.
7. Official MCP conformance suite when final and available.
8. `npm run db:generate` and migration smoke when Phase 6 changes Prisma schema.

### Manual QA

1. `curl` modern `server/discover` without prior initialize.
2. `curl` modern `tools/list` with valid `_meta` and headers.
3. `curl` header mismatch and verify `-32001`.
4. `curl` unsupported protocol and verify `-32004`.
5. `curl` legacy initialize and verify session path still works.
6. Open `subscriptions/listen` and trigger a list-changed notification.

## Rollback

1. Disable `MCP_2026_ENABLED`.
2. Keep legacy routes unchanged.
3. Use additive database changes only for OAuth/client metadata.
4. Keep backward-compatible reads for new OAuth fields.

## Red Flags

- Modern-looking malformed requests route to legacy.
- Any modern response returns `Mcp-Session-Id`.
- Modern auth accepts query tokens.
- MRTR is advertised before a real downstream reverse-request flow passes.
- Modern cache results are public/shared before tenant/user safety is proven.
- SDK draft APIs are treated as final without verification.
