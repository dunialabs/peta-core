# Peta-Core Deployment Guide

Welcome to Peta Core! This guide will help you quickly deploy the Peta-Core service.

## 📋 Table of Contents

- [System Overview](#system-overview)
- [Quick Start](#quick-start)
- [Requirements](#requirements)
- [Deployment Steps](#deployment-steps)
- [Configuration](#configuration)
- [Usage Guide](#usage-guide)
- [Cloudflared Configuration](#cloudflared-configuration)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)

## 🎯 System Overview

Peta Core is an enterprise-grade **MCP (Model Context Protocol) proxy server** that provides a unified authentication, authorization, and session management layer for AI applications.

### Key Features

- ✅ Transparent MCP protocol proxy with support for multiple downstream servers
- ✅ Complete authentication system (JWT + OAuth 2.0)
- ✅ Rate limiting and IP whitelist protection
- ✅ Event persistence storage with Last-Event-ID reconnection support
- ✅ Socket.IO real-time communication
- ✅ Configuration encryption
- ✅ Dual logging system (Pino operational logs + database audit logs)
- ✅ Request ID mapping to prevent multi-client conflicts
- ✅ Reverse request routing
- ✅ One-click Docker deployment

## 🚀 Quick Start

### One-Click Deployment

Use the automated deployment script to complete all configuration and startup with one command:

```bash
# Download the deployment script
curl -O https://raw.githubusercontent.com/dunialabs/peta-core/main/docs/docker-deploy.sh
chmod +x docker-deploy.sh

# Run the deployment script
./docker-deploy.sh
```

The script will automatically:
1. Check Docker environment
2. Generate random passwords (JWT_SECRET, database password)
3. Create docker-compose.yml and .env files
4. Start all services (PostgreSQL + peta-core + optional peta-auth + Cloudflared)
5. Wait for health checks to pass
6. Display access information

If you are certain you will not use Peta-managed OAuth credentials, you can skip installing and starting `peta-auth`:

```bash
PETA_AUTH_AUTOSTART=false ./docker-deploy.sh
```

### Manual Deployment

If you prefer manual deployment, please refer to the [Deployment Steps](#deployment-steps) section.

## 💻 Requirements

### System Requirements

- **Operating System**: Linux / macOS / Windows (with Docker support)
- **CPU**: 2 cores or more
- **Memory**: 4GB RAM or more
- **Disk**: 10GB available space

### Software Requirements

- **Docker**: 20.10 or higher
- **Docker Compose**: 2.0 or higher

### Port Requirements

Ensure the following ports are not in use:

- `3002` - Peta-Core API service
- `5434` - PostgreSQL database (default, customizable)

## 📦 Deployment Steps

### Option 1: Using Automated Script (Recommended)

```bash
# 1. Download the deployment script
curl -O https://raw.githubusercontent.com/dunialabs/peta-core/main/docs/docker-deploy.sh
chmod +x docker-deploy.sh

# 2. Run the deployment script
./docker-deploy.sh

# 3. Wait for deployment to complete and view access information
```

### Option 2: Manual Deployment

#### 1. Create Deployment Directory

```bash
mkdir peta-core-deployment
cd peta-core-deployment
```

#### 2. Create docker-compose.yml File

```yaml
services:
  # PostgreSQL for peta-core
  postgres:
    image: postgres:16-alpine
    container_name: peta-core-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    ports:
      - '${DB_PORT}:5432'
    volumes:
      - postgres_peta_core:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${DB_USER} -d ${DB_NAME}']
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - peta-network

  # Peta Auth Service (used by peta-core)
  peta-auth:
    image: petaio/peta-auth:latest
    container_name: peta-auth
    restart: unless-stopped
    # Optional: required only when using Peta-managed OAuth credentials
    # Expose this port only when running peta-core on the host machine
    # ports:
    #   - '7788:7788'
    networks:
      - peta-network
    volumes:
      - peta-auth-data:/data

  # Peta Core Service (MCP Gateway)
  peta-core:
    image: petaio/peta-core:latest
    container_name: peta-core
    restart: unless-stopped
    user: root  # Root permission required to access Docker socket
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: ${NODE_ENV}
      DATABASE_URL: ${DATABASE_URL}
      BACKEND_PORT: ${BACKEND_PORT}
      JWT_SECRET: ${JWT_SECRET}
      LOG_LEVEL: ${LOG_LEVEL}
      LOG_PRETTY: ${LOG_PRETTY}
      CLOUDFLARED_CONTAINER_NAME: ${CLOUDFLARED_CONTAINER_NAME}
      PETA_AUTH_AUTOSTART: ${PETA_AUTH_AUTOSTART}
      PETA_CORE_IN_DOCKER: "true"
      SKILLS_DIR: /data/skills
      # Skip database container startup (database is started via docker-compose)
      SKIP_DB_CONTAINER_START: "true"
    ports:
      - '${BACKEND_PORT}:${BACKEND_PORT}'
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Mount Docker socket for starting downstream MCP service containers
      - ./cloudflared:/app/cloudflared  # Shared cloudflared configuration directory
      - ./skills:/data/skills  # Skills storage directory (enables auto host-path detection for child containers)
    networks:
      - peta-network
    healthcheck:
      test: ['CMD-SHELL', 'curl -f http://localhost:$BACKEND_PORT/health']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  # Cloudflared Service
  # Note: restart is set to "no" to prevent auto-start on deployment
  # Cloudflared will be started via API when needed
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: ${CLOUDFLARED_CONTAINER_NAME}
    restart: "no"
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-}
    networks:
      - peta-network
    volumes:
      - ./cloudflared:/etc/cloudflared

volumes:
  postgres_peta_core:
    driver: local
  peta-auth-data:
    driver: local

networks:
  peta-network:
    driver: bridge
```

#### 3. Create .env File

```bash
# ====================================
# Peta-Core Docker Deployment Environment Variables
# ====================================

# -------------------- Environment Configuration --------------------
NODE_ENV=production

# -------------------- Service Port Configuration --------------------
BACKEND_PORT=3002

# -------------------- Database Configuration (for docker-compose) --------------------
DB_USER=peta
DB_PASSWORD=your-database-password-change-in-production
DB_NAME=peta_core_postgres
DB_PORT=5434

# -------------------- Database Connection String --------------------
# Note: Uses Docker Compose service name 'postgres' as hostname (inter-container communication)
# To access database from host, use localhost:5434
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}?schema=public"

# -------------------- JWT Secret Configuration --------------------
# ⚠️ For production, be sure to change to a strong password (at least 32 characters)
JWT_SECRET=your-jwt-secret-change-in-production-min-32-chars

# -------------------- Peta Auth Configuration (Optional) --------------------
# Auto-start peta-auth for Peta-managed OAuth credentials
PETA_AUTH_AUTOSTART=true

# -------------------- Logging Configuration (Pino Logger) --------------------
LOG_LEVEL=info
LOG_PRETTY=false
LOG_RESPONSE_MAX_LENGTH=300

# -------------------- Cloudflared Configuration --------------------
CLOUDFLARED_CONTAINER_NAME=peta-core-cloudflared

# -------------------- HTTPS/SSL Configuration (Optional) --------------------
# ENABLE_HTTPS=false
# SSL_CERT_PATH=/path/to/cert.pem
# SSL_KEY_PATH=/path/to/key.pem
```

#### 4. Start Services

```bash
# Start all services
docker compose up -d

# Check service status
docker compose ps

# View logs
docker compose logs -f
```

#### 5. Access Services

- **API Service**: http://localhost:3002
- **Health Check**: http://localhost:3002/health

## ⚙️ Configuration

### Required Configuration Changes (Production)

```bash
# JWT Secret (random string of at least 32 characters)
JWT_SECRET=$(openssl rand -base64 32)

# Database Password (strong password)
DB_PASSWORD=$(openssl rand -base64 24)
```

### Optional Configuration

#### Peta Auth (optional)

Peta Core supports OAuth-based integrations (for example Google, Notion, GitHub, and Figma). You can either:

1. Use **Peta-managed OAuth credentials** — requires the `peta-auth` service so Peta secrets remain isolated.
2. Use **your own OAuth credentials** — `peta-auth` is not required.

If you are certain you will not use Peta-managed credentials, set `PETA_AUTH_AUTOSTART=false` in `.env` to skip installing and starting `peta-auth`.

#### Port Changes

If default ports are in use, you can modify them in the `.env` file:

```bash
# Modify service ports
BACKEND_PORT=4002          # Core API port (default 3002)
DB_PORT=5435              # Database port (default 5434)
```

**Start Services:**

```bash
# 1. Modify port configuration in .env file
vim .env

# 2. Restart services for changes to take effect
docker compose down
docker compose up -d

# 3. Access services using new ports
# API: http://localhost:4002
```

## 📖 Usage Guide

### Health Check

```bash
# Check service health status
curl http://localhost:3002/health

# Should return:
{
  "status": "healthy",
  "uptime": 12345.67,
  "sessions": {
    "active": 0,
    "total": 0
  },
  "socketio": {
    "onlineUsers": 0,
    "totalConnections": 0
  }
}
```

### OAuth 2.0 Authentication

Peta Core supports OAuth 2.0 authorization code + PKCE for user-interactive clients and refresh tokens for renewal.

For non-interactive automation, you can also authenticate to `/mcp` and `/admin` using a Peta access token (opaque bearer token) associated with a user.

#### Authorization Code Grant with PKCE

Suitable for user-agent applications (Web, mobile apps):

```bash
# 1. Generate code_verifier and code_challenge
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-43)
CODE_CHALLENGE=$(echo -n $CODE_VERIFIER | openssl dgst -sha256 -binary | base64 | tr -d "=+/" | cut -c1-43)

# 2. Get authorization code (open in browser)
open "http://localhost:3002/authorize?client_id=your_client_id&response_type=code&redirect_uri=http://localhost:3000/callback&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"

# 3. Exchange authorization code for access token
curl -X POST http://localhost:3002/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "authorization_code",
    "client_id": "your_client_id",
    "redirect_uri": "http://localhost:3000/callback",
    "code_verifier": "'$CODE_VERIFIER'"
  }'
```

### MCP Protocol Interface

#### Using EventSource Connection

```typescript
const token = "YOUR_ACCESS_TOKEN";
const eventSource = new EventSource(
  `http://localhost:3002/mcp?token=${token}`
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log("Received MCP event:", data);
};
```

#### Calling MCP Tools

```bash
curl -X POST http://localhost:3002/mcp \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "filesystem::read_file",
      "arguments": {
        "path": "/path/to/file.txt"
      }
    }
  }'
```

### API Documentation

For detailed API documentation, please refer to:

- **[API.md](./api/API.md)** - API overview and quick start
- **[ADMIN_API.md](./api/ADMIN_API.md)** - Complete Admin API (80+ operations)
- **[SOCKET_USAGE.md](./api/SOCKET_USAGE.md)** - Socket.IO real-time communication guide

## ☁️ Cloudflared Configuration

The Cloudflared container does not start automatically during deployment (to avoid startup failures), but is defined in docker-compose.yml to provide the runtime environment. Specific configuration (creating tunnels, setting routes, etc.) and startup are completed through peta-core's API. If Cloudflared has been configured before, it will automatically start when the application restarts.

### Configuration Method

Cloudflared configuration is done through the Admin API, with the following interfaces:

- **Update Cloudflared Config** (8001): Create or update tunnel configuration
- **Query Cloudflared Config List** (8002): Query existing configurations
- **Delete Cloudflared Config** (8003): Delete specified configuration
- **Restart Cloudflared** (8004): Restart Cloudflared service
- **Stop Cloudflared** (8005): Stop Cloudflared service

For detailed API interface documentation, please refer to [ADMIN_API.md](./api/ADMIN_API.md).

### Configuration Example

```bash
# Update Cloudflared configuration
curl -X POST http://localhost:3002/admin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "admin.updateCloudflaredConfig",
    "params": {
      "proxyKey": "your-proxy-key",
      "tunnelId": "your-tunnel-id",
      "subdomain": "your-subdomain.example.com",
      "credentials": {
        "TunnelSecret": "your-tunnel-secret"
      }
    }
  }'
```

### Configuration Directory

Cloudflared configuration files are stored in the `./cloudflared` directory, which is mounted to the container's `/etc/cloudflared`. Configuration is automatically generated and managed through the API.

## ❓ FAQ

### Q1: Service fails to start?

**A**: Check if ports are in use:

```bash
# Check port usage
lsof -i :3002
lsof -i :5434

# Stop processes using the ports
kill -9 <PID>
```

### Q2: How to update to the latest version?

**A**: Pull the latest image and restart:

```bash
# Pull latest image
docker compose pull

# Restart services
docker compose up -d

# Verify successful update
docker compose ps
```

### Q3: Database connection failed?

**A**: Check database container status:

```bash
# View database logs
docker compose logs postgres

# Restart database
docker compose restart postgres

# Check database health status
docker compose ps postgres
```

### Q4: How to configure Cloudflared?

**A**: Cloudflared configuration is done through the API, no need to manually edit configuration files. Please refer to the [Cloudflared Configuration](#cloudflared-configuration) section.

## 🔧 Troubleshooting

### View Logs

```bash
# View all service logs
docker compose logs -f

# View specific service logs
docker compose logs -f peta-core
docker compose logs -f postgres
docker compose logs -f cloudflared

# View last 100 lines of logs
docker compose logs --tail 100 peta-core
```

### Restart Services

```bash
# Restart all services
docker compose restart

# Restart specific service
docker compose restart peta-core
docker compose restart postgres
```

### Complete Reset

```bash
# ⚠️ Warning: This will delete all data!
docker compose down -v
docker compose up -d
```

### Health Check

```bash
# Check service health status
curl http://localhost:3002/health

# Check database connection
docker compose exec postgres pg_isready -U peta -d peta_core_postgres
```

## 📊 Monitoring and Maintenance

### Resource Monitoring

```bash
# View container resource usage
docker stats

# View disk usage
docker system df

# Clean up unused resources
docker system prune -a
```

### Regular Maintenance

Recommended weekly tasks:

```bash
# 1. Check logs for anomalies
docker compose logs --since 7d | grep -i error

# 2. Update images
docker compose pull
docker compose up -d

# 3. Backup data (see backup instructions below)
```

### Data Backup

```bash
# Backup PostgreSQL data
docker compose exec postgres pg_dump -U peta peta_core_postgres > backup_$(date +%Y%m%d_%H%M%S).sql

# Restore data
docker compose exec -T postgres psql -U peta peta_core_postgres < backup_20250101_120000.sql
```

## 🔐 Security Recommendations

1. **Change Default Passwords**: For production, be sure to change all default passwords
2. **Use HTTPS**: Configure SSL certificates and enable HTTPS
3. **Firewall Configuration**: Restrict database port (5434) to local access only
4. **Regular Backups**: Set up automatic backup tasks
5. **Log Auditing**: Regularly check access logs
6. **Update Maintenance**: Keep up to date with the latest version

## 📞 Support and Feedback

- **Documentation**: Check the project documentation directory
- **Issue Reporting**: Submit Issues to the project repository
- **API Documentation**: Refer to [docs/api/](./api/) directory

## 📄 License

Peta Core is licensed under the Elastic License 2.0 (ELv2). See the LICENSE file for details.

---

**Enjoy using Peta-Core!** 🎉

If you have any questions, feel free to check the documentation or submit an Issue.
