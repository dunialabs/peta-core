# Execution Plan

## Goal

Add HubSpot OAuth support for Template servers, covering authorization-code exchange, refresh-token runtime renewal, token env injection, docs, and tests.

## User-Visible Change

Admins and users can configure Template servers with `authType: 15 (HubSpotAuth)` and Peta Core will exchange, persist, refresh, and inject HubSpot access tokens.

## Constraints

- Preserve existing Template OAuth flow contracts and encrypted launchConfig persistence.
- Keep downstream runtimes limited to short-lived access tokens only.
- Avoid provider-specific fields unless HubSpot actually requires them.
- Update source-of-truth API docs with the new enum value.

## Documentation Impact

- Update `docs/api/ADMIN_API.md`.
- Update `docs/api/USER_API.md`.

## Scope

- OAuth types, provider registry, auth strategy factory, and ServerManager auth initialization.
- OAuth-related tests under `tests/`.
- No Prisma or `dist/` changes.

## Risks

- Missing one of the provider switch branches can leave create/configure/start flows inconsistent.
- Incorrect token request encoding would break both code exchange and refresh.
- Test coverage must catch provider mapping and token env injection regressions.

## Verification

- `npm run docs:check`
- `npm run verify:fast`
- Targeted Jest run for new HubSpot tests if needed

## Step Plan

1. Add HubSpot enum/provider/strategy/runtime branches.
2. Add focused tests for exchange, refresh, and startup injection.
3. Update docs and run verification.

## Open Questions

- None; use `accessToken` as the downstream env contract per provided template.
