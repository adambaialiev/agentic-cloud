# GitHub Secrets Setup Guide

This guide sets up the GitHub secrets used to deploy the landing page to Cloudflare Pages. The frontend is a **static landing page** — no authentication, no client-side config.

## Required Secrets

Add these in **GitHub Repository → Settings → Secrets and variables → Actions → New repository secret**.

### Cloudflare Secrets

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `CLOUDFLARE_API_TOKEN` | API token with Cloudflare Pages permissions | See below |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID | See below |
| `API_BASE_URL` | Backend API URL, injected as `VITE_API_BASE_URL` at build (the static landing does not call it) | Your production API endpoint |
| `PREVIEW_API_BASE_URL` | Preview/staging backend API URL | Your staging API endpoint (optional) |

## Getting Cloudflare Credentials

### 1. Get Account ID

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Click **Workers & Pages**.
3. The URL is `https://dash.cloudflare.com/<ACCOUNT_ID>/workers-and-pages` — copy `<ACCOUNT_ID>`.

### 2. Create API Token

1. Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Click **Create Token** → **Use template** → **Edit Cloudflare Workers**.
3. Configure permissions: **Account → Cloudflare Pages → Edit**.
4. Add **Account Resources → Include → Your Account**.
5. **Continue to summary → Create Token**, then copy it (you won't see it again).

## Quick Setup Commands

### Using GitHub CLI

```bash
gh secret set CLOUDFLARE_API_TOKEN -b"your-api-token-here"
gh secret set CLOUDFLARE_ACCOUNT_ID -b"your-account-id-here"
gh secret set API_BASE_URL -b"https://your-api.example.com"
gh secret set PREVIEW_API_BASE_URL -b"https://staging-api.example.com"
```

### Manual Setup

1. Repo **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret** → add each secret from the tables above → **Add secret**.

## Verification

1. Make a small change and push to `main`.
2. Open the **Actions** tab and watch the deployment workflow run.

## Troubleshooting

### Invalid API Token
Regenerate the token and ensure it has Cloudflare Pages permissions.

### Account Not Found
Verify `CLOUDFLARE_ACCOUNT_ID` matches your Cloudflare account.

### Build Failures
Verify `API_BASE_URL` is set, dependencies install cleanly, and `npm run build` works locally.

## Additional Resources

- [GitHub Actions Secrets Documentation](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [Cloudflare API Tokens Documentation](https://developers.cloudflare.com/fundamentals/api/get-started/keys/)
- [Wrangler Action Documentation](https://github.com/cloudflare/wrangler-action)
