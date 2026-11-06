# Deployment

How a change to this repository reaches production. This is the platform's own deployment. To
install your own Agentic Cloud in your company's Fly.io organization, follow
[public/own-cloud.md](public/own-cloud.md) instead.

## The path

Every change lands on `main` through a proposal on the platform's own git host
([docs/platform-on-own-git.md](docs/platform-on-own-git.md)). The CI runner
([docs/ci-two-lane-runner.md](docs/ci-two-lane-runner.md)) then runs each job for the new commit
and records it as a commit status:

| Status | What it does |
| --- | --- |
| `ci/checks` | Frontend and backend tests, the build, lint, and the real-Chrome checks |
| `deploy/site` | Builds the public site and uploads `dist/` to Cloudflare Pages (`wrangler.toml`) |
| `deploy/prod` | Builds the backend artifact, restarts the backend with a guard, and checks its health |
| `deploy/git-host` | Updates the platform git service |

Other jobs build the agent machine image, the git host and messaging images, the database backup
service and the release an own Agentic Cloud installs; most of them skip a commit that does not
touch their files.
The job definitions are in `infra/ci-runner/run-job.sh` and `infra/ci-runner/daemon.mjs`.

The GitHub Actions workflows in `.github/workflows` have not run since Actions froze on
2026-07-30, and nothing deploys through them. Credentials (Cloudflare, Fly) live on the CI runner, never in the repository.

## The backend

The backend is a long-running Node process on its own host, not a Cloudflare Worker. Its host
setup is in [infra/backend-host/](infra/backend-host/), and the cutover and rollback steps are in
[docs/backend-cutover-runbook.md](docs/backend-cutover-runbook.md). `backend/wrangler.toml` is
legacy: the backend does not run on the Workers runtime.

## Checking that it arrived

Merged is not live. Wait for the commit's `deploy/site` or `deploy/prod` status to go green, then
load the page or call the route that changed.
