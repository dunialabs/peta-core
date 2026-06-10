# Execution Plan

## Goal

Build and run a real-call smoke harness for Peta Core's dual-era MCP gateway compatibility layer.

## User-Visible Change

Operators get a repeatable local command that starts fixture downstream MCP servers, configures temporary `compat-*` gateway servers, and verifies legacy and modern upstream calls through the real `/mcp` endpoint.

## Constraints

- Do not change core gateway behavior while building the harness.
- Keep test data isolated with a `compat-*` prefix and clean it up where possible.
- Use real HTTP calls for upstream verification; unit tests are not enough for this task.
- Preserve existing auth semantics: legacy uses the Peta token, modern uses an OAuth bearer token with matching audience and scopes.
- Do not persist secrets in files.

## Documentation Impact

This is an operator/test harness addition. The execution plan documents scope. Public API docs are not changed because no protocol behavior changes are intended.

## Scope

- Add `scripts/compat-smoke/*` fixtures and runner.
- Read existing Prisma schema, MCP transport code, and auth validation code as needed.
- Avoid editing `src/` unless the smoke run reveals a gateway defect that must be fixed separately.

## Risks

- Harness failures may come from environment setup rather than protocol behavior.
- Modern OAuth failures can mask routing failures if the generated token has the wrong audience.
- Legacy SDK fixture behavior must match the installed SDK version.
- Temporary DB records must not collide with real operator-managed server ids.

## Verification

- Run the smoke runner against a local Peta Core instance with `MCP_2026_ENABLED=true` and `MCP_2026_DOWNSTREAM_ENABLED=true`.
- Review the generated report for upstream status, headers, downstream fixture logs, and cleanup status.
- Run a build/type-check only if the harness introduces TypeScript changes; this harness is JavaScript ESM.

## Step Plan

1. Inspect runtime, env, schema, and transport/auth code.
2. Implement fixture servers and smoke runner.
3. Start peta-core with modern flags and run real `/mcp` requests.
4. Capture failures and distinguish harness/environment issues from gateway defects.
5. Summarize results and any recommended fixes.

## Open Questions

None before first local run. The owner token was supplied by the user for this test environment.
