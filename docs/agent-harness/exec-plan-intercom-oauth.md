# Execution Plan

## Goal

Add Intercom OAuth support for template servers, including authorization-code exchange, region discovery, runtime token validation, invalid-token cleanup, and downstream env injection.

## User-Visible Change

Admins and users can configure template servers with `authType: 16 (IntercomAuth)`. Peta Core exchanges the authorization code for an Intercom access token, stores the Intercom region, injects `accessToken` and `intercomRegion` into the downstream runtime, and disables or disconnects servers when the Intercom token is no longer valid.

## Constraints

- Preserve existing OAuth exchange boundaries in `src/mcp/oauth`
- Keep Intercom-specific metadata lookup out of generic OAuth exchange types
- Do not add Peta-managed Intercom client support
- Keep invalid-token handling explicit and avoid weakening existing auth/runtime guardrails
- Update source-of-truth docs for API/security behavior changes

## Documentation Impact

- Update `docs/api/API.md`
- Update `docs/security.md`
- Update `docs/api/ADMIN_API.md`
- Update `docs/api/USER_API.md`

## Scope

- Likely changes: `src/types`, `src/utils`, `src/mcp/oauth/providers`, `src/mcp/auth`, `src/mcp/core`, `src/controllers/handlers`, `src/user`, `docs/api`, `docs/security.md`, `tests`
- Avoid changing `dist/` and unrelated runtime/config code

## Risks

- Hidden coupling between startup auth, token refresh timers, and server lifecycle cleanup
- Regressing mirrored admin/user OAuth configuration flows
- Incorrectly classifying transient Intercom API failures as token revocation
- Leaving docs and enum references inconsistent

## Verification

- `npm run docs:check`
- `npm run verify:fast`
- Targeted Jest coverage for Intercom exchange/helper/strategy/handler/runtime wiring

## Step Plan

1. Add Intercom enum/provider/helper/strategy primitives
2. Integrate Intercom into handler persistence and server runtime flows
3. Add invalid-token cleanup behavior and env injection
4. Update docs
5. Run targeted tests and fast verification
6. Self-review auth/error-path behavior

## Open Questions

- None blocking for implementation; use the existing 30-day synthetic expiry window only as the next validation schedule.
