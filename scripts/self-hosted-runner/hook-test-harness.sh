#!/usr/bin/env bash
# Test harness of job-started.sh (scripts/self-hosted-runner.test.ts): the only place a test starts the hook,
# which may kill, and only after one of two guards has passed. Before the guard it starts nothing.
#   namespace: PID 1 of a PID namespace of its own, started as
#     unshare --user --map-root-user --pid --fork --mount-proc --kill-child bash hook-test-harness.sh <token> ...
#     It is PID 1, PID 1 of /proc carries the run's <token> (so /proc is this namespace's), and no other
#     process is visible: every pid it can name is one it started, and the kernel kills them all when it exits.
#   container: inside the runner image's container (scripts/self-hosted-runner/Dockerfile), started as
#     python3 (PR_SET_CHILD_SUBREAPER on itself, then exec) bash hook-test-harness.sh container ...
#     The image's marker is there, root's and read-only, /.dockerenv is there, and PID 1 is the container's
#     init (tini or docker-init). Then it proves that an orphan of its subtree comes to it, not to any process
#     above it: the hook's parent can only be a process of this subtree or this harness (a bash), never the
#     container's real Runner.Worker. It notes every process above it (pid and start time) and reports whether
#     all of them still run after the case.
# Any doubt exits 97, and the tests skip. The harness signals nothing: whether a process lives is read from /proc.
#
# Then: hook-test-harness.sh <guard> <parent> <output>. <parent> is the process that starts the hook: worker (a
# copy of bash named Runner.Worker), nested (the worker with a shell between it and the hook), renamed (the
# worker, its name rewritten to systemd), posing (a copy named systemd, its name rewritten to Runner.Worker),
# named:<name> (a copy named <name>) or gone (a parent that ends between the hook's start and its refusal), or
# probe (the guard alone). <output> is open, or closed: the hook writes to a pipe nobody reads. The environment
# carries the hook's (GITHUB_*), HOOK, HOOK_PATH (its PATH) and HARNESS_DIR (a directory of the test's own).
# It prints one line:
#   report parent=<exit status|running|gone> hook=<ended|blocked|silent> next=<ran|no> decoys=<alive|dead> above=<alive|dead>
set -u

marker=/opt/runner-hooks/ovis-runner-image

