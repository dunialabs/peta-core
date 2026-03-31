# Peta Core Agent Entry Point

Use this file as a routing layer, not as a full manual. Start here, then read the smallest set of deeper docs needed for the task.

## Read Order

1. `START_HERE_FOR_AI.md`
2. `docs/agent-harness/README.md`
3. `docs/source-of-truth.md`
4. The relevant architecture, security, API, or deployment doc
5. The specific code files you plan to change

## Product Snapshot

- Peta Core is the MCP gateway and control-plane runtime in the Peta stack.
- Core responsibilities: upstream MCP compatibility, downstream server lifecycle, OAuth and token flows, policy enforcement, approval workflows, credential injection, and audit logging.
- Runtime shape: Node.js + TypeScript ESM service with Express, Socket.IO, Prisma/Postgres, and MCP transports.

## Repo Map

- `src/mcp/`: gateway core, downstream server management, request routing, cache, transport handling.
- `src/oauth/`: OAuth 2.0 endpoints, token issuance, and related services.
- `src/security/`: auth, permission, and network/policy helpers.
- `src/socket/`: real-time notification and approval channel.
- `src/controllers/`, `src/controllers/handlers/`: external and admin-facing HTTP request handling.
- `src/repositories/`: database access layer.
- `src/config/`: env loading and runtime configuration.
- `prisma/`: schema and migrations. Treat schema changes as cross-cutting work.
- `scripts/`: startup, release, DB bootstrap, and local tooling helpers.
- `docs/`: public-facing architecture, API, security, deployment, and reference docs.
- `CLAUDE.md`, `PROJECT_COLLABORATION.md`, `mcp-tools-guide.md`: deeper internal reference docs.

## Task Routing

- MCP runtime, downstream transports, lazy start, cache, event persistence:
  - `src/mcp/core/*`
  - `src/mcp/services/*`
  - `docs/architecture.md`
  - `CLAUDE.md`

- Authentication, OAuth, permissions, approvals:
  - `src/oauth/*`
  - `src/security/*`
  - `src/middleware/*`
  - `src/mcp/auth/*`
  - `docs/security.md`
  - `docs/api/API.md`

- Admin API, user management, external control surface:
  - `src/controllers/*`
  - `src/controllers/handlers/*`
  - `src/user/*`
  - `docs/api/ADMIN_API.md`
  - `docs/reference.md`

- Socket.IO and real-time workflows:
  - `src/socket/*`
  - `docs/api/SOCKET_USAGE.md`
  - `docs/reference.md`

- Database, audit persistence, schema:
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

## Working Rules

- Prefer minimal, targeted edits over broad rewrites.
- Preserve upstream MCP compatibility and avoid silent contract drift.
- Keep security, approval, and audit behavior explicit; do not weaken guardrails accidentally.
- When changing schema, request/response shapes, auth behavior, deployment flow, or runtime commands, update docs and types in the same task.
- Any change that affects user-visible behavior, API contracts, schema, runtime commands, deployment flow, permissions, approvals, or operator workflow must either update the relevant docs in the same task or explicitly state why no doc update is needed.
- Treat stale documentation as a defect. If you find conflicting docs, update the source-of-truth document first and then reconcile or remove downstream duplicates.
- Avoid touching generated output under `dist/` unless the task explicitly targets built artifacts.
- For non-trivial work, create a short execution plan from `docs/agent-harness/EXEC_PLAN_TEMPLATE.md` before editing.

## Verification

- Docs gate: `npm run docs:check`
- Fast path: `npm run verify:fast`
- Smoke path: `npm run verify:smoke`
- Full path: `npm run verify:full`
- Database changes: also run `npm run db:generate`

## Done Definition

- Behavior change is summarized clearly.
- Relevant verification commands are run, or skipped with a reason.
- Cross-cutting changes update docs, types, and schema artifacts together.
- Documentation impact is accounted for explicitly: docs updated, or a written reason explains why no update was needed.
- Final review covers protocol compatibility, failure paths, observability impact, and rollback/mitigation notes.
