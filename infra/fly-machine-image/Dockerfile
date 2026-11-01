# syntax=docker/dockerfile:1

# Baked image every user's Fly Machine boots from.
#
# Replaces the runtime bootstrap in backend/src/services/server-bootstrap.ts:
# all tooling (sshd, tmux, git, node, the claude + codex + opencode CLIs, build tooling)
# is installed at build time so machine creation is seconds, not minutes, and a
# fleet-wide CLI upgrade is just "roll a new image".
#
# Rootfs is EPHEMERAL. Nothing stateful may live outside the Fly Volume, which
# the entrypoint bind-mounts onto /home/agent. See README.md for the full
# volume / first-boot contract.

FROM ubuntu:24.04

# Base LTS Node pin. Bump this (and rebuild) to move the fleet's Node version.
ARG NODE_MAJOR=22
# CLI package versions. REQUIRED, and deliberately without a default: these
# come from the fleet pin in the backend's config store, which is the only place
# a CLI version is chosen. They used to default to "latest", which quietly made
# every image build a version decision made by the npm registry — and left the
# pre-sleep updater to correct machines afterwards, for the one CLI their agent
# used, while the others drifted. The build fails below if any is unset.
ARG CLAUDE_PKG=@anthropic-ai/claude-code
ARG CLAUDE_VERSION=
ARG CODEX_PKG=@openai/codex
ARG CODEX_VERSION=
ARG OPENCODE_PKG=opencode-ai
ARG OPENCODE_VERSION=

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8

# ---------------------------------------------------------------------------
# System packages.
#
# Mirrors the apt list installed by server-bootstrap.ts:
#   ca-certificates curl unzip jq ripgrep git gh tmux nodejs npm
#   build-essential python3 make g++
# plus openssh-server (Fly machines have no sshd by default), locales (a
# UTF-8 locale keeps tmux / the CLIs' TUIs sane), rsync (first-boot home
# seeding), and nftables (the boot-time firewall that pins SSH ingress to the
# backend peer — cross-tenant isolation on the shared 6PN network). Node comes
# from NodeSource (pinned LTS) instead of Ubuntu's old nodejs/npm, and gh from
# GitHub's apt repo (not in Ubuntu's default repos).
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        locales; \
    # UTF-8 locale for tmux / CLI TUIs.
    sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen; \
    locale-gen en_US.UTF-8; \
    update-locale LANG=en_US.UTF-8; \
    # NodeSource apt repo (pinned LTS major).
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    # GitHub CLI apt repo.
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        nodejs \
        git \
        gh \
        tmux \
        openssh-server \
        rsync \
        unzip \
        jq \
        ripgrep \
        sqlite3 \
        build-essential \
        python3 \
        make \
        g++ \
        sudo \
        nftables; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Global CLI installs. Baked at build time so no npm install runs on boot.
# npm's global prefix is /usr (system-wide), so the binaries resolve for both
# the root and agent users. --unsafe-perm lets any postinstall native fetch
# run under root during the build.
# ---------------------------------------------------------------------------
RUN set -eux; \
    # Named, so a forgotten --build-arg fails here with the reason rather than
    # as a confusing `npm install pkg@` error twenty lines down.
    : "${CLAUDE_VERSION:?required build-arg: the fleet CLI pin (see infra/ci-runner/run-job.sh)}"; \
    : "${CODEX_VERSION:?required build-arg: the fleet CLI pin (see infra/ci-runner/run-job.sh)}"; \
    : "${OPENCODE_VERSION:?required build-arg: the fleet CLI pin (see infra/ci-runner/run-job.sh)}"; \
    npm install -g --unsafe-perm "${CODEX_PKG}@${CODEX_VERSION}"; \
    npm install -g --unsafe-perm "${CLAUDE_PKG}@${CLAUDE_VERSION}"; \
    # OpenCode's postinstall links the platform binary out of its optional
    # dependencies (note #780).
    npm install -g --unsafe-perm "${OPENCODE_PKG}@${OPENCODE_VERSION}"; \
    npm cache clean --force; \
    # Fail the build if any CLI is missing so a broken image never ships.
    command -v codex; \
    command -v claude; \
    command -v opencode; \
    node --version; \
    codex --version || true; \
    claude --version || true; \
    opencode --version || true

