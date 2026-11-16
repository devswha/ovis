#!/usr/bin/env bash
# Picks the runner for ci.yml's Linux jobs and prints `linux=<json>` for $GITHUB_OUTPUT, then `fast=<json>` for Fast checks,
# and for a push to main only, while a further self-hosted host is set, fresh and free, `parts=<json>` for parts 1 and 2 of
# Browser regression (other scripts) (at the end of this script).
# A fork pull request always gets the GitHub-hosted image: its code must never reach the
# self-hosted runner. Otherwise the workflow_dispatch input wins over the repository variable
# CI_SELF_HOSTED_LABELS. With neither, a push goes to the maintainer PC's runners
# (scripts/self-hosted-runner/, label self-hosted-ovis), a same-repository pull request goes there
# only while they have room for its Linux jobs and to ubuntu-24.04 otherwise, and any other event
# stays on ubuntu-24.04. "Room" is counted from the Actions API, since the workflow token cannot
# list runners: CI_SELF_HOSTED_CAPACITY (default 10) minus the queued and running jobs of every
# workflow that could take those runners must leave at least the jobs one run needs. When that count
# fails, the pull request stays hosted. Setting the variable to labels sends every pull request to
# them, and the value "ubuntu-24.04" (a JSON string, which release.yml also
# accepts) keeps every job hosted while that PC is offline. A push to main takes the
# repository variable CI_MAIN_SELF_HOSTED_LABELS over CI_SELF_HOSTED_LABELS when it is set, so main's
# runs go to runners pull requests never use (run.sh --reserved); "ubuntu-24.04" there keeps only
# main hosted, and deleting it puts main back on the shared runners. This script runs from the
# checked-out revision, which a fork pull request controls; the runner itself refuses fork code
# (scripts/self-hosted-runner/job-started.sh).
set -euo pipefail

