#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly IMAGE_NAME="petaio/peta-core"
readonly VERSION_TAG="$(node -e "const p=require(process.argv[1]); process.stdout.write(p.version || '')" "$SCRIPT_DIR/package.json")"
readonly PUBLISH_TAG="${PUBLISH_TAG:-$VERSION_TAG}"
readonly RELEASE_GIT_SHA="${PETA_RELEASE_GIT_SHA:-}"
readonly PLATFORMS="linux/amd64,linux/arm64"
readonly MANIFEST_VERIFY_ATTEMPTS="${MANIFEST_VERIFY_ATTEMPTS:-12}"
readonly MANIFEST_VERIFY_DELAY_SECONDS="${MANIFEST_VERIFY_DELAY_SECONDS:-5}"
VERBOSE=false

usage() {
  cat <<EOF
Usage: PETA_RELEASE_PUSH=1 DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled PETA_RELEASE_GIT_SHA=<40-char-sha> ./docker-build-push.sh [--verbose] [--non-interactive]

Publishes only ${IMAGE_NAME}:${VERSION_TAG} for linux/amd64 and linux/arm64.
The semantic-version tag must be protected by Docker Hub's server-side immutable-tag policy.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--verbose) VERBOSE=true ;;
    -y|--non-interactive) ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

cd "$SCRIPT_DIR"

if [[ "${PETA_RELEASE_PUSH:-}" != "1" ]]; then
  echo "PETA_RELEASE_PUSH=1 is required for external publication" >&2
  exit 1
fi
if [[ "${DOCKER_HUB_IMMUTABLE_TAG_POLICY:-}" != "enabled" ]]; then
  echo "DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled is required after enabling Docker Hub's server-side semantic-version tag immutability policy" >&2
  exit 1
fi
if [[ ! "$RELEASE_GIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "PETA_RELEASE_GIT_SHA must be a lowercase 40-character commit SHA" >&2
  exit 1
fi
if ! git rev-parse --verify "${RELEASE_GIT_SHA}^{commit}" >/dev/null; then
  echo "PETA_RELEASE_GIT_SHA must name an existing commit" >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$RELEASE_GIT_SHA" ]]; then
  echo "PETA_RELEASE_GIT_SHA must equal HEAD" >&2
  exit 1
fi
if ! git diff --quiet "$RELEASE_GIT_SHA" --; then
  echo "Refusing to publish tracked changes; commit or discard them first" >&2
  exit 1
fi
if [[ ! "$VERSION_TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "package.json version must be a simple semantic version" >&2
  exit 1
fi
if [[ "$PUBLISH_TAG" != "$VERSION_TAG" ]]; then
  echo "PUBLISH_TAG must equal package.json version (${VERSION_TAG}); latest, date, and arbitrary aliases are forbidden" >&2
  exit 1
fi
if [[ ",$PLATFORMS," != *",linux/amd64,"* || ",$PLATFORMS," != *",linux/arm64,"* ]]; then
  echo "PLATFORMS must include linux/amd64 and linux/arm64" >&2
  exit 1
fi
if [[ ! "$MANIFEST_VERIFY_ATTEMPTS" =~ ^[1-9][0-9]*$ || ! "$MANIFEST_VERIFY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Manifest verification settings are invalid" >&2
  exit 1
fi

command -v docker >/dev/null || { echo "Docker is required" >&2; exit 1; }
docker_config="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
if [[ ! -r "$docker_config" ]] || ! grep -Eq '"(https://index\.docker\.io/v1/|docker\.io|registry-1\.docker\.io)"|"credsStore"|"credHelpers"' "$docker_config"; then
  echo "Docker Hub credentials are required; run docker login docker.io before publishing" >&2
  exit 1
fi
docker info >/dev/null
docker buildx version >/dev/null

readonly IMAGE_REF="${IMAGE_NAME}:${PUBLISH_TAG}"
if inspect_output="$(docker buildx imagetools inspect "$IMAGE_REF" 2>&1)"; then
  echo "Refusing to overwrite existing release tag: ${IMAGE_REF}" >&2
  exit 1
fi
if ! grep -Eqi 'manifest unknown|name unknown|not found' <<< "$inspect_output"; then
  echo "Unable to confirm that release tag is unused; refusing to publish ${IMAGE_REF}" >&2
  exit 1
fi

build_args=(buildx build --platform "$PLATFORMS" --file ./Dockerfile --tag "$IMAGE_REF" --push)
[[ "$VERBOSE" == true ]] && build_args+=(--progress=plain)
git archive --format=tar "$RELEASE_GIT_SHA" | docker "${build_args[@]}" -

verified_digest=""
failure_reason="manifest is unreadable"
for ((attempt = 1; attempt <= MANIFEST_VERIFY_ATTEMPTS; attempt += 1)); do
  if inspect_output="$(docker buildx imagetools inspect "$IMAGE_REF" 2>&1)"; then
    digest="$(awk '$1 == "Digest:" {print $2; exit}' <<< "$inspect_output")"
    platforms="$(awk '$1 == "Platform:" {print $2}' <<< "$inspect_output")"
    if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      failure_reason="manifest digest is missing or invalid"
    elif ! grep -Fxq 'linux/amd64' <<< "$platforms"; then
      failure_reason="manifest is missing linux/amd64"
    elif ! grep -Fxq 'linux/arm64' <<< "$platforms"; then
      failure_reason="manifest is missing linux/arm64"
    else
      verified_digest="$digest"
      break
    fi
  fi
  if [[ $attempt -lt $MANIFEST_VERIFY_ATTEMPTS ]]; then
    sleep "$MANIFEST_VERIFY_DELAY_SECONDS"
  fi
done

if [[ -z "$verified_digest" ]]; then
  echo "Post-push verification failed: ${failure_reason}" >&2
  exit 1
fi

printf 'Published %s\nSource commit: %s\nDigest: %s\nPlatforms: linux/amd64, linux/arm64\n' "$IMAGE_REF" "$RELEASE_GIT_SHA" "$verified_digest"
