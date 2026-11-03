# How a documentation chapter is written

The owner's review of the first version (2026-09-24): no UI shown, robotic,
too verbose. These rules are what fixed it. A chapter that breaks them reads
like a manual for the agent, not a guide for the person.

## Show the screen, do not narrate it

- If a sentence quotes two or more `<Ui>` labels, it is a screenshot wearing
  words. Replace it with a live panel and one caption sentence in `says`.
- Every section that has a screen gets a `panel`.
- Quote a label only when the reader has to find it or press it. Never list
  every field and button of a form.
- The panel goes AFTER the paragraph that tells the reader what to do there.

## Write for the person, not the agent

- Delete every sentence that explains the agent's rules to the reader: "the
  agent is told", "the platform refuses", "a quiet turn", "wakes nobody",
  "a stranger talking", "look at the thing itself". Say what the reader sees
  or does instead: "You get a card only when the checks are green."
- Lead with a task. The first two or three sections of a chapter are
  "How to …" headings ("How to give an agent a key"); "What an X is" is a
  short paragraph under the lead, not a section.
- Say why the reader would want the thing in one sentence before saying how.

## Sentences

- About 25 words at most. One idea each. Start a new sentence instead of a
  semicolon; one semicolon per paragraph is the ceiling.
- No colon-list longer than three items in running prose. Four or more items
  is a `<ul>`.
- "X, not Y" and "X, never Y" are allowed once per chapter. "On purpose",
  "by design", "exactly as", "honestly", "plainly": not at all.
- Prefer "you" and the agent's name to "the reader", "the person", "one".
- No em-dashes in a sentence as a joiner; use a full stop or a comma.

## The reference

- Only numbers, limits, names and where-to-find-it. If a row restates a
  paragraph above, cut the row. `notes-knowledge-drive` and `secrets` are the
  model.
- Four rows or more (the test asks for at least four).

## What stays true

- The claims the site never makes (knowledge page `claims-we-never-make`):
  no price, no Telegram, agents are not "coworkers", sleep is "about three
  quiet minutes", the storage split lives in /privacy only. The Docs test
  checks these.
- The FAQ answers in `lib/product-copy.ts` are the one copy of each answer;
  link to the question rather than restating it.
- A fact stays where it belongs. One chapter owns each fact; another chapter
  links to it with `DocLink` rather than repeating it.
- No chapter lists a screen's rows. The "Every screen" reference chapter was
  removed on 2026-09-24 (the owner: verbose and not necessary); a screen is
  shown in the chapter that explains it, or not at all.

## Panels available (`src/components/Live*.tsx`)

Before Home and the first run (`LiveSetup.tsx`): `LiveSignUp`, `LiveSignIn`,
`LiveFirstGreeting` (Home's empty state: the one line that says what the
Chief of Staff is, note #967), `LiveFirstSignIn` (the sign-in ask with the two-row card),
`LiveFirstPlan` (the plan and the progress card while the team is built),
`LiveClaudeSignIn` (Claude's own sign-in page). There is no setup gate
since note #726 and no cloud step since note #664.
Settings (`LiveSettings.tsx`, default): the whole Settings screen.
Forms (`LiveForms.tsx`): `LiveMailCompose`, `LiveAddSecret`, `LiveJobs`
(an agent's background jobs), `LiveNewAgent` (the chooser).
The landing's: `LiveFleet` (the Agents list; takes `fleet`, `size`, `says`),
`LiveAgent` (an agent's own screen; `size="tile"` adds the software card),
`LiveChat` and `LivePeerChat` (a conversation; two agents talking),
`LivePhone`, `LiveNotes`, `LiveNote`, `LiveDecisions` (Waiting for your
decision), `LiveProposal`, `LiveRepo` (a repository's overview),
`LiveRepoFiles`, `LiveKnowledgePage`, `LiveMail` (the inbox), `LiveChief` (Home, the Chief of Staff's conversation),
`LiveCloud` (the hosted workplace's Cloud card), `LiveSubscriptions` (default of `LiveSeats.tsx`), and from
`LiveSurfaces.tsx`: `LiveRepositories`, `LiveSites`, `LiveKnowledge`,
`LiveSecrets`.

Wrap one in the chapter's `Panel` with a `says` sentence; `size="compact"`
for chat-sized panels, the default `wide` otherwise.
