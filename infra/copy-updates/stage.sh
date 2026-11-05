#!/usr/bin/env bash
# Stage the update service's build context into $1 (default: a new temp dir)
# and print it: `fly deploy "$(infra/copy-updates/stage.sh)" -c infra/copy-updates/fly.toml`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$(mktemp -d)}"
mkdir -p "$OUT/copy-release" "$OUT/copy-updates"
cp "$ROOT/infra/copy-release/signed.mjs" "$ROOT/infra/copy-release/signing-key.pub" "$ROOT/infra/copy-release/notes.mjs" "$OUT/copy-release/"
# Release notes (note #1006): the service serves these for releases cut
# before notes rode in the release image itself.
cp -r "$ROOT/infra/copy-release/notes" "$OUT/copy-release/notes"
cp "$ROOT/infra/copy-updates/server.mjs" "$ROOT/infra/copy-updates/Dockerfile" "$OUT/copy-updates/"
cp "$ROOT/infra/copy-updates/Dockerfile" "$OUT/Dockerfile"
echo "$OUT"
