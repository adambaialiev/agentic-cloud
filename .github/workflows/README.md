# GitHub Actions Workflows

This directory contains automated CI/CD workflows for the Infinite Agents project.

## Workflows Overview

### 1. `deploy-cloudflare.yml` - Simple Production Deployment
**Triggers:** Push to `main` branch, manual workflow dispatch

**What it does:**
- Checks out the code
- Sets up Node.js environment
- Installs dependencies
- Builds the frontend with production environment variables
- Deploys to Cloudflare Pages

**Use case:** Quick, straightforward deployment to production on every main branch push.

---

### 2. `ci-cd.yml` - Full CI/CD Pipeline
**Triggers:** 
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop`
- Manual workflow dispatch

**What it does:**
- **Test Frontend:** Runs linter, builds frontend with test environment variables
- **Deploy Frontend:** Deploys to Cloudflare Pages (only on main branch pushes) with production environment variables

**Use case:** Comprehensive pipeline that tests frontend before deployment.

---

### 3. `preview-deploy.yml` - Preview Deployments
**Triggers:** 
- Pull requests to `main` branch
- Manual workflow dispatch

**What it does:**
- Builds the frontend with preview environment variables
- Deploys to Cloudflare Pages as a preview
- Comments on the PR with deployment status

**Use case:** Preview deployments for code reviews and testing before merging to main.

---

## How to Use

### Automatic Deployment
Simply push to the `main` branch:

```bash
git add .
git commit -m "Your changes"
git push origin main
```

The workflow will automatically run and deploy your changes.

### Manual Deployment
1. Go to the **Actions** tab in your GitHub repository
2. Select a workflow from the list
3. Click **Run workflow** → **Run workflow**

### Preview Deployment
Create a pull request targeting `main`:

```bash
git checkout -b feature/your-feature
# Make changes
git add .
git commit -m "Add new feature"
git push origin feature/your-feature
# Create PR on GitHub
```

A preview deployment will be created automatically.

---

## Required Secrets

These workflows require the following GitHub secrets to be configured:

| Secret | Required By | Description |
|--------|-------------|-------------|
| `CLOUDFLARE_API_TOKEN` | All workflows | Cloudflare API token with Pages permissions |
| `CLOUDFLARE_ACCOUNT_ID` | All workflows | Your Cloudflare Account ID |
| `API_BASE_URL` | All workflows | Backend API URL, injected as `VITE_API_BASE_URL` (the static landing does not call it) |
| `PREVIEW_API_BASE_URL` | preview-deploy.yml | Preview backend API URL |

The frontend is a static landing page with no authentication, so no auth-related build secrets are needed. See `../scripts/setup-github-secrets.md` for detailed setup instructions.

---

## Configuration Files

### `wrangler.toml` (root)
Configuration for Cloudflare Pages deployment (frontend).

### `backend/wrangler.toml`
Configuration for Cloudflare Workers deployment (backend) - optional.

---

## Troubleshooting

### Workflow Fails to Start
- Verify GitHub Actions is enabled for your repository
- Check that the workflow file has valid YAML syntax

### Build Fails
- Check the Actions logs for specific error messages
- Try running the build locally: `npm run build`
- Ensure all dependencies are in `package.json`
- Verify all required environment variables are set as GitHub secrets

### Deployment Fails
- Verify Cloudflare secrets are correctly set
- Check that the Cloudflare project name matches
- Ensure your API token has the correct permissions

### Permission Errors
- Make sure the GitHub Actions token has `contents: write` permission
- Go to: Settings → Actions → General → Workflow permissions

---

## Customization

### Change Deployment Branch
Edit the `on.push.branches` section in the workflow file:

```yaml
on:
  push:
    branches:
      - main  # Change this to your preferred branch
```

### Add Environment Variables
Add them to the build step or as GitHub secrets:

```yaml
- name: Build frontend
  run: npm run build
  env:
    MY_CUSTOM_VAR: ${{ secrets.MY_CUSTOM_VAR }}
```

### Modify Node Version
Update the Node.js version in the setup step:

```yaml
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '20'  # Change to your preferred version
```

---

## Monitoring Deployments

### View Workflow Runs
- Go to **Actions** tab in your repository
- Click on a workflow to see run history

### View Logs
- Click on a specific workflow run
- Click on a job to see detailed logs
- Expand each step to view output

### Cloudflare Deployment History
- Log in to Cloudflare Dashboard
- Navigate to Workers & Pages
- Click on your project → Deployments

---

## Best Practices

1. **Always test locally before pushing** - Run `npm run build` to verify builds work
2. **Use PRs for changes** - Leverage preview deployments for testing
3. **Keep secrets secure** - Never commit secrets to the repository
4. **Monitor workflow runs** - Check Actions tab regularly for failures
5. **Use semantic commit messages** - Helps track deployment history

---

## Support

For issues with:
- **GitHub Actions**: [GitHub Actions Documentation](https://docs.github.com/en/actions)
- **Cloudflare Pages**: [Cloudflare Pages Documentation](https://developers.cloudflare.com/pages/)
- **Wrangler Action**: [Wrangler Action GitHub](https://github.com/cloudflare/wrangler-action)
