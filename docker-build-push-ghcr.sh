#!/usr/bin/env bash
set -euo pipefail

echo "GHCR publication is disabled: the coordinated release requires Docker Hub server-side immutable semantic-version tags." >&2
echo "Use docker-build-push.sh after setting PETA_RELEASE_PUSH=1 and DOCKER_HUB_IMMUTABLE_TAG_POLICY=enabled." >&2
exit 1
