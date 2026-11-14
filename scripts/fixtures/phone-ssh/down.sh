#!/bin/bash
# Stop and remove the phone-ssh fixture container (the image is kept for a fast next up.sh).
set -euo pipefail
name=ovis-phone-ssh-fixture
docker rm -f "$name" >/dev/null 2>&1 || true
echo "docker ps -a --filter name=$name:"
docker ps -a --filter "name=$name"
