#!/bin/bash

# ====================================
# Peta-Core One-Click Deployment Script
# ====================================
# Including PostgreSQL, peta-core, optional peta-auth, and Cloudflared services

set -e

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration variables (can be overridden via environment variables)
BACKEND_PORT=${BACKEND_PORT:-3002}
DB_PORT=${DB_PORT:-5434}
DEPLOY_DIR=${DEPLOY_DIR:-./peta-core-deployment}
PETA_VERSION=${PETA_VERSION:-1.3.0}
PETA_AUTH_VERSION=${PETA_AUTH_VERSION:-1.3.0}
PETA_AUTH_AUTOSTART=${PETA_AUTH_AUTOSTART:-false}
PETA_AUTH_MASTER_KEY_SOURCE=${PETA_AUTH_MASTER_KEY_SOURCE:-./secrets/peta_auth_master_key}
PETA_AUTH_CLIENT_SECRETS_SOURCE=${PETA_AUTH_CLIENT_SECRETS_SOURCE:-./secrets/peta_auth_client_secrets.json}

case "$PETA_AUTH_MASTER_KEY_SOURCE" in
    /*) ;;
    *) PETA_AUTH_MASTER_KEY_SOURCE="$(pwd -P)/${PETA_AUTH_MASTER_KEY_SOURCE#./}" ;;
esac
case "$PETA_AUTH_CLIENT_SECRETS_SOURCE" in
    /*) ;;
    *) PETA_AUTH_CLIENT_SECRETS_SOURCE="$(pwd -P)/${PETA_AUTH_CLIENT_SECRETS_SOURCE#./}" ;;
esac

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "\n${CYAN}==>${NC} $1"
}

# Generate random password
generate_password() {
    local length=${1:-32}
    openssl rand -base64 $length | tr -d "=+/" | cut -c1-$length
}

# Check if command exists
check_command() {
    if ! command -v $1 &> /dev/null; then
        log_error "$1 is not installed, please install $1 first"
        exit 1
    fi
}

# Check if port is in use
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1 ; then
        log_warn "Port $port is already in use"
        return 1
    fi
    return 0
}

# Wait for service health
wait_for_health() {
    local url=$1
    local max_attempts=30
    local attempt=0
    
    log_info "Waiting for service health check..."
    
    while [ $attempt -lt $max_attempts ]; do
        if curl -sf $url > /dev/null 2>&1; then
            log_success "Service health check passed"
            return 0
        fi
        attempt=$((attempt + 1))
        echo -n "."
        sleep 2
    done
    
    echo ""
    log_error "Service health check timed out"
    return 1
}

auth_secret_stat() {
    local field=$1
    local path=$2

    case "$(uname -s)" in
        Darwin)
            case "$field" in
                owner) stat -f '%Su' "$path" ;;
                mode) stat -f '%Lp' "$path" ;;
            esac
            ;;
        Linux)
            case "$field" in
                owner) stat -c '%U' "$path" ;;
                mode) stat -c '%a' "$path" ;;
            esac
            ;;
        *)
            return 1
            ;;
    esac
}

# Main function
main() {
    log_step "Peta-Core One-Click Deployment Script"
    echo ""
    
    # Check required commands
    log_step "Checking environment dependencies"
    check_command docker
    
    # Check docker compose (V2) or docker-compose (V1)
    if docker compose version > /dev/null 2>&1; then
        log_success "Docker Compose V2 is installed"
    elif docker-compose version > /dev/null 2>&1; then
        log_success "Docker Compose V1 is installed"
        # Create alias function for V1
        docker() {
            if [ "$1" = "compose" ]; then
                shift
                docker-compose "$@"
            else
                command docker "$@"
            fi
        }
    else
        log_error "Docker Compose is not installed, please install Docker Compose first"
        exit 1
    fi
    
    log_success "Docker environment check passed"
    
    # Check ports
    log_step "Checking port availability"
    if ! check_port $BACKEND_PORT; then
        log_error "Please modify BACKEND_PORT environment variable or release port $BACKEND_PORT"
        exit 1
    fi
    if ! check_port $DB_PORT; then
        log_warn "Database port $DB_PORT is already in use, will use this port"
    fi
    log_success "Port check completed"
    
    # Create deployment directory
    log_step "Creating deployment directory"
    if [ -d "$DEPLOY_DIR" ]; then
        log_error "Deployment directory already exists: $DEPLOY_DIR"
        echo ""
        log_info "If you need to redeploy, remove the directory using a literal-path-safe command for your shell"
        log_info "Or enter the directory using a literal-path-safe command, then run docker compose up -d"
        exit 1
    fi
    mkdir -p -- "$DEPLOY_DIR"
    cd -- "$DEPLOY_DIR"
    log_success "Deployment directory: $(pwd)"
    
    # Fixed database configuration
    DB_USER="peta"
    DB_NAME="peta_core_postgres"
    VOLUME_NAME="postgres_peta_core"
    
    # Check for existing data volumes
    log_step "Checking existing database"
    EXISTING_DB=false
    if docker volume ls | grep -q "${DEPLOY_DIR##*/}_${VOLUME_NAME}" 2>/dev/null || docker volume ls | grep -q ".*${VOLUME_NAME}" 2>/dev/null; then
        log_warn "Detected existing database data volume: ${VOLUME_NAME}"
        EXISTING_DB=true
    fi
    
    # Generate random passwords
    log_step "Generating random passwords"
    JWT_SECRET=$(generate_password 32)
    DB_PASSWORD=$(generate_password 24)
    log_success "Password generation completed"
    
    # Create docker-compose.yml
    log_step "Creating docker-compose.yml"
    cat > docker-compose.yml <<EOF
