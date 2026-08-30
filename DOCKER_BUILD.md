# PETA Core - Docker Build Guide

This document explains how to build and push Docker images for PETA Core (MCP Gateway).
The `petaio/mcp-runner` image used by Docker-deployed `CustomStdio` servers is built and released separately from this repository.

## Prerequisites

- Docker Desktop installed and running
- Docker Buildx enabled (included by default in Docker Desktop)
- Docker Hub account logged in

## Build Architecture

PETA Core supports multi-architecture builds:
- `linux/amd64` - Intel/AMD servers
- `linux/arm64` - ARM servers (Apple Silicon, etc.)

## Quick Start

### 1. Login to Docker Hub

```bash
docker login
```

### 2. Build and Push Image

```bash
cd /path/to/peta-core

# Publish only the package.json semantic version after enabling Docker Hub's
# server-side immutable-tag policy for semantic versions.
PETA_RELEASE_PUSH=1 \
DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled \
PETA_RELEASE_GIT_SHA="$(git rev-parse HEAD)" \
./docker-build-push.sh --non-interactive
```

## Build Details

### Dockerfile Structure

The image uses multi-stage builds:

1. **base** - Base environment (Node.js 20 Alpine + PostgreSQL client)
2. **builder** - Build stage (install dependencies, generate Prisma Client, compile TypeScript)
3. **production** - Production environment (copy build artifacts, install production dependencies)

### Included Components

The image includes the following components:
- TypeScript compiled code (/app/dist)
- Prisma ORM and database scripts
- MCP tools and proxy service
- Unified database initialization script

### Startup Process

When the container starts, it executes in the following order:

1. Run database initialization script (`scripts/unified-db-init.js`)
   - Generate Prisma Client
   - Run database migrations
2. Start MCP Gateway service (`dist/index.js`)
   - Listen on port 3002
   - Provide /admin management interface
   - Provide /health health check interface

## Advanced Usage

### Build Specific Architecture Locally

```bash
# Build AMD64 only without publishing
docker buildx build --platform linux/amd64 -t bcdunia/peta-core:1.3.0 --load .

# Build ARM64 only without publishing
docker buildx build --platform linux/arm64 -t bcdunia/peta-core:1.3.0 --load .
```

### Local Build (No Push)

```bash
# Build to local Docker
docker buildx build --platform linux/amd64 -t bcdunia/peta-core:1.3.0 --load .

# View local images
docker images | grep peta-core
```

### Background Build and View Logs

```bash
# Start background build
nohup env PETA_RELEASE_PUSH=1 DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled PETA_RELEASE_GIT_SHA="$(git rev-parse HEAD)" ./docker-build-push.sh --non-interactive > /tmp/build-core-$(date +%s).log 2>&1 &

# View build progress
tail -f /tmp/build-core-*.log
```

### Tag Policy

The publication script rejects `latest`, date tags, custom aliases, existing
tags, unreadable registry state, non-`HEAD` SHAs, and tracked changes. It builds
only the committed `git archive` tar stream, so untracked and ignored files are
not publication input. Change `package.json` through the reviewed release
preparation flow instead of passing a custom tag.

## Verify Build

### Check Image Details

```bash
# View architectures supported by the immutable release image
docker buildx imagetools inspect bcdunia/peta-core:1.3.0
```

Example output:
```
Name:      docker.io/bcdunia/peta-core:1.3.0
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:da979aad645340c4d1e24d718ea6a50cf32a196c2978f5ea60b71f581896d8f6

Manifests:
  Name:      docker.io/bcdunia/peta-core:1.3.0@sha256:3aabc6a...
  Platform:  linux/amd64

  Name:      docker.io/bcdunia/peta-core:1.3.0@sha256:645402d...
  Platform:  linux/arm64
```

### Local Test Run

```bash
# Pull the release image
docker pull bcdunia/peta-core:1.3.0

# Run container (requires environment variable configuration)
docker run -d \
  --name peta-core-test \
  -p 3002:3002 \
  -e DATABASE_URL="postgresql://user:password@host:5432/dbname" \
  -e PROXY_KEY="your-proxy-key" \
  bcdunia/peta-core:1.3.0

# View logs
docker logs -f peta-core-test

# Test health check
curl http://localhost:3002/health
```

## Environment Variable Configuration

The following environment variables are required when the image starts:

### Required Variables

- `DATABASE_URL` - PostgreSQL connection string
  ```
  postgresql://username:password@host:port/database
  ```

### Optional Variables

- `PROXY_KEY` - Proxy key (auto-generated if not set)
- `BACKEND_PORT` - Service listening port (default: 3002)
- `NODE_ENV` - Runtime environment (default: production)
- `MAX_CONNECTIONS` - Maximum database connections
- `ENABLE_METRICS` - Whether to enable metrics collection
- `LOG_LEVEL` - Log level (debug/info/warn/error)

### Database Related Variables

You can also use separate database variables (will be automatically combined into DATABASE_URL):
- `DB_HOST` - Database host
- `DB_PORT` - Database port (default: 5432)
- `DB_USER` - Database username
- `DB_PASSWORD` - Database password
- `DB_NAME` - Database name

## Service Interfaces

After the container starts, it provides the following interfaces:

### Health Check
```bash
GET http://localhost:3002/health
```

### Management Interface
```bash
POST http://localhost:3002/admin
Content-Type: application/json

{
  "action": 5001,
  "data": {}
}
```

### MCP Tool Interface

Supports various MCP protocol operations, see [CLAUDE.md](./CLAUDE.md) for details

## Common Issues

### Build Timeout

If you encounter network timeout during the build process, you can:
1. Check network connection
2. Retry build (Docker will use cache to speed up)
3. Use background build method

Typical build times:
- ARM64 platform: approximately 2-3 minutes
- AMD64 platform: approximately 5-6 minutes (npm install is slower)

### TypeScript Compilation Errors

Ensure before building:
1. Local TypeScript compilation passes: `npm run build`
2. No uncommitted code changes
3. package.json dependency versions are correct

### Prisma Generation Failure

If you encounter Prisma-related errors:
```bash
# Test Prisma generation locally
npx prisma generate --schema=./prisma/schema.prisma

# Check schema file syntax
npx prisma validate
```

### Insufficient Disk Space

```bash
# Clean unused images and build cache
docker system prune -a

# View disk usage
docker system df
```

### Buildx Builder Issues

```bash
# Recreate builder
docker buildx rm multiarch-builder
docker buildx create --name multiarch-builder --driver docker-container --use
docker buildx inspect --bootstrap
```

## Build Optimization

### Using Build Cache

Docker automatically caches each build layer. If source code hasn't changed, subsequent builds will be fast:

```bash
# Local cache warm-up without publishing
docker buildx build --platform linux/amd64 -t bcdunia/peta-core:1.3.0 --load .
```

### Reducing Image Size

Current image optimization strategies:
- Use Alpine Linux (minimal base image)
- Multi-stage builds (no build tools included)
- Install production dependencies only (`npm ci --only=production`)
- Clean npm cache

Final image size: approximately 250-300 MB

## Related Documentation

- [Dockerfile](./Dockerfile) - Docker image definition
- [CLAUDE.md](./CLAUDE.md) - Project architecture and API documentation
- [README.md](./README.md) - Project overview
