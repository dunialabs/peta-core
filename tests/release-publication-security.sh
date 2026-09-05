#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FAKE_BIN="$TEST_ROOT/bin"
DOCKER_CONFIG_DIR="$TEST_ROOT/docker-config"
DOCKER_LOG="$TEST_ROOT/docker.log"
TIMEOUT_LOG="$TEST_ROOT/timeout.log"
VALID_SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
OTHER_SHA='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
FOREIGN_REPO="$TEST_ROOT/foreign-repo"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$FAKE_BIN"
mkdir -p "$DOCKER_CONFIG_DIR"
mkdir -p "$FOREIGN_REPO"
git -C "$FOREIGN_REPO" init -q
printf '{"auths":{"https://index.docker.io/v1/":{"auth":"synthetic"}}}\n' > "$DOCKER_CONFIG_DIR/config.json"
printf 'source archive sentinel\n' > "$TEST_ROOT/.archive-sentinel"
printf 'foreign archive sentinel\n' > "$FOREIGN_REPO/.foreign-archive-sentinel"

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
Name: bcdunia/peta-core:1.3.0
Digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Platform: linux/amd64
$(if [[ "${SYNTHETIC_MANIFEST_STATE}" != "missing-arm64" ]]; then echo 'Platform: linux/arm64'; fi)
MANIFEST
    ;;
  "buildx build "*)
    tar -tf - >> "$DOCKER_LOG"
    touch "${DOCKER_LOG}.pushed"
    ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/docker"

cat > "$FAKE_BIN/timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$TIMEOUT_LOG"
if [[ "${1:-}" == "--help" ]]; then
  if [[ "${SYNTHETIC_TIMEOUT_NO_KILL_AFTER:-0}" != 1 ]]; then
    echo '--kill-after=DURATION'
  fi
  exit 0
fi
if [[ "${SYNTHETIC_TIMEOUT_STATUS:-0}" != "0" ]]; then
  exit "$SYNTHETIC_TIMEOUT_STATUS"
fi
shift 2
exec "$@"
EOF
chmod +x "$FAKE_BIN/timeout"

cat > "$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${PETA_FAKE_GIT_ROOT:-}" && "$PWD" != "$PETA_FAKE_GIT_ROOT" ]]; then
  case "$1 $2" in
    "rev-parse --verify")
      [[ "${3:-}" == "${PETA_FAKE_GIT_FOREIGN_SHA}^{commit}" ]] || exit 1
      printf '%s\n' "$PETA_FAKE_GIT_FOREIGN_SHA"
      ;;
    "rev-parse HEAD") printf '%s\n' "$PETA_FAKE_GIT_FOREIGN_HEAD" ;;
    "diff --quiet") [[ "${PETA_FAKE_GIT_DIRTY:-0}" == 0 ]] ;;
    "archive --format=tar")
      [[ "${3:-}" == "$PETA_FAKE_GIT_FOREIGN_SHA" ]] || exit 1
      tar -cf - -C "${PETA_FAKE_GIT_FOREIGN_ARCHIVE_DIR}" .foreign-archive-sentinel
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
case "$1 $2" in
  "rev-parse --verify")
    [[ "${3:-}" == "${PETA_FAKE_GIT_VALID_SHA}^{commit}" ]] || exit 1
    printf '%s\n' "$PETA_FAKE_GIT_VALID_SHA"
    ;;
  "rev-parse HEAD") printf '%s\n' "$PETA_FAKE_GIT_HEAD" ;;
  "diff --quiet") [[ "${PETA_FAKE_GIT_DIRTY:-0}" == 0 ]] ;;
  "archive --format=tar")
    [[ "${3:-}" == "$PETA_FAKE_GIT_VALID_SHA" ]] || exit 1
    tar -cf - -C "${PETA_FAKE_GIT_ARCHIVE_DIR}" .archive-sentinel
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$FAKE_BIN/git"

