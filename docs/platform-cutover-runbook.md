# Cutover runbook: the platform repo moves to our own git host

> Status (2026-11-06): history. The cutover was done. Since 2026-11-01 the platform repository is `agentic-cloud`, public under the AGPL-3.0, on the same git host.

Step 4 of `platform-on-own-git.md`. Everything before it is live and
verified: rollback, builds off the keyed box, the laptop key, the recovery
token (drilled daily), the mirror lane and the platform pipeline — both
shipped INERT, armed by one env variable. This runbook is the arming.

Two properties make this a calm afternoon instead of a leap:
- **One switch.** `PLATFORM_REPO` in `/etc/ia-ci/env` arms everything at
  once: the host-side pipeline, the mirror, the GitHub-webhook silence, and
  dispatch resolution. Unsetting it is the reverse in equal measure.
- **Reversible for as long as we want.** Until agents have pushed new work
  to the host, GitHub and the host hold identical history; unset the
  switch, repoint remotes back, and nothing happened.

## Pre-flight (any time before; all read-only)

1. `#1128` (or successor) merged and the daemon restarted onto it —
   `journalctl -u ia-ci-daemon | tail` shows a boot after the merge.
2. Yesterday's `recovery-drill` heartbeat is `ok` (Workspace/ops bot quiet).
3. `agentbuilt repo show infinite-agents` answers: protected `main`,
   CI off (expected — enabled below), size present.
4. No open GitHub PRs that should land first: `gh pr list`. Land or accept
   they will be re-proposed as workspace PRs.

## The flip (~15 minutes, quiet moment; nothing user-facing goes down)

1. **Freeze**: no merges on GitHub from here (say so in chat if other
   agents are active).
2. **Final sync** — bring the host's copy up to GitHub's exact tip:
   ```
   git fetch origin && git bundle create /tmp/ia.bundle origin/main
   scp /tmp/ia.bundle root@<git-host>:/tmp/ && ssh root@<git-host> \
     'chown agentgit:agentgit /tmp/ia.bundle && sudo -u agentgit git \
      --git-dir /var/lib/agentgit/repos/<uid>/infinite-agents.git \
      fetch /tmp/ia.bundle +refs/heads/main:refs/heads/main && rm /tmp/ia.bundle'
   ```
   Verify: `git ls-remote` of host and GitHub agree on `refs/heads/main`.
3. **Turn on required checks and CI** for the repo (owner-gated where it
   must be): `repo protect infinite-agents --require-checks`, then
   `repo ci enable infinite-agents`.
4. **Arm**: append `PLATFORM_REPO=<uid>/infinite-agents` to
   `/etc/ia-ci/env`, install `/home/runner/.netrc` (host + recovery token,
   0600, owned by runner) so the work repo can fetch from the host, repoint
   the work checkout: `git -C /home/runner/ci-work/repo remote set-url
   origin https://git.agentbuilt.app/<uid>/infinite-agents.git`. Restart the
   daemon when idle (`touch /opt/ia-ci/.restart-requested` or wait).
5. **Prove the pipeline before trusting it**: push a trivial branch to the
   HOST, open a workspace PR, approve it. Watch: ci-script pip on the card;
   on merge — self-update, deploy-prod (remote build), deploy-site,
   mirror-github all green in the journal; the merge sha appears on
   GitHub's main a minute later (the mirror working); prod healthy.
6. **Repoint agents**: each agent runs `git remote set-url origin
   https://git.agentbuilt.app/<uid>/infinite-agents.git` (auth via its own
   agentbuilt token, netrc/credential helper — same as any platform repo).
   From here: `git push origin HEAD:<branch>` + `agentbuilt pr create`, not
   `gh`. Update the repo's own README/CLAUDE.md to say so.
7. **GitHub demoted, not removed**: leave the repo, delete its webhook
   (Settings → Webhooks) — the daemon already ignores it, the deletion just
   stops the noise. GitHub Actions stays frozen; branch protection there is
   now meaningless (only the mirror pushes, forced, with the GH token).

## Rollback of the flip (any time before new work lands on the host)

Remove `PLATFORM_REPO` from `/etc/ia-ci/env`, restart the daemon, repoint
the work checkout and agents back to GitHub. The mirror pushed every merge
to GitHub as it happened, so GitHub is already current — that is the point
of it. After new work exists only on the host, rollback becomes "mirror
first, then flip back", which the mirror does on its own.

## The day after

- Watch one organic PR land end to end without touching anything.
- The nightly git bundle now covers the platform repo (it is just another
  repo on the host); confirm the backup summary counts it.
- `ci-rehearsal` and friends still work — other repos must be unaffected.
- Retire the GitHub-era muscle memory as it surfaces: `gh pr` → `agentbuilt
  pr`, `gh run` → the journal, statuses → the Mini App.
