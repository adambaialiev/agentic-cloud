# agentbuilt

The production-hosting CLI baked into agent machines (docs/deployments-phase1.md).
Deliberately a **single zero-dependency file** (`agentbuilt.mjs`): the backend
serves this exact file at `/api/agent-cli/install/agentbuilt`, and each agent
machine's `~/.boot.d/20-agentbuilt.sh` hook (written by the identity writer)
curls it back into place after image rolls. The backend build copies it to
`dist/agentbuilt-cli.mjs` so deploys ship it.

Auth: `~/.agentbuilt/config.json` (`{ apiUrl, token }`), written per machine by
the backend's identity writer. The token maps to `{userId, agentId}` and grants
only the `/api/agent-cli/*` routes — never Fly or Cloudflare.

Run `agentbuilt --help` for the command surface. API-backed commands also need
their route in `backend/src/routes/agent-cli.ts`; machine-local commands such
as the durable `agentbuilt job` supervisor deliberately do not.

`agentbuilt help <topic>` prints the rules for one area — `repos`, `knowledge`,
`notes`, `hosting`, `mail`, `secrets`, `agents`, `chat` — the words that used to
sit in every machine's CLAUDE.md (note #702). The first command of an area whose
topic has not been read in the last day prints one stderr line naming the page;
`help <topic>` leaves the stamp (`~/.agentbuilt/help-read/<topic>`) that quiets it.
