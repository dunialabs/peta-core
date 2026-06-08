# Deployment

## Quick Start

### Prerequisites

- Node.js **v18+**
- npm
- Docker and Docker Compose (for PostgreSQL and optional Cloudflare DDNS)

### Local Development

Install dependencies:

```bash
npm install
```

Start the full development environment (gateway + local database):

```bash
npm run dev
```

Start only the backend (if you already have PostgreSQL running):

```bash
npm run dev:backend-only
```

Database helper commands:

```bash
npm run db:start   # Start PostgreSQL via Docker
npm run db:init    # Run migrations and generate Prisma client
npm run db:studio  # Open Prisma Studio
npm run db:reset   # Reset database (destructive)
npm run db:stop    # Stop database services
```

Build for production:

```bash
npm run build
```

To skip Cloudflared in development, set:

```bash
SKIP_CLOUDFLARED=true npm run dev
```

### Production with Docker

Peta Core ships with a shell script that prepares a Docker-based deployment:

```bash
curl -O https://raw.githubusercontent.com/dunialabs/peta-core/main/docs/docker-deploy.sh
chmod +x docker-deploy.sh
./docker-deploy.sh
```

The script will:

1. Validate your Docker environment.
2. Generate random secrets (for example `JWT_SECRET` and a database password).
3. Create a `docker-compose.yml` and `.env` file.
4. Start all services (PostgreSQL, Peta Core, and optional Cloudflared DDNS).
5. Wait for basic health checks.
6. Print connection information and next steps.

You can also adapt the generated files to your own Docker or orchestration setup.

### Production with Node.js/PM2

To run Peta Core directly on Node.js with an existing PostgreSQL database:

```bash
# 1. Clone the repository
git clone https://github.com/dunialabs/peta-core.git
cd peta-core

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and set required values such as DATABASE_URL and JWT_SECRET

# 4. Build
npm run build

# 5. Start the service
npm start
```

For process management in production you can use PM2 with an `ecosystem.config.js` like the following:

```js
module.exports = {
  apps: [
    {
      name: 'peta-core',
      script: './dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        BACKEND_PORT: 3002,
      },
      max_memory_restart: '500M',
      autorestart: true,
      watch: false,
    },
  ],
};
```

Then start Peta Core with:

```bash
pm2 start ecosystem.config.js
```

---

## Configuration

All configuration is set via environment variables (for example in a `.env` file).

### Key Environment Variables

#### Database

| Name           | Required | Default | Description                                                                                                      |
| -------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | ✓        | –       | PostgreSQL connection string, for example `postgresql://user:password@host:5432/peta_mcp_gateway?schema=public`. |

#### Server

| Name            | Required | Default | Description                                               |
| --------------- | -------- | ------- | --------------------------------------------------------- |
| `BACKEND_PORT`  |          | `3002`  | HTTP port that the gateway listens on.                    |
| `ENABLE_HTTPS`  |          | `false` | Enable HTTPS termination in the Node.js process.          |
| `SSL_CERT_PATH` |          | –       | Path to TLS certificate, required if `ENABLE_HTTPS=true`. |
| `SSL_KEY_PATH`  |          | –       | Path to TLS private key, required if `ENABLE_HTTPS=true`. |

For OAuth-based MCP clients, the externally visible Peta Core URL must be stable before production use. Peta Core derives its OAuth issuer and MCP resource from `X-Forwarded-Proto` and `X-Forwarded-Host` when they are present, then falls back to the request protocol and `Host` header. Configure reverse proxies, tunnels, and load balancers to send values such as:

```http
X-Forwarded-Proto: https
X-Forwarded-Host: your-domain.example
```

Do not rely on a `localhost:3002` OAuth registration when moving the same database to a public domain. Third-party MCP/OAuth clients such as ChatGPT, Claude, and Cursor should be configured with the final public `/mcp` URL; localhost and the public domain are different OAuth issuers and may use different client registrations.

#### Authentication

| Name         | Required          | Default | Description                                         |
| ------------ | ----------------- | ------- | --------------------------------------------------- |
| `JWT_SECRET` | ✓ (in production) | –       | Secret used to sign and verify OAuth access tokens (JWT) issued by Peta Core. |

OAuth 2.0 and multi-tenant settings are also configured via environment variables; refer to `../.env.example` and the API docs for the full list.

