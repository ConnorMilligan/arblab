#!/usr/bin/env bash
# Rebuild and restart Dannymarket on the server. With --bump, first move the Dockerfile's base-image
# pin to the current digest of the same tag, so Node and Debian security patches get picked up.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--bump" ]]; then
  tag=$(grep -oE 'node:[0-9.]+-slim' Dockerfile | head -1)
  podman pull -q "docker.io/library/$tag" >/dev/null
  digest=$(podman image inspect "docker.io/library/$tag" --format '{{index .RepoDigests 0}}' | grep -oE 'sha256:[0-9a-f]+')
  sed -i -E "s|^(FROM node:[0-9.]+-slim)@sha256:[0-9a-f]+|\1@$digest|" Dockerfile
  echo "base image pinned to $tag@$digest"
fi

npm audit --omit=dev --audit-level=high || echo "WARNING: npm audit reported issues" >&2
podman build -t localhost/arblab:latest .
systemctl --user restart arblab.service
sleep 4
podman healthcheck run arblab && echo "Dannymarket healthy"
