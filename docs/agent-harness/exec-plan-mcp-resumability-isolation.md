# Execution Plan

## Goal

Restore MCP `Last-Event-ID` resumability through the SDK transport, isolate temporary-server resource subscriptions per downstream instance, and remove the roots notification registration race.

## User-Visible Change

Upstream SSE reconnection uses the SDK-native replay path, temporary personal servers no longer share resource subscription state across users, and roots list change notifications work after initialization without relying on pre-initialize capability timing.

## Constraints

- Preserve upstream MCP compatibility and avoid new protocol fields.
- Do not rework shared managed reverse-request architecture in this patch.
- Keep event IDs backward compatible; do not require event data migration.
- Update the source-of-truth architecture doc in the same task.

## Documentation Impact

- Update `docs/architecture.md`.
- No changes expected for `docs/api/API.md` or `docs/DOCKER_DEPLOYMENT.md` unless implementation reveals incorrect mechanism details there.

## Scope

- `src/mcp/core/ProxySession.ts`
- `src/mcp/controllers/MCPController.ts`
- `src/mcp/core/PersistentEventStore.ts`
- `src/mcp/core/ServerManager.ts`
- `src/mcp/core/GlobalRequestRouter.ts`
- `src/mcp/types/mcp.ts`
- `tests/*.test.js`
- `docs/architecture.md`
- No `dist/` edits.

## Risks

- Resumability depends on transport lifecycle details; bypass paths must be removed cleanly.
- Resource update fan-out must stay scoped to the correct downstream instance.
- ProxySession tests need stable SDK mocks because initialization is transport-driven.

## Verification

- `npm run docs:check`
- `npm run build`
- Targeted Jest for new regression tests
- Full `npm test -- --runInBand`

## Step Plan

1. Reconnect upstream SSE handling to the SDK transport and remove the manual replay path.
2. Make `PersistentEventStore` resolve stream IDs from persisted events instead of parsing event IDs.
3. Scope resource subscriptions and resource-update fan-out by `ServerContext.id`.
4. Register roots list changed notifications without pre-initialize gating.
5. Update architecture docs and run verification.

## Open Questions

- None in scope; reverse-request support remains intentionally disabled for shared managed connections.
