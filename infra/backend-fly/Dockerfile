# Production's backend on Fly (note #1032, stage 4): the RUNTIME only.
#
# Unlike a private copy's image (infra/backend-image), this one carries no
# release. deploy-prod keeps shipping the lane A artifact into
# /opt/infinite-agents/releases/<sha> on the volume and restarting Node
# behind the held socket, exactly as on ia-backend, so a deploy is about a
# second of held requests and rollback is ia-rollback. The image changes only
# when the runtime does; build and roll it with
#
#   flyctl deploy --remote-only -c infra/backend-fly/fly.toml \
#     --dockerfile infra/backend-fly/Dockerfile .      # from the repository root
#
# Ubuntu 24.04 and NodeSource's Node 22 are what ia-backend ran, so the
# artifact (native modules included) runs here unchanged. Nothing secret is
# baked in.
FROM ubuntu:24.04

ARG NODE_MAJOR=22
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs python3-minimal \
      openssh-server openssh-client rsync git tmux sqlite3 zstd gzip tar procps less \
      wireguard-tools iproute2 iputils-ping util-linux \
 && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
 && useradd --system --home-dir /opt/infinite-agents --shell /bin/bash app

COPY infra/backend-fly/holder.py infra/backend-fly/systemctl infra/backend-fly/systemd-analyze /usr/local/sbin/
COPY infra/backend-fly/entrypoint.sh /usr/local/sbin/ia-backend-entrypoint
# Seeds for the volume's /usr/local/bin on a first boot (entrypoint.sh);
# every deploy-prod installs its own copies over them.
COPY infra/ci-runner/ia-rollback.sh /opt/ia-seed/ia-rollback
COPY infra/backend-host/set-machine-image /opt/ia-seed/set-machine-image

ENV HOLDER_PORT=3001
EXPOSE 3001
CMD ["/usr/local/sbin/ia-backend-entrypoint"]
