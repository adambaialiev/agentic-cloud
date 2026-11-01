# Project-grade repos on the internal git host

Decided with Owner 2026-08-12. Phase 1 (durability, `agent-git-phase1.md`)
and the approval gate made the host a fine home for **agent projects** — a
site, a bot, a script a user asked for. This doc is the plan for the next
tier: a repo shaped like a real software project — a monorepo with `main` +
an integration branch, PR velocity in the hundreds, CI on every push, deploys
off the protected branch.

One repo was explicitly out of scope when this was written: infinite-agents
itself, because hosting the code that rebuilds the backend behind a service
that fails closed when the backend is down is a circle we chose not to draw.
**Reversed 2026-08-13**: the circle gets drawn on purpose, with each of its
links given its own answer — see
[`platform-on-own-git.md`](./platform-on-own-git.md).

## The gaps, in dependency order

Surveyed 2026-08-12 against what such a repo actually uses day to day:

1. **Multi-branch + tag protection** — protection was a single branch fixed at
   creation; a `main` + `dev` discipline didn't fit, and tags were movable by
   any agent. *Shipped in this slice — see below.*
2. **Repo maintenance** — no scheduled `git gc`, and approved merges are built
   with `commit-tree`, which bypasses git's auto-gc entirely, so a busy repo
   accumulates loose objects unwatched. Backup RPO is ~24 h (nightly bundles),
   thin for a repo merging many times a day. *Shipped: `gc --auto` after every
   real merge, a weekly full-gc timer, and three intra-day quiet backup runs
   (RPO ≈ 6 h) — see `infra/git-host/README.md` → Maintenance.*
3. **The review loop** — PRs were one-shot: a new push to the source branch
   stranded the proposal (terminally `stale` at decision time) instead of
   updating it. *Shipped: open proposals now follow their branch — the pin,
   stats and card subjects re-pin on every push, and a decision carries the
   sha the decider was shown, so a mismatch refreshes and re-asks instead of
   killing the proposal or merging unread commits. Rejections carry a reason:
   the workspace's reason box writes `decisionNote`, the agent's wake-up turn
   quotes it, and the decided screen keeps it. And checks can be required:
   `repo protect <name> --require-checks` (one-way, like protection) makes an
   approval merge only when every check on the pinned sha passes — the
   default everywhere else stays "checks inform, never block"
   (ci-status-miniapp.md). And squash merges: `pr create --squash` lands the
   branch as ONE commit — single parent, branch author kept, same conflict
   answer. The agent chooses at creation, because the diff the user approves
   is identical either way; history shape is merge mechanics, not part of
   the gate.* This slice is complete.
