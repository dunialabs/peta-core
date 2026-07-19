# Execution Plan

## Goal

Validate and resolve GitHub issues #15 and #16, including equivalent code paths that share the same root causes, then publish the verified fixes and close the issues with evidence.

## User-Visible Change

- Permission replacements always persist, including empty-map server entries and disabled override-key changes; active sessions receive conservative list invalidation when inherited visibility may change.
- Multiple downstream servers may report the same MCP name without colliding in health reporting, persisted operator metadata, or client capability aggregation.

## Constraints

- Preserve MCP protocol compatibility and existing server identifiers.
- Do not weaken permission, approval, authentication, or audit behavior.
- Keep operator-supplied server names stable unless an explicit contract says otherwise.
- Avoid schema changes unless runtime evidence proves they are necessary.

## Documentation Impact

- Review `docs/api/ADMIN_API.md` for permission-update semantics.
- Review `docs/architecture.md` and `docs/reference.md` for server identity and health behavior.
- Update only documents whose published contract changes or is currently misleading.

## Scope

- Permission comparison and admin user-update flow.
- Downstream connection metadata, server registries, capability aggregation, and `/health` serialization.
- Focused regression tests and affected source-of-truth documentation.
- Do not edit generated `dist/` output.

## Risks

- False-positive permission-change notifications or unnecessary cache invalidation.
- Changing display names in a way that breaks existing clients.
- Fixing `/health` while leaving a second name-keyed collision elsewhere.

## Verification

- Failing-first regression tests for both reports and sibling patterns.
- Targeted test execution, `npm run docs:check`, and repository verification.
- Manual API/runtime exercise for the observable permission and duplicate-name behavior.

## Step Plan

1. Inventory current GitHub and repository state.
2. Reproduce and classify both reports.
3. Trace all shared callers and name-keyed registries.
4. Implement the smallest shared fixes and update affected docs.
5. Run targeted, fast, full, and manual verification as risk requires.
6. Self-review, commit atomically, push, and close each issue with evidence.

## Resolved Decisions

- `serverId` remains the stable identifier across runtime registries, permissions, namespaces, and health output.
- Downstream `serverInfo.name` is display metadata only and may fill a blank configured label without replacing an operator-supplied name.
