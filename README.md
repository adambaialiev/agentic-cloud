# Agentic Cloud Computer

**Everything an agent needs to finish the job.** Agentic Cloud Computer is an open-source
workplace for a team of coding agents (Claude Code, Codex and OpenCode) that a company runs in its
own Fly.io account, on its own domain. Each agent has a name, a job and a machine of its own. Git
hosting with checks, hosting for sites and apps, object storage, email, Drive, notes and knowledge
pages are built in, so the work ends as something live rather than as a pull request.

This repository is the whole platform: the public site, the browser Workspace, the control-plane
backend, the `agentbuilt` CLI the agents use, the git host and CI runner, the installer for your
own Agentic Cloud, and the machine and runtime infrastructure.

- Product: https://agenticcloudcomputer.com
- Licence: [GNU AGPL-3.0](LICENSE). If you run a modified version as a service, you must offer
  its source to the people who use it. The name and the logo are not under that licence.
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Outside contributions need a contributor
  agreement.

## Install your own Agentic Cloud

Your own Agentic Cloud is the whole platform installed in your company's own Fly.io organization,
on a domain of yours. One installer builds it. None of your data comes to us: only a daily report
of counts and the contact you chose, which your admin sees in the Workspace and can turn off. It
is free for now: no licence, no key and no charge from us. Fly bills your own account for the
machines, and your AI provider bills your own plan.

- Hand your terminal agent (Claude Code, Codex or any agent with a terminal) this line:
  "Set up our own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md".
  It checks your computer, shows you the plan and Fly's prices, and changes nothing until you
  agree. The guide is also in this repository: [public/own-cloud.md](public/own-cloud.md).
- You need a Fly.io organization with a card on file, a domain name you can add DNS records to
  (such as `agents.yourcompany.com`), and Node 20 or newer.
- The installer's code and tests: [infra/copy-installer/](infra/copy-installer/).
- Why it runs on Fly and not AWS, Google Cloud or Vercel: https://agenticcloudcomputer.com/why-fly

## Product shape

- Agents are created, messaged, reviewed and managed in the Workspace, in a browser.
- Each agent has a name, a job and a persistent machine of its own that sleeps when idle and
  wakes when work arrives. Claude Code, Codex and OpenCode agents work side by side on the same
  repositories, on the Claude, ChatGPT or OpenCode plans the company already pays for. Several agents can
  share one seat.
- Agents can run Docker: `docker compose up` brings a project's database, cache and app up on an
  agent's machine and in checks.
- Notes, knowledge pages, Drive, repositories and sites belong to the workplace, so every agent
  in it works from the same context: a Codex agent can pick up where a Claude Code agent left off.
- Changes to protected code come back as proposals. A person approves one, and approving is what
  lands it, unless that person switched on auto-merge for their own agents' proposals (checks
  must still pass). No agent can merge or approve by itself. Knowledge pages change the moment
  an agent writes them, and the owner is told.
- Each person signs in to their own AI subscription on the provider's own page.

Not built yet: hosting outside Fly.io, single sign-on, and an alert when an agent stalls.

## What happens during a turn

1. A member opens the Workspace in a browser and messages an agent.
2. The backend admits or steers the turn, wakes the agent's machine when necessary and runs the
   selected CLI harness over SSH.
3. Claude Code, Codex or OpenCode works on the persistent machine with its normal tools and
   filesystem.
4. The `agentbuilt` CLI gives the agent scoped access to Workspace features such as notes,
   repositories, proposals, secrets and deployments.
5. Progress and the final reply are written back to the Workspace conversation. A proposal becomes
   a human decision card; a completed turn leaves an unread receipt on the Workspace.

The backend does not drive coding models token by token. The coding CLI runs on the agent's
machine and retains its own working session there.

## Where things live

In your own Agentic Cloud, everything runs in your own Fly organization: the Workspace and its
database, the code host and CI, the agents' machines, sites, files, backups and email. Your AI
provider receives the prompts, code and files your agents send it, under your own plan's terms.

The same code also runs our invite-only hosted Workspace. There, agent machines and sites run on
our Fly account and the control plane keeps the records needed to run the Workspace (membership,
notes, recent chat rows, encrypted credentials); see https://agenticcloudcomputer.com/privacy.

## Architecture

```text
 Workspace web app                    Public site
 browser auth + control               marketing + legal
           |                                |
           +---------------+----------------+
                           v
                    Cloudflare Pages
                           |
                           v
          +---------------------------+
          | Node/Express control plane|
          | Workspace API + workers   |
          +---------------------------+
             |        |        |
             |        |        +---------- platform git + CI
             |        +------------------- SQLite + media storage
             +---------------------------- agent Fly machines
                                                  |
                                      Claude Code / Codex + agentbuilt CLI
```

### Main components

- **Public frontend** — Vite, React, TypeScript, React Router and Tailwind. Static routes are
  prerendered by `scripts/prerender.mjs` — every public route, including `/`, `/product`, the
  documentation under `/docs` and the legal pages, plus `robots.txt`, `sitemap.xml` and `llms.txt`. The tour and the twelve articles were removed on 2026-09-07; their
  addresses are 301s in `public/_redirects`, because the SPA fallback would otherwise answer
  each one with the homepage and a 200. A narrowly routed Pages Function proxies
  `/workspace` to the backend so the product stays on the main domain. The site's product
  pictures are the Workspace's own components on fixture data (`src/components/Live*.tsx`), not
  screenshots.
- **Workspace** — `backend/workspace-ui/`, a React shell the backend builds and serves. People sign in with
  their name here and a password; an authenticator code is an optional second step.
