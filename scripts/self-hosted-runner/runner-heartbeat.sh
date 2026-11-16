#!/usr/bin/env bash
# The heartbeat of a further self-hosted host's runners (README "Routing jobs to it"): while at least <min-online>
# (default 2) runners whose name starts with <runner-name-prefix> and that carry <label> are online, sets the
# repository variable <variable> to "<epoch seconds> <labels> <their own labels>": the labels the counted runners
# carry, and those of them no other runner of the repository carries, online or not, each lower-case as one JSON
# array. The counted runners must carry identical labels, or a job asking for a label only some of them carry could
# take one unseen; and some label must be theirs alone, or a label list for the host could also send a job to another
# runner. Otherwise the heartbeat is not written. scripts/ci-runner-route.sh requires that value to be fresh, to list
# every label of CI_MAIN_BROWSER_PARTS_LABELS among the first and at least one among the second, before it sends
# main's browser parts 1 and 2 to the host (CI_BROWSER_PARTS_RUNNERS_SEEN), and counts the jobs that ask only for the
# first as the host's. Listing runners needs the repository admin's token, which the workflow token lacks, so this
# runs outside Actions with the maintainer's `gh`, once a minute from the loop that hands the host its registration
# tokens: when that loop or the host stops, the value ages and the parts run where they always did. Too few runners
# online writes nothing; a failed listing writes nothing and exits 1.
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $0 <runner-name-prefix> <label> <variable> [min-online]" >&2
  exit 2
fi
prefix="$1" label="$2" variable="$3" min="${4:-2}"
repo="${REPO:-devswha/ovis}"
if ! [[ "$min" =~ ^[1-9][0-9]{0,2}$ ]]; then
  echo "min-online must be a whole number above 0, got: $min" >&2
  exit 2
fi

if ! runners=$(gh api --paginate "repos/$repo/actions/runners?per_page=100"); then
  echo "could not list the runners of $repo: heartbeat not written" >&2
  exit 1
fi
# every runner of the repository by name, status and lower-case labels; the counted ones among them
all=$(jq -sc '[.[].runners[] | {name, status, labels: ([.labels[].name | ascii_downcase] | unique)}]' <<<"$runners")
counted=$(jq -c --arg prefix "$prefix" --arg label "$label" \
  '[.[] | select((.name | startswith($prefix)) and .status == "online" and (.labels | index($label | ascii_downcase)))]' <<<"$all")
online=$(jq length <<<"$counted")
if (( online < min )); then
  echo "$online runner(s) $prefix* with $label online, $min needed: heartbeat not written" >&2
  exit 0
fi
if [[ $(jq '[.[].labels] | unique | length' <<<"$counted") != 1 ]]; then
  echo "the runners $prefix* with $label carry different labels ($(jq -c '[.[].labels] | unique' <<<"$counted")): heartbeat not written" >&2
  exit 0
fi
labels=$(jq -c '.[0].labels' <<<"$counted")
alone=$(jq -c --argjson counted "$counted" '($counted | map(.name)) as $names
  | $counted[0].labels - [.[] | select(.name as $name | $names | index($name) | not) | .labels[]]' <<<"$all")
if [[ "$alone" == "[]" ]]; then
  echo "every label of the runners $prefix* with $label is carried by another runner too: heartbeat not written" >&2
  exit 0
fi
now=$(date +%s)
gh variable set "$variable" --repo "$repo" --body "$now $labels $alone"
