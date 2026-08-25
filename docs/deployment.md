# Deployment

## Quick Start

### Prerequisites

- Node.js **v20+**
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

`.env.example` defaults `PETA_AUTH_AUTOSTART=false`, so local setup does not
start Auth until its separate runtime secrets have been provisioned.

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
2. Generate deployment secrets such as `JWT_SECRET` and a database password; Peta Auth runtime secrets are provisioned separately and are never generated or printed by this script.
3. Create a `docker-compose.yml` and `.env` file.
4. Validate separately provisioned Peta Auth runtime-secret files when Auth is enabled.
5. Start PostgreSQL, Peta Core, optional Peta Auth, and optional Cloudflared DDNS.
6. Wait for basic health checks.
7. Print connection information and next steps.

The default deployment starts Core without Peta Auth and does not require Auth
secret files. Enable it only after provisioning the protected files:

```bash
PETA_AUTH_AUTOSTART=true ./docker-deploy.sh
```

You can also adapt the generated files to your own Docker or orchestration setup.
The coordinated `1.3.0` images are still in pre-publication preparation. Do not
install or update to that version until the Core, Console, and Auth manifests
are available for both `linux/amd64` and `linux/arm64`. After publication, pin
Peta Core with `PETA_VERSION=1.3.0` rather than the moving `latest` tag. Auth
remains independently pinned with `PETA_AUTH_VERSION=1.3.0`, so a Core rollback
does not change Auth; the complete Compose example and rollback steps are in
[DOCKER_DEPLOYMENT.md](./DOCKER_DEPLOYMENT.md).

#### Release publication controls

Core publishes exactly the semantic version in `package.json`; the release
script refuses `latest`, date tags, custom aliases, an existing tag, or a tag
whose registry state cannot be read. Before an operator runs it, Docker Hub
must enforce server-side immutability for semantic-version tags:

```bash
PETA_RELEASE_PUSH=1 \
DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled \
PETA_RELEASE_GIT_SHA="$(git rev-parse HEAD)" \
./docker-build-push.sh --non-interactive
```

The command requires the lowercase 40-character SHA of `HEAD`, rejects tracked
changes, and sends only `git archive` output for that commit to Docker. It
succeeds only after the pushed manifest has a `sha256` digest and contains both
`linux/amd64` and `linux/arm64`. GHCR publication is disabled for
this coordinated release because it is outside that Docker Hub policy boundary.

`scripts/release-main.js publish` is unconditionally disabled and performs no
source push, Docker push, Git tag creation, or GitHub Release creation. Push
reviewed source commits through the normal Git flow and publish the immutable
semver Docker image with the command above. Public tags and GitHub Releases
require a separately approved operator process after the exposed Console TLS
credential is revoked, replaced, and the replacement deployment is verified;
repository-local evidence files are not accepted as authorization.

#### Peta Auth runtime secrets (Docker)

The coordinated `1.3.0` Docker contract keeps Peta Auth on the private Compose network. Do not publish host port `7788`. When Peta-managed OAuth credentials are enabled, Compose must provide exactly these secrets to `peta-auth` and to no other service:

- `peta_auth_master_key`: raw 32-byte key.
- `peta_auth_client_secrets_json`: encrypted JSON produced by the Peta Auth provisioning flow.

The service receives them read-only at `/run/secrets/peta_auth_master_key` and `/run/secrets/peta_auth_client_secrets_json`, with `PETA_AUTH_MASTER_KEY_FILE` and `PETA_AUTH_CLIENT_SECRETS_FILE` set to those paths. Provision the source files separately under a protected directory (default `./secrets/`, resolved from the directory where `docker-deploy.sh` is run), using `PETA_AUTH_MASTER_KEY_SOURCE` and `PETA_AUTH_CLIENT_SECRETS_SOURCE`; the JSON file defaults to `peta_auth_client_secrets.json`. Both sources must be regular, current-user-owned files (not symbolic links) with owner-only permissions, such as mode `0400` or `0600`; the JSON file must be non-empty. Each source file's immediate parent must be a current-user-owned, non-symlink directory without group/other write permission; the installer does not constrain higher ancestors, so separately provisioned absolute paths remain supported. Never put their contents in `.env`, source control, logs, or command output. The installer and `.env.example` default `PETA_AUTH_AUTOSTART=false`; set it to `true` only after these files are valid.

Rotate or roll back these files separately from the deployment config: retain a protected previous pair, replace both files atomically, recreate only `peta-auth`, and verify Core-to-Auth connectivity on the Compose network. On rollback, restore the previous pair and recreate only `peta-auth`; do not remove `peta-auth-data`, the database volume, or expose `7788`.

