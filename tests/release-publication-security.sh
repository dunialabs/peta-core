#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FAKE_BIN="$TEST_ROOT/bin"
DOCKER_CONFIG_DIR="$TEST_ROOT/docker-config"
DOCKER_LOG="$TEST_ROOT/docker.log"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$FAKE_BIN"
mkdir -p "$DOCKER_CONFIG_DIR"
printf '{"auths":{"https://index.docker.io/v1/":{"auth":"synthetic"}}}\n' > "$DOCKER_CONFIG_DIR/config.json"

cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  "info"|"buildx version"|"buildx inspect peta-core-release-builder") exit 0 ;;
  "buildx imagetools inspect "*:1.3.0)
    if [[ ! -f "${DOCKER_LOG}.pushed" && "${SYNTHETIC_MANIFEST_STATE:-missing}" =~ ^(missing|missing-arm64)$ ]]; then
      echo 'manifest unknown' >&2
      exit 1
    fi
    if [[ "${SYNTHETIC_MANIFEST_STATE}" == "unreadable" ]]; then
      echo 'unauthorized' >&2
      exit 1
    fi
    cat <<MANIFEST
Name: petaio/peta-core:1.3.0
Digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Platform: linux/amd64
$(if [[ "${SYNTHETIC_MANIFEST_STATE}" != "missing-arm64" ]]; then echo 'Platform: linux/arm64'; fi)
MANIFEST
    ;;
  "buildx build "*) touch "${DOCKER_LOG}.pushed" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/docker"

run_docker_release() {
  : > "$DOCKER_LOG"
  rm -f "${DOCKER_LOG}.pushed"
  set +e
  RELEASE_OUTPUT="$(
    cd "$ROOT"
    env \
      PATH="$FAKE_BIN:$PATH" \
      DOCKER_LOG="$DOCKER_LOG" \
      DOCKER_CONFIG="$DOCKER_CONFIG_DIR" \
      IMAGE_NAME="example.invalid/other" \
      PLATFORMS="linux/amd64,linux/arm64,linux/s390x" \
      PETA_RELEASE_PUSH="${1:-}" \
      DOCKER_HUB_IMMUTABLE_TAG_POLICY="${2:-}" \
      SYNTHETIC_MANIFEST_STATE="${3:-missing}" \
      MANIFEST_VERIFY_ATTEMPTS=1 \
      MANIFEST_VERIFY_DELAY_SECONDS=0 \
      ./docker-build-push.sh --non-interactive 2>&1
  )"
  RELEASE_STATUS=$?
  set -e
}

run_docker_release '' enabled missing
[[ $RELEASE_STATUS -ne 0 ]]
[[ ! -s "$DOCKER_LOG" ]]
grep -q 'PETA_RELEASE_PUSH=1 is required' <<< "$RELEASE_OUTPUT"

mv "$DOCKER_CONFIG_DIR/config.json" "$DOCKER_CONFIG_DIR/config.json.saved"
run_docker_release 1 enabled missing
[[ $RELEASE_STATUS -ne 0 ]]
[[ ! -s "$DOCKER_LOG" ]]
grep -q 'Docker Hub credentials are required' <<< "$RELEASE_OUTPUT"
mv "$DOCKER_CONFIG_DIR/config.json.saved" "$DOCKER_CONFIG_DIR/config.json"

run_docker_release 1 '' missing
[[ $RELEASE_STATUS -ne 0 ]]
[[ ! -s "$DOCKER_LOG" ]]
grep -q 'DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled is required' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled unreadable
[[ $RELEASE_STATUS -ne 0 ]]
! grep -q '^buildx build ' "$DOCKER_LOG"
grep -q 'Unable to confirm that release tag is unused' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled existing
[[ $RELEASE_STATUS -ne 0 ]]
! grep -q '^buildx build ' "$DOCKER_LOG"
grep -q 'Refusing to overwrite existing release tag' <<< "$RELEASE_OUTPUT"

set +e
CUSTOM_TAG_OUTPUT="$(cd "$ROOT" && env PETA_RELEASE_PUSH=1 DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled PUBLISH_TAG=latest ./docker-build-push.sh --non-interactive 2>&1)"
CUSTOM_TAG_STATUS=$?
set -e
[[ $CUSTOM_TAG_STATUS -ne 0 ]]
grep -q 'latest, date, and arbitrary aliases are forbidden' <<< "$CUSTOM_TAG_OUTPUT"

run_docker_release 1 enabled missing-arm64
[[ $RELEASE_STATUS -ne 0 ]]
grep -q 'manifest is missing linux/arm64' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled missing
[[ $RELEASE_STATUS -eq 0 ]]
grep -Fxq 'buildx build --platform linux/amd64,linux/arm64 --file ./Dockerfile --tag petaio/peta-core:1.3.0 --push .' "$DOCKER_LOG"
! grep -Eq 'latest|[0-9]{8}' "$DOCKER_LOG"
! grep -Eq 'example\.invalid|linux/s390x' "$DOCKER_LOG"
grep -q 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' <<< "$RELEASE_OUTPUT"

set +e
GHCR_OUTPUT="$(cd "$ROOT" && PATH="$FAKE_BIN:$PATH" DOCKER_LOG="$DOCKER_LOG" ./docker-build-push-ghcr.sh 2>&1)"
GHCR_STATUS=$?
set -e
[[ $GHCR_STATUS -ne 0 ]]
grep -q 'GHCR publication is disabled' <<< "$GHCR_OUTPUT"

set +e
PUBLISH_OUTPUT="$(cd "$ROOT" && env \
  PETA_CONSOLE_TLS_REVOCATION_EVIDENCE= \
  PETA_CONSOLE_TLS_ROTATION_EVIDENCE= \
  PETA_CONSOLE_REPLACEMENT_DEPLOYMENT_EVIDENCE= \
  node scripts/release-main.js publish --manifest "$TEST_ROOT/missing.json" 2>&1)"
PUBLISH_STATUS=$?
set -e
[[ $PUBLISH_STATUS -ne 0 ]]
grep -q 'PETA_CONSOLE_TLS_REVOCATION_EVIDENCE' <<< "$PUBLISH_OUTPUT"

for evidence in revocation rotation deployment; do
  printf 'verified %s evidence\n' "$evidence" > "$TEST_ROOT/$evidence.txt"
done
set +e
PUBLISH_OUTPUT="$(cd "$ROOT" && env \
  PETA_CONSOLE_TLS_REVOCATION_EVIDENCE="$TEST_ROOT/revocation.txt" \
  PETA_CONSOLE_TLS_ROTATION_EVIDENCE="$TEST_ROOT/rotation.txt" \
  PETA_CONSOLE_REPLACEMENT_DEPLOYMENT_EVIDENCE="$TEST_ROOT/deployment.txt" \
  node scripts/release-main.js publish --manifest "$TEST_ROOT/missing.json" 2>&1)"
PUBLISH_STATUS=$?
set -e
[[ $PUBLISH_STATUS -ne 0 ]]
grep -q 'Manifest not found' <<< "$PUBLISH_OUTPUT"
! grep -q 'PETA_CONSOLE_TLS_REVOCATION_EVIDENCE' <<< "$PUBLISH_OUTPUT"

echo 'PASS: Core publication paths are immutable and public release creation is evidence-gated'
