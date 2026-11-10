# Guests' own agents (notes #1038, #1055)

A visitor of the home page, signed out, makes a Claude Code agent of their
own: a name and a face, a dedicated 2-core machine nobody else uses, Sonnet
at high effort, and a copy of the public agentic-cloud repository. They chat
with it, can stop a turn, and can delete it. Its machine sleeps after a few
quiet minutes like every agent's. After 30 quiet minutes, 3 hours, or 40
messages, the agent is deleted with its machine, volume and app. The owner
keeps the transcript for 90 days. The design and its screens are note #1036.
Adam's decisions are note #1038. Since note #1055 (Adam, 7 Nov 2026) there
are no slots, no waiting line and no spares: every visitor's Start guest agent
builds that visitor's machine and agent from nothing, and the visitor
watches the real steps.

This is the backend's half. The home page section is built to the contract
in `backend/src/shared/guest-agent.ts`.

## The seal, with a shell

A guest's agent has every Claude Code tool, a shell included, so the seal
of the home page's guide (`docs/sealed-public-agent.md`) cannot rest on
read-only tools any more. It rests on three locks, none of them a prompt:

1. **Nothing to take.** No platform token, no workplace secret and no
   preview address, as for every sealed agent. Unlike the guide, the
   **Claude seat token never reaches the machine**. Claude Code on the
   machine is pointed (`ANTHROPIC_BASE_URL`) at the platform's model door
   (`services/guest-model-door.ts`, mounted at `/api/guest-model`) and
   given a **per-turn key** as its OAuth token. The door swaps that key for
   the seat token on the backend. A key works only while its turn runs
   (closed at the end, on Stop and on deletion), only for Sonnet and Haiku,
   only on the messages routes, and only up to 150 requests a turn. A shell
   that prints its environment prints a key that dies with the turn.
2. **A separate user.** Every turn runs as `guide`: no group of the agent's,
   no sudo, no login shell. The agent's home is 0750 and closed to it.
   `/proc` hides other users' processes, and every process the guide left
   running is killed when the turn ends.
3. **A closed network.** An nftables table (`inet acc_guest`) rejects every
   packet the guide's processes send, except to loopback (and not to
   loopback ssh or 8080). The only way out is a forward proxy on
   `127.0.0.1:3128`, run as `guidenet`, that connects only to an allow-list:
   the public repository's host, the model door's host, and `registry.npmjs.org`,
   `registry.yarnpkg.com`, `pypi.org` and `files.pythonhosted.org`. That
   rules out the web, DNS, Fly's private network (so no other agent's
   machine) and the metadata service. The runner also turns off Claude
   Code's WebFetch and WebSearch. The setup **fails closed**: no nftables,
   or a lock that did not load, means no turn.

The work lives on the volume (`/data/guest`): the copy, the guide's home and
Claude's session. A sleep, a restart or an image roll keeps the visitor's
conversation and changes. The copy is cloned once, anonymously, with no
remote left behind, and is never refreshed: it is the visitor's working copy.

`backend/scripts/probe-guest-agent.mts` proves it with the real Claude Code
binary against a stub model door, with no credential. It runs one turn that
issues 19 shell commands, then checks the environment, the door, the cleanup
and the key file. Measured on 6 Nov 2026 with Claude Code 2.1.316, all 24
checks passed:

- **Controls worked:** listing, writing and running code in its own copy,
  and reaching the npm registry through the proxy.
- **Blocked:** the agent's `CLAUDE.md` and token file, the per-turn key
  folder, `/proc/1/environ`, the proxy's process, sudo, the web (direct and
  through the proxy), an IP address, DNS, this machine's 6PN address, Fly's
  DNS, loopback ssh, and a push to the git host.
- **The environment:** the guide's process held only the expected names. Its
  Claude credential was the per-turn key, and the launching shell's fake
  seat token and fake secret never arrived.
- **The door** saw 20 requests, all with the per-turn key, all through the
  egress proxy, none with the seat token.
- **After the turn,** the process left running was gone, and so was the key
  file.

`src/test/unit/guest-agent.test.ts` holds the code to it on every push.