hosted='"ubuntu-24.04"'
default_labels='["self-hosted","self-hosted-ovis"]'
event="${EVENT_NAME:-}"
requested="${REQUESTED_LABELS:-}"
configured="${CONFIGURED_LABELS:-}"
configured_from=CI_SELF_HOSTED_LABELS
# CI_LINUX_SELF_HOSTED_LABELS moves only the Linux jobs of pull requests and branch pushes; a tag push, a workflow that calls ci.yml
# without hosted_only (relay-deploy) or a manual run keeps CI_SELF_HOSTED_LABELS' routing. A call with hosted_only (pages.yml's
# and the Release's validation, HOSTED_ONLY=true) always gets the hosted image, before anything else is read
if [[ ("$event" == pull_request || ("$event" == push && "${REF:-}" == refs/heads/*)) && -n "${LINUX_LABELS:-}" && -n "${LINUX_LABELS//[[:space:]]/}" ]]; then
  configured=$LINUX_LABELS
  configured_from=CI_LINUX_SELF_HOSTED_LABELS
fi
main_configured="${MAIN_LABELS:-}"
capacity="${SELF_HOSTED_CAPACITY:-}"
# the ci.yml jobs that run on the chosen Linux runner when it is self-hosted: Fast checks,
# Integration, Browser regression (ui-regression) and the three parts of Browser regression (other
# scripts) (scripts/ci-runner-route.test.ts holds this to ci.yml)
linux_jobs=6

# Prints the one JSON value in $1, compacted, when it is a non-empty array of strings that contains "self-hosted";
# fails otherwise, also for two values one after the other, which would each print a line of their own
label_list() {
  jq -sce 'if length == 1 and (.[0] | type == "array" and length > 0 and all(.[]; type == "string") and any(.[]; . == "self-hosted")) then .[0] else error("invalid") end' <<<"$1" 2>/dev/null
}

choose_labels() {
  local source="$1" value="$2" compact
  if ! compact=$(label_list "$value"); then
    echo "::error::$source must be a JSON array of strings that contains \"self-hosted\", got: $value" >&2
    exit 1
  fi
  echo "Runner: self-hosted $compact (from $source)" >&2
  echo "linux=$compact"
}

# the labels of the pull requests' runners (run.sh registers them with self-hosted, Linux and X64):
# a job that asks only for labels among these can take one of them
pool_labels='["self-hosted","linux","x64","self-hosted-ovis"]'
# the light jobs of a pull request's run that share those runners (scripts/light-runner-workflow.test.ts
# keeps this list in step): they hold a runner for seconds, so counting them would send heavy jobs
# hosted whenever a few runs start at once
light_job_names='["Detect changes","herdr-core live contract","Integration and browser","Pull request title","bundle-windows"]'

# One Actions API read, asked again up to twice when it fails: a single 502 would otherwise send
# the whole run hosted, where it depends on the Ubuntu mirror the self-hosted image does not need.
# Only a whole answer is printed: pages a failed attempt got before failing would be counted twice.
# A refusal (HTTP 4xx: the token or the path) would answer the same again, so only a server error or
# no answer is asked again. All reads together have API_BUDGET seconds from the script's start, so the
# hosted fallback is printed well inside Detect changes' five minutes; each attempt is bounded by a
# minute or what is left, with timeout or gtimeout where there is one (stock macOS has neither: there
# an attempt is unbounded, and only the shared budget stops further ones).
API_BUDGET=240
bound=""
if command -v timeout >/dev/null 2>&1; then bound=timeout
elif command -v gtimeout >/dev/null 2>&1; then bound=gtimeout
fi
# The seconds this script has run. ROUTE_TEST_SECONDS_FILE is a test seam and nothing else: in
# scripts/ci-runner-route.test.ts it names a file the fake gh moves on, so a read can take time without any being
# spent; ci.yml never sets it.
elapsed() {
  if [[ -n "${ROUTE_TEST_SECONDS_FILE:-}" ]]; then cat "$ROUTE_TEST_SECONDS_FILE"; else echo "$SECONDS"; fi
}
# set by the browser parts' check alone (below): its reads also stop once elapsed reaches it
api_until=""
api() {
  local out errors left spent
  errors=$(mktemp)
  for _ in 1 2 3; do
    left=$((API_BUDGET - SECONDS))
    if [[ -n "$api_until" ]]; then
      spent=$(elapsed)
      if (( api_until - spent < left )); then left=$((api_until - spent)); fi
    fi
    if [ "$left" -le 0 ]; then break; fi
    if [ "$left" -gt 60 ]; then left=60; fi
    if out=$(${bound:+$bound "$left"} gh api --paginate "$1" 2>"$errors"); then rm -f "$errors"; printf '%s\n' "$out"; return 0; fi
    cat "$errors" >&2
    if grep -q 'HTTP 4[0-9][0-9]' "$errors"; then break; fi
  done
  rm -f "$errors"
  return 1
}

# api for the browser parts' check: the answer counts only when every page is a JSON object with the array $2, so an
# empty or cut answer is a failed read there, never an idle host
api_array() {
  local out
  out=$(api "$1") || return 1
  jq -se --arg key "$2" 'length > 0 and all(.[]; type == "object" and (.[$key] | type) == "array")' <<<"$out" >/dev/null 2>&1 || return 1
  printf '%s\n' "$out"
}

# Prints how many unfinished jobs of queued or running workflow runs could take one of the runners
# whose labels are $2 (lowercase), leaving out the jobs named in $3, stopping once the count passes $1
# (one API call per run adds up while many runs wait); fails when the API does three times in a row.
# With $4 set (the browser parts' check), a job counts without asking for self-hosted, since one that asks only for
# the runners' own label takes them too, and every read goes through api_array.
busy_jobs() {
  local limit="$1" pool="$2" light="$3" read=api need='index("self-hosted") != null and ' ids id jobs n total=0
  if [[ -n "${4:-}" ]]; then read=api_array need=''; fi
  ids=$(for status in in_progress queued; do
    "$read" "repos/$REPOSITORY/actions/runs?status=$status&per_page=100" workflow_runs | jq '.workflow_runs[].id' || exit 1
  done) || return 1
  for id in $ids; do
    jobs=$("$read" "repos/$REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100" jobs) || return 1
    n=$(jq -s -e --argjson pool "$pool" --argjson light "$light" '[.[].jobs[] | select(.status != "completed" and (.name as $name | $light | index($name)) == null)
      | [.labels[] | ascii_downcase] | select('"$need"'all(.[]; . as $x | $pool | index($x) != null))]
      | length' <<<"$jobs") || return 1
    total=$((total + n))
    if (( total > limit )); then break; fi
  done
  echo "$total"
}

route_pull_request() {
  local busy
  if [[ -z "${capacity//[[:space:]]/}" ]]; then
    capacity=10
  elif ! [[ "$capacity" =~ ^[0-9]{1,4}$ ]]; then
    echo "::error::repository variable CI_SELF_HOSTED_CAPACITY must be a whole number, got: $capacity" >&2
    exit 1
  fi
  capacity=$((10#$capacity))
  if ! busy=$(busy_jobs $((capacity - linux_jobs)) "$pool_labels" "$light_job_names"); then
    echo "::warning::could not count the self-hosted runners' jobs; using ubuntu-24.04" >&2
    echo "linux=$hosted"
  elif (( capacity - busy >= linux_jobs )); then
    echo "Runner: self-hosted $default_labels ($busy of $capacity busy, pull request)" >&2
    echo "linux=$default_labels"
  else
    echo "Runner: ubuntu-24.04 (at least $busy of $capacity self-hosted busy, pull request)" >&2
    echo "linux=$hosted"
  fi
}

route_linux() {
if [[ "${HOSTED_ONLY:-}" == true ]]; then
  echo "Runner: ubuntu-24.04 (called with hosted_only)" >&2
  echo "linux=$hosted"
elif [[ ("$event" == "pull_request" || "$event" == "pull_request_target") && "${HEAD_REPO:-}" != "${REPOSITORY:-}" ]]; then
  echo "Runner: ubuntu-24.04 (pull request from fork ${HEAD_REPO:-unknown})" >&2
  echo "linux=$hosted"
elif [[ -n "${requested//[[:space:]]/}" ]]; then
  choose_labels "workflow_dispatch input self_hosted_labels" "$requested"
elif [[ "${configured//[[:space:]]/}" == "$hosted" ]]; then
  echo "Runner: ubuntu-24.04 (from repository variable $configured_from)" >&2
  echo "linux=$hosted"
elif [[ "$event" == push && "${REF:-}" == refs/heads/main && -n "${main_configured//[[:space:]]/}" ]]; then
  if [[ "${main_configured//[[:space:]]/}" == "$hosted" ]]; then
    echo "Runner: ubuntu-24.04 (push to main, from repository variable CI_MAIN_SELF_HOSTED_LABELS)" >&2
    echo "linux=$hosted"
  else
    choose_labels "repository variable CI_MAIN_SELF_HOSTED_LABELS" "$main_configured"
  fi
elif [[ -n "${configured//[[:space:]]/}" ]]; then
  choose_labels "repository variable $configured_from" "$configured"
elif [[ "$event" == push ]]; then
  choose_labels "default for $event (CI_SELF_HOSTED_LABELS unset)" "$default_labels"
elif [[ "$event" == pull_request ]]; then
  route_pull_request
else
  echo "Runner: ubuntu-24.04 ($event, CI_SELF_HOSTED_LABELS unset)" >&2
  echo "linux=$hosted"
fi
}

line=$(route_linux)
echo "$line"
# Fast checks can stay on other runners while the Linux jobs go to the cloud VM runners (label ovis-vm):
# CI_FAST_SELF_HOSTED_LABELS applies only then, so a fork's Fast checks always follow its hosted Linux jobs.
linux=${line#linux=}
fast=$linux
fast_labels="${FAST_LABELS:-}"
# (a manual run that names ovis-vm itself keeps Fast checks with the rest)
if [[ ("$event" == pull_request || "$event" == push) && "$linux" == *'"ovis-vm"'* && -n "${fast_labels//[[:space:]]/}" ]]; then
  if chosen=$(label_list "$fast_labels"); then
    echo "Fast checks: self-hosted $chosen (from repository variable CI_FAST_SELF_HOSTED_LABELS)" >&2
    fast=$chosen
  else
    echo "::warning::repository variable CI_FAST_SELF_HOSTED_LABELS must be a JSON array of strings that contains \"self-hosted\", got: $fast_labels; Fast checks follow the Linux jobs" >&2
  fi
fi
echo "fast=$fast"

# Parts 1 and 2 of Browser regression (other scripts) on a further self-hosted host (scripts/self-hosted-runner/README.md,
# "Routing jobs to it"): PARTS_LABELS, the repository variable CI_MAIN_BROWSER_PARTS_LABELS that ci.yml hands over in its
# own runs alone, names the host's labels. A push to main sends the two parts there while the Linux jobs take the
# self-hosted PC's three parts, the host's heartbeat is fresh, its runners carry every one of those labels and at
# least one of them is theirs alone, and no job those runners could take is queued or running. The heartbeat
# PARTS_SEEN (CI_BROWSER_PARTS_RUNNERS_SEEN, which scripts/self-hosted-runner/runner-heartbeat.sh writes while the
# host's runners are online) is "<epoch seconds> <their labels> <those of them no other runner carries>", each a
# lower-case JSON array. Anything else prints
# nothing more, so every part goes where `linux=` sends it; a bad variable, a failed read or the clock only warn,
# since the host only makes main's run shorter. The check is a snapshot, not a reservation: a job queued after it
# can still take a runner first.
parts_seen_seconds=180
# the check's own share of the API budget: two run lists and one read per unfinished run take seconds even at a
# busy hour, and past it the parts stay with the Linux jobs, leaving Detect changes the rest of its five minutes
parts_budget=30
parts_labels="${PARTS_LABELS:-}"
if [[ "$event" == push && "${REF:-}" == refs/heads/main && -n "${parts_labels//[[:space:]]/}" ]]; then
  # the matrix's own test (ci.yml's shard): three parts when the Linux label names self-hosted and not ovis-vm
  shape=$(tr '[:upper:]' '[:lower:]' <<<"$linux")
  # the heartbeat: "<epoch seconds> <the host's runners' labels> <those no other runner carries>"
  seen_at="" seen_labels="" seen_alone=""
  if [[ "${PARTS_SEEN:-}" =~ ^([0-9]{1,12})\ (.+)$ ]] && seen=$(jq -sce 'map(if type == "array" and all(.[]; type == "string") then map(ascii_downcase) | unique else error("invalid") end)
    | if length == 2 and (.[1] | length > 0) and (.[1] - .[0] | length == 0) then . else error("invalid") end' <<<"${BASH_REMATCH[2]}" 2>/dev/null); then
    seen_at=${BASH_REMATCH[1]}
    seen_labels=$(jq -c '.[0]' <<<"$seen") && seen_alone=$(jq -c '.[1]' <<<"$seen") || seen_labels=""
  fi
  # the value itself is not shown: a line of it could read as a workflow command
  if ! parts=$(label_list "$parts_labels"); then
    echo "::warning::repository variable CI_MAIN_BROWSER_PARTS_LABELS must be one JSON array of strings that contains \"self-hosted\"; every browser part runs with the Linux jobs" >&2
  elif [[ "$shape" == *ovis-vm* || "$shape" != *self-hosted* ]]; then
    echo "Browser parts: with the Linux jobs, which do not run three parts on self-hosted runners" >&2
  elif ! now=$(date +%s) || ! [[ "$now" =~ ^[0-9]{1,12}$ ]]; then
    echo "::warning::could not read the clock; every browser part runs with the Linux jobs" >&2
  # base 10 from here on: leading zeroes must not make it octal
  elif now=$((10#$now)); [[ -z "$seen_labels" ]]; then
    echo "Browser parts: with the Linux jobs (CI_BROWSER_PARTS_RUNNERS_SEEN is not \"<epoch seconds> <the runners' labels> <their own labels>\")" >&2
  elif (( now - 10#$seen_at > parts_seen_seconds || 10#$seen_at - now > 60 )); then
    # a heartbeat up to a minute ahead is a clock that differs, not a stale one
    echo "Browser parts: with the Linux jobs (the host's heartbeat is from $seen_at, now is $now: older than $parts_seen_seconds s or ahead)" >&2
  elif ! missing=$(jq -c --argjson have "$seen_labels" '[map(ascii_downcase)[] | select(. as $label | $have | index($label) | not)]' <<<"$parts"); then
    echo "::warning::could not compare $parts with the labels of the host's runners; every browser part runs with the Linux jobs" >&2
  elif [[ "$missing" != "[]" ]]; then
    echo "Browser parts: with the Linux jobs (no runner the heartbeat counted carries $missing)" >&2
  # a list with none of the host's own labels would match other runners too (the PC's, the Mac), which a part could take
  elif ! alone=$(jq -c --argjson alone "$seen_alone" '[map(ascii_downcase)[] | select(. as $label | $alone | index($label))]' <<<"$parts"); then
    echo "::warning::could not compare $parts with the labels of the host's runners; every browser part runs with the Linux jobs" >&2
  elif [[ "$alone" == "[]" ]]; then
    echo "Browser parts: with the Linux jobs (no label of CI_MAIN_BROWSER_PARTS_LABELS is carried by the host's runners alone)" >&2
  # without timeout or gtimeout nothing could stop a read that hangs inside the 30 s: no reads then
  elif [[ -z "$bound" ]]; then
    echo "::warning::neither timeout nor gtimeout is installed to bound the count of the jobs on $parts; every browser part runs with the Linux jobs" >&2
  # every job the host's runners could take counts here, light ones too: any of them makes the parts wait
  elif api_until=$(($(elapsed) + parts_budget)); ! busy=$(busy_jobs 0 "$seen_labels" '[]' parts); then
    echo "::warning::could not count the jobs on $parts within $parts_budget s; every browser part runs with the Linux jobs" >&2
  elif (( busy > 0 )); then
    echo "Browser parts: with the Linux jobs (a job is queued or running on $parts)" >&2
  else
    echo "Browser parts 1 and 2: self-hosted $parts (from repository variable CI_MAIN_BROWSER_PARTS_LABELS)" >&2
    echo "parts=$parts"
  fi
fi
