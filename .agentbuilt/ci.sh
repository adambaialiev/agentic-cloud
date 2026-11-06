#!/usr/bin/env bash
# The platform's own CI, run on a throwaway lane A machine on every push
# (docs/ci-two-lane-runner.md). Mirrors what the retired GitHub-webhook
# `checks` job ran, step for step, so a green check keeps meaning what it
# always meant: frontend tests + advisory lint + build, backend core tests.
#
# Plus one step the old job never had: the BACKEND TYPECHECK. vitest does not
# typecheck, and `npm run build` at the root only builds the frontend project,
# so a backend type error used to pass checks and fail later in deploy/prod's
# remote build — which is exactly what happened on 2026-08-16 (a new plan id
# vs a hand-listed union in types/user.ts). The site had already deployed by
# then, so the two halves of one commit disagreed in production. Cheap step,
# and it moves that failure back to where it can still stop a proposal.
#
# Shape (since 2026-09-05): one install pass, then TWO LANES; since 2026-09-15
# a THIRD STAGE that drives the Workspace in a real browser, and since
# 2026-09-17 the browser's own download sits BETWEEN them rather than beside
# the lanes, where it was quietly reddening them. The steps are
# the same ones in the same order within each lane; only the waiting is gone.
# Measured on a shared 4-core VM the sequential script took 179 s, and the
# backend suite alone was 94 s of it while leaving two of the four cores idle
# (195 s of CPU over 93 s of wall). The frontend lane fits in that gap: the
# two-lane shape ran in 120–180 s across repeats on the same VM, the spread
# being the host's (the suite's own CPU time swung 195–316 s), with peak
# memory ~1.5 GB above idle on the 4 GB job machine. On a BUSY host, where
# the same job has taken 13.6 min, whatever it saves is what keeps it clear
# of the wall clock — that is the point, not the quiet-day speed.
set -euo pipefail

# ── Where the minutes went ──────────────────────────────────────────────────
# One line at the end of every run, red or green, naming each stage and its
# seconds. The 64 KB log tail is kept for passing runs too, so this is
# readable afterwards for any sha — which is the difference between changing
# this file with a measurement and changing it with an opinion. Every number
# in the comments above was won by hand-timing a run; nobody should have to
# do that again.
JOB_STARTED=$(date +%s)
STAGE_STARTED=$JOB_STARTED
TIMINGS=""
stage() {
  local now; now=$(date +%s)
  TIMINGS="${TIMINGS}${TIMINGS:+, }$1 $((now - STAGE_STARTED))s"
  STAGE_STARTED=$now
}
print_timings() {
  printf '\nci timings: %s%stotal %ss\n' \
    "$TIMINGS" "${TIMINGS:+, }" "$(( $(date +%s) - JOB_STARTED ))"
}
trap print_timings EXIT

# ── Installs ────────────────────────────────────────────────────────────────
# ONE backend install, not two. The root package.json carries a postinstall
# hook — `npm --prefix backend install` — so the old "npm ci, then cd backend
# && npm ci" installed the backend tree twice: once inside the root install,
# then again from scratch (npm ci deletes node_modules first). It also made
# the two installs impossible to run side by side: both wrote into
# backend/node_modules and one died with ENOTEMPTY (exit 217) when tried.
#
# So: the backend first, strictly from its lockfile, then the root with its
# lifecycle scripts off. The root tree's only install-time scripts are its
# own hooks (git pre-commit setup, that backend install) and esbuild's binary
# check, which is a no-op when the platform package is present — and a
# missing one fails the frontend build a minute later, loudly. Measured
# cold: 10 s + 4 s where the old pair took 22 s + 8 s. `npm ci` audits by
# default; nothing reads that verdict here, so it is one round trip saved.
(cd backend && npm ci --silent --no-audit --no-fund)
npm ci --silent --no-audit --no-fund --ignore-scripts
stage installs

