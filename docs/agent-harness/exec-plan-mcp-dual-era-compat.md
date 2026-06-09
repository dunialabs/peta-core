# Execution Plan

## Goal

Implement dual-era MCP gateway compatibility: modern upstream clients can use stateless MCP `2026-07-28`, legacy upstream clients keep sessionful behavior, and downstream HTTP servers can be selected as modern or legacy without breaking stdio/SSE legacy servers.

## User-Visible Change

- Existing legacy clients remain usable even if they send non-authoritative modern-looking headers on an established session.
- Operators can set `launchConfig.mcpProtocol` to `auto`, `legacy`, or `modern` for downstream servers.
- HTTP downstream servers can be probed and called with stateless modern MCP when enabled.

## Constraints

- Do not change Prisma schema.
- Do not weaken auth, permission, approval, or audit behavior.
- Preserve existing stdio/SSE legacy downstream behavior.
- Modern downstream support is HTTP-only in this implementation slice.

## Documentation Impact

- Update `docs/api/API.md`, `docs/architecture.md`, `docs/deployment.md`, and `docs/DOCKER_DEPLOYMENT.md`.

## Scope

- Change MCP routing/classification, modern controller mixed-era behavior, downstream client abstraction, server startup protocol selection, targeted tests, and related docs.
- Avoid generated output under `dist/`.

## Risks

- Misrouting malformed modern requests into legacy auth.
- Breaking SDK-backed downstream notification/subscription behavior.
- Incorrect fallback from HTTP modern probe to legacy HTTP/SSE.

## Verification

- Targeted Jest tests for route classification and downstream protocol selection.
- `npm run docs:check`
- `npm run type-check`
- `npm run verify:fast`

## Step Plan

1. Add compatibility-aware upstream classifier behavior.
2. Introduce downstream client interface and SDK wrapper.
3. Add modern HTTP downstream client and protocol selection.
4. Update call sites to use the interface.
5. Add tests for compatibility and downstream selection.
6. Update docs and run verification.

## Open Questions

None. Defaults are: valid session compatibility enabled, runtime downstream profile, no DB migration, HTTP-only modern downstream.