# Builtins only, in this process: a subshell or a command started here would be a second process.
in_own_namespace() {
  local token=$1 arg found=0 args pids
  [[ $$ == 1 ]] || { why="not PID 1 of a new PID namespace (pid $$)"; return 1; }
  [[ ${#token} -ge 32 ]] || { why="no run token"; return 1; }
  mapfile -d '' args 2>/dev/null </proc/1/cmdline || { why="/proc/1/cmdline cannot be read"; return 1; }
  for arg in "${args[@]}"; do [[ $arg == "$token" ]] && found=$((found + 1)); done
  [[ $found == 1 ]] || { why="PID 1 of /proc does not carry this run's token: /proc is not this namespace's"; return 1; }
  pids=(/proc/[0-9]*)
  [[ ${pids[*]} == /proc/1 ]] || { why="other processes are visible (${#pids[@]})"; return 1; }
}

in_runner_container() {
  local init args
  [[ -f $marker && ! -L $marker && ! -w $marker && ! -w ${marker%/*} ]] || { why="no read-only marker of the runner image ($marker)"; return 1; }
  [[ $(stat -c %u "$marker" "${marker%/*}" 2>/dev/null) == $'0\n0' ]] || { why="$marker is not root's"; return 1; }
  [[ -f /.dockerenv ]] || { why="not in a docker container (/.dockerenv)"; return 1; }
  IFS= read -r init 2>/dev/null </proc/1/comm || { why="/proc/1/comm cannot be read"; return 1; }
  mapfile -d '' args 2>/dev/null </proc/1/cmdline || { why="/proc/1/cmdline cannot be read"; return 1; }
  [[ ($init == tini || $init == docker-init) && ${args[0]##*/} == "$init" ]] || { why="PID 1 is $init, not the container's init"; return 1; }
  [[ $$ != 1 ]] || { why="this harness is PID 1"; return 1; }
}

why=""
guard=${1-}
if [[ $guard == container ]]; then
  in_runner_container || { echo "not isolated: $why" >&2; exit 97; }
else
  in_own_namespace "$guard" || { echo "not isolated: $why" >&2; exit 97; }
fi
parent=${2-} output=${3-}

# Sets ppid_of and start_of from /proc/<pid>/stat (fields 4 and 22, after the last ")")
stat_of() {
  local line
  IFS= read -r line 2>/dev/null <"/proc/$1/stat" || return 1
  line=${line##*) }
  read -r _ ppid_of _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ start_of _ <<<"$line"
}

# running or gone (a zombie is gone)
state() {
  local line
  IFS= read -r line 2>/dev/null <"/proc/$1/stat" || { echo gone; return; }
  line=${line##*) }
  if [[ ${line%% *} == Z ]]; then echo gone; else echo running; fi
}

# Every process above this harness, before it starts anything: none of them may end while the case runs.
above=()
pid=$$
while stat_of "$pid" && [[ $ppid_of =~ ^[1-9][0-9]*$ ]] && (( ${#above[@]} < 64 )); do
  pid=$ppid_of
  stat_of "$pid" && above+=("$pid:$start_of")
done

dir=$HARNESS_DIR
mkdir -p "$dir/exe" "$dir/decoys"
# The write end of $dir/hold stays with this harness alone: what reads it ends when the harness does.
mkfifo "$dir/hold"
exec 5<>"$dir/hold"

if [[ $guard == container ]]; then
  # An orphan of this subtree must come to this harness: one that would go to a process above it could
  # leave the hook a parent outside the subtree.
  ( "$BASH" -c 'read -r _ <"$0"' "$dir/hold" 5>&- & echo "$!" >"$dir/orphan" )
  IFS= read -r orphan <"$dir/orphan"
  stat_of "$orphan" && [[ $ppid_of == "$$" ]] || { echo "not isolated: an orphan of this harness went to ${ppid_of:-nobody}, not to it" >&2; exit 97; }
fi
if [[ $parent == probe ]]; then echo isolated; exit 0; fi

# Decoys that must outlive every case: another Runner.Worker that is not the hook's parent, and a look-alike name
cp "$BASH" "$dir/decoys/Runner.Worker"
cp "$BASH" "$dir/decoys/Runner.Worker2"
decoys=()
for decoy in Runner.Worker Runner.Worker2; do
  "$dir/decoys/$decoy" -c 'read -r _ <"$0"' "$dir/hold" </dev/null >/dev/null 2>&1 5>&- &
  decoys+=($!)
done

run='bash "$0"'
prefix=""
case $parent in
  worker) exe=Runner.Worker ;;
  nested) exe=Runner.Worker run='bash -c '\''bash "$0"; :'\'' "$0"' ;;
  renamed) exe=Runner.Worker prefix='printf systemd >"/proc/$$/comm" && ' ;;
  posing) exe=systemd prefix='printf Runner.Worker >"/proc/$$/comm" && ' ;;
  named:*) exe=${parent#named:} ;;
  gone) exe=parent ;;
  *) echo "unknown parent: $parent" >&2; exit 2 ;;
esac
cp "$BASH" "$dir/exe/$exe"
if [[ $output == closed ]]; then
  # $1: a FIFO whose only reader is closed before the hook starts, so its first write raises SIGPIPE
  script="${prefix}mkfifo \"\$1\" && exec 4<>\"\$1\" 5>\"\$1\" 4<&- && $run >&5 2>&5; echo \"next step ran\""
elif [[ $parent == gone ]]; then
  # $1: the parent ends once the harness opens this FIFO and closes it again
  script="$run & read -r _ <\"\$1\"; exit 0"
  mkfifo "$dir/fifo" "$GITHUB_EVENT_PATH"
else
  script="$prefix$run; echo \"next step ran\""
fi
mkfifo "$dir/out"
PATH=$HOOK_PATH "$dir/exe/$exe" -c "$script" "$HOOK" "$dir/fifo" >"$dir/out" 2>&1 </dev/null 5>&- &
pid=$!
exec 3<"$dir/out"

parent_status=""
if [[ $parent == gone ]]; then
  # The hook's jq opening its event proves the hook runs, its $PPID the parent; then the parent
  # ends and is reaped, and only then does the event arrive and the hook refuse it.
  exec 4>"$GITHUB_EVENT_PATH"
  : >"$dir/fifo"
  wait "$pid"
  parent_status=$?
  cat "$dir/event.json" >&4
  exec 4>&-
fi

# The hook's output, read as it comes. Before its ::error:: line: up to 20 s for it. After it,
# whether it blocks is the case under test, and a block is the absence of an end: an output still
# open 2 s later (the hook, or the parent that waits on it, still holds it) is a hook that blocks.
said=0 hook=silent next=no
while :; do
  if IFS= read -r -t "$(( said ? 2 : 20 ))" line <&3; then
    printf '%s\n' "$line" >>"$dir/output"
    [[ $line == *'::error::'* ]] && said=1
    [[ $line == 'next step ran' ]] && next=ran
  else
    if (( $? > 128 )); then (( said )) && hook=blocked; else hook=ended; fi
    break
  fi
done

if [[ -n $parent_status ]]; then
  parent_report=$parent_status
elif [[ $hook == ended ]]; then
  wait "$pid"
  parent_report=$?
else
  parent_report=$(state "$pid")
fi
decoy_report=alive
for decoy in "${decoys[@]}"; do
  [[ $(state "$decoy") == running ]] || decoy_report=dead
done
above_report=alive
for entry in "${above[@]}"; do
  stat_of "${entry%%:*}" && [[ $start_of == "${entry#*:}" ]] || above_report=dead
done
echo "report parent=$parent_report hook=$hook next=$next decoys=$decoy_report above=$above_report"