run_docker_release() {
  : > "$DOCKER_LOG"
  : > "$TIMEOUT_LOG"
  rm -f "${DOCKER_LOG}.pushed"
  local release_cwd="${7:-$ROOT}"
  set +e
  RELEASE_OUTPUT="$(
    cd "$release_cwd"
    env \
      PATH="$FAKE_BIN:$PATH" \
      DOCKER_LOG="$DOCKER_LOG" \
      TIMEOUT_LOG="$TIMEOUT_LOG" \
      DOCKER_CONFIG="$DOCKER_CONFIG_DIR" \
      IMAGE_NAME="example.invalid/other" \
      PLATFORMS="linux/amd64,linux/arm64,linux/s390x" \
      PETA_RELEASE_PUSH="${1:-}" \
      DOCKER_HUB_IMMUTABLE_TAG_POLICY="${2:-}" \
      SYNTHETIC_MANIFEST_STATE="${3:-missing}" \
      PETA_RELEASE_GIT_SHA="${4-$VALID_SHA}" \
      PETA_FAKE_GIT_VALID_SHA="$VALID_SHA" \
      PETA_FAKE_GIT_HEAD="${5:-$VALID_SHA}" \
      PETA_FAKE_GIT_DIRTY="${6:-0}" \
      PETA_FAKE_GIT_ARCHIVE_DIR="$TEST_ROOT" \
      PETA_FAKE_GIT_ROOT="$ROOT" \
      PETA_FAKE_GIT_FOREIGN_SHA="$OTHER_SHA" \
      PETA_FAKE_GIT_FOREIGN_HEAD="$OTHER_SHA" \
      PETA_FAKE_GIT_FOREIGN_ARCHIVE_DIR="$FOREIGN_REPO" \
      SYNTHETIC_TIMEOUT_STATUS="${8:-0}" \
      MANIFEST_VERIFY_ATTEMPTS=1 \
      MANIFEST_VERIFY_DELAY_SECONDS=0 \
      "$ROOT/docker-build-push.sh" --non-interactive 2>&1
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

run_docker_release 1 enabled missing ''
[[ $RELEASE_STATUS -ne 0 ]]
[[ ! -s "$DOCKER_LOG" ]]
grep -q 'PETA_RELEASE_GIT_SHA must be a lowercase 40-character commit SHA' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled missing 'ABCDEF'
[[ $RELEASE_STATUS -ne 0 ]]
[[ ! -s "$DOCKER_LOG" ]]
grep -q 'PETA_RELEASE_GIT_SHA must be a lowercase 40-character commit SHA' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled missing "$OTHER_SHA"
[[ $RELEASE_STATUS -ne 0 ]]
[[ ! -s "$DOCKER_LOG" ]]
grep -q 'PETA_RELEASE_GIT_SHA must name an existing commit' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled missing "$VALID_SHA" "$OTHER_SHA"
[[ $RELEASE_STATUS -ne 0 ]]
[[ ! -s "$DOCKER_LOG" ]]
grep -q 'PETA_RELEASE_GIT_SHA must equal HEAD' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled missing "$VALID_SHA" "$VALID_SHA" 1
[[ $RELEASE_STATUS -ne 0 ]]
[[ ! -s "$DOCKER_LOG" ]]
grep -q 'tracked changes' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled missing "$VALID_SHA" "$VALID_SHA" 0 "$FOREIGN_REPO"
[[ $RELEASE_STATUS -eq 0 ]]
grep -Fxq '.archive-sentinel' "$DOCKER_LOG"
! grep -Fxq '.foreign-archive-sentinel' "$DOCKER_LOG"

run_docker_release 1 enabled unreadable
[[ $RELEASE_STATUS -ne 0 ]]
! grep -q '^buildx build ' "$DOCKER_LOG"
grep -q 'Unable to confirm that release tag is unused' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled existing
[[ $RELEASE_STATUS -ne 0 ]]
! grep -q '^buildx build ' "$DOCKER_LOG"
grep -q 'Refusing to overwrite existing release tag' <<< "$RELEASE_OUTPUT"

set +e
CUSTOM_TAG_OUTPUT="$(cd "$ROOT" && env \
  PATH="$FAKE_BIN:$PATH" \
  PETA_RELEASE_PUSH=1 \
  DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled \
  PETA_RELEASE_GIT_SHA="$VALID_SHA" \
  PETA_FAKE_GIT_VALID_SHA="$VALID_SHA" \
  PETA_FAKE_GIT_HEAD="$VALID_SHA" \
  PETA_FAKE_GIT_ARCHIVE_DIR="$TEST_ROOT" \
  PUBLISH_TAG=latest \
  ./docker-build-push.sh --non-interactive 2>&1)"
CUSTOM_TAG_STATUS=$?
set -e
[[ $CUSTOM_TAG_STATUS -ne 0 ]]
grep -q 'latest, date, and arbitrary aliases are forbidden' <<< "$CUSTOM_TAG_OUTPUT"

run_docker_release 1 enabled missing-arm64
[[ $RELEASE_STATUS -ne 0 ]]
grep -q 'manifest is missing linux/arm64' <<< "$RELEASE_OUTPUT"

run_docker_release 1 enabled missing
[[ $RELEASE_STATUS -eq 0 ]]
grep -Fxq 'buildx build --platform linux/amd64,linux/arm64 --file ./Dockerfile --tag bcdunia/peta-core:1.3.0 --push -' "$DOCKER_LOG"
grep -Fxq -- '--kill-after=30s 900 docker buildx build --platform linux/amd64,linux/arm64 --file ./Dockerfile --tag bcdunia/peta-core:1.3.0 --push -' "$TIMEOUT_LOG"
grep -Fxq '.archive-sentinel' "$DOCKER_LOG"
! grep -Eq 'latest|[0-9]{8}' "$DOCKER_LOG"
! grep -Eq 'example\.invalid|linux/s390x' "$DOCKER_LOG"
grep -q 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' <<< "$RELEASE_OUTPUT"

SYNTHETIC_TIMEOUT_NO_KILL_AFTER=1 run_docker_release 1 enabled missing
[[ $RELEASE_STATUS -eq 0 ]]
grep -Fxq -- '--help' "$TIMEOUT_LOG"
grep -Fxq 'buildx build --platform linux/amd64,linux/arm64 --file ./Dockerfile --tag bcdunia/peta-core:1.3.0 --push -' "$DOCKER_LOG"

for timeout_status in 124 142 143; do
  run_docker_release 1 enabled missing "$VALID_SHA" "$VALID_SHA" 0 "$ROOT" "$timeout_status"
  [[ $RELEASE_STATUS -eq $timeout_status ]]
  [[ ! -f "${DOCKER_LOG}.pushed" ]]
  ! grep -q '^buildx build ' "$DOCKER_LOG"
  grep -q "Docker Buildx publication timed out after 15 minutes (exit ${timeout_status})" <<< "$RELEASE_OUTPUT"
done

TIMEOUT_CHILD_PID_FILE="$TEST_ROOT/term-resistant-child.pid"
TIMEOUT_STARTED="$(perl -MTime::HiRes=time -e 'printf "%.3f", time')"
set +e
TIMEOUT_OUTPUT="$(
  TIMEOUT_CHILD_PID_FILE="$TIMEOUT_CHILD_PID_FILE" \
    perl "$ROOT/scripts/hard-timeout.pl" 1 1 bash -c 'bash -c "trap \"\" TERM; printf \"%s\" \"\$\$\" > \"$TIMEOUT_CHILD_PID_FILE\"; while :; do :; done" & trap "exit 0" TERM; wait' 2>&1
)"
TIMEOUT_STATUS=$?
set -e
TIMEOUT_FINISHED="$(perl -MTime::HiRes=time -e 'printf "%.3f", time')"
TIMEOUT_ELAPSED="$(awk -v started="$TIMEOUT_STARTED" -v finished="$TIMEOUT_FINISHED" 'BEGIN { print finished - started }')"
[[ $TIMEOUT_STATUS -eq 124 ]]
[[ -s "$TIMEOUT_CHILD_PID_FILE" ]]
for ((attempt = 1; attempt <= 20; attempt += 1)); do
  ! kill -0 "$(<"$TIMEOUT_CHILD_PID_FILE")" 2>/dev/null && break
  sleep 0.05
