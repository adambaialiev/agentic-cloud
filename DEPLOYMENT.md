# Deployment Guide - Cloudflare Pages

The web surface is a **static landing page** (no authentication, no backend calls). It deploys to Cloudflare Pages automatically on every push to `main` via GitHub Actions.

> The backend is a long-running Node process, not a Cloudflare Worker — see [`infra/backend-host/`](infra/backend-host/) and [`docs/backend-cutover-runbook.md`](docs/backend-cutover-runbook.md). `.github/workflows/backend-deploy.yml` ships it on pushes under `backend/**`.

## Prerequisites

1. **Cloudflare Account** — create a free account at [cloudflare.com](https://cloudflare.com) and enable Cloudflare Pages.
2. **GitHub Repository** — connected to GitHub Actions.

## Setup Instructions

### Step 1: Create the Cloudflare Pages Project

1. Log in to your Cloudflare dashboard.
2. Navigate to **Workers & Pages** → **Create Application** → **Pages** → **Upload Assets**.
3. Project name: `infinite-agents`. Skip the upload — GitHub Actions handles deployment.
4. Note your **Account ID** from the URL: `https://dash.cloudflare.com/<YOUR_ACCOUNT_ID>/pages`.

### Step 2: Create a Cloudflare API Token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Click **Create Token**.
3. Use the **Edit Cloudflare Workers** template, or create a custom token with:
   - **Account** → **Cloudflare Pages** → **Edit**
   - **Zone** → **Zone** → **Read**
   - **Account Resources**: include your specific account
4. Copy the generated token.

### Step 3: Configure GitHub Secrets

Go to your GitHub repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

| Secret Name | Value |
|-------------|-------|
| `CLOUDFLARE_API_TOKEN` | Your Cloudflare API token from Step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID from Step 1 |
| `API_BASE_URL` | Backend API URL, injected as `VITE_API_BASE_URL` at build (the static landing does not call it) |

### Step 4: Push to Main

```bash
git push origin main
```

GitHub Actions will install dependencies, run `npm run build`, and deploy `dist/` to Cloudflare Pages.

## Workflow Files

- **`.github/workflows/deploy-cloudflare.yml`** — deploys the landing page on every push to `main`.
- **`.github/workflows/ci-cd.yml`** — lint, build, tests, and Pages deploy on `main`.
- **`.github/workflows/preview-deploy.yml`** — preview deployments for pull requests.

## Manual Deployment

From the GitHub Actions tab: **Actions** → **Deploy to Cloudflare Pages** → **Run workflow**. Or locally:

```bash
npm run build
npx wrangler pages deploy dist --project-name=infinite-agents
```

## Configuration Files

- **`wrangler.toml`** — Cloudflare Pages configuration (the landing page).
- **`backend/wrangler.toml`** — legacy; the backend does not run on the Workers runtime.

## Troubleshooting

### Build Failures
- Check the GitHub Actions logs for detailed error messages.
- Verify the build works locally: `npm run build`.

### Deployment Failures
- Verify `CLOUDFLARE_API_TOKEN` has Cloudflare Pages permissions.
- Confirm `CLOUDFLARE_ACCOUNT_ID` is correct and the Pages project name matches.

### Environment Variables
- **Cloudflare Dashboard**: Workers & Pages → your project → Settings → Environment Variables.
- **GitHub Secrets**: for values needed during the build.

## Additional Resources

- [Cloudflare Pages Documentation](https://developers.cloudflare.com/pages/)
- [Wrangler Action Documentation](https://github.com/cloudflare/wrangler-action)