> For production deployments, treat `JWT_SECRET` as a high-value key: provision it from your secret manager or KMS, never check it into source control, and rotate it according to your organization’s security policies.

#### Peta Auth (optional)

Peta Core supports multiple OAuth-based integrations (for example Google, Notion, GitHub, and Figma). There are two ways to supply OAuth credentials:

1. **Peta-managed credentials** (Peta provides `clientId` and `clientSecret`) — requires the separate `peta-auth` service so Peta secrets are never exposed.
2. **Bring your own credentials** — no `peta-auth` service is required.

If you are certain you will not use Peta-managed credentials, set `PETA_AUTH_AUTOSTART='false'` to skip installing and starting `peta-auth`.

#### Logging

| Name         | Required | Default                      | Description                                           |
| ------------ | -------- | ---------------------------- | ----------------------------------------------------- |
| `LOG_LEVEL`  |          | `trace` (dev), `info` (prod) | Log level: `trace`, `debug`, `info`, `warn`, `error`. |
| `LOG_PRETTY` |          | `true` (dev), `false` (prod) | Enable pretty-printed logs in development.            |

#### MCP Server Management

| Name                  | Required | Default | Description                                                                                      |
| --------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `LAZY_START_ENABLED`  |          | `true`  | Enable lazy loading for MCP servers. When true, servers stay managed in memory, delay startup until first use, and idle/unexpected closes can return them to `Sleeping` for later wake-up. |
| `MCP_2026_ENABLED` | | `false` | Enable stateless MCP `2026-07-28` handling on `/mcp` and `/mcp/public`. Leave disabled until clients and operators are ready. |
| `MCP_2026_SUPPORTED_VERSIONS` | | `2026-07-28` | Comma-separated allowlist of modern MCP protocol versions accepted by the modern adapter. |
| `MCP_2026_ALLOWED_CLIENT_IDS` | | | Optional comma-separated OAuth client allowlist for canary rollout. Empty allows all modern OAuth clients. |
| `MCP_2026_ALLOWED_TENANT_IDS` | | | Optional comma-separated tenant allowlist for canary rollout. Empty allows all tenants. |

Modern MCP support is a runtime flag. Disabling `MCP_2026_ENABLED` rejects modern-looking requests fail-closed before they can fall through to the legacy sessionful MCP surface, without rolling back the additive OAuth metadata migration.

#### Cloudflared DDNS (optional)

| Name               | Required | Default | Description                                         |
| ------------------ | -------- | ------- | --------------------------------------------------- |
| `SKIP_CLOUDFLARED` |          | `false` | Skip Cloudflared setup in development environments. |

For additional environment variables (for example OAuth clients, multi-tenant configuration, or external services), see `../.env.example` and the deployment documentation.

---

## Docker Configuration

The default Docker setup uses the following containers and settings.

### CustomStdio In Docker

When `peta-core` runs with `PETA_CORE_IN_DOCKER=true`, non-`docker` `CustomStdio` commands are executed inside `petaio/mcp-runner:latest`, while explicit `docker` commands keep their original behavior. For the complete behavior and current limitations, see [DOCKER_DEPLOYMENT.md](./DOCKER_DEPLOYMENT.md).

### PostgreSQL

- Container name: `peta-core-postgres`
- Port: `5432`
- Database name: `peta_mcp_gateway`
- User/password: `peta` / `peta123` (⚠️ change these in production)

### Cloudflared DDNS (optional)

- Container name: `peta-core-cloudflared`
- Configuration directory: `./cloudflared`

These values come from the default Docker compose files and can be adjusted to match your environment.

---

## Available Commands

**Development**

```bash
npm run dev              # Watch and run gateway + dev stack
npm run dev:backend-only # Gateway only (use your own DB)
npm run build            # Compile TypeScript to ./dist
npm run rebuild          # Clean and rebuild
```

**Database**

```bash
npm run db:start    # Start PostgreSQL in Docker
npm run db:init     # Apply migrations and generate the Prisma client
npm run db:studio   # Open Prisma Studio
npm run db:reset    # Reset database (destructive)
npm run db:logs     # View database container logs (if available)
npm run db:restart  # Restart database containers (if available)
npm run db:stop     # Stop database containers
```

See `../package.json` for the full list of scripts.

---