Use `PETA_VERSION` for a Core-only image rollback and keep
`PETA_AUTH_VERSION=1.3.0`; changing Auth requires an explicit
`PETA_AUTH_VERSION` override.

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
| `PETA_PUBLIC_URL` |          | –       | Canonical public origin for OAuth issuer and `/mcp` protected-resource URLs, for example `https://peta.example.com`. |
| `TRUST_PROXY` |          | –       | Explicit Express trusted-proxy setting (IP/subnet list, hop count, `true`, or `false`) controlling whether forwarded host/proto headers are accepted. |

For OAuth-based MCP clients, the externally visible Peta Core URL must be stable before production use. Public deployments require `PETA_PUBLIC_URL` to pin the canonical public origin, or a trusted proxy configured through `TRUST_PROXY` that supplies `X-Forwarded-Proto` and `X-Forwarded-Host`. Without either, Peta Core accepts raw `Host` only for localhost and loopback development addresses. Configure reverse proxies, tunnels, and load balancers to send values such as:

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

| Name                                  | Required | Default | Description |
| ------------------------------------- | -------- | ------- | ----------- |
| `OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP` |          | `true`  | Allow hostname-based URL client metadata documents to resolve to VPN/TUN fake-IP addresses in `198.18.0.0/15`. Direct IP metadata URLs and real private/localhost/link-local targets are still rejected. Set to `false` for deployments that require strictly public DNS results. |

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
| `MCP_2026_DOWNSTREAM_ENABLED` | | same as `MCP_2026_ENABLED` | Enable probing and use of stateless MCP `2026-07-28` for HTTP downstream servers when `launchConfig.mcpProtocol` is `auto` or `modern`. |
| `MCP_2026_SUPPORTED_VERSIONS` | | `2026-07-28` | Comma-separated allowlist of modern MCP protocol versions accepted by the modern adapter. |
| `MCP_2026_ALLOWED_ORIGINS` | | | Optional comma-separated exact `http(s)://host[:port]` origins allowed for a present modern browser `Origin`; malformed entries are ignored. `localhost`, `127.0.0.1`, and `[::1]` are always allowed with any HTTP(S) port. |
| `MCP_2026_ALLOWED_CLIENT_IDS` | | | Optional comma-separated OAuth client allowlist for canary rollout. Empty allows all modern OAuth clients. |
| `MCP_2026_ALLOWED_TENANT_IDS` | | | Optional comma-separated tenant allowlist for canary rollout. Empty allows all tenants. |

Modern MCP support is a runtime flag. Disabling `MCP_2026_ENABLED` rejects sessionless modern-looking upstream requests fail-closed before they can fall through to the legacy sessionful MCP surface, without rolling back the additive OAuth metadata migration. Active legacy sessions continue using the legacy path.

After a request is classified as modern MCP, Streamable HTTP validates a present `Origin` before mixed-era rejection, method rejection, and authentication. Missing `Origin` remains valid for non-browser MCP clients. A valid browser origin must use `http` or `https` and exactly match the canonical `PETA_PUBLIC_URL` origin or an explicitly configured `MCP_2026_ALLOWED_ORIGINS` entry, including scheme, host, and effective port. `localhost`, `127.0.0.1`, and `[::1]` remain valid at any HTTP(S) port; malformed, `null`, or other origins receive HTTP 403.

Downstream server launch configs may set `mcpProtocol` to `auto`, `legacy`, or `modern`. The default `auto` probes HTTP downstream servers for modern MCP when `MCP_2026_DOWNSTREAM_ENABLED=true`. Transport or legacy-compatible probe failures fall back to the legacy SDK HTTP/SSE path, while recognized modern protocol errors received from a downstream (`-32020`, `-32021`, or `-32022`) fail closed rather than silently changing protocol eras. Set `legacy` to skip probing. Set `modern` only for HTTP downstream servers that must use stateless MCP `2026-07-28`; its URL is treated as Streamable HTTP even when the path includes `/sse` or `/events`. An explicit `type: "sse"` takes precedence over protocol-era inference and is rejected with `mcpProtocol: "modern"`. Non-HTTP modern configs are rejected. The gateway currently does not emit `-32021` for its own ingress metadata validation; missing `clientCapabilities` is `-32602`.

For local compatibility verification, `npm run compat:smoke` starts fixture downstream MCP servers and a temporary Peta Core instance, seeds isolated `compat-smoke-*` server records, and performs real `/mcp` calls across legacy and modern upstream/downstream combinations. It requires `PETA_COMPAT_OWNER_TOKEN` and `JWT_SECRET`, plus a reachable database configured through `DATABASE_URL`; use `PETA_COMPAT_BACKEND_PORT` or `--backend-port` to choose its port. The generated `scripts/compat-smoke/report.json` is a local diagnostic artifact and is not committed.

`mcpProtocol=modern` is HTTP-only. It supports stateless requests and response SSE correlation, not a persistent downstream modern subscription/progress/cancel bridge; retain `legacy` for stdio or SSE downstreams.

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
