# START_HERE_FOR_AI

This file is the shortest path for a new agent session to understand how to work safely in `peta-core`.

## What This Repo Is

Peta Core is the backend MCP gateway in the Peta stack. It sits between upstream MCP clients and downstream MCP servers, enforcing authentication, policy, approvals, credential injection, runtime supervision, and audit logging.

## What Matters Most

- Upstream MCP compatibility must remain stable.
- Security, approval, and token-handling behavior must not regress.
- Auditability matters: gateway actions need logs, traceability, and predictable failure behavior.
- Runtime and deployment changes have operator impact and usually need documentation updates.
- Documentation freshness matters. Do not leave behavior, API, security, or deployment docs stale after changing the code.

## Read Based On Task

- Gateway/runtime behavior:
  - `src/mcp/core/*`
  - `src/mcp/services/*`
  - `docs/architecture.md`
  - `CLAUDE.md`

- Auth, OAuth, policy, approvals:
  - `src/oauth/*`
  - `src/security/*`
  - `src/middleware/*`
  - `src/mcp/auth/*`
  - `docs/security.md`
  - `docs/api/API.md`

- Admin API and management flows:
  - `src/controllers/*`
  - `src/controllers/handlers/*`
  - `src/user/*`
  - `docs/api/ADMIN_API.md`
  - `docs/reference.md`

- Socket.IO and real-time notifications:
  - `src/socket/*`
  - `docs/api/SOCKET_USAGE.md`

- Database and persistence:
  - `prisma/schema.prisma`
  - `src/repositories/*`
  - `docs/architecture.md`
  - `docs/reference.md`

- Runtime, startup, and deployment:
  - `src/config/*`
  - `src/index.ts`
  - `scripts/*`
  - `Dockerfile`
  - `docker-compose.yml`
  - `docs/deployment.md`
  - `docs/DOCKER_DEPLOYMENT.md`

## Known Hot Spots

- `src/mcp/core/*` often has hidden coupling between session routing, server lifecycle, and capability filtering.
- `src/oauth/*` and `src/security/*` are high-risk areas; small changes can alter auth semantics or token scope.
- `prisma/schema.prisma` is a contract, not just an implementation detail.
- `dist/` is build output and should usually be left alone.
- Some older internal references still live in `CLAUDE.md`; prefer the current docs under `docs/` when they cover the same topic.

## Default Agent Workflow

1. Read `AGENTS.md`.
2. Read only the task-specific files and docs.
3. For non-trivial tasks, fill out an execution plan from `docs/agent-harness/EXEC_PLAN_TEMPLATE.md`.
4. Decide which source-of-truth docs are affected.
5. Make the smallest viable change.
6. Update the relevant docs while context is fresh, or record why no update is needed.
7. Run the cheapest useful verification path first.
8. Self-review with `docs/agent-harness/SELF_REVIEW_TEMPLATE.md` before handoff.

## Useful Commands

- `npm run dev`
- `npm run docs:check`
- `npm run verify:fast`
- `npm run verify:smoke`
- `npm run verify:full`
- `npm run db:start`
- `npm run db:generate`
