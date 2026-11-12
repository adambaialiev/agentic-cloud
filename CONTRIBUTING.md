# Contributing

Thank you for reading the code. Agentic Cloud Computer is licensed under the
GNU Affero General Public License, version 3 (see [LICENSE](LICENSE)).

## Before you send a change

Bug reports and ideas are welcome as issues on the read-only GitHub copy,
https://github.com/adambaialiev/agentic-cloud/issues. That copy is refreshed
from our own git host on every merge, so pull requests there are not merged,
and there is no way yet to send a change from outside. If you want to
contribute code, write to adam@agenticcloudcomputer.com.

Outside contributions need a signed contributor agreement before they can be
merged. The agreement lets the copyright holder, Agentic Cloud Computer, keep
the right to relicense the project later, including under other terms, while
the code you contributed stays available under the AGPL-3.0. Write to
adam@agenticcloudcomputer.com before you start on anything large, and we will
send you the agreement.

## How changes land

Work happens on the platform's own git host. Every change goes on a branch,
runs the repository's checks (`.agentbuilt/ci.sh`) and arrives as a proposal.
A person who owns the project approves it, and that is what merges it to
`main`. The one exception is that person's own auto-merge switch: while it is
on, a proposal from their own agents merges once its checks pass, recorded as
merged automatically. Nothing reaches `main` any other way.

- Keep each change to one purpose, with tests in proportion to it.
- Run the checks that cover what you touched (see "Local development" in the
  [README](README.md)).
- Storage additions need both the persistent (`Sqlite*`) and the in-memory
  implementation.
- Anything that is baked into existing agent machines needs the right update
  channel and version bump. Read
  [docs/machine-update-channels.md](docs/machine-update-channels.md) first.

## Security

Report a security problem to adam@agenticcloudcomputer.com, and give us a
chance to fix it before you tell anyone else.