4. **Deploy jobs** — a platform repo's push triggers exactly its own
   `.agentbuilt/ci.sh` in a lane-A throwaway machine, by design. Deploys need
   secrets and a trust decision (`ci-two-lane-runner.md` phase 3: per-repo
   opt-in secrets, protected-branch pushes only) before they exist here.
   *Shipped: `repo ci-secrets <name> NAME…` asked the OWNER (card in chat,
   then the repository's screen); since 2026-10-11 (note #739) an admin's
   agent grants at once and the owner is told in the chat; any agent can
   remove on its own. Granted
   names ride protected-branch jobs as plain env, the backend re-checks
   protection with the host per job and fails closed, and the runner masks
   the values out of the log tail it reports. And CI is self-serve:
   `repo ci enable <name>` replaces an operator with a shell on ia-media —
   the API carries a boolean, the host fills in its own dispatcher URL, so
   the SSRF reason that made it manual is kept rather than traded away. See
   ci-two-lane-runner.md phase 3 for what remains (minute budgets, CI
   history, lane B artifact build).*
5. **Admin surface** — no delete/rename/settings. *Shipped in this slice —
   see below. The webhook half was already done: `provision.sh` carries the
   CI dispatcher env, so a rebuild restores it instead of silently losing CI
   host-wide.*
6. **A human credential** — only agent tokens and CI clone tokens can touch a
   repo; a person with a laptop cannot. *Shipped: the "laptop key"
   (human-git-token.ts) — one per user, minted ONLY in the Workspace's
   repositories list, where it goes straight to the clipboard and is never
   displayed anywhere, chat and agents included; the profile keeps a hash.
   Verified by the same `/git/verify` round trip as agent tokens, same
   namespace and quota, `agentId: "owner"` in the host's logs. Minting again
   IS the rotation; Revoke clears it. Made a prerequisite for the platform
   repo's migration by platform-on-own-git.md.*

Each is a slice with its own PR; the numbers above are the order, because each
leans on the ones before it (required checks are meaningless until protection
covers the branches CI watches; deploys are unsafe until checks can be
required).

## Link-only public repositories (note #665, 2026-09-25)

**Back since 2026-11-01 (note #936).** Publishing was hidden on 2026-09-29
(PR #1234: the owner then wanted closed-source work only), and the open-source
page note #674 had put up the day before went with it. That page stays gone —
`GET api/public/repositories` and the footer link are not coming back, and
`/open-source` still 301s home — so a public repository is reached by its
address alone. When the owner decided to open the platform's own source, the
admin's Make public button came back on the repository's screen; the server's
`POST api/repos/:name/public-access` had never changed (admin, human session
only, a root LICENSE required). Make private no longer says it is final.

A repository starts private. A workplace admin can open-source it from the
repository's Workspace screen after confirming that anyone with the link may
browse and clone it. Agents cannot publish code: there is deliberately no
agent CLI mutation for visibility. `repo list` marks an already-public repo
and `repo show` prints its public page, so an agent can report the state
without being able to change it.

Publishing requires a non-empty conventional licence file at the root of the
default branch (`LICENSE`, `LICENSE.md`, `LICENSE.txt`, `LICENSE.rst`, the UK
`LICENCE` spellings, or `COPYING`). Visible source with no permission to use,
copy or modify it is not called open source here.

The public surface is intentionally link-only:

- `publicAccess.id` is an opaque UUID unrelated to the repository namespace or
  name. There is no public list/search endpoint, and the shell/API responses
  carry `noindex`; renaming the repository does not break a shared page link.
- The no-account page shows the default branch's folders, files, images and
  rendered README plus the clone URL. It exposes no members, agents,
  proposals, checks, secrets or settings.
- Anonymous smart-HTTP access is `git-upload-pack` only. The host asks
  `/git/verify` for the exact namespace/name on every anonymous request and
  receives a repo-scoped, read-only answer. `git-receive-pack` challenges for
  credentials before that lookup, and the read-only scope is a second push
  refusal. Authenticated workplace clones continue unchanged.
- Anonymous permission is never cached on the host. Making the repository
  private clears `publicAccess`, kills the public page and closes the next
  anonymous git request immediately. Publishing later mints a new UUID, so an
  old link never revives. Copies already made cannot be recalled.
- Deleting a repository also clears `publicAccess`; restoring it keeps it
  private. The public lookup returns live repositories only.

The git host remains byte-serving only. Public browsing still goes through
the backend's existing internal `tree`/`file` control calls, which apply the
same path validation, text/binary detection and size caps as the private
Workspace explorer.

## Slice 5 — admin surface (this PR)

Four verbs, and one property under all of them: **nothing here destroys bytes
on anyone's say-so.**

- **Deleting is not an agent verb.** `agentbuilt repo delete <name>` records
  `deleteAsk` and returns; no agent-reachable route removes a repo, whatever
  its protection is — absent, like `pr approve`. The owner deletes it in the
  **Workspace**, and that is the only surface in the product that can. Not a
  chat card either: a delete has no deadline, so it does not belong in the
  channel a user cannot mute, and the workspace can show what is actually at
  stake — the size, the history, the proposals still waiting — beside the
  button. The cost is real and is stated to the agent in words: nothing
  pushes a Workspace state change, so an agent that wants a repo gone has to
  SAY SO IN CHAT. The repo's row carries a `delete asked` badge until the
  owner answers, and answering either way (`DELETE /api/repos/:name`, or
  `POST …/keep`) wakes the agent that asked with the outcome.
- **The trash.** A delete moves the bare repo to `<repos>/../trash/<userId>/
  <name>.<stamp>.git` — a sibling of the repos root, so the move is one
  atomic `rename(2)` and every loop that walks repos (backups, gc, the size
  sweep) steps over it without being taught to. `maintain-repos.sh` purges
  entries older than `TRASH_KEEP_DAYS` (14) on its weekly run, and is the
  only thing that purges: the retention window is one number in one place.
- **`repo restore <name>`** IS an agent verb, unlike the delete it undoes.
  Bringing bytes back destroys nothing, and a mistake should not need a
  second trip to the workspace to fix. It restores the exact trash entry
  the delete recorded (`trashedAs`), so two deletes of one name can never
  resolve to the wrong bytes.
- **`repo rename <old> <new>`** is a rename inside the user's namespace.
  Protection, CI config and hooks live in the repo's own config — the whole
  reason they live there — so they travel with the directory and the gate
  stays closed. It is not gated: nothing is destroyed and nothing lands on a
  branch — it is a directory the user already owns, moved. It DOES change the
  clone URL, and the answer says so, because a remote that 404s tomorrow is
  this verb's entire cost.
- **`repo show <name>`** is the settings surface. Every mutation on a repo
  already has its own verb; what was missing was one place that says what the
  answers currently are — protection, required checks, CI, granted secrets,
  sizes, dates. The host's config is the truth for protection and CI; the
  record answers for the rest.

The record side is a tombstone, not a row delete: `deletedAt` makes a repo
invisible to `getByName`/`listByUser`, which is what makes the change safe.
`repo delete` reaches one route, but "a repo by name" is reached by pushes,
proposals, CI secrets, the Workspace and the quota — any of those forgetting a
flag would be a deleted repo that still works. The tombstone keeps its name,
so the unique index on `(user_id, name)` had to go: the live-name fence is now
in `create()`, exactly where deployments already keep theirs for destroyed
tombstones. Trash counts against neither the quota nor the name.

Two consequences worth stating out loud, because they are chosen and not
accidental: open proposals are WITHDRAWN when their repo is deleted (nothing
can land in a repo that is gone, and a card still offering Approve would be
lying), and a restored repo does not get them back.

The trash is NOT on screen. It was, for a while — deleted repos sat under the
live ones with a Restore button beside each, on the reasoning that an app
promising a repo can come back should be where that promise is redeemed. What
it produced was a list of what you own that ended with what you had already
thrown away, permanently, because fourteen days is longer than anyone looks at
a workspace. So the weight moved to the front of the flow instead: the delete
now opens a dialog that will not answer until the repository's name has been
TYPED (the only typing this app asks of anyone), and what it leaves behind is
a list of live repositories only. The window itself is unchanged — the bytes
sit in the host's trash for fourteen days and `repo restore` is an agent verb,
which is exactly what the dialog and the banner tell the user. That CLI route
is the one restore doorway; the unused browser restore endpoint was removed
in note #304.

One known loose end: `backup-repos.sh` prunes per EXISTING repo, so the
bundles of a deleted one are orphaned on the backup target and age out never.
That is disk on the far end, and an off-box copy that outlives the window —
useful to an operator, and deliberately not promised to anyone: the product
says fourteen days, because fourteen days is what a user can act on without
asking a human for help.

## Slice 1 — protection

- `agentgit.protectedBranch` is now **multi-valued** (`git config --add`, read
  with `--get-all`); the first entry is the default branch `reconcileHead`
  points HEAD at, so existing single-value repos read identically.
- `agentbuilt repo protect <name> <branch>...` adds protection to an existing
  repo — **add-only**, mirroring the gate's shape: no agent call ever widens
  what agents may do. `--unprotected` remains permanent; the record refuses
  before the host is even asked, and the host's own config check backs it up.
- **Tags in a protected repo are append-only.** New tags land freely; moving
  or deleting an existing one is refused by pre-receive. No new config — any
  protected branch is the switch — and since hooks re-install on every push,
  the rule reaches protected repos that already exist. A release tag another
  machine resolved yesterday resolves to the same commit tomorrow.
- `/internal/repos/stat` reports `protectedBranches`, read from the repo's
  config: the config stays the single source of truth, and the backend's
  `protectDefaultBranch` stays what it was — a product flag.

Wire compatibility during the deploy window (backend deploys before the host
in the same lane-B queue): repo creation sends the legacy singular
`protectedBranch` alongside the new list, so a new backend against the old
host still protects the default branch, and `repo protect` catches up the rest
once the host restarts.

## Files on a proposal (2026-08-18)

Owner's notes #10 and #18 ("proposals and knowledge should be able to have
files as attachments"). This section covers the proposal half; knowledge is a
separate build and a harder one — see the note at the end.

**What it is for.** A proposal is answered on a phone, off a title, a body and
a diff, and a diff is the worst of those on a small screen. Some changes have a
LOOK, and the thing that settles them is a picture: the screen as it now reads,
the chart the export produces, the page with the new hero on it. Before this,
an agent's only way to show one was to send it into the chat, where it arrives
detached from the proposal it is about, above or below the card, and is
scrolled past. Now it rides the proposal and is drawn on the screen where the
tap happens.

**The record is the note's, deliberately.** `PullRequestAttachment` is
`QuickNoteAttachment` with a different prefix — same fields, its own limits (5
files, 10 MB each; a note's files grew to 100 MB in note #784, a proposal's did not), same name rule (a storage path segment and the CLI's
handle, so `résultat (1).pdf` is refused rather than silently renamed), same
two-step order on both sides: bytes before record when attaching, record before
bytes when detaching, so the failure mode is always a stranded object and never
a row promising bytes that are gone. Two stores with one shape means the CLI's
verbs and the Workspace's card work the same way on both.

**Bytes live in media storage**, never in git: `users/<uid>/prs/<prId>/<id>/<name>`.
A screenshot is not part of the change being reviewed, and putting one in the
branch would make it part of the diff it is evidence for.

**Attaching changes nothing the decision is about** — not the pinned sha, not
the diff, not the branch — which is what makes it safe on an open proposal.
That is the same reasoning that lets any agent attach to any note.

## The margin on a proposal (2026-08-27)

Owner's note #66 ("humans and agents should be able to add comments to
proposals and knowledge pages"). A proposal carries **remarks under it** — the
`MarginComment` shape notes grew first (`types/comment.ts`), kept on the
document the way a note's are, appended by an `addComment` of its own because
a person tapping Send and an agent mid-turn must not lose each other's writes.

Who writes: **everyone in the workplace** — `agentbuilt pr comment <n>` from
an agent's turn, a collapsed composer on the proposal screen for the person.
There is deliberately no ownership gate: the document above the margin keeps
one author's words, and the margin is where everybody else speaks. `pr
show`/`pr list` carry the thread and its marker, and the Workspace draws it
under the diff.

**Nobody is told.** A comment is a write and nothing else (note #518): it
starts no agent, whoever wrote it and whoever it names. The composer has no
picker, the request body is `{ text }` alone, an `@Name` in the words is prose,
and a `mentions` array an older client still sends is ignored. The margin is a
record, read by whoever opens the proposal next.

Two starts used to live here and both are gone: an explicit `@Name` (note #179)
and — without any name — the agent that OPENED the proposal (note #239). The
second is the one worth saying out loud, because it was the useful one: a
question in this margin is nearly always a question for its author. What
replaced it is not a smaller notification but a different place to ask. A
person who needs an answer opens that agent's chat and says so, where the
request arrives with the rest of what they want and can be answered in a
conversation rather than in one woken turn.

What that costs is a reread, and the agent guides now ask for it in those
words: an agent coming back to a proposal of its own reads the whole margin,
because a question waiting there sent it nothing.

Comments **close with the files** (`pullRequestTakesComments` is
`pullRequestTakesAttachments`): a decided proposal is not a question any more,
and a remark for a merged change belongs in chat or on a note, where it will
be read. A rejection's reason stays the decision bar's field, not a comment —
it must reach the agent's next turn, and only the decision flow does that.

**Evidence arrives before the verdict.** A merged, rejected or withdrawn
proposal takes no more files (409): a picture added then hangs on a card
nobody will open again. `conflict` still takes them — that proposal is being
worked on and re-proposed.

**The Workspace is READ-only here**, and that is a decision rather than an
unfinished edge. A file on a proposal is the proposing agent's evidence, and
the person on that screen is the one being shown it; they answer with a tap,
not by adding to the ask. (A note is the opposite — a shared jotting — which
is why the Workspace attaches there.)

**A photo renders as the photo**, everything else as a row; SVG stays a row,
because a drawing of unknown dimensions crops badly. The card sits ABOVE the
diff summary, since it is the half of the argument a phone can actually read.
It is drawn by its own small renderer rather than the note card's: the two
differ in where the bytes come from, whether a file can be taken off, and
whether the card stands when empty. Knowledge will be the third store to want
this, and three cases is when the shape is worth extracting.

    agentbuilt pr attach <n> <file>      put one on
    agentbuilt pr fetch <n> <name>       bring one back to this machine
    agentbuilt pr detach <n> <name>      take one off
    agentbuilt pr show <n>               lists them (on stderr, like `note show`)

`pr detach` is the first DELETE under `/repos` on the agent surface, which
trips the guard in `git-repo-admin.test.ts` on purpose. What it removes is a
picture the agent itself attached to its own ask — not a repo, a branch, a
commit or a proposal — and re-attaching is one command. The assertion now
names what `/repos` may delete rather than forbidding the prefix.

### What is deliberately NOT in this slice

- **The initial Workspace notification does not carry the file.** It is
  recorded by `pr create`, and a proposal has to exist before anything can be
  attached to it, so the file lands after that notification. The proposal
  screen is one tap away and shows the attachment. Closing that gap wants
  `pr create --file <path>` — create, attach, THEN send — which is a change to
  the create flow rather than to attachments.
- **Knowledge pages.** The other half of #10/#18, and not the same job. A page
  is git-backed, sha-pinned and lands through an approval, so a file on one has
  to ride the proposal and land with it; and a page can already embed an image
  only as an `https://` URL or inline base64 (`safe-html.ts`), so the valuable
  version gives a page's own image a stable URL to point `<img src>` at and
  gets a megabyte of base64 out of the source every agent reads. That is a
  design decision about referencing, not a copy of this slice.

## A proposal is quiet until its agent says it is ready (2026-09-05)

Owner's note #293: *"If proposal is created, I want it to be silent, not shown
yet. It should be shown only by special command from agentbuilt cli … only
after everything is passed, nothing is left, nothing is in process."* The
worry behind it was concrete — the owner could see a proposal, and its Approve
button, while the agent that made it was visibly still working on it.

Until now `pr create` **was** the ask. The record, the chat card, the browser
notification and the queue row all landed in the same call, so the earliest
moment a proposal existed was also the moment it could be approved — and
agents create early: before the screenshot is attached, before a comment is
left, before the push that fixes what they just noticed.

Now there are two verbs, and the record carries which has happened:

| Verb | What it does | What the owner sees |
|---|---|---|
| `agentbuilt pr create` | Records the proposal with `draft: true` | Nothing. No card, no notification, no queue row; the decision route answers 409. |
| `agentbuilt pr ready [<n>]` | Re-pins the branch, reads the checks on the new head, clears `draft`, sets `readyAt`, then sends the ask exactly as `pr create` used to | The card, the notification, the queue row — the proposal as it always arrived. |

`pullRequestAwaitsDecision(doc)` (`types/git-pr.ts`) is the one rule every
decision surface asks — Home's queue and the agent row's *waiting on you*
line, `POST /api/prs/:id/decision`, and the card-tap flow
in `agent-service.ts` — so a quiet proposal cannot be approved from any of
them. Its own screen still opens (from the agent's history, or a saved link)
and says *Still being prepared* with no bar. Proposals recorded before this
existed carry no `draft` and behave exactly as they did.

**`pr ready` refuses** a proposal whose head has checks `pending` or
`failure`, in the words of what to do about it (`repo checks --wait`, or fix
and push). It re-pins first, so the verdict it reads is for the commits the
card will describe. A repo without CI, or a sha CI has not registered yet, has
no verdict and is not held — the card then says nothing about checks, which is
what it always did. It is idempotent: a second run on a proposal already with
the owner sends nothing again, because a CLI timeout after a successful ask
must not fire a second card.

**Without a number**, `pr ready` finds the quiet proposal from the branch the
clone is on, which is what lets the whole loop be one chain:
`git push … && agentbuilt repo checks --wait && agentbuilt pr create … &&
agentbuilt pr ready`. `pr list` prints a quiet proposal's state as `quiet`
with the command that shows it; `pr show` says so on stderr. `pr edit`,
`pr attach` and `pr comment` all work on a quiet proposal — preparing it is the
point.

The identity block on every agent machine teaches the new loop (v98), and the
same bump reinstalls the CLI, since `pr ready` is new in CLI 1.19.0 and an
agent told to run it on the old binary would have nowhere to go.

Knowledge proposals follow the same rule since the owner asked for it the
same day: `knowledge propose` is quiet and `agentbuilt knowledge proposals
ready <n>` is the invitation — see docs/agent-knowledge-pages.md.

## Auto-merge (note #944, 2026-11-01)

Adam: *"auto-approve mode. If it's on, all proposals should be automatically
approved."* Then, the same day: *"I envision auto merge mode on/off individual
for each user in workplace modal window. And if it's on, in chief of staff
chat screen in header it should be displayed text that auto merge is on as
yellow colored text"* and *"Each user should enable disable for itself."*

**Each person's own.** One switch per member of a workplace, kept on the
membership (`OrgMembershipDocument.autoApprove`: on, when, and a `history` of
the last 50 flips), in the **Workplace window** under Repositories, worded with
what it does: *Every code proposal your agents make ready is merged without
asking you. Checks must still pass.* Any member flips their own
(`PUT api/org/auto-approve` names no user, so a teammate's cannot be reached),
turning it on asks once more, and the flip is on their own last-action line.
It covers only proposals from that person's own agents: `pr ready` reads the
switch of the proposal's OWNER, so one member's switch never merges a
teammate's work. The agents' router has no verb that writes it — an agent only
meets it in `pr ready`'s answer. Off is the default and today's behaviour.

**The header.** The state read carries the reader's own switch
(`org.autoMerge`), so the window's switch and the Chief of Staff header draw
from the read Home already makes. While it is on, the header says
*Auto-merge on* in yellow (`--star`) beside the model line.

**What it does.** `pr ready` makes the proposal ready as always, then, with
the owner's switch on, decides it instead of asking (`AgentService.autoApprovePullRequest`):

- **Checks still gate.** Red and running are refused by `pr ready` itself, as
  before. Green merges. Superseded never does. No verdict at all merges only
  where the repo's CI is off — what an owner's Approve does there — and on a
  repo with CI on it waits for its owner instead (`autoApproveChecksBlocker`).
  A repo with `requireChecks` meets the same `requiredChecksBlocker` an
  owner's Approve meets.
- **Same merge path.** The same host merge, anchored to the sha `pr ready`
  pinned, the same landing stamp, the same follow-up: the proposing agent
  (and a card sender) is woken with the outcome, the note's state advances
  with the merge, and deploys run as on any merge to main.
- **Recorded as automatic.** `autoApproved` (when, and the mode's who and
  when) and no `decidedBy`: no surface may name a person who did not read it.
  The proposal screen's pill says *Merged automatically* and its line
  *Approved automatically (auto-merge on, turned on by Adam at
  1 Nov 2026, 15:02 UTC). No person read it before it merged.*; the Chief of
  Staff's card and every history row say *Merged automatically*; the merge
  commit says *approved automatically*; the agent's outcome is *PR #N … was
  APPROVED AUTOMATICALLY …*, drawn in its chat as a *Merged automatically*
  card, and no *awaits your decision* ask is written.
- **Nothing silently stuck.** A merge that conflicts, finds the branch moved,
  finds it gone or throws leaves the proposal OPEN — not the terminal
  `conflict` a person's Approve writes, since nobody has seen it yet — with
  `autoApproveFallback.reason`, and `pr ready` sends the ordinary ask. Its
  screen says *Auto-merge is on, but this was not merged automatically:
  <reason>. It waits for your decision.*, and the agent's answer and the
  Chief of Staff's card say the same.

Only code proposals: knowledge changes have been live at once since note
#746, and the human-only asks (deleting a site, repository or agent, sending
mail) are untouched. A proposal already waiting when the switch is turned on
is not swept up; the mode decides at `pr ready`.

Proof: `git-prs.test.ts` (on → merged and automatic; red or missing checks →
waits; off → unchanged; merge failure → falls back), `workspace-router.test.ts`
(each member's own switch, its record and the state read), the screen
tests (`AutoMerge.test.tsx`: the window's switch and the header line), and in Chrome
`scripts/verify-workspace-auto-approve.mts`.
