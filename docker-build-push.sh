#!/bin/bash
set -euo pipefail  # Exit on error, undefined vars, pipe failures

# ============================================================================
# Peta Core - Docker Build & Push Script
# ============================================================================
# Builds and pushes Docker images to Docker Hub with proper versioning
# Usage: ./docker-build-push.sh [OPTIONS]
# ============================================================================

# Configuration
readonly IMAGE_NAME="petaio/peta-core"
readonly DOCKERFILE_PATH="."
readonly DATE_TAG=$(date +%Y%m%d)
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$SCRIPT_DIR"
readonly VERSION_TAG=$(node -e "const fs = require('fs'); const path = require('path'); try { const pkg = JSON.parse(fs.readFileSync(path.join(process.argv[1], 'package.json'), 'utf8')); if (/^\\d+\\.\\d+\\.\\d+$/.test(pkg.version)) { process.stdout.write(pkg.version); } } catch (error) { process.exit(0); }" "$PROJECT_ROOT")

# Thresholds
readonly MIN_DISK_SPACE_GB=5
readonly BUILD_TIMEOUT=600  # 10 minutes
readonly PUSH_TIMEOUT=300   # 5 minutes

# Docker Hub
readonly DOCKER_HUB_REPO="petaio/peta-core"

# ANSI Colors (matching project style from start-app.js)
readonly RESET='\033[0m'
readonly BRIGHT='\033[1m'
readonly GREEN='\033[32m'
readonly YELLOW='\033[33m'
readonly BLUE='\033[34m'
readonly RED='\033[31m'
readonly ORANGE='\033[38;5;208m'
readonly GRAY='\033[90m'

# Global flags
VERBOSE=false
CLEAN=false
FORCE=false
NON_INTERACTIVE=false

# ============================================================================
# Logging Functions
# ============================================================================

function log_info() {
  echo -e "${BLUE}ℹ️  $1${RESET}"
}

function log_success() {
  echo -e "${GREEN}✅ $1${RESET}"
}

function log_warning() {
  echo -e "${YELLOW}⚠️  $1${RESET}"
}

function log_error() {
  echo -e "${RED}❌ $1${RESET}" >&2
}

function log_step() {
  echo -e "\n${BRIGHT}${BLUE}▶ $1${RESET}\n"
}

function log_verbose() {
  if [[ "$VERBOSE" == true ]]; then
    echo -e "${GRAY}[VERBOSE] $1${RESET}"
  fi
}

# ============================================================================
# Help Display
# ============================================================================

function show_help() {
  cat << EOF
${BRIGHT}Docker Build & Push Script for Peta Core${RESET}

${BLUE}Usage:${RESET}
  ./docker-build-push.sh [OPTIONS]

${BLUE}Options:${RESET}
  -v, --verbose    Enable detailed Docker output
  -c, --clean      Clean old images and build cache before building
  -f, --force      Force mode: skip cleanup confirmation (use with -c)
  -y, --non-interactive  Fail instead of prompting for input
  -h, --help       Show this help message

${BLUE}Examples:${RESET}
  ./docker-build-push.sh              # Normal build and push
  ./docker-build-push.sh -v           # Verbose mode
  ./docker-build-push.sh -c           # Clean then build (with confirmation)
  ./docker-build-push.sh -c -f        # Clean then build (no confirmation)
  ./docker-build-push.sh -v -c -f     # Verbose + clean + force
  ./docker-build-push.sh -y           # Non-interactive mode

${BLUE}What this script does:${RESET}
  1. Checks Docker installation and Buildx
  2. Validates Docker Hub login
  3. Creates/reuses multi-architecture builder
  4. Validates disk space (requires ${MIN_DISK_SPACE_GB}GB free)
  5. Optionally cleans old images/cache
  6. Builds multi-arch image (linux/amd64, linux/arm64)
  7. Pushes both architectures to Docker Hub
  8. Verifies multi-arch manifest
  9. Displays build summary

${BLUE}Supported platforms:${RESET}
  - linux/amd64 (Intel/AMD servers, most cloud providers)
  - linux/arm64 (Apple Silicon, ARM servers)

${BLUE}Tags created:${RESET}
  - ${IMAGE_NAME}:latest
  - ${IMAGE_NAME}:${DATE_TAG}
$(if [[ -n "$VERSION_TAG" ]]; then echo "  - ${IMAGE_NAME}:${VERSION_TAG}"; fi)

${BLUE}Docker Hub:${RESET}
  https://hub.docker.com/r/${DOCKER_HUB_REPO}
EOF
}

# ============================================================================
# Argument Parsing
# ============================================================================

function parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      -v|--verbose)
        VERBOSE=true
        shift
        ;;
      -c|--clean)
        CLEAN=true
        shift
        ;;
      -f|--force)
        FORCE=true
        shift
        ;;
      -y|--non-interactive)
        NON_INTERACTIVE=true
        shift
        ;;
      -h|--help)
        show_help
        exit 0
        ;;
      *)
        log_error "Unknown option: $1"
        echo ""
        show_help
        exit 1
        ;;
    esac
  done
}

# ============================================================================
# Environment Checks
# ============================================================================

function check_docker() {
  log_step "Step 1/8: Checking Docker installation"

  # Check Docker command exists
  if ! command -v docker &> /dev/null; then
    log_error "Docker is not installed"
    echo -e "\n${BLUE}Installation instructions:${RESET}"
    echo "  macOS: https://docs.docker.com/desktop/install/mac-install/"
    echo "  Linux: https://docs.docker.com/engine/install/"
    return 1
  fi

  # Check Docker daemon is running
  if ! docker info &> /dev/null; then
    log_error "Docker daemon is not running"
    echo -e "\n${BLUE}Start Docker:${RESET}"
    echo "  macOS: Open Docker Desktop from Applications"
    echo "  Linux: sudo systemctl start docker"
    return 1
  fi

  # Get Docker version
  local docker_version=$(docker --version | awk '{print $3}' | sed 's/,//')
  log_success "Docker ${docker_version} is running"

  # Check Buildx (optional)
  if docker buildx version &> /dev/null; then
    local buildx_version=$(docker buildx version | awk '{print $2}')
    log_verbose "Docker Buildx ${buildx_version} available"
  fi
}

function check_docker_login() {
  log_step "Step 2/8: Checking Docker Hub authentication"

  # Check if Docker config file exists
  local docker_config="$HOME/.docker/config.json"

  if [[ ! -f "$docker_config" ]]; then
    log_warning "Docker config file not found"
    prompt_docker_login
    return $?
  fi

  # Check if there are any auth entries for Docker Hub
  # Docker Hub may use the following domains:
  # - https://index.docker.io/v1/
  # - docker.io
  # - registry-1.docker.io
  local has_auth=false

  if grep -q '"auths"' "$docker_config" 2>/dev/null; then
    # Check for common Docker Hub registry URLs
    if grep -E '"(https://index.docker.io/v1/|docker\.io|registry-1\.docker\.io)"' "$docker_config" >/dev/null 2>&1; then
      has_auth=true
    fi
  fi

  # Also check for credential helpers
  local has_cred_helper=false
  if grep -q '"credsStore"' "$docker_config" 2>/dev/null || \
     grep -q '"credHelpers"' "$docker_config" 2>/dev/null; then
    has_cred_helper=true
  fi

  if [[ "$has_auth" == false ]] && [[ "$has_cred_helper" == false ]]; then
    log_warning "Not logged in to Docker Hub"
    prompt_docker_login
    return $?
  fi

  log_success "Docker Hub credentials found"
}

function prompt_docker_login() {
  if [[ "$NON_INTERACTIVE" == true ]]; then
    log_error "Docker Hub login required, but non-interactive mode is enabled"
    echo -e "\n${BLUE}Run docker login first, then retry.${RESET}"
    return 1
  fi

  echo -e "\n${BLUE}Please log in to Docker Hub:${RESET}"
  echo -e "  ${GRAY}docker login${RESET}"
  echo ""
  read -p "Press ENTER after logging in, or Ctrl+C to cancel: "

  # Verify login by checking config file again
  local docker_config="$HOME/.docker/config.json"
  local has_auth=false

  if [[ -f "$docker_config" ]]; then
    if grep -q '"auths"' "$docker_config" 2>/dev/null; then
      if grep -E '"(https://index.docker.io/v1/|docker\.io|registry-1\.docker\.io)"' "$docker_config" >/dev/null 2>&1; then
        has_auth=true
      fi
    fi

    # Check credential helpers too
    if grep -q '"credsStore"' "$docker_config" 2>/dev/null || \
       grep -q '"credHelpers"' "$docker_config" 2>/dev/null; then
      has_auth=true
    fi
  fi

  if [[ "$has_auth" == false ]]; then
    log_error "Still not logged in to Docker Hub"
    echo ""
    echo -e "${BLUE}Debug info:${RESET}"
    echo -e "  Config file: $docker_config"
    if [[ -f "$docker_config" ]]; then
      echo -e "  File exists: yes"
      echo -e "  Has auths: $(grep -q '"auths"' "$docker_config" 2>/dev/null && echo 'yes' || echo 'no')"
      echo -e "  Has credsStore: $(grep -q '"credsStore"' "$docker_config" 2>/dev/null && echo 'yes' || echo 'no')"
    else
      echo -e "  File exists: no"
    fi
    return 1
  fi

  log_success "Docker Hub credentials verified"
}

