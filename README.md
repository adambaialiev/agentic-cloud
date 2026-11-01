# Agentic Cloud Computer

**A few people, a fleet of agents, huge output.** Agentic Cloud Computer is a shared Workspace in
the browser where a small team works with persistent AI coworkers. Each agent has a name, a job
and its own cloud computer. The agents work in parallel, share the company's notes, knowledge
pages, repositories and files, and ask a person before anything important ships.

This repository is the whole platform: the public site, the browser Workspace, the control-plane
backend, the `agentbuilt` CLI the agents use, the git host and CI runner, the installer for your
own Agentic Cloud, and the machine and runtime infrastructure.

- Product: https://agenticcloudcomputer.com
- Licence: [GNU AGPL-3.0](LICENSE). If you run a modified version as a service, you must offer
  its source to the people who use it.
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Outside contributions need a contributor
  agreement.

## Install your own Agentic Cloud

Your own Agentic Cloud is the whole platform installed in your company's own Fly.io organization,
on your own domain. One installer builds it, and nothing of yours is kept by us.

- For people: https://agenticcloudcomputer.com
- For the AI agent that does the installing: [public/own-cloud.md](public/own-cloud.md), also
  served at https://agenticcloudcomputer.com/own-cloud.md. Hand it to Claude Code, Codex or any
  agent with a terminal and ask it to set up your Agentic Cloud.
- The installer's code and tests: [infra/copy-installer/](infra/copy-installer/).

## Product shape

- Agents are created, messaged, reviewed and managed in the Workspace.
- Each agent has a name, a job and a persistent cloud computer. Claude Code, Codex and OpenCode
  agents can work side by side.
- Notes, knowledge pages, Drive, repositories and sites belong to the workplace, so every agent
  in it works from the same context.
- Code and knowledge changes come back as proposals. Only a person can approve one, and approving
  is what lands it.
- Each person signs in to their own AI subscription on the provider's own page.

## What happens during a turn

1. A member opens the Workspace in a browser and messages a coworker.
2. The backend admits or steers the turn, wakes the coworker machine when necessary and runs the
   selected CLI harness over SSH.
3. Claude Code or Codex works on the persistent machine with its normal tools and filesystem.
4. The `agentbuilt` CLI gives the coworker scoped access to Workspace features such as notes,
   repositories, proposals, secrets and deployments.
5. Progress and the final reply are written back to the Workspace conversation. A proposal becomes
   a human decision card; a completed turn leaves an unread receipt on the Workspace.

The backend does not drive coding models token by token. The coding CLI runs on the coworker
machine and retains its own working session there.

## Data split

Customer-controlled resources and platform records are deliberately separate.

| Customer-controlled services | Platform control plane |
| --- | --- |
| Agent machines and disks in the workplace's Fly organization | Workplace, membership and agent records |
| Repositories, media and deployments when BYO integrations are configured | Notes, knowledge pages, proposal and deployment metadata |
| Provider billing for AI access and cloud resources | Encrypted credentials and saved secrets |
| The full coding-harness session on each agent machine | A rolling window of recent Workspace chat rows per agent |

In your own Agentic Cloud, both columns live in your own Fly organization.

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
             +---------------------------- customer Fly machines
                                                  |
                                      Claude Code / Codex + agentbuilt CLI
```

### Main components

- **Public frontend** — Vite, React, TypeScript, React Router and Tailwind. Static routes are
  prerendered by `scripts/prerender.mjs` — `/`, the legal pages, `robots.txt`, `sitemap.xml`
  and `llms.txt`. The tour and the twelve articles were removed on 2026-09-07; their
  addresses are 301s in `public/_redirects`, because the SPA fallback would otherwise answer
  each one with the homepage and a 200. A narrowly routed Pages Function proxies
  `/workspace` to the backend so the product stays on the main domain. Every product picture
  on it is a crop of a real simulation capture — see
  [`docs/marketing-screenshots.md`](docs/marketing-screenshots.md).
- **Workspace** — `backend/workspace-ui/`, a React shell the backend builds and serves. Browser sessions use a
  username and rotating authenticator code.
- **Backend** — a stateful Node/Express service. It owns Workspace APIs,
  provisioning, SSH turns, schedulers and the platform control plane.
- **Persistence** — SQLite behind storage interfaces, plus an S3-compatible media store. The
  backend has in-memory implementations for local development and tests.
- **Coworker machines** — created in the workplace's Fly account and reached over the private
  network. Each runs one coding CLI harness and the zero-dependency `agentbuilt` CLI.
- **Platform git and CI** — protected repositories, owner approval cards and a two-lane CI runner.

## Repository layout

```text
.
├── src/                     # Public React site, legal pages and guides
├── backend/
│   ├── src/
│   │   ├── agent/           # Setup-agent loop and Claude/Codex harnesses
│   │   ├── routes/          # Workspace, ops and agentbuilt API routes
│   │   ├── services/        # Storage, provisioning, git, media and lifecycle services
│   │   ├── types/           # Persisted and API document shapes
│   │   └── test/            # Unit, integration, live and helper suites
│   └── scripts/             # Operator and migration tools
├── cli/agentbuilt/          # CLI baked into coworker machines
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

GitHub Actions is frozen and retained only as historical/specification material. The platform git
host triggers the two-lane CI runner described in [docs/ci-two-lane-runner.md](docs/ci-two-lane-runner.md):

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
   running or red (note #293). Knowledge proposals work the same way: `knowledge propose`
   records quietly and `knowledge proposals ready <n>` invites the owner.

5. The owner approves or rejects in the Workspace. Do not push or merge on the GitHub mirror.

Changes requested by a quick note must use `agentbuilt note start <n>` before work and link the
proposal with `--note <n>`.

Conventions worth knowing:

- Storage additions need both persistent (`Sqlite*`) and in-memory implementations.
- New setup-agent capabilities need a schema in `backend/src/agent/tool-definitions.ts` and a
  handler in `backend/src/agent/tool-executor.ts`.
- New `agentbuilt` commands normally touch both `cli/agentbuilt/agentbuilt.mjs` and
  `backend/src/routes/agent-cli.ts`.
- Anything baked into existing coworker machines needs the correct update channel and version
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
