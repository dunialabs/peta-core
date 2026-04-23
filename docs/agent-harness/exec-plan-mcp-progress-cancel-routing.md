# Execution Plan

## Goal

Fix MCP progress and cancellation routing so shared downstream connections preserve protocol semantics while still routing notifications back to the correct upstream session.

## User-Visible Change

Progress notifications from downstream servers will resume flowing to the correct upstream client with the client's original progress token, and client-side cancellations will cancel the actual downstream in-flight request instead of being dropped.

## Constraints

- Do not modify the vendored MCP SDK source.
- Keep shared managed downstream connections and keep reverse requests disabled.
- Do not add new external API fields or change existing wire shapes.
- Update docs if MCP-facing behavior changes.

## Documentation Impact

- Update `docs/api/API.md` with the progress/cancel forwarding behavior.
- No architecture doc change required unless implementation diverges from current docs.

## Scope

- `src/mcp/core/RequestIdMapper.ts`
- `src/mcp/core/ProxySession.ts`
- `src/mcp/core/ServerManager.ts`
- `docs/api/API.md`
- Focused tests under `tests/`
- No `dist/` edits

## Risks

- Downstream request-id capture must not interfere with transport behavior.
- Retry paths must not leave stale downstream-id mappings behind.
- Shared downstream sessions must not misroute progress across users or sessions.

## Verification

- `npm run docs:check`
- `npm run build`
- Targeted Jest for mapper/proxy/server-manager routing tests
- `npm test -- --runInBand` if time permits, expecting the known Intercom failure to remain unchanged unless separately fixed

## Step Plan

1. Extend request-id mapping to track original progress tokens and downstream request ids.
2. Rewrite outbound progress tokens and capture downstream request ids through a transport wrapper.
3. Route downstream progress using known proxy ids and route upstream cancellations using captured downstream request ids.
4. Remove dead downstream-to-upstream cancellation forwarding and update docs/tests.

## Open Questions

- None in scope.
