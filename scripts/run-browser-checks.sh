#!/usr/bin/env bash
# Every real-Chrome check in this repository, run in parallel from one command
# — locally, and as CI's third lane. TWO KINDS, one pool:
#
#   scripts/verify-*.mts    a feature, asserted on the built shell
#   simulations/*.mjs       a whole JOURNEY, walked through the visible
#                           controls and pictured at two widths
#
# The simulations joined this lane on 2026-09-16 (note #533). Nothing ran them
# before, so six of the nine rotted for five unrelated reasons while every pip
# stayed green — and two of those five were real bugs in the fixture, not
# stale expectations. They are the only checks here that walk a journey end to
# end, which is exactly the break a feature-level check does not see.
#
# These harnesses are the only thing in this repo that can SEE a screen. jsdom
# lays nothing out, so a 512px face, a three-line title, a wait that does not
# hold its rows and a button under another element are all invisible to it.
# Until 2026-09-15 they ran only when somebody remembered to run them, which
# meant they rotted: eighteen of them were dead for days behind a signup form
# that had changed, and nobody heard, because nothing anywhere went red.
#
# SO THIS IS WHAT CI RUNS. Everything below is in service of that one fact.
#
#   ./scripts/run-browser-checks.sh                 everything
#   ./scripts/run-browser-checks.sh verify-x mail   just these (either kind)
#
# A name is dispatched by where it lives: `scripts/<name>.mts` is a harness,
# `simulations/<name>.mjs` is a journey. The two namespaces cannot collide —
# every harness is named `verify-*` and no simulation is.
#
# Env: JOBS (parallel checks, default: cores, capped at 4), SIM_JOBS (parallel
# JOURNEYS, default 2 — see below), OUT_ROOT, PER_TIMEOUT (seconds per
# attempt), CHROME (an explicit binary).
#
# THE JOURNEYS RUN AT A LOWER CONCURRENCY than the harnesses, and are started
# FIRST — but in the SAME pool since 2026-09-20, so a journey slot nobody may
# use goes to a harness rather than standing empty (the long note further
# down). A harness serves a built file from express; a journey runs a Vite dev
# server beside its Chrome and photographs every step at two widths, which is
# a different weight of process — and the longest of them (the tour, ~1 min)
# has to start early or it becomes the tail everything else waits on.
#
# PORTS ARE PER CHECK, not per run. Every harness defaults to the same port
# and serves its own fixture backend, so two started together collide and both
# fail on something that looks nothing like a port. The index in the list is
# the offset, so a name always lands on the same port and a retry reuses it
# after its predecessor is gone. A simulation does not read PORT — its fixture
# asks the kernel for a free port and its Vite server runs in middleware mode
# with HMR off, so it owns no fixed port to collide on — but it is given one
# anyway, so that the day one of them wants a fixed port the offset is already
# there and correct.
#
# OUTPUT IS DELIBERATELY QUIET. A passing harness prints one line per check —
# the chat harness alone prints 158 — and the dispatcher keeps only the last
# 64 KB of a job's log. Printing all of them would push the failure that
# matters off the top of the only record anybody reads. So: a tally, then the
# TAIL of each failing harness, last.
#
# NO RETRY, EXCEPT BY NAME (note #1075, 8 Nov 2026). Until then every check
# got a second attempt, silently. It bought almost nothing: in the 17 red runs
# of 25 Oct-8 Nov whose logs show the browser stage, every flaky check except
# one failed BOTH attempts, because what broke it (a layout a few pixels
# different on that machine, a box measured mid-transition, a slow decoder)
# held for the whole run. And it hid the one it did rescue: a pass on the
# second attempt printed as a plain `ok`, so nobody learned a check was
# flaking until the day it lost both. The causes were fixed instead — see the
# browser-harnesses knowledge page, "Writing a check that does not flake".
#
# A retry is now allowed only where the flakiness is in the BROWSER and has
# been chased and cannot be removed: RETRY_BECAUSE below, one entry per check,
# each with the reason. It is one retry, never more, and it is LOUD: a check
# that passes on its second attempt prints as `ok … RETRIED` in the tally and
# its first attempt's failure is printed under "Passed only on a retry", on a
# green run too. A new entry needs the same: the cause, the measurement, and
# why it cannot be fixed in the check. It is not where a red goes to be quiet.
declare -A RETRY_BECAUSE=(
  # Note #563: under heavy load the cold-open step (9d) timed out on 1 run in
  # 15 because Puppeteer could neither finish goto nor evaluate in the page
  # until the held state read landed, while the page itself had answered in
  # ~360 ms. Holding the read behind a gate made it worse (7 in 21). Chrome's
  # side of the wait, not the app's; why is not established.
  [verify-workspace-react-agent-chat]='Puppeteer navigation held by a pending read in Chrome (note #563, step 9d)'
)
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

