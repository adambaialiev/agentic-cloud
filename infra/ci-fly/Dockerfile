# CI on Fly (note #1032 stage 3): one image, two roles.
#   CI_ROLE=dispatcher  the webhook daemon (infra/ci-runner/daemon.mjs) and
#                       every lane B job, as on the Hetzner ia-ci-runner box.
#                       App ia-ci, always on, small.
#   CI_ROLE=builder     dockerd + sshd and nothing else: the dispatcher's
#                       docker CLI drives it over SSH (DOCKER_HOST) for the
#                       image builds and runs their smoke tests on it. App
#                       ia-ci-builder, started for a build, stopped after.
# Built from the infra/ directory:  docker build -f infra/ci-fly/Dockerfile infra
FROM ubuntu:24.04
ARG NODE_MAJOR=22
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git rsync openssh-client openssh-server \
        docker.io build-essential python3 sqlite3 jq unzip xz-utils iproute2 util-linux; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*
# The runner's home and the daemon's code live on the volume (/data), so the
# self-update job and the work clone survive restarts exactly as on the box.
RUN useradd --no-create-home --home-dir /data/runner --shell /bin/bash runner \
    && ln -sfn /data/opt-ia-ci /opt/ia-ci \
    && mkdir -p /run/sshd
# The same files the self-update job installs (run-job.sh, SELF_FILES).
COPY ci-runner/daemon.mjs ci-runner/ci-verdicts.mjs ci-runner/lane-a.mjs ci-runner/run-job.sh ci-runner/runner-agent.sh /opt/ia-ci-seed/
COPY ci-fly/entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh /opt/ia-ci-seed/run-job.sh /opt/ia-ci-seed/runner-agent.sh \
    && node --check /opt/ia-ci-seed/daemon.mjs && node --check /opt/ia-ci-seed/ci-verdicts.mjs && bash -n /opt/ia-ci-seed/run-job.sh
ENTRYPOINT ["/entrypoint.sh"]
