# Backend assets

Non-code files shipped inside the release artifact. `tsc` copies nothing that
isn't TypeScript, so this whole directory is named explicitly in the `cp -R` in
`.github/workflows/backend-deploy.yml` — anything added here that prod needs
must stay inside that copy.

- `agent-avatars/` — one pixel-art dog per agent name, served to the Workspace
  at `/workspace/avatars/<name>`. See its own README.
