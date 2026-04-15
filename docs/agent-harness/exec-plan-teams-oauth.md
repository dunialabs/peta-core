# Execution Plan

## Goal

Add Microsoft Teams OAuth support for Template servers, including authorization-code exchange with PKCE, refresh-token runtime renewal, access-token env injection, docs, and tests.

## User-Visible Change

Admins and users can configure Template servers with `authType: 18 (TeamsAuth)`. Peta Core exchanges the authorization code against Microsoft Entra, persists the Teams OAuth state, refreshes tokens at runtime, and injects `accessToken` into the downstream MCP runtime.

## Constraints

- Preserve existing Template OAuth flow contracts and encrypted launchConfig persistence.
- Keep downstream runtimes limited to short-lived access tokens only.
- Treat Teams as direct/custom-app OAuth only; do not route through Peta-managed OAuth exchange/refresh.
- Keep PKCE handling explicit and limited to first-time code exchange.
- Update source-of-truth API docs alongside the code changes.

## Documentation Impact

- Update `docs/api/API.md`.
- Update `docs/api/ADMIN_API.md`.
- Update `docs/api/USER_API.md`.

## Scope

- Likely changes: `src/types`, `src/utils`, `src/mcp/oauth/providers`, `src/mcp/auth`, `src/mcp/core`, `src/controllers/handlers`, `src/user`, `docs/api`, `tests`.
- Do not change `dist/`, Prisma schema, or unrelated runtime/deployment code.

## Risks

- Missing one Teams branch in create/configure/start flows would leave behavior inconsistent.
- Incorrect request encoding for Microsoft token endpoints would break both code exchange and refresh.
- PKCE verifier must be consumed during exchange but not retained in persisted OAuth state.
- Docs currently have authType drift and must be reconciled while adding Teams.

## Verification

- `npm run docs:check`
- `npm run verify:fast`
- Targeted Jest coverage for Teams OAuth tests if needed

## Step Plan

1. Add Teams enum, provider mapping, and refresh strategy primitives.
2. Wire Teams into owner/user OAuth exchange flows and startup auth initialization.
3. Add Teams tests for provider mapping, strategy refresh, create/configure flows, and env injection.
4. Update API docs and authType references.
5. Run docs/build verification and targeted tests.
6. Self-review OAuth persistence, PKCE handling, and runtime injection behavior.

## Open Questions

- None blocking; treat `accessToken` as the downstream env contract and keep Teams on direct OAuth only.
