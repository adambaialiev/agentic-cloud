# Knowledge pages

Decided 2026-08-15. The sibling of the repository system: repos hold code an
agent runs, knowledge holds **pages a user reads**. One knowledge page is one
HTML file. Until note #746 (12 Oct 2026) every change to one was proposed by
an agent and approved by the owner; since then a change is live the moment the
agent makes it, and the owner is told (see "The gate — removed" below).

The two systems are deliberately not one. A repo is a tree an agent clones,
branches and merges; a knowledge page is a single document with a name. Giving
a one-file document branch-and-merge ceremony would be paying a repo's price
for none of a repo's problems.

## The two readers, and what each one gets

This is the shape everything else follows from.

- **The owner, in the Workspace.** A list of pages, tap one, read it *rendered*
  — never raw HTML, never a source diff. That is the whole reason the format is
  HTML rather than markdown or JSON: the artifact is a page somebody reads.
- **The agent, from the CLI.** `knowledge list` for names and one-line
  descriptions, `knowledge show <name>` for the page's **exact source**.

The agent reads raw HTML on purpose (decided against a tag-stripped "clean
text" mode, 2026-08-15). Stripping tags loses tables, links and structure, and
an agent about to edit a page needs the source anyway — two representations of
one page mostly buys you the chance to edit the wrong one.

That choice is what makes the content rule below load-bearing: source an agent
reads on every lookup has to stay mostly *content*.

## What a page may contain

**Semantic HTML. No author CSS, no JavaScript.** The Workspace styles the page
with its own typography, in the reader's colour scheme, at the reader's width.
Inline SVG is allowed, so a page can still carry a diagram or a chart.

The allowlist itself lives in `backend/src/types/safe-html.ts` and is **shared
with quick notes** (docs/agent-quick-notes.md), which are written in the same
HTML and rendered by the same renderer. Only the wording of a refusal is
per-format — an error that names the wrong thing teaches the wrong lesson.

Two reasons, both practical:

1. A page carrying its own colours and fonts clashes with the app around it and
   reads as broken the moment the reader is in dark mode. Forty pages that look
   like one product beat one page that looks special.
2. Source that is mostly `<style>` is source every agent pays for on every read.

Rendering is sandboxed regardless — the rule above is about how pages *look*,
and defence against a page reaching the owner's session cannot rest on a
convention agents are asked to follow.

Every page carries a title and a one-line description (`<title>`,
`<meta name="description">`). The description is what `knowledge list` prints
and what the Workspace shows under the name; a page nobody can identify from a
list is a page nobody opens.

## The gate — removed (note #746, 12 Oct 2026)

Adam: *"I think there is no point in creating proposals for knowledge pages. I
think agent should be able to mutate knowledge without human in the loop."*
Seven knowledge decisions had sat in his list that morning beside the code
changes that actually needed him.

- **A change is live the moment the agent makes it.** `knowledge propose`
  (same verb, same flags) records the change and lands it in one call
  (`KnowledgeService.apply`); `knowledge proposals ready` is left only to apply
  a proposal recorded before this. There is no card and no queue row.
- **The owner is told, not asked** — a `platform` line in the agent's chat
  (`tellOwnerKnowledgeChanged`): what changed, who, why, and that a Put back
  button exists. Same shape as the CI-secrets line of note #739.
- **Every change is restorable in one step.** The landing records each touched
  page's words *before* the change (`KnowledgePageChange.previousHtml`), so the
  proposal table is the page's history: who, when, why, previous text.
  `knowledge history <name>` lists it; `knowledge restore <name>` undoes the
  last change, `--to <n>` restores exactly what change #n landed
  (`KnowledgeService.restore`). The Workspace page screen shows the same
  History with a **Put back** button (`POST /api/knowledge/pages/:name/restore`,
  signed with the person's sentinel). A restore is itself a landed change, so
  nothing in history is ever rewritten and a restore can be put back too.
- **Open proposals at the switch** were settled once at boot
  (`knowledge-direct-backfill.ts`): ready ones applied, quiet ones withdrawn,
  moved ones marked conflict — each with a signed platform remark saying so.
- **The rules an approval used to enforce are now the agent's to keep**: no
  secrets, one page per topic, change rather than duplicate. The HTML
  allowlist, the page cap and the moved-page refusal still hold at the door.

Everything below this line describes the gate as it was, kept because the
records, routes and screens it produced still exist as history.

### The gate as it was (2026-08-15 to 2026-10-12)

Identical in shape to repository proposals, different in what it displays.

- **Create, edit and delete are all proposed** (decided 2026-08-15, including
  create). A knowledge base whose pages an agent can silently add to or rewrite
  is not one anybody should trust for facts.
- **One proposal may touch several pages**, the way one PR touches several
  files. It lands whole or not at all.
- **The card shows the page rendered** — a preview for a new page, before/after
  for an edit, the page being removed for a delete. The source is reachable
  underneath for whoever wants it and is never the default view. A source diff
  is the correct review surface for code and the wrong one for a document.
- **The approval carries the version it was shown**, exactly as a PR pins
  `headSha`: if the agent revises the page after the card was sent, the
  decision refreshes and re-asks rather than landing text nobody read.
- **A rejection carries a reason**, relayed to the proposing agent, because "no"
  alone makes it retry blindly.
- **There is no `approve` verb.** Nothing on the agent-facing surface can
  approve, and that absence is the feature.

## History — git underneath, hidden

Each user's knowledge base is a bare repo on the same host as their code repos,
and every approved proposal is a commit. The agent never clones it, never
branches, never sees a sha; the CLI ships file contents and the host keeps the
history. What that inheritance buys, on day one and without new code:

- **Versions.** `knowledge history <name>` — who changed it, when, what the
  proposal said, in the same rendered form.
- **Revert.** `knowledge revert <name> --to <version>` is not a special path: it
  is an ordinary proposal whose content happens to be an old version, so going
  back is approved exactly like going forward.
- **Conflict detection.** A proposal names the version it started from. If the
  page moved underneath it — another agent's proposal landed first — the
  proposal is refused with the current version, rather than quietly clobbering.
- **Backups, quota and restore**, already solved for repos, already scheduled on
  that host, already true here.

Whether the knowledge base is one repo per user or one repo per page is an
implementation detail behind the CLI; one repo per user is the default, because
a proposal touching several pages should be one commit.

## The CLI

```
agentbuilt knowledge list                        names + one-line descriptions
agentbuilt knowledge show <name>                 the page's exact HTML source
agentbuilt knowledge propose <name> --file <f> [--note "why"]
                                                 create OR edit — same verb
agentbuilt knowledge propose-rename <old> <new>   move a page's NAME, keeping
                                                 its words, files and margin
agentbuilt knowledge propose-delete <name>
agentbuilt knowledge history <name>
agentbuilt knowledge revert <name> --to <version>
agentbuilt knowledge proposals [list|show <n>|close <n>]
```

`close` withdraws the agent's own proposal. There is no `approve`, by design —
see `pr`, which is missing the same verb for the same reason.

A **rename** is its own action rather than a delete beside a create, because a
delete takes the page's margin with it (`knowledge-page-comments.ts`: "a thread
dies with its page"). Names go stale — the owner asked in September 2026 why a
page was still called `workspace-react-migration` when the migration had long
finished, and five of the twenty-six pages on that shelf were named after a Telegram
Mini App the product no longer had. Nobody had fixed one, because the only way
was to destroy the conversation under it. So `rename` moves the blob, carries
the index entry (and therefore the page's files) across, and moves the thread;
its bytes ride the proposal like an edit's, so the owner still approves the page
that will exist, and it refuses a destination that is already taken — both when
proposed and again at landing, since somebody may have claimed it in between.

## Slice 1 — the engine (merged 2026-08-15)

Storage, the content rules, the proposal queue and the routes behind them.
Nothing agent-facing and nothing on screen: the Workspace half is slice 2, and
the `CLAUDE.md` teaching is slice 3, because telling agents about a capability
whose review surface does not exist yet produces proposals nobody can look at.

**The CLI verbs moved to slice 2 for exactly that reason**, and the discovery
came from a guard test. The `agentbuilt` CLI reaches a machine that already has
one ONLY through the forced reinstall inside an identity write, which fires when
`TELEGRAM_AGENT_IDENTITY_VERSION` moves — so the version pins the CLI's hash,
and editing the CLI fails the suite until the version is bumped. Bumping it here
would push a `knowledge` section into every agent's `--help` while the owner had
nowhere to read a proposal, and the CLI would have told them it was "waiting in
their Workspace" when it was not. The verbs ship with the screens they describe.

- **The base is `_knowledge.git` in the user's own namespace**, and the leading
  underscore is the entire fence: the host's `SEGMENT` pattern requires a
  leading alphanumeric, so `parseRepoUrl` refuses that path and no git request
  can reach it. An agent cannot clone it, cannot push to it, and therefore
  cannot walk around the gate by treating it as an ordinary repo. Its name
  never crosses the wire either — callers send a userId and the host decides
  what the base is called. `git-host.test.ts` asserts the clone fails.
- **Three control endpoints** — `list`, `read`, `commit` — are the only way in
  or out. `commit` builds the tree through a temp index and `--index-info`
  (not `--add`/`--force-remove`, which need a work tree a bare repo has not)
  and swaps the ref with a compare-and-swap, so two approvals racing cannot
  lose one another's work.
- **The proposed HTML lives in the proposal record**, not on a branch. An
  unapproved page is therefore nowhere a reader can reach, and a one-file
  document gets no branch it has no use for.
- **`index.json`** is written beside the pages on every landing, so
  `knowledge list` is one blob read rather than one read per page. It is
  derived, never authoritative: a page missing from it is read directly, and
  the next landing writes a clean one.
- **`validateKnowledgeHtml` refuses rather than strips.** A silent sanitiser
  lands a page subtly unlike the one the agent wrote and teaches it nothing;
  an error names the tag and the rule. It is not the security boundary —
  slice 2 renders sandboxed regardless, because a defence resting on agents
  following a convention is not one.
- **`KnowledgeService.land` exists with no production caller yet.** It is what
  slice 2's approve button calls, and it carries the conflict rule (a page that
  moved under a proposal is refused, not clobbered), which is the part worth
  having tests around before there is a button to press.

## Slice 2 — the screens, and the agent's verbs (merged 2026-08-15)

The half that makes slice 1 mean anything: the owner can now read a page and
decide on a change, and agents can list, read and propose.

- **The page is rebuilt, not embedded.** `renderKnowledgeHtml` parses the
  source and copies across an allowlist of elements and attributes, building
  every node itself — the workspace never hands agent-authored HTML to
  `innerHTML`, and never puts it in an iframe either. An iframe would have been
  the obvious sandbox and is the wrong one here: without scripts it cannot
  report its own height, so it would need a fixed box with an inner scroller,
  and this app keeps exactly one vertical scroller (the page). Rebuilding the
  nodes gets the isolation AND the app's own typography, which is the point of
  refusing pages their own CSS in the first place. `on*` and `style` are
  refused by name before the allowlist is consulted; `href`/`src` are
  re-checked against the same scheme rule the backend uses; SVG is created in
  its own namespace or it would draw nothing.
- **Belt and braces on purpose.** The backend already refuses a page with
  script in it at propose time — that refusal is what teaches the agent — and
  the renderer is what makes a hole in it harmless. A headless run drives a
  proposal whose edit carries `<script>`, an `onclick` and a `style`, and
  asserts all three are absent from the DOM and that the script never ran.
- **A proposal IS the diff.** It first shipped as the page rendered, with what
  it says now folded underneath — before and after, both rendered, and finding
  the difference left to the reader. That is fine for a page that grew a
  section and exactly wrong for the change most worth catching: a rewritten
  table, a flipped condition, a number edited inside prose that scans as
  identical. So the change card leads with the raw diff, open, in the same card
  and colours a change proposal's diff wears — one kind of diff on this app,
  not two.
- **The rendering is one tap under it**, because a knowledge page's whole point
  is that it renders: the diff says what moved, and only the rendering says
  whether the result reads well. "Read the page" lands on the same screen a
  published page is read on, showing the page as it WOULD be (for a removal,
  the page that would go), with Back one hop up to the change. Nothing is
  fetched — the proposal response already carries the source. Three words on
  every change, because the header above already says UPDATE / NEW KNOWLEDGE /
  REMOVING and names the page: a longer label wrapped to a second line to
  repeat what the reader had just read.
- **The page builds the patch itself** (`knowledgePatch`, feeding the existing
  `renderDiff`) from the two versions of the source that response carries, so
  it costs no round trip and the host computes nothing new.
- **A page that moved is said on the screen**, in front of the button, rather
  than discovered by tapping it: the approve button says so and refuses, which
  is the same answer `land` would give but without spending the tap.
- **The queue is one queue.** A knowledge proposal sits in "Waiting for your
  decision" beside a change proposal, because the header names the state and
  that state is identical. Rejection is one tap with no reason box, exactly as
  for a change proposal: the agent is a chat and the user is already in it.
- **The chat card is a POINTER.** It says what would change and carries one
  button that opens the proposal in the workspace. No Approve in chat: a page's
  whole point is that it renders, and chat cannot render one — approving there
  would be approving something unread.
- **Every line of the card earns its place** (reworked 2026-08-17, from a photo
  of the real thing). A one-page proposal used to say one fact three times —
  the title (`Update "How a change reaches production"`), the count
  (`1 page (1 updated)`), then a bullet repeating the title — while leaving out
  the two things the reader cannot infer. So the count and the list appear only
  ABOVE ONE PAGE, where they summarise instead of echoing, and their room goes
  to the page's own `description` (italic — it is the page's subtitle, not the
  card's voice) and the agent's `--note` (in a `<blockquote>`, so it cannot be
  mistaken for the page's own words). The count was already deleted from the
  Workspace row for this exact reason; the chat card had kept it.
  The note does not turn the card into the review: it says why the agent is
  ASKING, which no rendered page can answer, and the closing line still sends
  the reader to the workspace. Same rule now on the change-proposal card, whose
  single-commit bullet repeated its title for the same reason.
- **The OUTCOME comes back to the chat** (added 2026-08-17), where the card sits
  and where the user still is tomorrow — approved, rejected, and the conflicted
  landing that wrote nothing. This was missing for the feature's whole life: the
  decision woke the agent and told the user nothing, so a knowledge approval and
  a change approval behaved differently for no reason the user could see. The
  conflict case is the one that mattered most: they tap Approve, nothing lands,
  and silence reads exactly like success. The guard answers (already decided,
  not this account) stay toast-only, as they are on the change-proposal path —
  they are answers to the screen that asked, not events worth a message.
  An approval receipt carries a **"Read it"** button (`?k=<page>`, which opens
  the LIVE page rather than the decided proposal — by then the proposal is
  history and the page is the thing). Only for a single change, and never for a
  delete: with several pages there is no one page to open, and a removed page
  has nothing to read, so the receipt stands on its own words instead of
  offering a button to a screen that would apologise.
- **The CLI ships here**, with the screens it describes (see slice 1 for why it
  could not ship earlier), which means `TELEGRAM_AGENT_IDENTITY_VERSION` moves
  and every existing machine gets the new binary.

## Slice 3 — the agents learn it (this PR)

The last slice, and the one the order was built around: agents are told the
system exists only now that there is a screen to read a proposal on.

It goes in the per-agent identity prose (`## What your user knows`), which is
rewritten on every identity version bump — so it reaches machines that ALREADY
exist, not just new ones. The bump also re-pins three hashes in
`agent-service.test.ts`; that guard is deliberate and is what stops a
docs edit shipping to nobody.

What it actually teaches, in the order an agent needs it:

- **Check before you guess.** The failure this feature exists to fix is an
  agent reasoning from scratch about something the account wrote down last
  week. `knowledge list` costs one command.
- **Write one when you learn something DURABLE** — a runbook, a decision and
  its reason, a gotcha — and not a diary of the turn. One page per topic, and
  change the existing page rather than adding a second, because two pages on
  one subject is how a knowledge base starts lying.
- **Proposing is the only way in**, there is no approve verb, and do not wait
  for the tap.
- **The content rule, with its reason**: semantic HTML, a title and a one-line
  description, no CSS or JavaScript because the Workspace styles every page.
- **Not your notebook.** `~/SCRATCHPAD.md` is the agent's own; a page is the
  account's.

## Comments: the margin (2026-08-27)

Owner's note #66. Both knowledge surfaces carry the shared margin
(`types/comment.ts`, grown on quick notes):

- **On a proposal** — remarks while it is being decided, closing with the
  decision, exactly as a change proposal's margin works. Stored on the
  proposal document; `agentbuilt knowledge proposals comment <n>` for agents,
  the composer on the review screen for the person.
- **On a PAGE** — the interesting one: a signed, dated remark BESIDE a
  document only a proposal may change. "Stale since the deploy moved", a
  question, a "checked, still true" — the reader who would have trusted the
  page sees the caveat in the same glance, and nobody paid a proposal for it.
  Threads live in their own store (`knowledge_page_comments`), NOT in the
  base's git history: a remark is not part of the reviewed document, and a
  comment that cost a commit would write conversation into a history that is
  meant to be the pages. A thread dies when its page's deletion lands
  (`decideKnowledgeProposal` drops it), so a recreated name starts clean.
- **A comment starts nobody** (note #518). There is no picker and no recipient
  list: the body is `{ text }`, an `@Name` in it is prose, and a `mentions`
  array from an older client is ignored. On a knowledge PROPOSAL its own author
  is left alone too — the `@Name` start (note #179) and the author start (note
  #239) went together. Handing work to an agent is a message to that agent, in
  its own chat, which is also the only way to hand it any context.
- So a margin is READ, never delivered. Both surfaces' detail GETs carry the
  whole thread, and the agent guides tell an agent to reread its own open
  proposals rather than wait to be started by one.
- The margin is not the page: what the thread AGREES on belongs in the page,
  through a proposal, and the teaching prose says so.

## Scope and limits

- **Per user, shared by every agent that user owns** — like repos, like secrets.
  Anything one agent proposes and the owner approves, every other agent reads.
- **One flat namespace of named pages.** No folders until there is a user with
  enough pages to need them.
- **~1 MB a page**, counted against the same per-user storage budget as repos.

## Deliberately not in v1

- **Public share links.** The obvious next thing an owner does with a good page
  is forward it, and a per-page public URL is the natural answer — but it is a
  second surface with its own privacy question, and it is not what makes the
  system useful on day one.
- **Owner authoring in the Workspace.** They approve, reject with a reason and
  delete; writing stays agent-side. Letting both sides write means answering the
  collision, and that answer is better designed against a real complaint than
  guessed at now.
- **Image uploads.** Pages reference external URLs or inline SVG; no upload
  pipeline yet.

## Discovery

An agent learns this system exists from its **`CLAUDE.md`**, in the section
`buildTelegramAgentPlatformDocs` and the identity prose already use to teach
repos, secrets and hosting. That file is regenerated on every identity version
bump, which is the whole reason it is the right place: the teaching reaches
machines that ALREADY EXIST, where shipping it in the image skeleton would
reach new machines only (machine-skel-docs.test.ts states this rule outright).

What goes there is the system and the command. **The list of pages does not.**
`CLAUDE.md` is rewritten on version bumps, not on every approved proposal, so a
baked-in index would drift and start naming pages that are gone — a stale list
is worse than no list, because an agent believes it. The live answer stays
behind `knowledge list`.

**Rejected: injecting the index into every turn** (decided 2026-08-15). It reads
as the obvious fix for "an agent has to remember to look", and it is a tax paid
on every conversation, including the great majority that never touch knowledge.
The agent is told where the knowledge is and asks for it when the task calls for
it. If it turns out in practice that agents do not reach for the command, that
is a prose problem in `CLAUDE.md` first, and only then a machinery problem.

## Pictures on a page (2026-08-18)

The other half of Owner's notes #10 and #18. `docs/agent-git-project-repos.md`
covers files on a change proposal; this is files on a knowledge PAGE, and it is
not the same feature wearing a different name.

**What it is for.** A page could always contain an `<img>`, but only pointing
at an absolute `https://` URL — something outside the account, which rots — or
at an inline base64 `data:` URI, which puts a megabyte of encoded bytes in the
middle of the source every agent reads and every proposal diffs. So in practice
pages had no pictures. Now a page's own diagram has somewhere to live and the
page points at it:

    <img src="files/plan.png" alt="the wiring plan">

`files/<name>` is the ONE relative form the renderer understands and it means
"a file on this page". No traversal, no folders, no query: `files/../x`,
`files/sub/x.png` and `files/x.png?v=2` all resolve to nothing and the `src` is
dropped rather than left as a path the browser would resolve against the
Workspace itself.

**Records in git, bytes in media storage.** The attachment records live in the
base's `index.json`, beside the title and description they belong with, so a
page and its pictures land in one commit and move together. The bytes go to
`users/<uid>/knowledge/<page>/<id>/<name>` — a git base is no place for photos.

**Staged BEFORE the proposal, and this is the load-bearing decision.**

    agentbuilt knowledge propose wiring --file page.html --attach plan.png

uploads the file first, then proposes the page that references it. The obvious
alternative — attach to an existing proposal — cannot work, because
`POST /knowledge/proposals` refuses a page whose HTML is byte-identical to what
is already there, and "put the floor plan on the page" is a real request about
a page whose words are already right. Staging first means the proposal is
written knowing its files, and a file-only change is a change the route
accepts. `--detach <name>` takes one off, through the same gate.

Staging writes bytes and nothing else: no page, no index entry, no proposal.
Until a landing puts the record in the index there is nothing that addresses
those bytes, which is why `post /knowledge/files` does not breach "the gate is
the absence" — it is asserted, with that reasoning, in
`knowledge-routes.test.ts`. The same footing as `note attach` and `pr attach`,
neither of which can change a page either.

**The proposal's preview shows the picture.** A knowledge proposal is read as
the page WOULD look, so the preview resolves the change's own staged files —
reading a page "as it will look" with its diagram missing is reading a
different page.

**A change that says nothing about files leaves them alone.** An edit to the
words carries the page's existing attachments forward untouched; only a change
that attaches or detaches rewrites the set. The set is carried WHOLE, like the
HTML, because a proposal is a picture of the page as it will be rather than a
patch of it.

**Landing reports what it orphaned.** A page removed whole, or a file taken
off, leaves bytes nothing points at. `KnowledgeService` holds no media storage
by design, so `land()` returns them and the approval surface clears them.

**The path is rebuilt server-side.** `--attach` sends back the id the staging
route issued; the propose route recomputes the storage path from the
authenticated user, the page and that id. A path from the caller would be a
path handed to us by the thing we are checking.

### Known edges

- **A staged file that is never proposed stays.** It is unreachable (nothing in
  the index names it), but the bytes sit there. No sweeper today.
- **A staged id is not verified to exist** before it goes into a proposal:
  media storage has no `exists`, and downloading 10 MB to check would cost more
  than it saves. A bad reference shows as a broken image in the preview — on
  the screen where the decision is made, which is the check that matters.

## A proposal is quiet until its agent says it is ready (2026-09-05)

The knowledge half of note #293 — asked for in the owner's own words the same
day the change-proposal half landed: *"Do the same with knowledge page
proposals."* The worry is the same: a card and an Approve button in front of
the owner while the agent is still working.

`agentbuilt knowledge propose` now records the proposal with `draft: true` and
sends **nothing** — no card, no browser notification, no queue row, and the
decision route and `decideKnowledgeProposal`
both refuse it. `agentbuilt knowledge proposals ready <n>` is the invitation:
it flips the record (`readyAt`), then sends the card and notification exactly
as `propose` used to. It is idempotent, so a retry never sends a second card.

There is no pin to refresh and no CI to read, so the one thing `ready` checks
is the one thing that would make the decision pointless: a page that moved
underneath the proposal since it was written is refused up front, with the
advice to propose again from the page's current words and withdraw this one.

`knowledgeProposalAwaitsDecision(doc)` (`types/knowledge.ts`) is the rule every
decision surface asks. A quiet proposal's own screen still opens — from the
agent's history — and says *still being prepared* with no bar. `knowledge
proposals` lists it as `quiet` with the command that shows it; `show` says so
on stderr. Comments work on it; preparing it is the point. Proposals recorded
before this existed carry no flag and behave exactly as they did.

The identity block (v99) teaches the loop and the bump reinstalls the CLI
(1.20.0), which carries the new verb.
