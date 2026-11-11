# The backend as a container (note #804, private copy stage 0).
#
# Production runs this same code under systemd on ia-backend; a private copy
# runs it as one always-on Fly machine with its database on a volume. Build
# context is the REPOSITORY ROOT (the build copies the agentbuilt CLI and the
# CI runner script from beside backend/, exactly as `npm run build` does):
#
#   flyctl deploy --build-only --push --dockerfile infra/backend-image/Dockerfile .
#
# Nothing secret is baked in: every key arrives as a Fly secret at run time.

FROM node:22-bookworm-slim AS build
WORKDIR /src
# better-sqlite3 ships a prebuilt binary for this platform; the toolchain is
# only the fallback when its download is unavailable.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --no-audit --no-fund
COPY backend/ backend/
COPY cli/agentbuilt/agentbuilt.mjs cli/agentbuilt/agentbuilt.mjs
COPY infra/ci-runner/runner-agent.sh infra/ci-runner/runner-agent.sh
# The words around a check, shared with our own dispatcher (note #1161):
# the backend build copies it beside dist, so it must be in the context.
COPY infra/ci-runner/ci-verdicts.mjs infra/ci-runner/ci-verdicts.mjs
# The Workspace bundles one picture from the public site's folder.
COPY public/logo-bw.png public/logo-bw.png
RUN cd backend && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080
# openssh-client is for an operator's `fly ssh console` hop onto agent
# machines; sqlite3 for reading the database by hand. Neither runs at boot.
# wireguard-tools and iproute2 are for our own platform's backend on Fly
# (note #1032): it keeps one WireGuard peer per workplace that runs in its own
# Fly account (services/org-wireguard.ts). Fly's kernel carries WireGuard, so
# wg-quick works in the machine (proved 6 Nov 2026). A copy never uses them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssh-client sqlite3 wireguard-tools iproute2 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/infinite-agents/current
COPY --from=build /src/backend/dist dist
COPY --from=build /src/backend/node_modules node_modules
COPY --from=build /src/backend/assets assets
COPY --from=build /src/backend/scripts scripts
COPY --from=build /src/backend/package.json /src/backend/package-lock.json ./
# The installer's own registry code (note #1008): the Upgrade button copies the
# new release's upgrader image into the copy's registry with it before
# starting the upgrader (services/copy-upgrade.ts, loadInstaller).
COPY infra/copy-installer/install.mjs installer/install.mjs
# The font and icons a browser asks the domain's root for (note #815). Our
# platform's public site serves them; a copy has only this backend, which
# reads them from ../public (routes/workspace-root.ts, BRAND_FILES).
COPY public/fonts/inter-latin-var.woff2 /opt/infinite-agents/public/fonts/
COPY public/favicon.ico public/apple-touch-icon.png /opt/infinite-agents/public/
ARG RELEASE_SHA=unknown
RUN printf '%s\n' "$RELEASE_SHA" > RELEASE_SHA
EXPOSE 8080
CMD ["node", "dist/index.js"]
