# Peta Core

A control-plane runtime for MCP (Model Context Protocol). Gateway, vault, policy engine, and audit trail for every tool call between AI agents and downstream MCP servers.

![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)
![License](https://img.shields.io/badge/license-ELv2-blue.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)

**Key guarantees:**

- **Credential vault.** Secrets stay encrypted at rest (PBKDF2 + AES-GCM) and are injected server-side at execution time. Clients never see raw credentials.
- **Policy engine.** RBAC/ABAC with per-user, per-tool capability filtering. Optional human-in-the-loop approval for high-risk operations.
- **Audit trail.** Every tool call is logged with caller identity, policy decision, and outcome. Secrets are never included in logs.
- **Managed runtime.** Downstream MCP server lifecycle management with health checks, idle timeouts, and on-demand startup.
- **Protocol compatibility.** Standard MCP upstream and downstream. Existing clients and servers work without modification or custom extensions.
- **Self-hosted.** On-premises deployment model. No hosted SaaS dependency.

[Quick Start](https://peta.io/quick-start) | [Website](https://peta.io) | [Documentation](https://docs.peta.io)

---

## Architecture

![Peta MCP Stack Overview](docs/overview.png)

Peta Core sits between MCP clients (Claude, ChatGPT, Cursor, n8n, or any MCP-compatible client) and downstream MCP servers. From the client's perspective, it connects to a single MCP server. Behind that endpoint, Peta Core routes to multiple downstream servers using standard MCP in both directions.

Peta Core is one component of the Peta MCP stack:

- **Peta Core** (this repository) — MCP gateway, credential vault, policy engine, and audit runtime.
- **Peta Console** — Admin UI for users, servers, policies, and audit logs.
- **Peta Desk** — Desktop client for approval workflows and per-user server configuration.

> This repository contains only Peta Core. See [docs.peta.io](https://docs.peta.io) for the full stack.

---

## Features

### MCP Gateway

- Transparent MCP proxying. Acts as an MCP server upstream and an MCP client downstream. Routes tool calls via namespaced identifiers (`serverId::toolName`).
- Built-in OAuth 2.0 authorization server. Authorization Code with PKCE, refresh tokens, dynamic client registration, token introspection, and revocation.
- Downstream server lifecycle. Lazy start (servers initialize in sleeping state and start on first request), health checks, idle timeouts, and capability caching.
- REST API to MCP converter. Register REST API endpoints as MCP servers — Peta Core translates tool calls to HTTP requests without writing a custom MCP server.
- Skills MCP. Upload skill packages (ZIP with `SKILL.md` metadata) per server. Skills are served as MCP tools and isolated by server ID.

### Credential Vault

- Server-side credential injection. Credentials are decrypted and injected at execution time. They never appear in client configs or prompts.
- Encrypted configuration storage. Server launch configs and per-user configuration blobs are encrypted at rest.
- OAuth token brokerage. Stores downstream OAuth configurations encrypted, refreshes access tokens automatically, and injects them into downstream calls. Refresh tokens are never exposed.

### Policy Engine

- Per-user, per-tool policy evaluation. RBAC/ABAC rules with content-aware capability filtering.
- Human-in-the-loop approvals. Execution pauses for flagged tools and resumes only after an explicit approval or rejection.
- Rate limiting and network controls. Per-user quotas with sliding window enforcement. Optional IP allow-lists per workspace.

### Audit & Observability

- Audit trail. Records caller identity, tool name, policy decision, approval status, and outcome for every tool call. Secrets are excluded from log payloads.
- Structured logging. Pino-based JSON logs with per-module child loggers. Integrates with external log aggregation via webhook.

### Reliability

- Stream resumption. Events are persisted to allow clients to resume via `Last-Event-ID` after disconnection.
- Real-time notification channel. Socket.IO-based push for approval requests, capability updates, and server status changes.

---

## Documentation

- [Architecture & Internals](./docs/architecture.md) — System architecture, request flows, and core design patterns.
- [Security & Permissions](./docs/security.md) — Vault encryption model and the three-layer permission system.
- [Deployment & Configuration](./docs/deployment.md) — Docker, PM2 deployment, and environment variables.
- [Reference](./docs/reference.md) — API surfaces, usage examples, and contributing.

---

## License

Licensed under the [Elastic License 2.0 (ELv2)](./LICENSE).

You may use, modify, and self-host this software. You may not provide it to third parties as a hosted or managed service, remove license key functionality, or obscure licensing notices.

For detailed terms, see the [LICENSE](./LICENSE) file.

Copyright &copy; 2026 [Dunia Labs, Inc.](https://dunialabs.io)
