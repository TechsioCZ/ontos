#!/usr/bin/env bash
# Run from app/. Starts the S3-compatible emulator (MinIO, NOT Cloudflare R2) the Core Media proof writes to,
# from the image docker-compose.yml pins, with one throwaway bucket. run-core-media-proof.sh uses it.
set -euo pipefail

: "${ONTOS_CI_MINIO_ROOT_USER:?}"
: "${ONTOS_CI_MINIO_ROOT_PASSWORD:?}"
: "${ONTOS_CI_MINIO_BUCKET:?}"
: "${ONTOS_CI_MINIO_PORT:?}"
container="${ONTOS_CI_MINIO_CONTAINER:-ontos-ci-minio}"

image="$(docker compose --profile core-media config --format json | jq -er '.services["ontos-minio"].image')"
# The ontos-ci-worker label puts the container under the job's cleanup of its worker services.
MINIO_ROOT_USER="$ONTOS_CI_MINIO_ROOT_USER" MINIO_ROOT_PASSWORD="$ONTOS_CI_MINIO_ROOT_PASSWORD" \
  docker run --detach --name "$container" --label ontos-ci-worker \
  --env MINIO_ROOT_USER --env MINIO_ROOT_PASSWORD --env "MINIO_DEFAULT_BUCKETS=$ONTOS_CI_MINIO_BUCKET" \
  --publish "127.0.0.1:$ONTOS_CI_MINIO_PORT:9000" "$image" >/dev/null

# The image first runs a temporary server to create the bucket and answers health checks from it too, so only
# the server it starts after that setup counts.
for ((attempt = 0; attempt < 90; attempt++)); do
  if docker logs "$container" 2>&1 | grep -F '** Starting MinIO **' >/dev/null \
    && docker logs "$container" 2>&1 | grep -F 'API: ' >/dev/null \
    && curl --fail --silent --max-time 2 "http://127.0.0.1:$ONTOS_CI_MINIO_PORT/minio/health/live" >/dev/null; then
    echo "The S3-compatible emulator accepts connections with bucket $ONTOS_CI_MINIO_BUCKET."
    exit 0
  fi
  sleep 1
done
docker logs --tail 100 "$container"
echo '::error::The S3-compatible emulator did not become ready.'
exit 1