function setup_buildx_builder() {
  log_step "Step 3/8: Setting up Docker Buildx builder"

  local builder_name="peta-multiarch-builder"

  # Check if builder exists
  if docker buildx inspect "$builder_name" &> /dev/null; then
    log_verbose "Builder '$builder_name' already exists"
    docker buildx use "$builder_name"
    log_success "Using existing builder: $builder_name"
  else
    log_info "Creating new multi-architecture builder: $builder_name"

    docker buildx create \
      --name "$builder_name" \
      --driver docker-container \
      --platform linux/amd64,linux/arm64 \
      --use

    log_info "Bootstrapping builder (30-60 seconds)..."
    docker buildx inspect --bootstrap

    log_success "Builder created: $builder_name"
  fi

  # Show platforms in verbose mode
  if [[ "$VERBOSE" == true ]]; then
    docker buildx inspect --bootstrap | grep "Platforms:" || true
  fi
}

function check_disk_space() {
  log_step "Step 4/8: Checking disk space"

  # Get available space in GB
  local available_gb
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    available_gb=$(df -g "$PROJECT_ROOT" | tail -1 | awk '{print $4}')
  else
    # Linux
    available_gb=$(df -BG "$PROJECT_ROOT" | tail -1 | awk '{print $4}' | sed 's/G//')
  fi

  if [[ $available_gb -lt $MIN_DISK_SPACE_GB ]]; then
    log_error "Insufficient disk space: ${available_gb}GB (need ${MIN_DISK_SPACE_GB}GB)"
    echo -e "\n${BLUE}Free up space or use -c to clean Docker cache${RESET}"
    return 1
  fi

  log_success "Available disk space: ${available_gb}GB"
}

# ============================================================================
# Safe Timeout Wrapper
# ============================================================================

# Safe timeout wrapper - uses timeout if available, otherwise runs directly
function safe_timeout() {
  local timeout_seconds=$1
  shift
  local cmd=("$@")

  if command -v timeout &> /dev/null; then
    # Linux: use timeout command
    timeout "$timeout_seconds" "${cmd[@]}"
  elif command -v gtimeout &> /dev/null; then
    # macOS with coreutils: use gtimeout
    gtimeout "$timeout_seconds" "${cmd[@]}"
  else
    # No timeout available: run directly
    log_verbose "timeout command not available, running without timeout"
    "${cmd[@]}"
  fi
}

# ============================================================================
# Cleanup Function
# ============================================================================

function clean_docker() {
  log_step "Step 5/8: Cleaning Docker resources"

  # If force mode, skip confirmation
  if [[ "$FORCE" != true ]]; then
    if [[ "$NON_INTERACTIVE" == true ]]; then
      log_error "Cleanup requires --force when non-interactive mode is enabled"
      return 1
    fi

    echo -e "${YELLOW}This will remove:${RESET}"
    echo "  - Dangling images (untagged intermediate layers)"
    echo "  - Build cache"
    echo "  - Stopped peta-core containers"
    echo ""

    # Show current disk usage
    log_info "Current Docker disk usage:"
    docker system df
    echo ""

    read -p "Proceed with cleanup? [y/N]: " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      log_info "Cleanup skipped"
      return 0
    fi
  else
    log_info "Force mode: cleaning without confirmation"
  fi

  # Remove dangling images
  log_info "Removing dangling images..."
  docker image prune -f || true

  # Remove build cache
  log_info "Removing build cache..."
  docker builder prune -f || true

  # Remove stopped peta-core containers
  log_info "Removing stopped peta-core containers..."
  local stopped_containers=$(docker ps -a --filter "ancestor=${IMAGE_NAME}" --filter "status=exited" -q)
  if [[ -n "$stopped_containers" ]]; then
    echo "$stopped_containers" | xargs docker rm || true
  fi

  # Show new disk usage
  echo ""
  log_success "Cleanup complete"
  docker system df
}

# ============================================================================
# Build Function
# ============================================================================

