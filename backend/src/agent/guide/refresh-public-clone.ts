/**
 * Keeps the PUBLIC GUIDE agent's one folder current (note #1010): an
 * anonymous, shallow clone of the public agentic-cloud repository, whose
 * src/docs/chapters are the docs on agenticcloudcomputer.com, so "the code
 * and the docs" is one folder and the agent needs no web access.
 *
 * Production and the site deploy from main, so the clone follows main: what
 * the agent reads is what the public can read and what is running.
 *
 * The script is written onto the guide's machine and run as the guide user
 * before each visit turn:
 *
 *   bash refresh-public-clone.sh <dir> <clone-url> [max-age-seconds]
 *
 * - First run (no <dir>/.git): a shallow clone of main.
 * - Later runs: when the last successful fetch is older than max-age
 *   (default GUIDE_CLONE_MAX_AGE_SECONDS), fetch main shallowly and reset the
 *   working tree to it, removing anything that is not in the repository.
 *   A fresher fetch is a no-op, so a busy queue costs one fetch per window.
 * - Never fails a turn: every outcome exits 0 and prints one status line
 *   (cloned / fetched / fresh / kept / missing). A failed fetch keeps the last
 *   copy; only "missing" (no copy at all) means there is nothing to read.
 * - Anonymous by construction: no credential helper, no prompt, no askpass,
 *   so a credential that happens to sit on the machine is never offered.
 *
 * The clone URL is the caller's: it comes from the backend's config, never
 * from this public file (server addresses stay out of the public code).
 */

/** Fetch at most once per this many seconds (note #1010: 15 minutes). */
export const GUIDE_CLONE_MAX_AGE_SECONDS = 15 * 60;

/** Where the script stamps its last successful fetch, inside <dir>/.git. */
export const GUIDE_CLONE_STAMP = 'guide-last-fetch';

export const REFRESH_PUBLIC_CLONE_SCRIPT = `#!/usr/bin/env bash
# Keep the public guide's clone of the public repository current (note #1010).
# Usage: refresh-public-clone.sh <dir> <clone-url> [max-age-seconds]
set -u
dir="\${1:?dir}"
url="\${2:?clone-url}"
max_age="\${3:-${GUIDE_CLONE_MAX_AGE_SECONDS}}"
stamp="$dir/.git/${GUIDE_CLONE_STAMP}"
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false GCM_INTERACTIVE=never
anon=(git -c credential.helper= -c core.askPass=/bin/false -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20)
now=$(date +%s)

if [ ! -d "$dir/.git" ]; then
  rm -rf "$dir.tmp"
  if timeout 120 "\${anon[@]}" clone --quiet --depth 1 --single-branch --branch main "$url" "$dir.tmp" >/dev/null 2>&1; then
    rm -rf "$dir" && mv "$dir.tmp" "$dir" && echo "$now" > "$stamp"
    echo "cloned $(git -C "$dir" rev-parse --short HEAD)"
  else
    rm -rf "$dir.tmp"
    echo "missing"
  fi
  exit 0
fi

last=$(cat "$stamp" 2>/dev/null || echo 0)
case "$last" in ''|*[!0-9]*) last=0 ;; esac
if [ $((now - last)) -lt "$max_age" ]; then
  echo "fresh $(git -C "$dir" rev-parse --short HEAD 2>/dev/null)"
  exit 0
fi

if timeout 60 "\${anon[@]}" -C "$dir" fetch --quiet --depth 1 "$url" main >/dev/null 2>&1 \\
  && git -C "$dir" reset --quiet --hard FETCH_HEAD >/dev/null 2>&1 \\
  && git -C "$dir" clean --quiet -ffdx >/dev/null 2>&1; then
  echo "$now" > "$stamp"
  echo "fetched $(git -C "$dir" rev-parse --short HEAD)"
else
  echo "kept $(git -C "$dir" rev-parse --short HEAD 2>/dev/null)"
fi
exit 0
`;