# ---------------------------------------------------------------------------
# A BROWSER, BAKED — for CI's third stage, and for any agent taking a picture.
#
# `.agentbuilt/ci.sh` used to fetch this on every run: apt for Chrome's shared
# libraries, then ~500 MB of browser from the Chrome-for-Testing CDN, on a
# throwaway machine that then threw it away. About a minute of every check,
# 1300 runs a month, to arrive at the same bytes each time. A lane-A machine
# boots THIS image (infra/ci-runner/lane-a.mjs reads the fleet's ref), so
# baking it here is the one place that removes the fetch for CI and hands
# every agent machine a working browser at the same time — the libraries in
# particular, which live outside the volume and vanish on every image roll,
# which is why an agent's screenshot harness dies with `libglib-2.0.so.0`
# some mornings.
#
# THE VERSION IS PINNED, for the same reason the font is (scripts/ci-fonts.conf):
# every browser check asserts about a screen, and a browser that changes under
# us on any Tuesday moves those assertions with nobody having touched a line.
# `chrome@stable` was what the old runtime install asked for — a version chosen
# by whichever day CI ran. Bumping is this one line, reviewed like anything else.
#
# ci.sh still installs when this is missing (an older image, a workbench), so
# the two paths agree: what it does at runtime, this does once.
ARG CHROME_VERSION=153.0.8010.52
RUN set -eux; \
    apt-get update; \
    # Chrome's shared libraries. libasound2t64, not libasound2: the plain name
    # has no installation candidate on Ubuntu 24.04 and takes the line down
    # with it. fonts-liberation is what ci-fonts.conf pins every screen to.
    apt-get install -y --no-install-recommends \
        libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0 \
        fontconfig fonts-liberation; \
    npx --yes @puppeteer/browsers install "chrome@${CHROME_VERSION}" --path /opt/puppeteer; \
    # The path every harness and journey already searches is
    # $HOME/.cache/puppeteer — CI runs as root, so root's cache IS the baked
    # tree and nothing has to be told where the browser is. The agent user
    # gets it by name below; its own home is a volume this image cannot write.
    mkdir -p /root/.cache; \
    ln -s /opt/puppeteer /root/.cache/puppeteer; \
    printf '%s\n' \
        '# The browser baked into this image (infra/fly-machine-image/Dockerfile).' \
        '# Harnesses read CHROME, journeys read CHROME_PATH; both accept this.' \
        'for _chrome in /opt/puppeteer/chrome/linux-*/chrome-linux64/chrome; do' \
        '  [ -x "$_chrome" ] && { CHROME="$_chrome"; CHROME_PATH="$_chrome"; export CHROME CHROME_PATH; }' \
        'done; unset _chrome' \
        > /etc/profile.d/agentbuilt-chrome.sh; \
    chmod 0644 /etc/profile.d/agentbuilt-chrome.sh; \
    # Fail the build rather than ship an image whose browser cannot start:
    # a missing library here is 37 red browser checks on every run afterwards.
    "/opt/puppeteer/chrome/linux-${CHROME_VERSION}/chrome-linux64/chrome" --version; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Users.
#
# server-bootstrap.ts connects as `root` for admin and creates a non-root
# `agent` user (login shell /bin/bash) for all development / harness work
# (DEFAULT_DEVELOPMENT_SSH_USER = 'agent', home /home/agent). Recreate both.
# The agent home is a bind-mount target at runtime; keep it as a plain empty
# dir here so the baked skeleton can be seeded onto the volume on first boot.
# ---------------------------------------------------------------------------
RUN set -eux; \
    useradd -m -s /bin/bash agent; \
    # Passwordless sudo mirrors the "root for admin, agent for dev" split while
    # letting agent sessions self-serve apt installs without a second SSH user.
    echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent; \
    chmod 0440 /etc/sudoers.d/agent

# Platform-owned Codex hooks live in the system layer: Codex treats that layer
# as managed, so these lifecycle records run without making each user approve
# an operator hook. The identity pass also installs this file (and a durable
# boot hook) so existing volumes receive changes before their next image roll.
RUN install -d -m 0755 /etc/codex
COPY codex-managed-hooks.json /etc/codex/hooks.json
RUN chmod 0644 /etc/codex/hooks.json

# Bake the home skeleton the entrypoint seeds onto an empty volume on first
# boot. Anything here is first-boot-only defaults; user data on the volume is
# never overwritten afterwards.
COPY --chown=agent:agent skel/ /opt/agent-skeleton/

# sshd config tuned for Fly 6PN (key-only, IPv6-reachable, no public IP).
COPY sshd_config /etc/ssh/sshd_config.d/10-fly-machine.conf

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 2222 = SSH. The backend reaches this over the machine's private 6PN IPv6.
# Not 22: Fly's built-in hallpass daemon owns :22 on the 6PN address (see
# sshd_config).
EXPOSE 2222

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