services:
  # PostgreSQL for peta-core
  postgres:
    image: postgres:16-alpine
    container_name: peta-core-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${DB_USER}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: \${DB_NAME}
    ports:
      - '\${DB_PORT}:5432'
    volumes:
      - ${VOLUME_NAME}:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U \${DB_USER} -d \${DB_NAME}']
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - peta-network

  # Peta Core Service (MCP Gateway)
  peta-core:
    image: petaio/peta-core:${PETA_VERSION}
    container_name: peta-core
    restart: unless-stopped
    user: root  # Root permission required to access Docker socket
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: \${NODE_ENV}
      DATABASE_URL: \${DATABASE_URL}
      BACKEND_PORT: \${BACKEND_PORT}
      JWT_SECRET: \${JWT_SECRET}
      LOG_LEVEL: \${LOG_LEVEL}
      LOG_PRETTY: \${LOG_PRETTY}
      LAZY_START_ENABLED: \${LAZY_START_ENABLED}
      PETA_AUTH_AUTOSTART: \${PETA_AUTH_AUTOSTART}
      CLOUDFLARED_CONTAINER_NAME: \${CLOUDFLARED_CONTAINER_NAME}
      PETA_CORE_IN_DOCKER: "true"
      SKILLS_DIR: /data/skills
      # Skip database container startup (database is started via docker-compose)
      SKIP_DB_CONTAINER_START: "true"
    ports:
      - '\${BACKEND_PORT}:\${BACKEND_PORT}'
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Mount Docker socket for starting downstream MCP service containers
      - ./cloudflared:/app/cloudflared  # Shared cloudflared configuration directory
      - ./skills:/data/skills  # Skills storage directory (enables auto host-path detection for child containers)
    networks:
      - peta-network
    healthcheck:
      test: ['CMD-SHELL', 'curl -f http://localhost:\${BACKEND_PORT}/health']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