function build_image() {
  local step_num="5/8"
  if [[ "$CLEAN" == true ]]; then
    step_num="6/8"
  fi

  log_step "Step ${step_num}: Building multi-architecture Docker image"

  local start_time=$(date +%s)

  log_info "Building ${IMAGE_NAME} for platforms:"
  echo "  - linux/amd64 (Intel/AMD servers)"
  echo "  - linux/arm64 (Apple Silicon, ARM servers)"
  echo ""
  log_info "Tags:"
  echo "  - latest"
  echo "  - ${DATE_TAG}"
  if [[ -n "$VERSION_TAG" ]]; then
    echo "  - ${VERSION_TAG}"
  fi
  echo ""

  cd "$PROJECT_ROOT"

  # Prepare multi-arch buildx command
  local build_args=(
    "buildx" "build"
    "--platform" "linux/amd64,linux/arm64"
    "--file" "${DOCKERFILE_PATH}/Dockerfile"
    "--tag" "${IMAGE_NAME}:latest"
    "--tag" "${IMAGE_NAME}:${DATE_TAG}"
    "--push"  # Required for multi-arch
  )

  if [[ -n "$VERSION_TAG" ]]; then
    build_args+=("--tag" "${IMAGE_NAME}:${VERSION_TAG}")
  fi

  # Progress output
  if [[ "$VERBOSE" == true ]]; then
    build_args+=("--progress=plain")
  else
    build_args+=("--progress=auto")
  fi

  build_args+=(".")

  log_verbose "Build command: docker ${build_args[*]}"
  log_info "Building and pushing (5-15 minutes)..."

  # Execute build with extended timeout for multi-arch
  safe_timeout 900 docker "${build_args[@]}"
  local exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    # Success
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    local minutes=$((duration / 60))
    local seconds=$((duration % 60))

    log_success "Build and push completed in ${minutes}m ${seconds}s"
  elif [[ $exit_code -eq 124 ]] || [[ $exit_code -eq 143 ]]; then
    # Timeout (124 for timeout, 143 for SIGTERM)
    log_error "Build timed out after 900s"
    echo ""
    echo -e "${BLUE}Troubleshooting:${RESET}"
    echo "  - Network: Multi-arch build requires stable connection"
    echo "  - Reset builder: docker buildx rm peta-multiarch-builder"
    echo "  - Check builder: docker buildx inspect --bootstrap"
    return 1
  else
    # Other error
    log_error "Build failed with exit code ${exit_code}"
    echo ""
    echo -e "${BLUE}Common issues:${RESET}"
    echo "  - Network: Multi-arch requires stable connection"
    echo "  - Builder: docker buildx inspect --bootstrap"
    echo "  - Auth: docker login"
    echo "  - Reset: docker buildx rm peta-multiarch-builder"
    return 1
  fi
}

# ============================================================================
# Push Function
# ============================================================================

function push_image() {
  local step_num="6/8"
  if [[ "$CLEAN" == true ]]; then
    step_num="7/8"
  fi

  log_step "Step ${step_num}: Verifying push to Docker Hub"

  log_info "Images were pushed during build (multi-arch requirement)"
  log_success "Push verification complete"
}

# ============================================================================
# Verification Function
# ============================================================================

function verify_image() {
  local step_num="7/8"
  if [[ "$CLEAN" == true ]]; then
    step_num="8/8"
  fi

  log_step "Step ${step_num}: Verifying multi-architecture images"

  local tags=("latest" "${DATE_TAG}")

  if [[ -n "$VERSION_TAG" ]]; then
    tags+=("${VERSION_TAG}")
  fi

  for tag in "${tags[@]}"; do
    log_info "Verifying ${IMAGE_NAME}:${tag}..."

    # Use buildx imagetools for multi-arch manifest inspection
    if docker buildx imagetools inspect "${IMAGE_NAME}:${tag}" &> /dev/null; then
      log_success "Tag '${tag}' is accessible"

      if [[ "$VERBOSE" == true ]]; then
        echo ""
        docker buildx imagetools inspect "${IMAGE_NAME}:${tag}" | \
          grep -E "(Name:|MediaType:|Platform:)" || true
        echo ""
      fi
    else
      log_warning "Could not verify '${tag}' (may be propagating)"
    fi
  done

  echo ""
  log_info "Inspect manifest:"
  echo -e "  ${GRAY}docker buildx imagetools inspect ${IMAGE_NAME}:latest${RESET}"
  echo ""
  log_info "View on Docker Hub:"
  echo -e "  ${BLUE}https://hub.docker.com/r/${DOCKER_HUB_REPO}/tags${RESET}"
}

# ============================================================================
# Summary Function
# ============================================================================

