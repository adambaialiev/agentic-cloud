# The fleet SSH key: where it lives and how to rotate it

The backend reaches every agent machine and every hosted site over SSH on port
2222 with ONE keypair, the fleet key. Whoever holds its private half is root on
the whole fleet, so it lives in as few places as possible. A private copy makes
its own keypair at install (`infra/copy-installer/install.mjs`) and shares
nothing with ours.

## Where it lives

The private half is held by:

- the backend: `FLY_SSH_PRIVATE_KEY` in `/etc/infinite-agents/backend.env` on
  ia-control (on its volume as `/data/etc/backend.env`). Nowhere else. It is
  not a workplace secret, not in CI, and not in any image.

The public half is trusted by:

- every agent machine and every hosted site, through `AUTHORIZED_KEYS` in the
  machine's env. The backend writes it from `FLY_SSH_PUBLIC_KEY` when it
  creates a machine or deploys a site, and the image's entrypoint copies it into
  `/root/.ssh/authorized_keys` and `/home/agent/.ssh/authorized_keys` at every
  boot. The key is NOT baked into any image: the image only carries the
  entrypoint that reads it.
- That includes machines in a workplace's own connected Fly org. They are
  reached through the same backend, so they trust the same key.

The CI deploy job has its own key, the deploy key. It is `DEPLOY_SSH_KEY` on
ia-ci, trusted only by ia-control (`DEPLOY_AUTHORIZED_KEYS` on ia-control). It
opens nothing else. The CI builder has a third key of its own (`BUILDER_SSH_*`).

`FLY_SSH_PUBLIC_KEY` may hold several keys, one per line (a literal `\n`
works in the env file). New machines trust every key it names.

## How existing machines pick up a change

A machine reads `AUTHORIZED_KEYS` only when it boots, and Fly can change a
machine's env only by restarting it. So the change rides the moment that
costs nothing: sleep. The machine image updater (`machine-image-updater.ts`)
already rewrites a sleeping machine's config to move it onto the fleet image,
with `skip_launch` so it stays asleep. Since note #1074 the same write also sets
`AUTHORIZED_KEYS` to the current `FLY_SSH_PUBLIC_KEY`. Every agent machine
converges at its next sleep, or within a sweep if it is already asleep, in
every org the backend reaches. It never restarts an awake machine to do it.

The updater does not cover these, so they are done by hand:

- **An agent machine that is awake.** Edit its live
  `/root/.ssh/authorized_keys` and `/home/agent/.ssh/authorized_keys` over SSH.
  Its env converges when it sleeps.
- **A hosted site.** Sites never sleep, so their env changes only with a
  restart: a config write, or the next deploy. Edit the live files first. Then
  make one config write per site, with the old key already gone, so each site
  restarts once.
- **Machines no record claims** (for example, leftovers in a test org). The
  updater only touches claimed machines, so write their env with `skip_launch`
  by hand.

## Rotating it, in this order

1. **Inventory.** List every machine in every org with the fingerprints of its
   `AUTHORIZED_KEYS`, and every holder of the private half. Write the list on
   the rotation's note. Print fingerprints only, never a value.
2. **New keypair, made on ia-control** (`ssh-keygen -t ed25519 -N ''`), kept
   under `/data/etc`. It is never made on an agent machine and never copied off
   the backend.
3. **Trust both.** Set `FLY_SSH_PUBLIC_KEY` to the old key and the new key,
   then restart the backend. Sleeping machines converge within minutes. Edit
   the live files on awake machines and sites. **Prove** the new key opens
   every machine: wake each sleeping one and run a command with the new key.
   If any machine cannot be reached, stop here.
4. **Switch.** Point `FLY_SSH_PRIVATE_KEY` at the new key and restart. Check
   that turns, stop, job reads and the wake path all work, and watch the log
   for SSH failures.
5. **Retire the old key.** Set `FLY_SSH_PUBLIC_KEY` to the new key alone.
   Edit the live files on awake machines and sites, then make one config write
   per site. Every agent machine drops the old key at its next sleep. Delete
   the old private half from `backend.env` and from every `backend.env.*`
   backup. Check that a machine refuses the old key.

If the backend ever loses the private key, nothing is locked for good. The Fly
API needs no SSH, so a new key can be written into every machine's env the same
way, and a sleeping machine takes it at its next wake.

## History

- 2026-11-08, note #1074: first rotation. The previous key had lived on the
  retired Hetzner host (note #1072). That rotation also split the CI deploy key
  off from the fleet key.
