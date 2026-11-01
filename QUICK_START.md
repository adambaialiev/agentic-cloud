# Quick Start: Deploying the Landing Page to Cloudflare Pages

The web surface is a **static landing page** — no authentication, no backend calls. Deploying it needs only Cloudflare credentials.

## What's Involved

### GitHub Actions Workflows
- `.github/workflows/deploy-cloudflare.yml` — production deployment on `main`
- `.github/workflows/ci-cd.yml` — full CI/CD pipeline with tests
- `.github/workflows/preview-deploy.yml` — preview deployments for PRs
- `.github/workflows/README.md` — workflow documentation

### Cloudflare Configuration
- `wrangler.toml` — Cloudflare Pages configuration (the landing page)

### Documentation
- `DEPLOYMENT.md` — complete deployment guide
- `scripts/setup-github-secrets.md` — GitHub secrets setup instructions

---

## Setup in 5 Minutes

### Step 1: Get Cloudflare Credentials (2 min)

**Get Account ID:**
1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Go to **Workers & Pages**
3. Copy the account ID from the URL

**Create API Token:**
1. Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token** → **Edit Cloudflare Workers** template
3. Add **Cloudflare Pages → Edit** permission
4. Click **Create Token** and copy it

### Step 2: Add GitHub Secrets (2 min)

Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

**Cloudflare:**
- `CLOUDFLARE_API_TOKEN` — your API token from step 1
- `CLOUDFLARE_ACCOUNT_ID` — your account ID from step 1
- `API_BASE_URL` — your production backend URL, e.g. `https://api.agenticcloudcomputer.com` (build-time proxy target; the static landing does not call it)
- `PREVIEW_API_BASE_URL` — your staging backend URL (optional)

### Step 3: Create the Cloudflare Pages Project (1 min)

1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. **Workers & Pages** → **Create Application** → **Pages** → **Connect to Git**
3. Authorize GitHub and select your repository
4. Project name: `infinite-agents`
5. Build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`

### Step 4: Deploy

Push to the `main` branch:

```bash
git push origin main
```

GitHub Actions builds and deploys the landing page automatically. 🎉

---

## Workflow Triggers

### Production Deployments
- Push to `main` → automatic deployment
- Or manually trigger from the Actions tab

### Preview Deployments
- Open a pull request → automatic preview deployment (URL posted as a PR comment)

### CI Pipeline
- Push to `main` → tests + deployment
- Pull requests → tests only

---

## Monitor Your Deployments

**GitHub Actions:** Actions tab → click a workflow run to see logs.

**Cloudflare Pages:** Cloudflare Dashboard → Workers & Pages → your project → Deployments.

---

## Common Issues & Solutions

### ❌ "Invalid API Token"
Regenerate your API token and verify it has Cloudflare Pages permissions.

### ❌ "Account not found"
Double-check that `CLOUDFLARE_ACCOUNT_ID` matches your Cloudflare account.

### ❌ "Build failed"
Run `npm run build` locally first to verify everything works.

### ❌ Workflow doesn't trigger
Ensure GitHub Actions is enabled and the branch name matches.

---

## Need More Help?

📖 **Read the full documentation:**
- `DEPLOYMENT.md` — complete deployment guide
- `.github/workflows/README.md` — workflow details
- `scripts/setup-github-secrets.md` — secret setup instructions

🌐 **Official resources:**
- [Cloudflare Pages Docs](https://developers.cloudflare.com/pages/)
- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [Wrangler Action](https://github.com/cloudflare/wrangler-action)