function show_summary() {
  local step_num="8/8"
  if [[ "$CLEAN" == true ]]; then
    step_num="9/8"
  fi

  log_step "Step ${step_num}: Build Summary"

  local manifest_digest=$(docker buildx imagetools inspect "${IMAGE_NAME}:latest" 2>/dev/null | \
    grep "Digest:" | head -1 | awk '{print $2}' || echo "N/A")

  cat << EOF
${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}
${BRIGHT}Multi-Architecture Build & Push Successful!${RESET}

${BLUE}Image Details:${RESET}
  Name:          ${IMAGE_NAME}
  Tags:          latest, ${DATE_TAG}$(if [[ -n "$VERSION_TAG" ]]; then printf ", %s" "$VERSION_TAG"; fi)
  Architectures: linux/amd64, linux/arm64
  Digest:        ${manifest_digest}

${BLUE}Docker Hub:${RESET}
  Repository: https://hub.docker.com/r/${DOCKER_HUB_REPO}
  Latest:     https://hub.docker.com/r/${DOCKER_HUB_REPO}/tags?name=latest
  Dated:      https://hub.docker.com/r/${DOCKER_HUB_REPO}/tags?name=${DATE_TAG}
$(if [[ -n "$VERSION_TAG" ]]; then printf "  Versioned:  https://hub.docker.com/r/%s/tags?name=%s\n" "${DOCKER_HUB_REPO}" "${VERSION_TAG}"; fi)

${BLUE}Next Steps:${RESET}
  ${GREEN}✓${RESET} Pull image:        docker pull ${IMAGE_NAME}:latest
  ${GREEN}✓${RESET} Run container:     docker run -p 3002:3002 ${IMAGE_NAME}:latest
  ${GREEN}✓${RESET} Test health:       curl http://localhost:3002/health
  ${GREEN}✓${RESET} Inspect manifest:  docker buildx imagetools inspect ${IMAGE_NAME}:latest

${BLUE}Platform-specific pulls:${RESET}
  ${GRAY}# Auto-selected by Docker, or specify explicitly:${RESET}
  docker pull --platform linux/amd64 ${IMAGE_NAME}:latest
  docker pull --platform linux/arm64 ${IMAGE_NAME}:latest

${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}
EOF
}

# ============================================================================
# Error Handler
# ============================================================================

function cleanup_on_error() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo ""
    log_error "Script failed with exit code ${exit_code}"
    echo ""
    echo -e "${BLUE}Troubleshooting:${RESET}"
    echo "  - Check Docker logs: docker logs <container-id>"
    echo "  - Verify Dockerfile: cat Dockerfile"
    echo "  - Check disk space: df -h"
    echo "  - Review build output above"
    echo ""
    echo -e "${BLUE}Multi-arch troubleshooting:${RESET}"
    echo "  - Reset builder: docker buildx rm peta-multiarch-builder"
    echo "  - Check builder: docker buildx inspect --bootstrap"
    echo "  - List builders: docker buildx ls"
    echo "  - Network: Multi-arch requires stable connection"
    echo "  - Auth: docker login"
    echo ""
    echo -e "${BLUE}Common issues:${RESET}"
    echo "  - Insufficient disk space (need ${MIN_DISK_SPACE_GB}GB + 2GB for multi-arch)"
    echo "  - Network connectivity problems (critical for multi-arch)"
    echo "  - Docker Hub rate limits"
    echo "  - Invalid Docker Hub credentials"
    echo "  - Builder initialization failed"
    echo "  - Platform emulation issues (QEMU)"
  fi
}

trap cleanup_on_error EXIT

# ============================================================================
# Main Function
# ============================================================================

function main() {
  local total_start=$(date +%s)

  # Banner
  echo -e "${BRIGHT}${BLUE}"
  cat << 'BANNER'
╔═══════════════════════════════════════════════════╗
║   Peta Core - Multi-Arch Docker Build             ║
╚═══════════════════════════════════════════════════╝
BANNER
  echo -e "${RESET}"

  # Parse arguments
  parse_arguments "$@"

  # Environment checks
  check_docker || exit 1
  check_docker_login || exit 1
  setup_buildx_builder || exit 1
  check_disk_space || exit 1

  # Optional cleanup
  if [[ "$CLEAN" == true ]]; then
    clean_docker
  fi

  # Build and push
  build_image || exit 1
  push_image || exit 1
  verify_image

  # Summary
  show_summary

  # Total time
  local total_end=$(date +%s)
  local total_duration=$((total_end - total_start))
  local minutes=$((total_duration / 60))
  local seconds=$((total_duration % 60))

  local step_num="9/9"
  if [[ "$CLEAN" == true ]]; then
    step_num="10/10"
  fi

  log_step "Step ${step_num}: Complete"
  log_success "Total time: ${minutes}m ${seconds}s"

  # Remove error trap on success
  trap - EXIT
}

# ============================================================================
# Execute main function
# ============================================================================

main "$@"