done
! kill -0 "$(<"$TIMEOUT_CHILD_PID_FILE")" 2>/dev/null
awk -v elapsed="$TIMEOUT_ELAPSED" 'BEGIN { exit !(elapsed >= 1.8 && elapsed < 4) }'
[[ -z "$TIMEOUT_OUTPUT" ]]

NO_TIMEOUT_BIN="$TEST_ROOT/no-timeout-bin"
mkdir -p "$NO_TIMEOUT_BIN"
for command_name in bash dirname node; do
  ln -s "$(command -v "$command_name")" "$NO_TIMEOUT_BIN/$command_name"
done
cp "$FAKE_BIN/git" "$NO_TIMEOUT_BIN/git"
set +e
NO_TIMEOUT_OUTPUT="$(
  cd "$ROOT"
  env \
    PATH="$NO_TIMEOUT_BIN" \
    PETA_RELEASE_PUSH=1 \
    DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled \
    PETA_RELEASE_GIT_SHA="$VALID_SHA" \
    PETA_FAKE_GIT_VALID_SHA="$VALID_SHA" \
    PETA_FAKE_GIT_HEAD="$VALID_SHA" \
    PETA_FAKE_GIT_DIRTY=0 \
    PETA_FAKE_GIT_ARCHIVE_DIR="$TEST_ROOT" \
    "$ROOT/docker-build-push.sh" --non-interactive 2>&1
)"
NO_TIMEOUT_STATUS=$?
set -e
[[ $NO_TIMEOUT_STATUS -ne 0 ]]
grep -q 'No supported hard-timeout implementation is available' <<< "$NO_TIMEOUT_OUTPUT"

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
grep -q 'Public Git tag and GitHub Release publication is disabled' <<< "$PUBLISH_OUTPUT"
! grep -q 'Manifest not found' <<< "$PUBLISH_OUTPUT"

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
grep -q 'Public Git tag and GitHub Release publication is disabled' <<< "$PUBLISH_OUTPUT"
! grep -q 'Manifest not found' <<< "$PUBLISH_OUTPUT"

echo 'PASS: Core publication paths are immutable and automated public Git releases are disabled'