JOBS=${JOBS:-$(( $(nproc 2>/dev/null || echo 2) > 4 ? 4 : $(nproc 2>/dev/null || echo 2) ))}
SIM_JOBS=${SIM_JOBS:-2}
(( SIM_JOBS > JOBS )) && SIM_JOBS=$JOBS
PER_TIMEOUT=${PER_TIMEOUT:-420}
BASE_PORT=${BASE_PORT:-4400}
OUT_ROOT=${OUT_ROOT:-$(mktemp -d -t browser-checks-XXXXXX)}
LOGS="$OUT_ROOT/logs"
mkdir -p "$LOGS"

TSX=backend/node_modules/.bin/tsx
if [[ ! -x "$TSX" ]]; then
  echo "no $TSX — run the backend install first" >&2
  exit 1
fi

# `all.mjs` is the suite's own sequential runner and `_*.mjs` are scratch
# scenarios — neither is a check. Everything else under simulations/ is one.
mapfile -t sims < <(ls simulations/*.mjs 2>/dev/null | xargs -n1 basename | sed 's/\.mjs$//' | grep -vx all | grep -v '^_')

# LONGEST FIRST, by name and on purpose. A wave is only as short as its
# longest member, and the tour — every screen of the lived-in Workspace, 28
# moments — takes about as long as the other five together. Alphabetical order
# started it LAST, where the whole wave waited on it: 156 s instead of 120 s
# on a two-slot run. This list is explicit rather than measured because there
# is nowhere to keep a timing; if a new journey outgrows the tour, put it here.
LONG_FIRST=(workspace-tour)
ordered=()
for long in "${LONG_FIRST[@]}"; do
  for name in "${sims[@]}"; do [[ "$name" == "$long" ]] && ordered+=("$name"); done
done
for name in "${sims[@]}"; do
  skip=""
  for long in "${LONG_FIRST[@]}"; do [[ "$name" == "$long" ]] && skip=1; done
  [[ -z "$skip" ]] && ordered+=("$name")
done
sims=("${ordered[@]}")
mapfile -t harnesses < <(ls scripts/verify-*.mts | xargs -n1 basename | sed 's/\.mts$//')

if [[ $# -gt 0 ]]; then
  names=("$@")
  # Sorted into the two kinds even when named by hand, so the journey cap
  # below still means what it says.
  requested_sims=(); requested_harnesses=()
  for name in "${names[@]}"; do
    if [[ -f "simulations/$name.mjs" ]]; then requested_sims+=("$name"); else requested_harnesses+=("$name"); fi
  done
  sims=("${requested_sims[@]}"); harnesses=("${requested_harnesses[@]}")
else
  names=("${sims[@]}" "${harnesses[@]}")
fi

run_one() {
  local name=$1 port=$2 attempt rc=1 started
  local out="$OUT_ROOT/$name" log="$LOGS/$name.log"
  local -a cmd
  mkdir -p "$out"
  if [[ -f "scripts/$name.mts" ]]; then
    cmd=("$TSX" "scripts/$name.mts")
  elif [[ -f "simulations/$name.mjs" ]]; then
    # A journey's pictures go under this run's output root like everything
    # else, rather than into the working tree's simulations/shots.
    cmd=(node "simulations/$name.mjs" --shots "$out/shots" --shot "$out/final.png")
  else
    printf 'no scripts/%s.mts and no simulations/%s.mjs — nothing to run\n' "$name" "$name" > "$log"
    printf '127\n' > "$LOGS/$name.rc"
    printf '0\n' > "$LOGS/$name.secs"
    return
  fi
  started=$(date +%s)
  local retries=0
  [[ -n "${RETRY_BECAUSE[$name]:-}" ]] && retries=1
  for (( attempt = 0; attempt <= retries; attempt++ )); do
    if (( attempt > 0 )); then
      printf '\n=== attempt %s (the one before it exited %s) ===\n' "$((attempt + 1))" "$rc" >> "$log"
    fi
    # A harness reads CHROME, a journey reads CHROME_PATH; an empty one is
    # ignored by both, so an unset CHROME still means "find it yourself".
    timeout "$PER_TIMEOUT" env PORT="$port" OUT_DIR="$out" CHROME_PATH="${CHROME:-${CHROME_PATH:-}}" \
      "${cmd[@]}" >> "$log" 2>&1
    rc=$?
    (( rc == 0 )) && break
  done
  # A pass that needed the retry is recorded as such, so the tally can say so.
  (( rc == 0 && attempt > 0 )) && printf '%s\n' "$attempt" > "$LOGS/$name.retried"
  printf '%s\n' "$rc" > "$LOGS/$name.rc"
  printf '%s\n' "$(( $(date +%s) - started ))" > "$LOGS/$name.secs"
}

printf 'browser checks: %s checks, %s at a time (at most %s of them journeys), output under %s\n' \
  "$(( ${#sims[@]} + ${#harnesses[@]} ))" "$JOBS" "$SIM_JOBS" "$OUT_ROOT"
started=$(date +%s)

# The port offset is the name's position in the FULL list, so a name always
# lands on the same port whichever order the pool starts it in.
port_of() {
  local wanted=$1 i=0
  for name in "${names[@]}"; do
    [[ "$name" == "$wanted" ]] && { printf '%s\n' "$(( BASE_PORT + i ))"; return; }
    i=$(( i + 1 ))
  done
  printf '%s\n' "$BASE_PORT"
}

# ONE POOL, NOT TWO WAVES (2026-09-20). The journeys and the harnesses used to
# run as separate waves — all nine journeys two at a time, and only then the
# harnesses four at a time. Two thirds of the machine sat idle for the length
# of the first wave: 264 seconds of journey work at two slots is about 132
# seconds during which two of the four cores had nothing to do, and the
# harnesses that could have used them had not been started. Measured on
# lane A: 261-277 s across four green runs as two waves, 202 s as one pool,
# 37 of 37 passing on the first attempt.
#
# So: one pool of JOBS slots, of which at most SIM_JOBS may be journeys. The
# caps that mattered are both still here — a journey is a Vite server beside
# its Chrome, and more than two of those at once is what took the tour down
# the first time CI ran them in parallel (note #533) — but a slot a journey
# may not have is now offered to a harness instead of being left empty.
# Journeys are still started FIRST and longest-first, because a wave is only
# as short as its longest member and the tour is the longest thing here.
#
# THE PEAK IS HEAVIER THAN IT WAS, and that is the thing to watch: four
# harnesses were the old worst case, and two journeys plus two harnesses is
# more than that on the same four cores. These checks drive a real browser
# against real sockets and their waits are not generous (note #548), so if
# flakes arrive with this, this is what to back out first.
declare -A kind_of_pid=()
running=0
running_sims=0

start_check() {
  local name=$1 kind=$2
  run_one "$name" "$(port_of "$name")" &
  kind_of_pid[$!]=$kind
  running=$(( running + 1 ))
  [[ "$kind" == sim ]] && running_sims=$(( running_sims + 1 ))
  return 0
}

# `wait -n -p` names the job that finished, which is the whole reason this can
# be one pool: the caps are per KIND, so a slot coming free has to say which
# kind is free. (bash 5.1+; the image ships 5.2.)
reap_one() {
  local pid=''
  wait -n -p pid
  [[ -n "$pid" ]] || return 0
  [[ "${kind_of_pid[$pid]:-}" == sim ]] && running_sims=$(( running_sims - 1 ))
  unset 'kind_of_pid[$pid]'
  running=$(( running - 1 ))
  return 0
}

pending=("${sims[@]}" "${harnesses[@]}")
while (( ${#pending[@]} > 0 || running > 0 )); do
  launched=0
  if (( running < JOBS )); then
    for index in "${!pending[@]}"; do
      name=${pending[$index]}
      if [[ -f "simulations/$name.mjs" ]]; then
        (( running_sims >= SIM_JOBS )) && continue
        kind=sim
      else
        kind=harness
      fi
      unset 'pending[index]'
      pending=("${pending[@]}")
      start_check "$name" "$kind"
      launched=1
      break
    done
  fi
  (( launched )) && continue
  (( running > 0 )) || break   # nothing running and nothing startable: done
  reap_one
done

# What a passing check DID, in its own units: a harness counts its PASS lines,
# a journey counts the moments it pictured. Both carry their seconds, which is
# the number anybody deciding what this lane costs actually wants.
did_what() {
  local log=$1 passes moments
  # No `|| echo 0` here: grep -c ALREADY prints 0 when it matches nothing, and
  # exits 1 saying so, which made the fallback append a second 0 — "0\n0",
  # which is not a number and blew up the comparison below.
  passes=$(grep -c '^PASS' "$log" 2>/dev/null)
  (( ${passes:-0} > 0 )) && { printf '%s checks' "$passes"; return; }
  moments=$(sed -n 's/^\([0-9]\+\) moments pictured.*/\1/p' "$log" 2>/dev/null | tail -n 1)
  [[ -n "$moments" ]] && { printf '%s moments' "$moments"; return; }
  printf 'no counted steps'
}