EOF

    if [ "$PETA_AUTH_AUTOSTART" != "false" ]; then
        cat >> docker-compose.yml <<'EOF'

  # Peta Auth Service
  peta-auth:
    image: petaio/peta-auth:${PETA_AUTH_VERSION}
    container_name: peta-auth
    restart: unless-stopped
    environment:
      PETA_AUTH_MASTER_KEY_FILE: /run/secrets/peta_auth_master_key
      PETA_AUTH_CLIENT_SECRETS_FILE: /run/secrets/peta_auth_client_secrets_json
    secrets:
      - peta_auth_master_key
      - peta_auth_client_secrets_json
    networks:
      - peta-network
    volumes:
      - peta-auth-data:/data
    healthcheck:
      test: ['CMD', '/usr/bin/bash', '-c', 'exec 3<>/dev/tcp/localhost/7788 || exit 1; printf "GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n" >&3; response=""; while IFS= read -r -t 2 line <&3; do response+="$$line"; done; [[ "$$response" == *"\"ok\":true"* ]]']
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s
EOF
    fi

    cat >> docker-compose.yml <<EOF

  # Cloudflared Service
  # Note: restart is set to "no" to prevent auto-start on deployment
  # Cloudflared will be started via API when needed
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: \${CLOUDFLARED_CONTAINER_NAME}
    restart: "no"
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=\${CLOUDFLARE_TUNNEL_TOKEN:-}
    networks:
      - peta-network
    volumes:
      - ./cloudflared:/etc/cloudflared

volumes:
  ${VOLUME_NAME}:
    driver: local
EOF

    if [ "$PETA_AUTH_AUTOSTART" != "false" ]; then
        cat >> docker-compose.yml <<EOF
  peta-auth-data:
    driver: local
EOF
    fi

    if [ "$PETA_AUTH_AUTOSTART" != "false" ]; then
        cat >> docker-compose.yml <<EOF

secrets:
  peta_auth_master_key:
    file: ${PETA_AUTH_MASTER_KEY_SOURCE:-./secrets/peta_auth_master_key}
  peta_auth_client_secrets_json:
    file: ${PETA_AUTH_CLIENT_SECRETS_SOURCE:-./secrets/peta_auth_client_secrets.json}
EOF
    fi

    cat >> docker-compose.yml <<EOF

networks:
  peta-network:
    driver: bridge
EOF
    log_success "docker-compose.yml created successfully"
    
    # Create .env file
    log_step "Creating .env file"
    
    cat > .env <<EOF
# ====================================
# Peta-Core Docker Deployment Environment Variables
# ====================================
# This file is automatically generated by the deployment script
# Keep this file secure in production, do not expose passwords

# -------------------- Environment Configuration --------------------
NODE_ENV=production

# -------------------- Service Port Configuration --------------------
BACKEND_PORT=${BACKEND_PORT}

# -------------------- Database Configuration (for docker-compose) --------------------
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}
DB_PORT=${DB_PORT}

# -------------------- Database Connection String --------------------
# Note: Uses Docker Compose service name 'postgres' as hostname (inter-container communication)
# To access database from host, use localhost:${DB_PORT}
DATABASE_URL="postgresql://\${DB_USER}:\${DB_PASSWORD}@postgres:5432/\${DB_NAME}?schema=public"

# -------------------- JWT Secret Configuration --------------------
JWT_SECRET=${JWT_SECRET}

# -------------------- Logging Configuration (Pino Logger) --------------------
LOG_LEVEL=info
LOG_PRETTY=false
LOG_RESPONSE_MAX_LENGTH=300

# -------------------- MCP Server Management --------------------
# Lazy loading: Servers load config but delay startup until first use
# Idle servers auto-shutdown to conserve resources
LAZY_START_ENABLED=true

# -------------------- Peta Auth Configuration (Optional) --------------------
# Auto-start peta-auth for Peta-managed OAuth credentials
PETA_AUTH_AUTOSTART=${PETA_AUTH_AUTOSTART}
PETA_VERSION=${PETA_VERSION}
PETA_AUTH_VERSION=${PETA_AUTH_VERSION}
PETA_AUTH_MASTER_KEY_SOURCE=${PETA_AUTH_MASTER_KEY_SOURCE}
PETA_AUTH_CLIENT_SECRETS_SOURCE=${PETA_AUTH_CLIENT_SECRETS_SOURCE}