## Time, and packages (notes #1047, #1054)

- **A reply has no time limit** (note #1054; Adam, 7 Nov 2026). A turn ends when the agent answers, when the visitor taps Stop, or when the agent's own life ends (3 hours, or its 40 messages). The machine-side wall is what is left of that life, plus a minute, so the sweeper ends a life rather than the wall. `GUEST_AGENT_LIMITS.turnCeilingMs` is the one place an optional ceiling would go; it is `null`.
- **A running turn is activity.** The 30-quiet-minute rule never removes an agent mid-turn, and its quiet clock starts when the turn ends.
- **No command cap of our own.** Claude Code's defaults apply: 2 minutes unless the agent asks for more, 10 at most, and past that a command moves to the background where the agent can wait for it. The 100 s caps of note #1047 are gone, so a full install or a whole test suite may run. The probe proves it: a 200 s command completed, and the reply arrived.
- The instructions say there is no limit, and ask the agent to say what it is about to run, and roughly how long, before anything long.
- A reply that is ended without an answer (the agent's life ending mid-reply, or a ceiling if one is ever set) becomes an answer that says why and names the command it was in. A Stop gets the reply so far. Neither counts against the visitor's 40 messages, and neither reads "something went wrong", because nothing did.
- Known gap: a guest turn runs as one SSH exec from the backend, so a backend restart (a deploy) ends a turn in flight. The page then gives up after 4 minutes of silence. Long turns make this likelier than 3-minute ones did.
- **No packages are installed while building** (note #1055; there are no spares to do it ahead). The instructions tell the agent its packages are not installed and to run `npm ci --ignore-scripts --no-audit --no-fund` in the root and then in `backend/` before tests or a build, saying so first. Run as the guide through the egress proxy; no install script runs. better-sqlite3's own script would fetch Node headers from nodejs.org, which is outside the allow-list, and its bundled linux-x64 prebuild loads without them (note #1050: plain `npm ci` runs the backend's install script, which fails under the lock).

## The kind

- `AgentRecord.sealed = 'guest'`, written when the record is reserved and
  never changed. The harness refuses any turn for it: no owner chat, no
  `agent message`, no event turn. A guest's agent talks only to its visitor,
  through the public routes.
- Machine `performance-2x` (2 dedicated cores, 4 GB), whatever the workplace
  builds its other agents on (`GUEST_AGENT_MACHINE_SIZE`).
- Sonnet at high, fixed.
- Guests' agents are left out of the person's fleet, out of the live tick,
  and out of every agent's `agent list`. The person sees them in the
  **Guests** group at the foot of their agents list. Since note #1063 they
  are also out of the Chief of Staff's own roster (`workspace.ts`, the recap
  scope: guest Oscar showed there as "Adam's own, sonnet, 0 turns"), the
  welcome's list, teammates' strips, people's agent counts and faces, the
  workplace picker's count, mail-wake choices, the secrets "reaches" names,
  the recap's model choices, the Chief of Staff's event sweep, and
  `agent message` recipients. The Home briefing never borrows a sealed
  agent's machine (a visitor has a shell on a guest's).

## Background jobs (note #1063)

A guest's agent runs long work (the whole suite, coverage, a build) as a
managed background job, the way a regular agent does (knowledge page
a-finished-job-wakes-its-agent), without a platform token:

- **Its own `agentbuilt`.** The setup installs `/usr/local/lib/acc-guest/bin/agentbuilt`
  (root-owned, plain Node), first on the runner's PATH. It has the one verb
  `job` with the regular sub-verbs: `start [--cwd DIR] [--timeout DURATION] [--quiet] -- PROGRAM [ARG...]`,
  `list`, `status`, `logs [-n N]`, `wait [--timeout]`, `stop`. Anything else
  answers that nothing else of the platform is open (exit 64). Records and
  output stay on the volume, `/data/guest/jobs/<id>/` (meta, sid, output.log,
  result.json).
- **The jobs door.** `start` registers the job at `POST <model door>/jobs/start`
  (so the egress allow-list needs nothing new) with the running turn's
  per-turn key, which the door already checks for the model. No open key, no
  job: a job can be started only from inside a reply. The backend records it
  (id, redacted label, start, time limit up to the agent's remaining life,
  default 30 minutes), allows at most 4 running and 8 starts a reply, and
  writes the running ids to `/home/agent/.guest-turns/jobs-allowed`, a file
  the guide can neither read nor write.
- **The reaper spares jobs.** After every turn (and on Stop) every process of
  the guide is killed except the sessions of the jobs in that list that have
  not finished. The job's supervisor is the leader of its own session.
- **Awake, and activity.** Every 15 s the backend reads each running job's
  result on the machine (`buildGuestJobsReadCommand`). Reading goes through
  `host.sandbox`, which stamps the machine active, so the idle reaper leaves
  it running; the 30-quiet-minutes rule skips a guest with a running job,
  the status never says `asleep`, and `quietUntil` is null. A machine that
  does not answer for about a minute has its jobs settled as `interrupted`.
- **A finished job wakes the guest.** Succeeded, failed, timed out and
  interrupted start one quiet turn (several together are one turn) opening
  on a `[Platform]` receipt: id, state, exit code, duration, label and a
  bounded, redacted output tail. Its answer reaches the visitor as a new
  agent message (`fromJob: true`) with no visitor line before it, not
  counted against the 40. A job that finishes during a reply is told when
  that reply ends. A job the guest stopped itself, or a `--quiet` one,
  starts nothing.
- **The status** carries `jobs: [{ id, label, startedAt }]`, the running
  ones, oldest first, at most 4 (`[]` when none). Never argv, cwd or output,
  and reading it never wakes a machine. While the receipt turn runs, `turn`
  is `{ turnId, fromJob: true }`. The page's pill is Alex's (note #1064).
- **Instructions** (`guest-agent-instructions.ts`): anything likely to run
  past about two minutes is a job, announced as "I started this as a
  background job; I will tell you when it finishes", never Claude Code's own
  background. A short request naming code work (tests, coverage, lines, a
  build) is in scope; declining is for clearly unrelated asks.
- **An empty answer is not a refusal** (Oscar, 7 Nov: "measure test
  coverage" ran 3.5 minutes, then ended with no answer text, which read as
  the decline line). It now reads "I stopped without writing an answer…",
  not counted.

## How it answers: product terms (note #1133)

A visitor hears what the product is and does, in plain words. The agent reads
the public code and docs to ground every answer, but does not quote their
internals back: no file paths, folder names, function or variable names, flag
or setting names, endpoints or internal doc names, and no remarks that a doc is
stale (the current code wins, stated plainly). It describes the product as it
is today. The exception is a question about the code itself, or code work the
visitor asked for: then it names the files it read or changed, never a test
file as evidence. The rule, with the "is it MCP?" example, is in `guest-agent-instructions.ts`.

## The build, from nothing (note #1055)

Start guest agent reserves a sealed guest record (its name) and builds the rest
behind the answer. There is no ceiling on how many are alive at once, no
waiting line and no spare: the 40 a day, 3 per address a day and one live
per address are what bound the spend. Each step is a real event, written
with its start and finish times on the row and answered by the status route:

| Step | What happens | Ends when |
|------|--------------|-----------|
| `machine` | A Fly app, volume and 2-core machine are made and started (the owner's New agent path, `performance-2x`) | the record has its machine and sshd answers |
| `agent` | The seal: the `guide` and `guidenet` users, the nftables lock, the egress proxy, the runner and the instructions (the setup without the copy) | the setup exits 0 |
| `code` | An anonymous, shallow clone of the public repository onto the volume (the whole setup again, which now clones) | the setup exits 0 |
| `waking` | Claude Code is started once as the guide (`claude --version`, no model call) | it answers a version |
| `ready` | The fixed greeting is written; the status turns `ready` | at once |

A step that fails deletes what was built and the status answers `failed`
for an hour. A build stuck for 15 minutes is abandoned the same way. A
backend restart mid-build resumes it from the top (every part is
idempotent). The visitor may delete it mid-build; the build stops there.

**Measured.** Spares built from nothing on production on 6 and 7 Nov 2026,
the same path from reservation to ready, took 25 to 31 s (once 55 s), and
46 s when they also installed packages. The probe's machine-side steps from
nothing are in `scripts/probe-guest-agent.mts --fresh` (see the PR for the
numbers). `GUEST_BUILD_ESTIMATE_SECONDS` (35) is the page's estimate.

**The status while `creating`** (`GET /workspace/api/public/guest`):
`step` names the step running now; `steps` lists all five in order, each
`{ id, done, startedAt, doneAt }` (ISO times, null until they happen);
`createdAt` is the tap, so the build's whole clock runs from it;
`estimateSeconds` is 35. There is no line: no `waiting` state and no
`linePosition` (both deleted with the page's line screen, note #1060).

**Spares from before** (Zoe, Nina): the sweeper deletes any row still in
`spare` or `preparing`, with its machine, on its first minute after the
deploy. None is ever handed to a visitor.

## The switch and the ceilings

- `agentbuilt agent guests on|off|status` (CLI 1.72.0; its help corrected
  in 1.73.0) is the Workspace Agent's switch, run by an admin's agent. Guests
  are made in that person's workplace and spend that person's Claude seat.
  Only one workplace on a platform can have guests on. Off, the public route
  rests.
- `GUEST_AGENT_LIMITS` (one place): 40 a UTC day, per address 1 live and 3
  a day, 1,000 characters a message, 40 messages, 3 hours, 30 quiet
  minutes, no time limit on a reply (note #1054), and 30 tool rounds a turn.
  No ceiling at once, no line, no spares (note #1055).
- **Cost:** each live guest is a dedicated 2-core machine while it is awake
  (it sleeps after a few quiet minutes like every agent, and is deleted
  after 30), so hosting spend follows visitors. Nothing sits warm waiting.
- **Rests:** the seat out of service (missing, dead, disabled or benched), a
  turn that hits the plan's limit, today's 40 made, guests switched off, or a
  backend with no public https URL for the door. The seat's share of its
  5-hour window or week never rests guests (note #1048, 7 Nov 2026, Adam:
  "remove guest limit"); until then they rested at 50% and 70%. The home
  page's guide still rests at 80% and 90% (`docs/sealed-public-agent.md`).
- **Turnstile:** checked on Start guest agent when `TURNSTILE_SECRET_KEY` and
  `TURNSTILE_SITE_KEY` are set on the backend. The site key reaches the page
  in `turnstileSiteKey`. While they are unset, the check is off and the key
  is null.

## The sweeper (every minute)

- Live agents: deleted after 30 quiet minutes (no message, no turn
  running), after 3 hours busy or not, or 5 quiet minutes after their last
  message is spent. A running turn is activity.
- **Leak guard:** a deletion still unfinished after 10 minutes is tried
  again. A build stuck for 15 minutes is abandoned and deleted. A guest
  record on the owner's profile that the table does not know is deleted
  (hourly).
- Any spare left from before note #1055 is deleted.
- Hourly: keys dropped a day after removal, rows after 90 days.

## Transcripts

One row per agent lives in `guest_agents` (SQLite). It holds the
conversation with each answer's activity (files read and changed, searches,
commands), seconds, Claude's cost line, and any flag from the outgoing check
(the guide's `guideAnswerLeak`). A held-back answer reaches the visitor as
the declined sentence, and the owner sees what was held. Nothing about the
visitor is kept beyond what they typed: no address, no user agent, and their
key only as a SHA-256, dropped a day after the agent goes. The owner reads
it all on the Guests group (`GET /workspace/api/guests`,
`/workspace/api/guests/:agentId`) and can delete a live one
(`DELETE /workspace/api/guests/:agentId`).

## The public routes

All under `/workspace/api/public/guest`, with 403 from another Origin and the
key in `X-Guest-Key`:

- `GET /` — the visitor's status.
- `POST /` — Start guest agent.
- `POST /messages` — send a message.
- `GET /turns/:turnId` — the turn, polled every second.
- `POST /turns/:turnId/stop` — stop the turn.
- `DELETE /` — delete the agent.

The types and every state are in `backend/src/shared/guest-agent.ts`.
