# Quick start: the public site

The public site (agenticcloudcomputer.com: the home page, `/product`, the documentation under
`/docs`, the legal pages, `llms.txt` and the agents' setup guide `own-cloud.md`) is a static,
prerendered React site on Cloudflare Pages. One Pages Function (`functions/[[path]].js`) sends
every address the site does not own, `/workspace` included, to the Workspace backend, so the
product stays on the main domain. `public/_routes.json` lists the files and pages that never
reach it.

## Run it locally

```bash
npm install          # also installs the backend's dependencies
npm run dev          # http://localhost:5173
npm run build        # typecheck, build and prerender every route into dist/
npm run test:frontend
```

## How it reaches production

The GitHub Actions workflows in `.github/workflows` have not run since Actions froze on 2026-07-30,
and nothing deploys through them. A change reaches the site through a proposal on the platform's own git host. When it
lands on `main`, the CI runner's `deploy-site` job (`infra/ci-runner/run-job.sh`, commit status
`deploy/site`) builds the site on a build machine and uploads `dist/` to the Cloudflare Pages
project named in `wrangler.toml`. The Cloudflare credentials live on the runner, never in the
repository. See [DEPLOYMENT.md](DEPLOYMENT.md) and
[docs/ci-two-lane-runner.md](docs/ci-two-lane-runner.md).

Merged is not live: check that `deploy/site` is green on the commit, then load the page.