# -------------------- Cloudflared Configuration --------------------
CLOUDFLARED_CONTAINER_NAME=peta-core-cloudflared

# -------------------- HTTPS/SSL Configuration (Optional) --------------------
# ENABLE_HTTPS=false
# SSL_CERT_PATH=/path/to/cert.pem
# SSL_KEY_PATH=/path/to/key.pem
EOF
    log_success ".env file created successfully"
    log_warn "Please keep the .env file secure, it contains sensitive information"
    
    # Create cloudflared directory
    log_step "Creating Cloudflared configuration directory"
    mkdir -p cloudflared
    log_success "Cloudflared configuration directory created"

    if [ "$PETA_AUTH_AUTOSTART" != "false" ]; then
        log_step "Checking protected Peta Auth runtime secrets"
        if [ -L "$PETA_AUTH_MASTER_KEY_SOURCE" ] || [ -L "$PETA_AUTH_CLIENT_SECRETS_SOURCE" ]; then
            log_error "Peta Auth runtime secret files must not be symbolic links"
            exit 1
        fi
        if [ ! -f "$PETA_AUTH_MASTER_KEY_SOURCE" ] || [ ! -f "$PETA_AUTH_CLIENT_SECRETS_SOURCE" ] || [ ! -s "$PETA_AUTH_CLIENT_SECRETS_SOURCE" ]; then
            log_error "Peta Auth runtime secrets are missing"
            log_info "Provision the protected files at $PETA_AUTH_MASTER_KEY_SOURCE and $PETA_AUTH_CLIENT_SECRETS_SOURCE, then run docker compose up -d"
            exit 1
        fi
        current_user=$(id -un)
        for secret_file in "$PETA_AUTH_MASTER_KEY_SOURCE" "$PETA_AUTH_CLIENT_SECRETS_SOURCE"; do
            secret_parent=$(dirname "$secret_file")
            if [ -L "$secret_parent" ]; then
                log_error "Peta Auth runtime secret parent directories must be current-user owned, non-symlinked, and not group/other-writable"
                exit 1
            fi
            if ! secret_owner=$(auth_secret_stat owner "$secret_file") || ! secret_mode=$(auth_secret_stat mode "$secret_file") || ! secret_parent_owner=$(auth_secret_stat owner "$secret_parent") || ! secret_parent_mode=$(auth_secret_stat mode "$secret_parent"); then
                log_error "Unable to inspect Peta Auth runtime secret ownership and permissions on this operating system"
                exit 1
            fi
            if [ "$secret_owner" != "$current_user" ] || [ "${secret_mode: -2}" != "00" ]; then
                log_error "Peta Auth runtime secret files must be current-user owned with owner-only permissions (for example, 0400 or 0600)"
                exit 1
            fi
            if [ "$secret_parent_owner" != "$current_user" ] || (( (8#$secret_parent_mode & 8#022) != 0 )); then
                log_error "Peta Auth runtime secret parent directories must be current-user owned, non-symlinked, and not group/other-writable"
                exit 1
            fi
        done
        if [ "$(wc -c < "$PETA_AUTH_MASTER_KEY_SOURCE")" -ne 32 ]; then
            log_error "Peta Auth master key must be exactly 32 raw bytes"
            exit 1
        fi
        log_success "Protected Peta Auth runtime secrets found"
    fi
    
    # If existing database detected, stop script execution
    if [ "$EXISTING_DB" = true ]; then
        echo ""
        log_warn "════════════════════════════════════════════════════════"
        log_warn "  Existing database data volume detected!"
        log_warn "════════════════════════════════════════════════════════"
        echo ""
        log_info "Configuration files have been generated, but services were not started due to potential password mismatch."
        echo ""
        log_info "Please follow these steps:"
        echo -e "  1. Edit the .env file and modify database configuration to match existing database password:"
        echo -e "     ${BLUE}vi $(pwd)/.env${NC}"
        echo ""
        echo -e "  2. Modify the following configuration items to correct values:"
        echo -e "     ${YELLOW}DB_USER=<existing database username>${NC}"
        echo -e "     ${YELLOW}DB_PASSWORD=<existing database password>${NC}"
        echo -e "     ${YELLOW}DB_NAME=<existing database name>${NC}"
        echo ""
        echo -e "  3. After modification, start services:"
        echo -e "     ${BLUE}cd $(pwd) && docker compose up -d${NC}"
        echo ""
        log_info "Or, if you need a fresh deployment, please delete the old data volume first:"
        echo -e "     ${BLUE}docker volume ls${NC}"
        echo -e "     ${BLUE}docker volume rm <volume_name>${NC}"
        echo -e "     ${BLUE}rm -rf $(pwd)${NC}"
        echo -e "     Then run the deployment script again"
        echo ""
        exit 0
    fi
    
    # Pull images
    log_step "Pulling Docker images"
    docker compose pull
    log_success "Image pull completed"
    
    # Start services
    log_step "Starting services"
    docker compose up -d
    log_success "Service startup command executed"
    
    # Wait for services to be ready
    log_step "Waiting for services to be ready"
    sleep 5
    
    # Wait for PostgreSQL health
    log_info "Waiting for PostgreSQL to be ready..."
    max_attempts=30
    attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if docker compose exec -T postgres pg_isready -U ${DB_USER} -d ${DB_NAME} > /dev/null 2>&1; then
            log_success "PostgreSQL is ready"
            break
        fi
        attempt=$((attempt + 1))
        echo -n "."
        sleep 2
    done
    echo ""
    
    if [ $attempt -eq $max_attempts ]; then
        log_error "PostgreSQL startup timed out"
        docker compose logs postgres
        exit 1
    fi
    
    # Wait for peta-core health
    log_info "Waiting for Peta-Core to be ready..."
    if wait_for_health "http://localhost:${BACKEND_PORT}/health"; then
        log_success "Peta-Core is ready"
    else
        log_error "Peta-Core startup failed"
        docker compose logs peta-core
        exit 1
    fi
    
    # Display deployment information
    echo ""
    log_step "Deployment completed!"
    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Peta-Core deployed successfully!${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${CYAN}Access Information:${NC}"
    echo -e "  API Service:     ${BLUE}http://localhost:${BACKEND_PORT}${NC}"
    echo -e "  Health Check:    ${BLUE}http://localhost:${BACKEND_PORT}/health${NC}"
    echo ""
    echo -e "${CYAN}Configuration Files:${NC}"
    echo -e "  Deployment Dir:     ${BLUE}$(pwd)${NC}"
    echo -e "  docker-compose.yml: ${BLUE}$(pwd)/docker-compose.yml${NC}"
    echo -e "  .env file:          ${BLUE}$(pwd)/.env${NC}"
    echo ""
    echo -e "${CYAN}Common Commands:${NC}"
    echo -e "  View logs:       ${BLUE}docker compose logs -f${NC}"
    echo -e "  View status:     ${BLUE}docker compose ps${NC}"
    echo -e "  Stop services:   ${BLUE}docker compose down${NC}"
    echo -e "  Restart services: ${BLUE}docker compose restart${NC}"
    echo ""
    echo -e "${YELLOW}Important Notes:${NC}"
    echo -e "  1. Please keep the .env file secure, it contains sensitive password information"
    echo -e "  2. It is recommended to change default passwords in production environment"
    echo ""
    echo -e "${CYAN}Next Steps:${NC}"
    echo -e "  1. Verify service by accessing health check endpoint: ${BLUE}curl http://localhost:${BACKEND_PORT}/health${NC}"
    echo -e "  2. Deploy peta console: ${BLUE}https://peta.io/quick-start${NC}"
    echo ""
}

# Error handling
trap 'log_error "An error occurred during deployment, please check the logs"; exit 1' ERR

# Run main function
main "$@"
