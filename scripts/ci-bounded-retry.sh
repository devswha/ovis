#!/usr/bin/env bash
set -uo pipefail
limit=$1
shift
for attempt in 1 2 3; do
  timeout --kill-after=15 "$limit" "$@" && exit 0
  echo "ci-bounded-retry: attempt $attempt of 3 failed or ran past ${limit}s: $*" >&2
done
exit 1