# ── Two lanes ───────────────────────────────────────────────────────────────
# Each lane logs to its own file and the logs are printed AFTER both finish,
# passing lanes first and the failing lane LAST: the dispatcher keeps only the
# final 64 KB of output, and on a red run the lines that matter are the
# failing lane's tail. Two lanes interleaved into one stream would leave half
# a stack trace in each. Nothing is lost by holding the output — the runner
# only ever reports the log once, at exit.
logs=$(mktemp -d)
# THE BROWSER IS BAKED INTO THE IMAGE since 2026-09-20
# (infra/fly-machine-image/Dockerfile): a lane-A machine boots the fleet's
# image, so Chrome and its shared libraries are already there — pinned, and at
# the `$HOME/.cache/puppeteer` path every harness and journey already searches.
# This function is now the FALLBACK for a machine without them: an older image
# during the roll, a workbench, an agent whose libraries went with the last
# image upgrade. It asks the browser itself rather than looking for a file,
# because "present" and "runs" are different states and only the second one is
# worth skipping work for — one missing library reads as a browser.
#
# `@puppeteer/browsers` is already in the tree (puppeteer-core's own
# dependency), so this downloads a browser and not a package to download it
# with. Called AFTER both lanes are green — see the long note at its call.
browser_runs() {
  local chrome
  chrome=$(ls -d "$HOME"/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)
  [ -n "$chrome" ] && "$chrome" --version >/dev/null 2>&1
}
install_browser() {
  # A subshell, as it was when it was a lane: DEBIAN_FRONTEND and `sudo` stay
  # inside it rather than leaking into the rest of the script.
  (
  export DEBIAN_FRONTEND=noninteractive
  # A lane-A machine runs this as root; a person running the script by hand
  # does not, and apt is the only step that cares. libasound2t64, not
  # libasound2: the plain name has no installation candidate on Ubuntu 24.04
  # and takes the whole line down with it.
  #
  # THE FONT IS PINNED HERE, and that is the whole point of the line below.
  # Every check in the browser stage asserts about a screen, and a screen is
  # mostly text — row heights, whether a line wraps, whether a label fits
  # beside a number are all font metrics. Left to the base image, that font is
  # an accident: different on a workbench than on a lane-A machine, and free
  # to change under us on any image bump, which would move every width
  # assertion in the suite at once with nobody having touched a line of code.
  #
  # It was tried once before, in a change about WHICH checks run (note #533),
  # and backed out the same day because it turned `verify-workspace-react-org`
  # red. That was not a flake and not the font's fault: the harness demanded a
  # loading skeleton be exactly as tall as the row it stood in for, which asks
  # a placeholder to predict a font. That screen and that assertion were fixed
  # on their own first, deliberately, so this could be one change rather than
  # five red things at once.
  #
  # `scripts/ci-fonts.conf` carries the reasoning and the aliases, including
  # why `Segoe UI` and `Roboto` are named in it.
  sudo=""; [ "$(id -u)" -ne 0 ] && sudo="sudo"
  # The libraries, and fontconfig to apply the pin with. Skipped wholesale on
  # an image that already carries both — which is every lane-A machine now.
  if ! command -v fc-cache >/dev/null 2>&1 || ! browser_runs; then
    $sudo apt-get update -qq || exit 1
    $sudo apt-get install -y -qq --no-install-recommends \
      libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0 \
      fontconfig fonts-liberation || exit 1
  fi
  # ~500 MB the image already holds. When it does not, the download ends on
  # `sync`: writing 500 MB and returning is not the same as the disk being
  # done with it, and the stage that starts next is the one that pays — a
  # `verify-workspace-drive` red on main on 2026-09-17 sat exactly there.
  if ! browser_runs; then
    node_modules/.bin/browsers install chrome@stable --path "$HOME/.cache/puppeteer" || exit 1
    sync
  fi
  # THE PIN RIDES THE REPO, not the image: it is a fact about what THIS
  # checkout's checks expect to render in, so it is installed on every run,
  # against whatever fonts the image ships. It costs about a second.
  $sudo install -Dm644 scripts/ci-fonts.conf /etc/fonts/conf.d/99-agentbuilt-pin.conf || exit 1
  $sudo fc-cache -f || exit 1
  )
}

