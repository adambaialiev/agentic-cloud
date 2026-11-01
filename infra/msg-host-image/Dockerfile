# syntax=docker/dockerfile:1

# The messaging-host image (note #608): the one machine a workplace's direct
# messages between people live on. One machine, one volume (mounted at /data),
# NO public address, no SSH and no Fly proxy service in front of it — the
# backend dials the machine's private address over the workplace's WireGuard
# peer, and the entrypoint's firewall drops every other private-network
# caller, agent machines included.
#
# Contents are deliberately public-safe: Ubuntu, node, nftables, one server
# file. No secrets — MSG_HOST_SECRET arrives as machine env at provision time,
# which is what makes a public GHCR ref correct (the git-host image's rule).
#
# Build context is a STAGING DIRECTORY assembled by the CI job
# (infra/ci-runner/run-job.sh, `msg-host-image`): this directory's files plus
# infra/msg-host/msg-host.mjs.

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
        iproute2 \
        nftables; \
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

RUN useradd --system --create-home --home-dir /var/lib/msghost-home \
        --shell /usr/sbin/nologin msghost

COPY msg-host.mjs /opt/msghost/msg-host.mjs
COPY entrypoint.sh /opt/msghost/entrypoint.sh
RUN chmod 0755 /opt/msghost/entrypoint.sh /opt/msghost/msg-host.mjs \
    && chmod -R a+rX /opt/msghost \
    && node --check /opt/msghost/msg-host.mjs

EXPOSE 8080
ENTRYPOINT ["/opt/msghost/entrypoint.sh"]
