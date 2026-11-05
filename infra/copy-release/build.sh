#!/usr/bin/env bash
# One private-copy release (note #811): every image a copy runs, built or
# taken from ONE commit, tagged with ONE version, pushed to our private
# registry, and named together in a release manifest. Run by CI's
# copy-release job (infra/ci-runner/run-job.sh) when infra/copy-release/VERSION
# changes on main; usable by hand on any box with docker.
#
#   VERSION=2026.10.27.1 SHA=<commit> RELEASE_REPO=acc-copy-releases \
#   MACHINE_IMAGE=<the live agent image> APP_RUNTIME_IMAGE=<the live site image> \
#     infra/copy-release/build.sh
#
# Built here, from this commit: backend, git-host, msg-host, router, mx, and
# upgrader (note #1008: the one-shot machine an upgrade runs on, with this
# release's install.mjs and a pinned flyctl).
# Taken by digest from what production runs today: machine (agent, site-less
# CI) and app-runtime (sites). Their CLI pins and runtime are what our own
# fleet runs, and building them again would only make a second, untested copy.
#
# Releases are immutable: a version that already has a release tag is refused.
# A version with no release notes (infra/copy-release/notes/<version>.md, note
# #1006) is refused too, before anything is built; the notes ride in the
# release image as notes.md, beside copy-release.json.
# Expects `docker login registry.fly.io` done by the caller.
set -euo pipefail

: "${VERSION:?VERSION unset}"
: "${SHA:?SHA unset}"
: "${RELEASE_REPO:?RELEASE_REPO unset (the registry app holding releases, e.g. acc-copy-releases)}"
: "${MACHINE_IMAGE:?MACHINE_IMAGE unset (the agent image production runs)}"
: "${APP_RUNTIME_IMAGE:?APP_RUNTIME_IMAGE unset (the site image production runs)}"
: "${FLY_API_TOKEN:?FLY_API_TOKEN unset (pushes into our registry; carry.mjs reads it too)}"
[[ "$VERSION" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{1,3}$ ]] || { echo "VERSION must look like 2026.10.27.1, got '$VERSION'" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REG="registry.fly.io/$RELEASE_REPO"
cd "$REPO_ROOT"

# What's new, for a company's admin (note #1006): no notes, no release.
NOTES_FILE=$(node infra/copy-release/notes.mjs check "$VERSION") || exit 1

if docker manifest inspect "$REG:release-$VERSION" >/dev/null 2>&1; then
  echo "release $VERSION already exists in $REG — releases are immutable; bump infra/copy-release/VERSION" >&2
  exit 1
fi

LABELS=(--label "org.opencontainers.image.revision=$SHA" --label "org.opencontainers.image.version=$VERSION")
stage_dir() { mktemp -d; }

echo "== backend"
docker build "${LABELS[@]}" --build-arg RELEASE_SHA="$SHA" -f infra/backend-image/Dockerfile -t "$REG:backend-$VERSION" .

echo "== git-host"
STAGE=$(stage_dir)
cp infra/git-host-image/Dockerfile infra/git-host-image/entrypoint.sh "$STAGE"/
cp infra/git-host/git-host.mjs infra/git-host/backup.mjs "$STAGE"/
cp -r infra/git-host/hooks "$STAGE/hooks"
docker build "${LABELS[@]}" -t "$REG:git-host-$VERSION" "$STAGE"
rm -rf "$STAGE"

echo "== msg-host"
STAGE=$(stage_dir)
cp infra/msg-host-image/Dockerfile infra/msg-host-image/entrypoint.sh "$STAGE"/
cp infra/msg-host/msg-host.mjs "$STAGE"/
docker build "${LABELS[@]}" -t "$REG:msg-host-$VERSION" "$STAGE"
rm -rf "$STAGE"

echo "== router"
docker build "${LABELS[@]}" -t "$REG:router-$VERSION" infra/copy-router

echo "== mx"
docker build "${LABELS[@]}" -t "$REG:mx-$VERSION" infra/copy-mx

echo "== upgrader"
STAGE=$(stage_dir)
cp infra/copy-installer/upgrader/Dockerfile infra/copy-installer/install.mjs infra/copy-installer/package.json "$STAGE"/
docker build "${LABELS[@]}" -t "$REG:upgrader-$VERSION" "$STAGE"
rm -rf "$STAGE"

BUILT=(backend git-host msg-host router mx upgrader)
# Built here: single-platform images, pushed as such.
for image in "${BUILT[@]}"; do docker push "$REG:$image-$VERSION"; done
declare -A DIGESTS
for image in "${BUILT[@]}"; do
  DIGESTS[$image]=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$REG:$image-$VERSION" | grep "^$REG@" | head -1 | cut -d@ -f2)
  [ -n "${DIGESTS[$image]}" ] || { echo "no pushed digest for $image" >&2; exit 1; }
done

echo "== machine, app-runtime (production's own, carried unchanged)"
# Registry to registry with the installer's own copy code: the same bytes,
# and so the same digests, that our fleet runs (infra/copy-release/carry.mjs).
DIGESTS[machine]=$(node infra/copy-release/carry.mjs "$MACHINE_IMAGE" "$RELEASE_REPO" "machine-$VERSION")
DIGESTS[app-runtime]=$(node infra/copy-release/carry.mjs "$APP_RUNTIME_IMAGE" "$RELEASE_REPO" "app-runtime-$VERSION")

IMAGES=(backend git-host msg-host router mx upgrader machine app-runtime)
# The manifest names every image by digest, so a copy installs exactly these
# bytes whatever happens to a tag later.
MANIFEST_DIR=$(stage_dir)
{
  printf '{\n  "version": "%s",\n  "commit": "%s",\n  "createdAt": "%s",\n  "repository": "acc-copy",\n  "images": {\n' \
    "$VERSION" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  last=$((${#IMAGES[@]} - 1))
  for i in "${!IMAGES[@]}"; do
    image="${IMAGES[$i]}"
    digest="${DIGESTS[$image]}"
    [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "no digest for $image" >&2; exit 1; }
    printf '    "%s": { "tag": "%s-%s", "digest": "%s" }%s\n' "$image" "$image" "$VERSION" "$digest" "$([ "$i" -lt "$last" ] && echo ,)"
  done
  printf '  },\n  "sources": { "machine": "%s", "app-runtime": "%s" }\n}\n' "$MACHINE_IMAGE" "$APP_RUNTIME_IMAGE"
} > "$MANIFEST_DIR/copy-release.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$MANIFEST_DIR/copy-release.json"
cp infra/copy-installer/install.mjs "$MANIFEST_DIR/install.mjs"
cp "$NOTES_FILE" "$MANIFEST_DIR/notes.md"
printf 'FROM scratch\nCOPY copy-release.json install.mjs notes.md /\n' > "$MANIFEST_DIR/Dockerfile"
docker build "${LABELS[@]}" -t "$REG:release-$VERSION" "$MANIFEST_DIR"
docker push "$REG:release-$VERSION"
cat "$MANIFEST_DIR/copy-release.json"
rm -rf "$MANIFEST_DIR"

for image in "${BUILT[@]}" release; do docker image rm "$REG:$image-$VERSION" >/dev/null 2>&1 || true; done
echo "release $VERSION pushed to $REG"