( npm run test:frontend:coverage \
    && { npm run lint || echo "lint failed (advisory, matching the old checks job)"; } \
    && VITE_API_BASE_URL=http://localhost:3001 npm run build
) > "$logs/frontend.log" 2>&1 & lane_frontend=$!

# The private-copy installer's own tests (note #816) and the backup
# watchdog's (note #1032): plain node:test, no
# packages, exactly as they run in the public copy of that folder.
( cd backend \
    && npm run build \
    && npm run test:core -- --reporter=dot \
    && node --test ../infra/copy-installer/test/*.test.mjs \
    && node --test ../infra/backup-watchdog/worker.test.mjs
) > "$logs/backend.log" 2>&1 & lane_backend=$!

rc_frontend=0; wait "$lane_frontend" || rc_frontend=$?
rc_backend=0;  wait "$lane_backend"  || rc_backend=$?

show() { printf '\n=== %s lane: %s ===\n' "$1" "$2"; cat "$logs/$1.log"; }
for lane in frontend backend; do
  rc="rc_$lane"; [ "${!rc}" -eq 0 ] && show "$lane" "passed"
done
for lane in frontend backend; do
  rc="rc_$lane"; [ "${!rc}" -ne 0 ] && show "$lane" "FAILED (exit ${!rc})"
done
stage lanes
[ "$rc_frontend" -eq 0 ] && [ "$rc_backend" -eq 0 ] || { rm -rf "$logs"; exit 1; }

# ── The browser, now usually already here ───────────────────────────────────
# SINCE 2026-09-20 THIS COSTS A SECOND OR TWO on a lane-A machine: the image
# carries Chrome, its libraries and Liberation, so all that is left is the
# font pin. It was 30 s on the run that measured it, and the `ci timings:`
# line at the end of every run is where to check it has stayed there.
# Everything below is why the download — which still happens on an older
# image, or a workbench — is placed exactly where it is, and it stays
# written down because the day this moves back into the lanes is the day
# somebody re-learns it.
#
# This used to run BESIDE the two lanes, at `nice -n 19` and `ionice -c3`, to
# hide ~500 MB of download and unpack inside the three minutes they take. The
# CPU half of that worked. THE DISK HALF NEVER DID: these machines run the
# `none` I/O scheduler (`/sys/block/vda/queue/scheduler`), and blk-mq's `none`
# ignores I/O priorities outright — `ionice` is a no-op here, so the unpack
# competed with the lanes at full tilt for the one thing it uses most.
#
# The lanes lost, twice that we know of. On 2026-09-15 a mail test that
# renders its body asynchronously came back empty, on a commit that touched
# nothing but this file — that is the incident the old comment recorded as an
# argument for MORE niceness. On 2026-09-17 it was `Drive.test.tsx`: one
# `findByRole` of 4334 tests, timing out against a five-second budget on a
# query that takes ~100 ms locally, red on main twice in a morning. A 50x
# margin does not evaporate because a budget is tight; it evaporates because
# the box stalled.
#
# So it waits. It costs the minute it used to hide — paid against a 15-minute
# ceiling, and worth it to stop a green change going red for no reason, which
# is how everyone learns to stop reading the colour. Two things come back:
# a red lane now skips the download entirely rather than paying for a browser
# it will never use, and the priority dance is gone, because nothing is left
# for it to be polite to.
#
# AND IT ENDS ON `sync`, which is the half of that move it took a second red
# main to see. Waiting for the lanes stopped the unpack starving THEM; it did
# not stop it starving what comes next, because writing 500 MB and returning
# is not the same as the disk being done with it. The browser stage now starts
# exactly where that writeback lands. Two sightings sit beside a large write
# finishing rather than beside a busy CPU: `verify-workspace-drive`, red on
# main on 2026-09-17 in the run right after this install, and the same harness
# failing locally for another agent seconds after a `build:workspace-ui`.
# `sync` makes the boundary a fact instead of a hope, for the few seconds it
# costs. It is not a cure for the suite's thin waits (note #548) — it removes
# the one contributor this file is responsible for.
rc_browser_install=0
install_browser > "$logs/browser-install.log" 2>&1 || rc_browser_install=$?
show "browser-install" "$([ "$rc_browser_install" -eq 0 ] && echo passed || echo "FAILED (exit $rc_browser_install)")"
stage 'browser setup'
rm -rf "$logs"

# ── The browser stage ───────────────────────────────────────────────────────
# `scripts/verify-*.mts` drive the REAL Workspace shell in real Chrome against
# a real backend router and a seeded fixture — the only checks in this repo
# that can see a screen rather than assert about one. They ran only when
# somebody remembered to run them, which is why eighteen of the twenty-seven
# sat dead for days behind a signup form that had changed, while every pip
# stayed green (2026-09-15). Nothing was red because nothing was asking.
#
# Since 2026-09-16 the same stage also runs `simulations/*.mjs` (note #533),
# and for the same reason, one turn of the screw further out: nothing ran the
# journeys either, so six of the nine had rotted — two of them on real bugs in
# the shared fixture — while that same green pip said nothing. A journey walks
# a whole road (sign in, recover an account, hand a note to an agent, approve a
# proposal, read the inbox) through the controls a person uses, which is the
# break a feature-level harness cannot see.
#
# WHAT IT COSTS, measured on the first green run of this stage: 133 s for all
# 27 harnesses, four at a time on the four cores, taking the whole job from
# ~3 min to 6.3 min. The journeys add a wave of their own in front of them:
# two green runs a quarter of an hour apart, on the same host class, came in
# at 6.6 min without them and 8.2 min with — call it a minute and a half for
# six whole journeys, two at a time. Since 2026-09-20 the two waves are ONE
# POOL (the long note in run-browser-checks.sh): the journey cap stands, but
# the slots it holds back now go to harnesses instead of standing empty, which
# took the stage from 261-277 s to 202 s. That is the price of
# the answer to "does
# the Workspace still work", paid on every push, and it is worth saying why
# it is paid on EVERY push rather than only on the ones that touch the shell:
# lane A fetches one commit shallow (`git fetch --depth 1`), so no history
# here to diff a path filter against. A filter would have to be built in the
# runner, not in this file — and half of what broke last time was not in the
# shell at all but in the routes and services under it.
#
# THE CEILING IS 15 MINUTES, and this stage is what will one day reach it:
# ORG_CI_TIMEOUT_MS (backend/src/services/org-ci.ts) fails a job that runs
# longer, and on a busy host this one has taken 13.6 min BEFORE the browser
# stage existed. Nothing about that is new today and nothing here fixes it —
# it is simply the number to weigh the next thing added to this file against,
# and JOBS / SIM_JOBS are the two knobs that buy time back. The browser fetch
# that moved out of the lanes on 2026-09-17 spends about a minute of it, and
# only on runs that get this far — a red lane never pays for it now.
#
# Last, and only over two green lanes. BOTH kinds need
# `backend/dist/workspace-ui` — the harnesses serve it, the journeys serve it
# as the shell they photograph — and the backend lane's build is what produces
# it, so this ordering is load-bearing rather than tidy: run against a stale
# dist and it invents both failures and passes. Its own output would also push
# a failing lane's tail out of the 64 KB the dispatcher keeps, which is the one
# record anybody reads on a red run. A failure here fails the script.
#
# An install that did not finish is a FAILURE, not a skip. A stage that
# quietly stops running when its browser is missing is the same silence this
# stage exists to end.
if [ "$rc_browser_install" -ne 0 ]; then
  echo "browser checks: the browser could not be installed (see its log above) — failing rather than skipping"
  exit 1
fi
rc_browser_checks=0
bash scripts/run-browser-checks.sh || rc_browser_checks=$?
stage 'browser checks'
exit "$rc_browser_checks"
