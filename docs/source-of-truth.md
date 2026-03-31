# Source Of Truth

This file defines which documents are authoritative for each class of information in `peta-core`.

If a change affects one of these areas, update the source-of-truth document first. Other docs should summarize or reference it rather than silently diverge.

## Product And Agent Entry

- Agent workflow and editing rules:
  - `AGENTS.md`
- New-session onboarding for coding agents:
  - `START_HERE_FOR_AI.md`
- Reusable execution and review workflow:
  - `docs/agent-harness/*`

## Architecture And Internal Design

- Public architecture and request flow overview:
  - `docs/architecture.md`
- Deep internal implementation notes and patterns:
  - `CLAUDE.md`
- Tool capability catalog and internal collaboration guidance:
  - `mcp-tools-guide.md`
  - `PROJECT_COLLABORATION.md`

## Security, Auth, And Permissions

- Security model, vault, permission layers, and approvals:
  - `docs/security.md`
- OAuth and MCP-facing auth details:
  - `docs/api/API.md`

## API And Protocol Behavior

- MCP and OAuth interface behavior:
  - `docs/api/API.md`
- Admin operation behavior:
  - `docs/api/ADMIN_API.md`
- Socket.IO event behavior:
  - `docs/api/SOCKET_USAGE.md`
- Cross-surface examples and usage notes:
  - `docs/reference.md`

## Runtime And Deployment

- Local development and high-level operator guidance:
  - `README.md`
- Runtime configuration and deployment behavior:
  - `docs/deployment.md`
- Docker-specific deployment behavior:
  - `docs/DOCKER_DEPLOYMENT.md`

## Database And Persistence

- Prisma schema and actual data model contract:
  - `prisma/schema.prisma`
- Persistence architecture, audit/event flow, and cache behavior:
  - `docs/architecture.md`
  - `docs/reference.md`

## Rules For Updates

- When code and docs disagree, code is not automatically the source of truth. Update the authoritative doc in the same task.
- If multiple docs describe the same thing, keep one authoritative file and turn the others into references, summaries, or delete candidates.
- If a task intentionally leaves a doc stale, record that explicitly in the self-review or handoff note. Silent drift is not acceptable.
- Run `npm run docs:check` before handoff for code changes that may affect API behavior, security, schema, runtime operations, or core architecture.
