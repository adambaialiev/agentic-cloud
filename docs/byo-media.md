# BYO media — build record

The contract is the account knowledge page **byo-media-design** (approved
2026-08-25): a client org's attachments live in a bucket in ITS OWN Fly
account; the env-configured store (MinIO on ia-media) becomes org #0's row.
This file is the code-side record, the way `byo-fly.md` and `byo-git.md` are
for workstreams 3 and 4. Owner: Alex.

## The shape — routing beats threading

The design page's slice 2 expected the per-org storage to be threaded through
every consumer (CLI routes, Workspace routes, session media — ~12 files). The
audit found a cheaper cut: **every storage path already names its owner** —
all five path builders (`pullRequestAttachmentPath`, `knowledgeAttachmentPath`,
`quickNoteAttachmentPath`, `buildSessionAttachmentStoragePath`, and the
platform-Telegram path they feed) produce `users/<owner>/…`, where `<owner>`
is an orgId on org-namespaced records and a member's userId on personal ones.

So the build is one wrapper, zero consumer changes:

- **`OrgMediaService`** (`backend/src/services/org-media.ts`) —
  `storageForOwner(owner, {provision})`: owner → org (orgId directly, else
  membership lookup), then the org's own `S3MediaStorage` built from its
  pointer + org-secret keys, provisioned lazily on first WRITE via the
  byo-git Tigris path (`createTigrisBucket`, mint-once credentials to the
  org-secret store in the same breath, failed secret write deletes the
  bucket). Reads never provision. Clients cached per org; concurrent first
  uploads coalesce onto one in-flight creation.
- **`OrgRoutedMediaStorage`** implements `MediaStorage` and routes each call
  by the path's owner segment — write verbs may provision, read/delete verbs
  never do. `index.ts` wraps the env-built store in it; every consumer keeps
  holding one `MediaStorage`, and org #0 behaves byte-identically (the whole
  pre-existing suite passes untouched).
- **`OrgDocument.media`** — the pointer (addOnName, bucket, endpoint,
  credsSecretName); credentials live in the org-secret store under
  `MEDIA_BUCKET_CREDS`.

The hard edge is shared with org-fly: an org WITH a pointer whose secret is
missing fails loudly — a platform fallback would silently split an org's
files across two accounts.

Fallback rules, deliberate: no org → platform store (pre-org/org #0 shape);
org without a connected Fly org → platform store even on writes (reads must
work from minute one, and agent machines are refused until cloud connect, so
real client bytes only land after the org's bucket can exist).

## The drill ran against production (2026-08-25, same day)

Slice 3, executed on the backend host with the DEPLOYED dist modules and the
live database, the platform store replaced by a proxy that throws on any
touch — so a silent fallback to ia-media fails the drill rather than passing
it:

1. The scratch org's (`ia-scratch-client`) first upload provisioned
   `iamedia-87c99fa526a3` in ITS Fly account — pointer written, mint-once
   keys in the org-secret store.
2. Probe bytes round-tripped through the org-media path; the poisoned
   platform store was never touched.
3. A presigned read URL was fetched from a DIFFERENT machine — no backend,
   no keys in the loop — HTTP 200, bytes exact.
4. The object answered a fetch signed with the org's OWN keys read from the
   secret store — the off-boarding half, proven.

Probe object deleted after; the bucket and pointer stand as rehearsal
ground beside the org's WireGuard peer and git host, so the multi-org media
path is exercised by anything that touches the scratch org from now on.

## Still ahead

- **Off-boarding:** delete `iamedia-<orghex>` via `deleteAddOn` joins the
  runbook in `byo-git.md` (nothing coded for it here yet — the byo-git
  runbook step covers add-on deletion generically).
- **`org spend`:** a labelled row for the media bucket, pennies, not gated.
