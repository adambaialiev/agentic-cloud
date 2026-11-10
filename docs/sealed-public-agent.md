# The sealed public guide (note #1010)

The home page has a section where anyone, signed out, can ask an agent about
the product. That agent is a **sealed** agent: a visible Claude Code agent in
its owner's roster that reads the public code and nothing else of the
workplace. This page is the backend's half: the agent kind, its machine, the
public route, and the transcripts.

## The seal is enforced in code, not in a prompt

A stranger's words reach this agent, so the seal does not depend on the
model doing what its instructions ask. It holds through three locks:

1. **Nothing to take.** A sealed agent is never given a platform token: the
   identity write, the one place a machine token is minted, returns before it
   for a sealed record. It is never given a workplace secret, in any turn, by
   any path (`claude-harness.ts` skips the secret projection). It gets no
   preview address. The one credential that reaches its machine is the seat
   token a turn needs to think, and that token rides the environment of the
   `sudo` call only. A visit turn gets it from a 0600 file in the agent's
   own home, which is read and removed, so it is never a command argument.
2. **A separate user.** Every turn runs as `guide`, a system user in no group
   of the agent's, with no sudo and no login shell. The agent's home is 0750
   and closed to it, and `/proc` is remounted with `hidepid`, so it sees only
   its own processes. Its working folder, `/srv/guide/agentic-cloud`, is an
   anonymous clone of the repository named `agentic-cloud` in the guide's
   workplace, made only while that repository is **public**. The docs site is
   built from `src/docs` in the same tree, so the code and the docs are one
   folder.
3. **Read-only tools.** The runner (`/usr/local/lib/acc-guide/turn`, installed
   by the setup) accepts a short allow-list of flags and refuses the rest. It
   always adds `--tools Read,Grep,Glob`, `--permission-mode dontAsk`, no
   settings, no MCP, and the guide's system prompt. Claude Code then refuses
   every path outside the folder, and every device or process file.

`backend/scripts/probe-sealed-guide.mts` measures all of it against the real
binary, using a stub model provider and no credential. On 5 Nov 2026 every
escape attempt was refused: `/proc/self/environ`, the agent's `CLAUDE.md`
and token file, `../`, Bash, grep and glob outside the folder, the web,
writing. Both control reads inside the folder worked. The guide's
environment held only the credential and fixed settings. The tests in
`sealed-public-guide.test.ts` hold the code to it on every push.

## The kind

- `AgentRecord.sealed = 'public-guide'`, set only at creation and never
  changed: a machine that once held a token cannot be made clean by a flag.
- Created by the Workspace Agent with `agentbuilt agent create --public-guide`.
  It is Claude Code on sonnet at medium. The harness runs it on that pair
  whatever a record says, and the picker refuses to change it.
- Its machine is `shared-2x` (two shared cores, 4 GB), whatever the workplace
  builds its other agents on.
- The setup (`buildGuideSetupScript`) runs as root before every sealed turn.
  It is idempotent, and it repairs the machine after an image roll, which
  rebuilds the root filesystem. The public copy is fetched again when it is
  more than 15 minutes old. A failed fetch keeps the last copy.
- The owner's own chat with the guide runs sealed too: the agent is the same
  thing whoever asks.

## How it answers: product terms (note #1133)

A visitor hears what the product is and does, in plain words. The agent reads
the public code and docs to ground every answer, but does not quote their
internals back: no file paths, folder names, function or variable names, flag
or setting names, endpoints or internal doc names, and no remarks that a doc is
stale (the current code wins, stated plainly). It describes the product as it
is today. The exception is a question about the code itself, or code work the
visitor asked for: then it names the files it read or changed, never a test
file as evidence. The rule, with the "is it MCP?" example, is in `public-guide-instructions.ts`.

## The public route

The Workspace router serves these paths under `/workspace`, so the page calls
`/workspace/api/public/ask`.

- `POST /workspace/api/public/ask` with `{ visitId, question }`. It answers
  `202 { state: 'accepted', questionId, position }`. Otherwise it answers
  `200` with `limited` (and `until`), `resting` (and `until`, or null) or
  `busy`, or `400 invalid`. The Origin must be the site's own.
- `GET /workspace/api/public/ask/:questionId` returns `{ state, position,
  files[], answer, until?, elapsedSeconds }`. The page polls it every 1.5 s.
  `state` is one of `queued`, `waking`, `reading`, `answered`, `declined`,
  `failed` or `resting`. `files` are paths relative to the repository. On
  `declined`, `answer` is the declined sentence.
- The visit id is random, made by the page and kept in sessionStorage: 8 to
  64 characters from `[A-Za-z0-9_-]`. Each visit is its own Claude session.
  The first question starts it with `--session-id`; later ones `--resume`
  it. A visit asks one thing at a time.
- The limits (`PUBLIC_GUIDE_LIMITS` in `shared/public-guide.ts`):
  - 500 characters per question;
  - 10 an hour per visitor, keyed by address and by visit, in memory only;
  - 30 an hour and 200 a UTC day for everyone together;
  - one answer at a time, with at most 5 waiting;
  - 15 tool rounds and 120 s per answer.

  A failed question is not counted.
- It rests (`seatTooFullForPublic`) when the guide's seat has used 80% of its
  5-hour window or 90% of its week, or is benched. It rests until that
  window resets. It also rests when a turn hits the plan's limit, or when
  there is no guide.
- On the way out, any answer shaped like a credential, a machine path, a
  private address, or an email outside the product's own domain is replaced
  with the declined sentence. The transcript is flagged for the owner.

## Transcripts

One row per visit in `public_guide_visits` holds every question with its
answer, files, state, seconds and Claude's cost line. Nothing about the
visitor is stored beyond what they typed: no address, no user agent, no
cookie. Rows are deleted after 90 days. The guide's owner reads them in the
**Visits** card on the guide's screen in the Workspace
(`GET api/agents/:id/visits` and `…/visits/:visitId`).
