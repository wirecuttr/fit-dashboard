#!/usr/bin/env bash
set -euo pipefail

# Navigate to the script directory to ensure relative paths work
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_BUILD="docker-compose-build.yml"
COMPOSE_OVERRIDE="docker-compose.override.yml"

# Build the docker compose arguments array
COMPOSE_ARGS=("-f" "$COMPOSE_BUILD")

if [ -f "$COMPOSE_OVERRIDE" ]; then
    echo "Info: Found override configuration file: $COMPOSE_OVERRIDE"
    COMPOSE_ARGS+=("-f" "$COMPOSE_OVERRIDE")
else
    echo "Info: No override configuration file found."
fi

echo "Step 1: Taking down existing container(s)..."
docker compose "${COMPOSE_ARGS[@]}" down

echo "Step 2: Building and deploying container(s)..."
docker compose "${COMPOSE_ARGS[@]}" up -d --build

echo "Deployment completed successfully."