failed=()
retried=()
for name in "${names[@]}"; do
  rc=$(cat "$LOGS/$name.rc" 2>/dev/null || echo 1)
  secs=$(cat "$LOGS/$name.secs" 2>/dev/null || echo 0)
  if [[ "$rc" == "0" && -f "$LOGS/$name.retried" ]]; then
    printf '  ok    %-44s %-12s %ss  RETRIED (passed on attempt 2)\n' "$name" "$(did_what "$LOGS/$name.log")" "$secs"
    retried+=("$name")
  elif [[ "$rc" == "0" ]]; then
    printf '  ok    %-44s %-12s %ss\n' "$name" "$(did_what "$LOGS/$name.log")" "$secs"
  else
    printf '  FAIL  %-44s exit %-7s %ss\n' "$name" "$rc" "$secs"
    failed+=("$name")
  fi
done
printf 'browser checks: %s of %s passed in %ss%s\n' \
  "$(( ${#names[@]} - ${#failed[@]} ))" "${#names[@]}" "$(( $(date +%s) - started ))" \
  "$( (( ${#retried[@]} )) && printf ', %s of them only on a retry' "${#retried[@]}")"

# A pass on the second attempt is still a first attempt that failed, and the
# one place anybody will see it is here. Short, because the failures below
# own the 64 KB tail; the full first attempt is in the check's log.
for name in "${retried[@]}"; do
  printf '\n=== %s: passed only on a retry (%s) — first attempt ===\n' "$name" "${RETRY_BECAUSE[$name]}"
  sed '/^=== attempt 2 /q' "$LOGS/$name.log" | grep -a -E '^FAIL|Error|Timeout|timed out' | cut -c1-300 | head -n 12
done

# The failures last, and only the failures: see the note about the 64 KB cap.
for name in "${failed[@]}"; do
  printf '\n=== %s (last 120 lines of its log) ===\n' "$name"
  # The checks that FAILED first, from every attempt: a harness keeps going
  # after a FAIL, so the line that names the failure is usually far above the
  # tail — on 2026-09-18 CI's record of a red run was 120 passes and
  # "1 FAILED", and the check had to be reproduced to learn its name.
  grep -a '^FAIL' "$LOGS/$name.log" | cut -c1-600 | sort | uniq -c
  tail -n 120 "$LOGS/$name.log"
done

(( ${#failed[@]} == 0 ))
