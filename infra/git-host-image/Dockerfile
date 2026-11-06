# syntax=docker/dockerfile:1

# The git-host image (byo-git-design slice 2): the same zero-dependency git
# server that runs on ia-media, packaged for a client org's own Fly machine.
#
# One machine, one volume (mounted at /data), no public address: the org's
# private network reaches it directly, the backend reaches it over the org's
# WireGuard peer, and flycast wakes it on demand — so an idle org's git host
# costs roughly its storage.
#
# Contents are deliberately public-safe: Ubuntu, git, node, the server file
# and its hooks. No secrets — GIT_HOST_SECRET and BACKEND_URL arrive as
# machine env at provision time, which is what makes a public GHCR ref
# correct rather than merely convenient (the same reasoning as the agent
# machine image).
#
# Build context is a STAGING DIRECTORY assembled by the CI job
# (infra/ci-runner/run-job.sh, `git-host-image`): this directory's files plus
# infra/git-host/{git-host.mjs,hooks/} — so the service code exists exactly
# once, in infra/git-host, and ia-media and this image ship the same bytes.

FROM ubuntu:24.04

ARG NODE_MAJOR=22

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        git; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    apt-get purge -y gnupg; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# The same unprivileged user ia-media runs; /data is the Fly volume.
RUN useradd --system --create-home --home-dir /var/lib/agentgit-home \
        --shell /usr/sbin/nologin agentgit

# Layout mirrors the script's own expectations: hooks resolve relative to
# git-host.mjs (`./hooks/<name>`), so they travel beside it.
COPY git-host.mjs /opt/agentgit/git-host.mjs
COPY backup.mjs /opt/agentgit/backup.mjs
COPY maintain-repos.sh /opt/agentgit/maintain-repos.sh
COPY hooks/ /opt/agentgit/hooks/
COPY entrypoint.sh /opt/agentgit/entrypoint.sh
RUN chmod 0755 /opt/agentgit/entrypoint.sh /opt/agentgit/git-host.mjs \
    && chmod -R a+rX /opt/agentgit \
    && node --check /opt/agentgit/git-host.mjs

EXPOSE 8080
ENTRYPOINT ["/opt/agentgit/entrypoint.sh"]