- **Backend** — a stateful Node/Express service. It owns Workspace APIs,
  provisioning, SSH turns, schedulers and the platform control plane.
- **Persistence** — SQLite behind storage interfaces, plus an S3-compatible media store. The
  backend has in-memory implementations for local development and tests.
- **Agent machines** — created in the platform's Fly account (or a workplace's own, in your own
  Agentic Cloud) and reached over the private network. Each runs one coding CLI harness and the zero-dependency `agentbuilt` CLI.
- **Platform git and CI** — protected repositories, owner approval cards and a two-lane CI runner.

## Repository layout

```text
.
├── src/                     # Public React site, legal pages and documentation (src/docs)
├── backend/
│   ├── src/
│   │   ├── agent/           # Setup-agent loop and Claude/Codex harnesses
│   │   ├── routes/          # Workspace, ops and agentbuilt API routes
│   │   ├── services/        # Storage, provisioning, git, media and lifecycle services
│   │   ├── types/           # Persisted and API document shapes
│   │   └── test/            # Unit, integration, live and helper suites
│   └── scripts/             # Operator and migration tools
├── cli/agentbuilt/          # CLI baked into agent machines
├── infra/                   # Machine images, backend, git, CI, backups and routing
├── docs/                    # Current runbooks plus dated design/history records
├── scripts/                 # Build, prerender, verification and screenshot tools
├── public/                  # Public-site assets
└── .agentbuilt/ci.sh        # Protected repository checks
```

## Local development

Prerequisite: Node.js 20 or newer.

```bash
npm install
```

The root install also installs backend dependencies and the pre-commit hook.

Start the backend:

```bash
npm --prefix backend run dev
```

Start the public site in another terminal:

```bash
npm run dev
```

The public site defaults to `http://localhost:5173`; Vite proxies `/api` to the backend. The
backend can boot with in-memory storage for local work. Production features switch on only when
their corresponding credentials and endpoints are configured.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run build` | Typecheck, build the public site and prerender every route |
| `npm --prefix backend run build` | Build the backend, Workspace HTML and bundled CLI |
| `npm run lint` | Run ESLint across the repository |
| `npm test` | Run backend and frontend suites |
| `npm run test:frontend` | Run the frontend suite only |
| `npm --prefix backend test` | Run the backend suite only |
| `npm run simulate` | Run every fixture-backed browser journey |
| `npm run simulate:signin` | Drive one Workspace journey in Chrome with fixture-only networking |

## CI and deployment

The platform git host triggers the two-lane CI runner described in [docs/ci-two-lane-runner.md](docs/ci-two-lane-runner.md):

| Job | Result |
| --- | --- |
| `checks` | Frontend tests/coverage, build, backend core tests and advisory lint, then every real-Chrome check: the `verify-*` harnesses and the journey simulations |
| `deploy-site` | Build and deploy the public site to Cloudflare Pages |
| `deploy-prod` | Build the backend artifact, guarded restart and health check |
| `deploy-git-host` | Update the platform git service |

Production releases keep rollback artifacts. Read
[docs/platform-on-own-git.md](docs/platform-on-own-git.md) and
[docs/backend-cutover-runbook.md](docs/backend-cutover-runbook.md) before changing the deploy path.

## Contributing

1. Update local `main` and create a branch.
2. Make the change with proportionate tests and visual verification.
3. Run the relevant local checks.
4. Push the branch, wait for protected CI, record the proposal, and — only when nothing is
   left to do — invite the owner to it:

   ```bash
   git push origin HEAD:my-change
   agentbuilt repo checks --wait
   agentbuilt pr create --from my-change --title "…" --body "what changed and why"
   agentbuilt pr ready
   ```

   `pr create` is quiet: no card, no notification, no queue row, and the owner cannot decide
   it. `pr ready` is the invitation, and it refuses while the checks on the branch are still
   running or red (note #293). With the owner's auto-merge on, `pr ready` merges a green
   proposal instead of asking. Knowledge is not proposed at all: since note #746
   `knowledge propose` is live the moment it returns.

5. The owner approves or rejects in the Workspace (or auto-merge merges it). Do not push or merge on the GitHub mirror.

Changes requested by a quick note must use `agentbuilt note start <n>` before work and link the
proposal with `--note <n>`.

Conventions worth knowing:

- Storage additions need both persistent (`Sqlite*`) and in-memory implementations.
- New `agentbuilt` commands normally touch both `cli/agentbuilt/agentbuilt.mjs` and
  `backend/src/routes/agent-cli.ts`.
- Anything baked into existing agent machines needs the correct update channel and version
  bump. Read [docs/machine-update-channels.md](docs/machine-update-channels.md) first.

## Further reading

- [Machine update channels](docs/machine-update-channels.md)
- [Legacy Telegram harness routing](docs/telegram-cli-harnesses.md)
- [Seat sign-in](docs/seat-sign-in.md)
- [BYO Fly](docs/byo-fly.md)
- [BYO git](docs/byo-git.md)
- [BYO media](docs/byo-media.md)
- [Agent repositories and proposals](docs/agent-git-project-repos.md)
- [Quick notes](docs/agent-quick-notes.md)
- [Knowledge pages](docs/agent-knowledge-pages.md)
- [Deployments](docs/deployments-phase1.md) — dated design record; verify current product copy
  against the public site before quoting it

## Licence

Copyright © 2026 Agentic Cloud Computer.

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License as published by the Free Software Foundation, version 3. It is
distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the
full text.

"Agentic Cloud Computer" and its logo are not licensed under the AGPL. Claude and Claude Code are
products of Anthropic; ChatGPT and Codex are products of OpenAI. We are not affiliated with those
companies.
