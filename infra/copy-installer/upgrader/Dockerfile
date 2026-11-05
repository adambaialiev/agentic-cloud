# The upgrader (note #1008): the one-shot machine an upgrade of your own
# Agentic Cloud runs on, in your own Fly organization, app <prefix>-upgrader.
# It runs this release's install.mjs (`upgrader`), which rolls the Workspace,
# the code host and the router with flyctl, and puts the old release back if
# anything fails. Built into every release by infra/copy-release/build.sh.
FROM node:22-slim
ARG FLYCTL_VERSION=0.5.4
ARG FLYCTL_SHA256=0e58776a99e561887b82b941b15b63fd8fb1c7153b567b11fb3e63b65dd9780e
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /tmp/flyctl.tgz "https://github.com/superfly/flyctl/releases/download/v${FLYCTL_VERSION}/flyctl_${FLYCTL_VERSION}_Linux_x86_64.tar.gz" \
  && echo "${FLYCTL_SHA256}  /tmp/flyctl.tgz" | sha256sum -c - \
  && tar -xzf /tmp/flyctl.tgz -C /usr/local/bin flyctl && ln -s /usr/local/bin/flyctl /usr/local/bin/fly \
  && rm -f /tmp/flyctl.tgz && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY install.mjs package.json /app/
RUN chmod -R a+rX /app && node --check /app/install.mjs && flyctl version
ENV FLY_NO_UPDATE_CHECK=1
CMD ["node", "/app/install.mjs", "upgrader"]
