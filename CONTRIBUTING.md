# Contributing

Thank you for reading the code. Agentic Cloud Computer is licensed under the
GNU Affero General Public License, version 3 (see [LICENSE](LICENSE)).

## Before you send a change

Outside contributions need a signed contributor agreement before they can be
merged. The agreement lets the copyright holder, Agentic Cloud Computer, keep
the right to relicense the project later, including under other terms, while
the code you contributed stays available under the AGPL-3.0. Open an issue or
write to hello@agenticcloudcomputer.com before you start on anything large,
and we will send you the agreement.

## How changes land

Work happens on the platform's own git host. Every change goes on a branch,
runs the repository's checks (`.agentbuilt/ci.sh`) and arrives as a proposal.
Only a person who owns the project approves it, and that is what merges it to
`main`. Nothing reaches `main` any other way.

- Keep each change to one purpose, with tests in proportion to it.
- Run the checks that cover what you touched (see "Local development" in the
  [README](README.md)).
- Storage additions need both the persistent (`Sqlite*`) and the in-memory
  implementation.
- Anything that is baked into existing agent machines needs the right update
  channel and version bump. Read
  [docs/machine-update-channels.md](docs/machine-update-channels.md) first.

## Security

Please do not open a public issue for a security problem. Write to
hello@agenticcloudcomputer.com instead, and give us a chance to fix it first.
