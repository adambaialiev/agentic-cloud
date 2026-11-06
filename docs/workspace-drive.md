# Workspace Drive

Note #298 adds a file library alongside repositories, notes and knowledge. One Drive belongs to one workplace. All current members and their agents can upload, read, organize and trash files. It has no public links or per-file sharing grants.

## The experience

Drive is a row of the Workplace window on Home (note #960, 3 Nov 2026), and it is shared across the workplace. (It stood above the Rooms selector, saying it was shared across all rooms, until rooms were removed on 30–31 Oct 2026 — note #843.) Drive supports nested folders, multiple-file upload, desktop file drop, name search across the workplace, previews, download, rename and move. Files can be up to 1 GiB (note #784): anything over one 8 MiB part is uploaded in parts — start, parts, complete — so no request crosses Cloudflare's 100 MB body cap and the backend holds one part at a time; downloads go straight from the bucket on a signed link; a Drive holds up to 10,000 entries, including Trash. Existing names in a folder are refused, case-insensitively, rather than overwritten. Unicode names are normalized to NFC; slashes, control characters and names longer than 255 UTF-8 bytes are refused.

Trash is recoverable, with no automatic expiry. Trashing a folder includes its live descendants. Items independently trashed earlier remain independently trashed when that folder is restored. Restore uses the original folder, or Drive's root if the folder is gone or trashed. A name conflict leaves the item in Trash and asks for another name. Trashed roots can be renamed before retrying.

Only a workplace admin using the Workspace can delete a trashed root forever; the screen requires typing its name. This also deletes all descendants, including any earlier independent trash inside that folder. The agent router has no permanent-deletion endpoint. A workplace with any Drive entries, including Trash, cannot be deleted as an unused workplace.

Drive renders Markdown with a raw/formatted switch, displays UTF-8 prose, data, configuration and source files, embeds PDFs, and uses browser-native image, audio and video players. Text previews are limited to 2 MiB so a large log cannot freeze a phone; the original remains downloadable up to Drive's 1 GiB file limit (50 MiB until note #784, 2026-10-24). Archives, office binaries and unknown formats explain that no safe browser viewer exists and remain downloads. Uploaded HTML is shown as inert source rather than executed, and SVG is loaded only as an image. Drive does not edit documents, keep file versions, import Google Drive, synchronize a desktop folder, or publish anonymous links.

## Agent commands

```sh
agentbuilt drive list                         # root items and stable IDs
agentbuilt drive list <folder-id>
agentbuilt drive list --search "brief" --json
agentbuilt drive show <item-id> --json
agentbuilt drive mkdir "Client work" --in <folder-id>
agentbuilt drive upload ./brief.pdf --in <folder-id>
agentbuilt drive fetch <file-id> -o ./brief.pdf
agentbuilt drive rename <item-id> "Final brief.pdf"
agentbuilt drive move <item-id> root
agentbuilt drive trash <item-id>              # rm is the same recoverable operation
agentbuilt drive list --trash
agentbuilt drive restore <item-id>
```

`upload` also accepts `--name`. `fetch` refuses to overwrite an existing local file unless `--overwrite` is explicit. IDs survive rename and move. Agent access comes from the agent's pinned workplace, never a workplace query parameter or its owner's currently selected Workspace.

## Storage and concurrency

`drive_items` is an additive SQLite table keyed by `(org_id, item_id)`, created at backend startup. Its records carry the folder tree, metadata, authorship and object paths. It participates in the existing whole-database backup. The in-memory store implements the same atomic mutation contract for development and tests.

Bytes use the existing `MediaStorage` and `OrgRoutedMediaStorage`, under `users/<orgId>/drive/<itemId>`. That owner segment resolves directly to the workplace's existing bucket. Moving or renaming changes metadata only. New names never become storage paths. Upload writes bytes first and then inserts the record in an atomic tree mutation; if that commit loses a race with a move, trash or duplicate name, its unreferenced object is cleaned up. A process crash between upload and commit can still leave an unreferenced object, as with existing attachment uploads.

Every SQLite mutation validates against a fresh snapshot inside an IMMEDIATE transaction and writes only changed rows. This covers duplicate names, cycles, trash and restore as a unit. Tree reads are bounded by the entry limit. Nothing awaiting network I/O runs inside a database transaction.

Permanent deletion revokes the records first, then removes their objects. Failed object cleanup is logged; records are never restored over potentially missing bytes. Existing signed URLs expire after 15 minutes, including when membership or a record is removed. Object-store durability and offboarding follow the existing workplace media contract; metadata remains in the control-plane database.

## Routes and rollout

The single Workspace route registry adds four workplace destinations: `/drive`, `/drive/trash`, `/drive/folders/:id`, `/drive/files/:id`. Copied URLs carry `org` and are membership-checked before they select a context. Workspace APIs live under `/workspace/api/drive`; agent APIs under `/api/agent-cli/drive`. Both use `routes/drive.ts` and `DriveService`, with their existing cookie/CSRF or bearer-token authentication. Responses omit private author identities and storage paths. Uploads use raw `application/octet-stream` bytes and an encoded `x-drive-name` header, including when the file itself is JSON.

Downloads mint fresh signed URLs at the tap. Disposition headers include a UTF-8 filename and an ASCII fallback. Previewable images, PDFs, audio and video receive separate 15-minute inline URLs; HTML never does. Text and Markdown travel through the authenticated preview route and are rebuilt as text or safe renderer nodes in the Workspace, never assigned as markup. The UI uses the existing image viewer, Markdown renderer and bounded-read helper. Visible lists refresh every 15 seconds and on window focus; stale reads cannot repaint over a local mutation.

A list row shows two kinds of file by themselves, each through an address of its own that answers with a redirect to an inline signed URL: a picture is its own thumbnail (`/:id/image`, note #694), and a recording's mark is its play button (`/:id/audio`, note #698). Both refuse any file the preview would not show as that kind. Because the row's address needs nothing asked for first, a press of play calls `play()` inside the tap, which phones require before they make a sound. The list has ONE player (`screens/drive/useRowPlayer.ts`), so starting a second track stops the first; the size line counts the time while a track is loaded, leaving the folder stops the sound, and a track that ends gets its play button back. A track that errors after it got further than before asks for its address again and resumes where it was — the signed bytes last 15 minutes and a long recording is read as it plays — while one that fails without getting anywhere puts the music glyph back and says it could not play here.

## One place in the history

Note #521. Drive is one place in the browser's history: entering it from Home pushes an entry, and every step INSIDE it — into a folder, into a file, up a breadcrumb, over to Trash — replaces that same entry (`WITHIN_DRIVE` in `screens/drive/drive-links.ts`). Addresses stay real, so a link copied four folders down still opens there and a reload stays put; what changes is what Back means. The trail above the reader is the breadcrumbs' job and is on the screen the whole time, so Back owes them the way out rather than the next step of a walk they can already see: from anywhere in Drive it lands on the screen Drive was opened from, which is Home. A pasted Drive address with nothing beneath it falls back to Home, as every screen does.

The header's button, a phone's edge gesture and the browser's own arrow therefore all spend the same single entry and cannot disagree about where Drive leads. This is the opposite choice from the repository screens, which push every folder and file (knowledge page `miniapp-navigation`); Drive makes it because breadcrumbs, not history, are its way up.

Home names the place `Drive`, the same word its heading, its first breadcrumb segment and its address carry. It said `Files and folders` until note #521.

## Traversal without flicker

Note #520. The Drive screens are keyed on the workplace, the item and Trash, so every step in or out rebuilds one from nothing. Every answer therefore outlives its screen in a per-tab cache (`screens/drive/drive-cache.ts`) keyed by the read path, which already carries the workplace, the parent, Trash and any search term. A visit draws the held copy on its first render and refreshes underneath it, so a folder walked back into never has its list taken away and put back.

A folder or file opened for the FIRST time has no held answer, but its row in the listing just tapped carried its name, and that listing carried the trail above it and Drive's own totals. Those are drawn immediately as an outline and only the contents wait, so a heading never falls back to the word `Drive` or `File` and breadcrumbs never collapse to one segment. Outlines are taken from plain folder listings only: the server answers a search or a Trash listing with no folder and no breadcrumbs.

A read with nothing on the screen behind it gets the full retry ladder from `ui/read.ts`. A refresh going out underneath an answer the reader can already see passes `again: []`: one bounded attempt, and a failure another attempt could fix is absorbed silently rather than drawn as an alert over a good list. A refusal is different — it forgets the held copy and says so, because what is held may describe a folder this reader is no longer allowed to see. Previews are held under their own rule: a file's bytes never change under its id, so a held preview whose 15-minute signature has at least a minute left is shown and not read again, which keeps a fresh signature from reloading an image in front of the reader. An expired or unreadable stamp is treated as broken, not stale, and is replaced.

Every Drive write empties the whole cache. A move empties one listing and fills another, a rename changes a row in every search that matched it, and upload, trash, restore and permanent deletion all move `totalBytes` and `trashCount`, which are drawn on every listing including Trash's. The screen the write was made from keeps its own last answer and refreshes underneath, so nothing blinks where the reader is looking. Sign-out empties it too.

The identity documentation version and CLI version move together so existing agents receive the Drive commands on their next turn after rollout. Before proposing a rebased branch, confirm the identity version is higher than the latest main; another branch may already have used the same increment.

## Verification

`drive.test.ts` exercises both storage implementations: workplace isolation, duplicate and cyclic moves, trash groups, restore conflicts, upload failures, concurrent mutation, permanent-deletion restrictions, preview classification and signed access. `drive-routes.test.ts` drives the real browser and agent routers over HTTP, including sessions, CSRF, membership loss, workplace deletion, text/PDF previews and the shipped CLI's upload/download of actual Unicode, binary and empty files. `Drive.test.tsx` covers navigation, PDF/media frames, safe Markdown/text rendering, forms, partial upload failures and typed deletion confirmation. It also covers note #521 — Home's row named `Drive`, and a walk from Home into a folder and into a file left in one tap of Back — and note #520: a folder walked back into drawn in the same tick as the tap and refreshed underneath, a first visit keeping its name and trail while its contents land, a file opening on what its row already said, a preview reused while signed and read again once expired, an absorbed refresh failure, a refusal taking the list away, and a write emptying every held listing without blinking the one it was made from.

`scripts/verify-workspace-drive.mts` drives real Chrome over the real Workspace router and SQLite tree. It checks Drive's organization-wide position on Home, create/upload/rename/move/search, text and formatted/raw Markdown, Chromium's PDF viewer, image loading, a recording played, paused and handed over from its list row, a browser download's bytes, tree trash/restore, and layout at 320, 420 and 1200 pixels. It also walks in and out of a folder and into a file with a `MutationObserver` running across each tap, so a list removed for even one commit or a heading falling back to a placeholder word fails the run. It writes the Home screenshot to `~/mini-preview/n363-drive-home-mobile.png`, preview screenshots to `~/mini-preview/n-drive-*-preview.png`, and the Drive-screen screenshots to `~/mini-preview/n298-drive-*.png`.
