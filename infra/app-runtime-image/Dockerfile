# syntax=docker/dockerfile:1

# Baked image for PRODUCTION deployment machines (docs/deployments-phase1.md).
#
# A deliberately minimal sibling of ../fly-machine-image: no harness CLIs, no
# tmux, no sudo, no build toolchain — this machine runs ONE user app that the
# backend syncs onto the volume. Two serve modes, chosen by the entrypoint
# from what exists on the volume:
#   static  — caddy file-server over /data/site on :8080
#   service — /data/app/run.sh, supervised with a restart loop
#
# Rootfs is EPHEMERAL (reset on image rolls). Everything durable — the site,
# the app, logs, SSH host keys — lives on the Fly Volume at /data.

FROM ubuntu:24.04

# Node for `service` apps (the presets promise a node runtime); bump to move
# the fleet.
ARG NODE_MAJOR=22
# Caddy serves `static` deployments. From Caddy's official apt repo.
ARG CADDY_VERSION=*

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg; \
    mkdir -p /etc/apt/keyrings; \
    # NodeSource apt repo (pinned LTS major), same pattern as the agent image.
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    # Caddy's official apt repo (cloudsmith).
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /etc/apt/keyrings/caddy-stable.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/caddy-stable.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
        > /etc/apt/sources.list.d/caddy-stable.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        nodejs \
        caddy \
        openssh-server \
        rsync \
        nftables; \
    rm -rf /var/lib/apt/lists/*; \
    node --version; \
    caddy version

# The app user runs the deployed workload. Unlike the agent image there is NO
# sudo: nothing on this machine ever needs to escalate, and a compromised app
# should stay inside this uid. Home is a plain dir on the rootfs — the
# workload's real files live under /data.
RUN useradd -m -s /bin/bash app

# sshd tuned for Fly 6PN (key-only, :2222 — hallpass owns :22). Same file as
# the agent image; kept as a copy so the two images stay independently
# buildable.
COPY sshd_config /etc/ssh/sshd_config.d/10-fly-machine.conf

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 2222 = SSH for the backend (deploy sync, logs, restart). 8080 = the app.
EXPOSE 2222 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
