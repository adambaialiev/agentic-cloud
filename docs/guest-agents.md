# Guests' own agents (note #1038)

A visitor of the home page, signed out, makes a Claude Code agent of their
own: a name and a face, a dedicated 2-core machine nobody else uses, Sonnet
at high effort, and a copy of the public agentic-cloud repository. They chat
with it, can stop a turn, and can delete it. Its machine sleeps after a few
quiet minutes like every agent's. After 30 quiet minutes, 3 hours, or 40
messages, the agent is deleted with its machine, volume and app. The owner
keeps the transcript for 90 days. The design and its screens are note #1036.
Adam's decisions are note #1038.

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

## Time, and packages (note #1047)

- A reply has 180 s. Every shell command is capped by Claude Code's own `BASH_DEFAULT_TIMEOUT_MS` (60 s) and `BASH_MAX_TIMEOUT_MS` (100 s), set in the runner. A command that asks for longer is moved off at the cap, so the agent gets control back with time left to answer. The probe proves it: a command asking for 10 minutes was cut at 100 s.
- The instructions state the budget and say to run a small slice (one test file, a count) and never a whole install, build or suite.
- A reply that still runs out of time ends as an answer that says so. It names the command it was in and suggests a smaller ask. It does not count against the visitor's 40 messages. It never reads "something went wrong", because nothing did.
- **Spares get their packages** while they are prepared: `npm ci --ignore-scripts` in the root and in `backend/`, run as the guide through the egress proxy, marked by `/data/guest/.deps-ready`. No install script runs. better-sqlite3's own script would fetch Node headers from nodejs.org, which is outside the allow-list, and its bundled linux-x64 prebuild loads without them. With packages in place, one test file runs in about 3 s. This is best effort: a spare whose install failed is still a spare. An agent built from nothing (no spare ready) has no packages, and its instructions tell it to run `npm ci --ignore-scripts` in the root and in `backend/` itself, about half a minute (note #1050: plain `npm ci` runs the backend's install script, which reaches nodejs.org and fails under the lock).

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
  **Guests** group at the foot of their agents list.

## The switch, spares and ceilings

- `agentbuilt agent guests on|off|status` (CLI 1.72.0; its help corrected
  in 1.73.0) is the Workspace Agent's switch, run by an admin's agent. Guests
  are made in that person's workplace and spend that person's Claude seat.
  Only one workplace on a platform can have guests on. Off, the public route
  rests and the spare is deleted.
- **Stopped spares:** a sealed guest record with its machine built and set
  up, waiting. A visitor claims one in seconds, and the next is built behind
  it. Without a spare, an agent is built from nothing, which takes a minute
  or two.
- `GUEST_AGENT_LIMITS` (one place): pilot 2 live, 1 spare, 40 a UTC day,
  per address 1 live and 3 a day, a line of 20 places (kept only while the
  page polls), 1,000 characters a message, 40 messages, 3 hours, 30 quiet
  minutes, 180 s and 30 tool rounds a turn.
- **Rests:** the seat out of service (missing, dead, disabled or benched), a
  turn that hits the plan's limit, today's 40 made, guests switched off, or a
  backend with no public https URL for the door. The seat's share of its
  5-hour window or week never rests guests (note #1048, 7 Nov 2026, Adam:
  "remove guest limit"); until then they rested at 50% and 70%. The home
  page's guide still rests at 80% and 90% (`docs/sealed-public-agent.md`).
- **Turnstile:** checked on Make my agent when `TURNSTILE_SECRET_KEY` and
  `TURNSTILE_SITE_KEY` are set on the backend. The site key reaches the page
  in `turnstileSiteKey`. While they are unset, the check is off and the key
  is null.

## The sweeper (every minute)

- Live agents: deleted after 30 quiet minutes (no message, no turn
  running), after 3 hours busy or not, or 5 quiet minutes after their last
  message is spent.
- **Leak guard:** a deletion still unfinished after 10 minutes is tried
  again. A creation or spare stuck for 15 minutes is abandoned and deleted.
  A guest record on the owner's profile that the table does not know is
  deleted (hourly).
- The line: the head gets the next free slot.
- Spares: kept at the target.
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
- `POST /` — Make my agent.
- `POST /messages` — send a message.
- `GET /turns/:turnId` — the turn, polled every second.
- `POST /turns/:turnId/stop` — stop the turn.
- `DELETE /` — delete the agent.

The types and every state are in `backend/src/shared/guest-agent.ts`.
